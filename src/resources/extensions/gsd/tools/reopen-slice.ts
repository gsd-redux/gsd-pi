/**
 * reopen-slice handler — the core operation behind gsd_slice_reopen.
 *
 * Resets a completed slice back to "in_progress" and resets ALL of its
 * tasks back to "pending". This is intentional — if you're reopening a
 * slice, you're re-doing the work. Partial resets create ambiguous state.
 *
 * Also recovers a desynced slice (#1205): when a UAT→planning fallback leaves
 * the slice open (e.g. "pending") but its tasks still "complete", this clears
 * that state so the planner can re-plan without hitting "already complete"
 * rejections.
 *
 * The parent milestone must still be open (not complete).
 */

// GSD — reopen-slice tool handler
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import {
  getSliceTasks,
} from "../gsd-db.js";
import { randomUUID } from "node:crypto";
import { reopenSlice, SliceLifecycleValidationError } from "../slice-lifecycle-domain-operation.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  buildFlatTaskFileName,
  buildTaskFileName,
  legacyMilestonesDir,
  resolveMilestonePath,
  resolveTasksDir,
  resolveSlicePath,
  clearPathCache,
} from "../paths.js";

export interface ReopenSliceParams {
  milestoneId: string;
  sliceId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
  invocation?: ExecutionInvocation;
}

export interface ReopenSliceResult {
  milestoneId: string;
  sliceId: string;
  tasksReset: number;
}

export async function handleReopenSlice(
  params: ReopenSliceParams,
  basePath: string,
): Promise<ReopenSliceResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  let tasksResetCount: number;
  try {
    tasksResetCount = reopenSlice({
      invocation: params.invocation ?? {
        idempotencyKey: `internal:reopen-slice:${randomUUID()}`,
        sourceTransport: "internal",
        actorType: "agent",
      },
      slice: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      reason: params.reason?.trim() || "User-directed full Slice redo",
    }).tasksReset;
  } catch (error) {
    if (!(error instanceof SliceLifecycleValidationError)) throw error;
    return { error: error.message };
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees SUMMARY.md files and
  // auto-corrects tasks back to "complete", making reopen a no-op (#3161).
  try {
    const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
    const legacyBase = legacyMilestonesDir(basePath);
    const isLegacy = !!milestoneDir && (
      milestoneDir.startsWith(legacyBase + "/") || milestoneDir.startsWith(legacyBase + "\\")
    );
    const tasksDir = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
    const tasks = getSliceTasks(params.milestoneId, params.sliceId);
    for (const task of tasks) {
      const summaryPaths = isLegacy
        ? (tasksDir ? [join(tasksDir, buildTaskFileName(task.id, "SUMMARY"))] : [])
        : milestoneDir
          ? [
            join(milestoneDir, buildFlatTaskFileName(params.sliceId, task.id, "SUMMARY")),
            join(milestoneDir, buildTaskFileName(task.id, "SUMMARY")),
          ]
          : [];
      for (const summaryPath of summaryPaths) {
        if (existsSync(summaryPath)) unlinkSync(summaryPath);
      }
    }
    const sliceDir = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
    if (sliceDir) {
      const sliceSummary = join(sliceDir, `${params.sliceId}-SUMMARY.md`);
      if (existsSync(sliceSummary)) unlinkSync(sliceSummary);
      const sliceUat = join(sliceDir, `${params.sliceId}-UAT.md`);
      if (existsSync(sliceUat)) unlinkSync(sliceUat);
    }
  } catch (cleanupErr) {
    logWarning("tool", `reopen-slice artifact cleanup warning: ${(cleanupErr as Error).message}`);
  }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "reopen-slice",
      params: {
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        reason: params.reason ?? null,
        tasksReset: tasksResetCount,
      },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    logWarning("tool", `reopen-slice post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    tasksReset: tasksResetCount,
  };
}
