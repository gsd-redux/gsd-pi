// GSD — reopen-milestone tool handler

/**
 * reopen-milestone handler — the core operation behind gsd_milestone_reopen.
 *
 * Resets a closed milestone back to "active", all of its slices to
 * "in_progress", and all tasks to "pending". Cleans up stale filesystem
 * artifacts so the DB-filesystem reconciler does not auto-correct
 * entities back to "complete".
 */

import {
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  reopenMilestoneCascade,
} from "../gsd-db.js";
import {
  isCurrentMilestoneReopenOperation,
  reopenMilestone,
  type MilestoneReopenReceipt,
} from "../milestone-lifecycle-domain-operation.js";
import { isMilestoneLifecycleAdopted } from "../db/milestone-closeout-readiness.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import { join } from "node:path";
import {
  buildFlatTaskFileName,
  buildSliceFileName,
  buildTaskFileName,
  legacyMilestonesDir,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveTasksDir,
  clearPathCache,
  targetMilestoneFile,
  targetSliceFile,
  targetTaskFile,
} from "../paths.js";
import { removeProjectionIfCurrent } from "../projection-cleanup.js";

export interface ReopenMilestoneParams {
  milestoneId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenMilestoneResult {
  milestoneId: string;
  slicesReset: number;
  tasksReset: number;
  operationId?: string;
  duplicate?: boolean;
  superseded?: boolean;
  stale?: boolean;
}

type CleanupDelivery = { artifactPath: string; operationId: string };
let cleanupInterleaveForTest: ((delivery: CleanupDelivery) => void) | null = null;

export function _setReopenMilestoneCleanupInterleaveForTest(
  hook: ((delivery: CleanupDelivery) => void) | null,
): void {
  cleanupInterleaveForTest = hook;
}

export async function handleReopenMilestone(
  params: ReopenMilestoneParams,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<ReopenMilestoneResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  const adoptedLifecycle = isMilestoneLifecycleAdopted(params.milestoneId);
  let canonicalReceipt: MilestoneReopenReceipt | undefined;
  let slicesResetCount = 0;
  let tasksResetCount = 0;
  if (adoptedLifecycle) {
    if (!invocation) {
      return { error: "adopted Milestone reopen requires canonical invocation identity" };
    }
    try {
      canonicalReceipt = reopenMilestone({
        invocation,
        milestoneId: params.milestoneId,
        reason: params.reason?.trim() || "Full Milestone redo requested",
        audit: {
          ...(params.actorName ? { actorName: params.actorName } : {}),
          ...(params.triggerReason ? { triggerReason: params.triggerReason } : {}),
        },
      });
      slicesResetCount = canonicalReceipt.slicesReset;
      tasksResetCount = canonicalReceipt.tasksReset;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    const outcome = reopenMilestoneCascade(params.milestoneId);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case "milestone-not-found":
          return { error: `milestone not found: ${params.milestoneId}` };
        case "canonical-authority-present":
          return { error: `refusing legacy reopen for partially adopted Milestone ${params.milestoneId}` };
        case "milestone-not-closed":
          return { error: `milestone ${params.milestoneId} is not closed (status: ${outcome.status}) — nothing to reopen` };
      }
    }
    slicesResetCount = outcome.slicesReset;
    tasksResetCount = outcome.tasksReset;
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // A historical replay must not remove files rendered by a newer operation.
  // T04 makes each individual cleanup delivery operation-fenced.
  const shouldProjectReopen = canonicalReceipt?.isCurrent !== false;
  let projectionStale = false;
  let superseded = !shouldProjectReopen;
  const operationId = canonicalReceipt?.operationId ?? `legacy-${params.milestoneId}`;
  const isCurrent = canonicalReceipt
    ? () => isCurrentMilestoneReopenOperation(operationId, params.milestoneId)
    : () => true;

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees SUMMARY.md files and
  // auto-corrects entities back to "complete", making reopen a no-op (#3161).
  if (shouldProjectReopen) {
    try {
      const slices = getMilestoneSlices(params.milestoneId);
      const milestoneTitle = getMilestone(params.milestoneId)?.title;
      const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
      const legacyBase = legacyMilestonesDir(basePath);
      const isLegacy = !!milestoneDir && (
        milestoneDir.startsWith(legacyBase + "/") || milestoneDir.startsWith(legacyBase + "\\")
      );
      const remove = (artifactPath: string): boolean => {
        cleanupInterleaveForTest?.({ artifactPath, operationId });
        return removeProjectionIfCurrent({ artifactPath, operationId, isCurrent });
      };

      const milestoneSummaries = new Set([
        resolveMilestoneFile(basePath, params.milestoneId, "SUMMARY"),
        targetMilestoneFile(basePath, params.milestoneId, "SUMMARY", milestoneTitle),
        ...(milestoneDir ? [join(milestoneDir, `${params.milestoneId}-SUMMARY.md`)] : []),
      ].filter((path): path is string => Boolean(path)));
      for (const artifactPath of milestoneSummaries) {
        if (!remove(artifactPath)) {
          superseded = true;
          projectionStale = true;
          break;
        }
      }

      cleanup: for (const slice of slices) {
        if (superseded) break;
        const sliceDir = resolveSlicePath(basePath, params.milestoneId, slice.id);
        for (const suffix of ["SUMMARY", "UAT"]) {
          const sliceArtifacts = new Set([
            resolveSliceFile(basePath, params.milestoneId, slice.id, suffix),
            targetSliceFile(basePath, params.milestoneId, slice.id, suffix, milestoneTitle),
            ...(sliceDir ? [
              join(sliceDir, buildSliceFileName(slice.id, suffix)),
              join(sliceDir, `${slice.id}-${suffix}.md`),
            ] : []),
          ].filter((path): path is string => Boolean(path)));
          for (const artifactPath of sliceArtifacts) {
            if (!remove(artifactPath)) {
              superseded = true;
              projectionStale = true;
              break cleanup;
            }
          }
        }

        const tasksDir = resolveTasksDir(basePath, params.milestoneId, slice.id);
        const tasks = getSliceTasks(params.milestoneId, slice.id);
        for (const task of tasks) {
          let taskSummaries: string[] = [];
          if (isLegacy) {
            if (tasksDir) {
              taskSummaries = [join(tasksDir, buildTaskFileName(task.id, "SUMMARY"))];
            }
          } else if (milestoneDir) {
            taskSummaries = [
              join(milestoneDir, buildFlatTaskFileName(slice.id, task.id, "SUMMARY")),
              join(milestoneDir, buildTaskFileName(task.id, "SUMMARY")),
            ];
          }
          const taskArtifacts = new Set([
            resolveTaskFile(basePath, params.milestoneId, slice.id, task.id, "SUMMARY"),
            targetTaskFile(basePath, params.milestoneId, slice.id, task.id, "SUMMARY", milestoneTitle),
            ...taskSummaries,
          ].filter((path): path is string => Boolean(path)));
          for (const artifactPath of taskArtifacts) {
            if (!remove(artifactPath)) {
              superseded = true;
              projectionStale = true;
              break cleanup;
            }
          }
        }
      }
    } catch (err) {
      projectionStale = true;
      debugLog("reopen-milestone-cleanup-failed", { milestoneId: params.milestoneId, error: String(err) });
    }
  }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    if (!shouldProjectReopen) {
      return {
        milestoneId: params.milestoneId,
        slicesReset: slicesResetCount,
        tasksReset: tasksResetCount,
        operationId: canonicalReceipt?.operationId,
        duplicate: canonicalReceipt?.status === "replayed",
        superseded: true,
      };
    }
    if (!superseded) {
      const flushed = await flushWorkflowProjections(
        basePath,
        { milestoneId: params.milestoneId },
        canonicalReceipt ? { operationId, isCurrent } : undefined,
      );
      projectionStale ||= flushed.stale;
      superseded ||= flushed.superseded;
      if (!superseded && isCurrent()) writeManifest(basePath);
      if (!canonicalReceipt) {
        appendEvent(basePath, {
          cmd: "reopen-milestone",
          params: {
            milestoneId: params.milestoneId,
            reason: params.reason ?? null,
            slicesReset: slicesResetCount,
            tasksReset: tasksResetCount,
          },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    }
  } catch (hookErr) {
    projectionStale = true;
    logWarning("tool", `reopen-milestone post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    slicesReset: slicesResetCount,
    tasksReset: tasksResetCount,
    ...(canonicalReceipt ? {
      operationId: canonicalReceipt.operationId,
      duplicate: canonicalReceipt.status === "replayed",
    } : {}),
    ...(projectionStale ? { stale: true } : {}),
    ...(superseded ? { superseded: true } : {}),
  };
}
