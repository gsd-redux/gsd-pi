import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  gsdProjectionRoot,
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveTaskFile,
  targetMilestoneFile,
} from "../paths.js";
import { deriveCompatProjectionKey } from "../compat/compat-marker.js";
import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString } from "../validation.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  getMilestone,
  getMilestoneSlices,
  getAssessment,
  getSlice,
  getSliceTasks,
  insertSlice,
  normalizeLegacyLifecycleStatus,
  projectCanonicalStatusToLegacy,
  updateSliceFields,
  insertAssessment,
  deleteAssessmentByScope,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import {
  renderRoadmapFromDb,
  renderAssessmentFromDb,
  resolveAssessmentProjectionPath,
} from "../markdown-renderer.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "../planning-domain-operation.js";
import type { PlanningInvocation } from "../planning-invocation.js";
import { removeOwnedPlanProjection } from "../projection-cleanup.js";

export interface SliceChangeInput {
  sliceId: string;
  title: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}

export interface ReassessRoadmapParams {
  milestoneId: string;
  completedSliceId: string;
  verdict: string;
  assessment: string;
  sliceChanges: {
    modified: SliceChangeInput[];
    added: SliceChangeInput[];
    removed: string[];
  };
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReassessRoadmapResult {
  milestoneId: string;
  completedSliceId: string;
  assessmentPath: string;
  roadmapPath: string;
}

function assessmentDbPathForRenderedFile(basePath: string, absPath: string): string {
  // Derive the .gsd-relative key with the shared helper, which realpath-normalizes
  // both the roots and the target (falling back to resolve() for not-yet-written
  // files). A prior implementation realpath-normalized only basePath and left
  // absPath raw, so on Windows the two sides used divergent drive/short-name/junction
  // forms and the .gsd/ prefix check spuriously failed (#windows-portability).
  const key = deriveCompatProjectionKey(absPath, [gsdProjectionRoot(basePath), gsdRoot(basePath)]);
  if (key === ".." || key.startsWith("../") || isAbsolute(key)) {
    throw new Error(`assessment projection must be inside .gsd: ${absPath}`);
  }
  return `.gsd/${key}`;
}

function removeSlicePlanProjections(basePath: string, milestoneId: string, sliceIds: string[]): void {
  for (const sliceId of sliceIds) {
    const planPaths = [resolveSliceFile(basePath, milestoneId, sliceId, "PLAN")];
    for (const task of getSliceTasks(milestoneId, sliceId)) {
      planPaths.push(resolveTaskFile(basePath, milestoneId, sliceId, task.id, "PLAN"));
    }
    for (const planPath of planPaths) {
      if (!planPath) continue;
      try {
        removeOwnedPlanProjection(basePath, planPath);
      } catch (err) {
        logWarning("tool", `removed slice plan cleanup warning: ${(err as Error).message}`);
      }
    }
  }
}

function validateParams(params: ReassessRoadmapParams): ReassessRoadmapParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.completedSliceId)) throw new Error("completedSliceId is required");
  if (!isNonEmptyString(params?.verdict)) throw new Error("verdict is required");
  if (!isNonEmptyString(params?.assessment)) throw new Error("assessment is required");

  if (!params.sliceChanges || typeof params.sliceChanges !== "object") {
    throw new Error("sliceChanges must be an object");
  }

  if (!Array.isArray(params.sliceChanges.modified)) {
    throw new Error("sliceChanges.modified must be an array");
  }

  if (!Array.isArray(params.sliceChanges.added)) {
    throw new Error("sliceChanges.added must be an array");
  }

  if (!Array.isArray(params.sliceChanges.removed)) {
    throw new Error("sliceChanges.removed must be an array");
  }

  const SLICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

  // Validate each modified slice
  for (let i = 0; i < params.sliceChanges.modified.length; i++) {
    const s = params.sliceChanges.modified[i];
    if (!s || typeof s !== "object") throw new Error(`sliceChanges.modified[${i}] must be an object`);
    if (!isNonEmptyString(s.sliceId)) throw new Error(`sliceChanges.modified[${i}].sliceId is required`);
    if (!isNonEmptyString(s.title)) throw new Error(`sliceChanges.modified[${i}].title is required`);
    if (s.depends !== undefined) {
      if (!Array.isArray(s.depends) || s.depends.some((item: unknown) => !isNonEmptyString(item) || !SLICE_ID_RE.test(item as string))) {
        throw new Error(`sliceChanges.modified[${i}].depends must be an array of valid slice IDs (e.g. "S01")`);
      }
    }
  }

  // Validate each added slice
  for (let i = 0; i < params.sliceChanges.added.length; i++) {
    const s = params.sliceChanges.added[i];
    if (!s || typeof s !== "object") throw new Error(`sliceChanges.added[${i}] must be an object`);
    if (!isNonEmptyString(s.sliceId)) throw new Error(`sliceChanges.added[${i}].sliceId is required`);
    if (!isNonEmptyString(s.title)) throw new Error(`sliceChanges.added[${i}].title is required`);
    if (s.depends !== undefined) {
      if (!Array.isArray(s.depends) || s.depends.some((item: unknown) => !isNonEmptyString(item) || !SLICE_ID_RE.test(item as string))) {
        throw new Error(`sliceChanges.added[${i}].depends must be an array of valid slice IDs (e.g. "S01")`);
      }
    }
  }

  return params;
}

export async function handleReassessRoadmap(
  rawParams: ReassessRoadmapParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ReassessRoadmapResult | { error: string }> {
  // ── Validate ──────────────────────────────────────────────────────
  let params: ReassessRoadmapParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }
  const hasStructuralChanges =
    params.sliceChanges.added.length > 0 ||
    params.sliceChanges.modified.length > 0 ||
    params.sliceChanges.removed.length > 0;

  const assessmentPath = resolveAssessmentProjectionPath(
    basePath,
    params.milestoneId,
    params.completedSliceId,
  );
  let operationStatus: "committed" | "replayed";
  try {
    const receipt = executePlanningDomainOperation({
      operationType: "workflow.roadmap.reassess",
      invocation,
      actorId: params.actorName,
      payload: planningOperationPayload(params),
      event: {
        eventType: "workflow.roadmap.reassessed",
        entityType: "milestone",
        entityId: params.milestoneId,
        payload: {
          milestoneId: params.milestoneId,
          completedSliceId: params.completedSliceId,
        },
        destinations: ["projection"],
      },
      projection: {
        projectionKey: `planning/${params.milestoneId}`.toLowerCase(),
        projectionKind: "markdown",
        rendererVersion: "v1",
      },
      lifecycleItems: () => {
        const sliceIds = new Set([
          params.completedSliceId,
          ...params.sliceChanges.modified.map((slice) => slice.sliceId),
          ...params.sliceChanges.added.map((slice) => slice.sliceId),
          ...params.sliceChanges.removed,
        ]);
        return [
          { itemKind: "milestone", milestoneId: params.milestoneId },
          ...Array.from(sliceIds).flatMap((sliceId) => [
            { itemKind: "slice" as const, milestoneId: params.milestoneId, sliceId },
            ...getSliceTasks(params.milestoneId, sliceId).map((task) => ({
              itemKind: "task" as const,
              milestoneId: params.milestoneId,
              sliceId,
              taskId: task.id,
            })),
          ]),
        ];
      },
      mutate(context) {
        const milestone = getMilestone(params.milestoneId);
        if (!milestone) {
          throw new PlanningGuardError(`milestone not found: ${params.milestoneId}`);
        }
        if (isClosedStatus(milestone.status)) {
          throw new PlanningGuardError(`cannot reassess a closed milestone: ${params.milestoneId} (status: ${milestone.status})`);
        }
        const milestoneLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "milestone",
          milestoneId: params.milestoneId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(milestone.status) ?? "ready",
        });
        if (
          milestoneLifecycle.lifecycleStatus === "completed" ||
          milestoneLifecycle.lifecycleStatus === "cancelled"
        ) {
          throw new PlanningGuardError(`cannot reassess a closed milestone: ${params.milestoneId} (canonical status: ${milestoneLifecycle.lifecycleStatus})`);
        }

        const completedSlice = getSlice(params.milestoneId, params.completedSliceId);
        if (!completedSlice) {
          throw new PlanningGuardError(`completedSliceId not found: ${params.milestoneId}/${params.completedSliceId}`);
        }
        if (!isClosedStatus(completedSlice.status)) {
          throw new PlanningGuardError(`completedSliceId ${params.completedSliceId} is not complete (status: ${completedSlice.status}) — reassess can only be called after a slice finishes`);
        }
        const completedSliceLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.completedSliceId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(completedSlice.status) ?? "completed",
        });
        if (completedSliceLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(`completedSliceId ${params.completedSliceId} is canonically cancelled and is not a valid completed slice`);
        }

        const existingSlices = getMilestoneSlices(params.milestoneId);
        const existingSliceById = new Map(existingSlices.map((slice) => [slice.id, slice]));
        const completedSliceIds = new Set<string>();
        for (const slice of existingSlices) {
          if (slice.status !== "skipped" && isClosedStatus(slice.status)) completedSliceIds.add(slice.id);
        }

        for (const modifiedSlice of params.sliceChanges.modified) {
          const existing = existingSliceById.get(modifiedSlice.sliceId);
          if (!existing) {
            throw new PlanningGuardError(`cannot modify missing slice ${modifiedSlice.sliceId}`);
          }
          if (completedSliceIds.has(modifiedSlice.sliceId)) {
            throw new PlanningGuardError(`cannot modify completed slice ${modifiedSlice.sliceId}`);
          }
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: modifiedSlice.sliceId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existing.status) ?? "ready",
          });
          if (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled") {
            throw new PlanningGuardError(
              `cannot modify ${lifecycle.lifecycleStatus} slice ${modifiedSlice.sliceId} — use gsd_slice_reopen first`,
            );
          }
        }
        for (const removedId of params.sliceChanges.removed) {
          if (completedSliceIds.has(removedId)) {
            throw new PlanningGuardError(`cannot remove completed slice ${removedId}`);
          }
          const existing = existingSliceById.get(removedId);
          if (!existing) {
            throw new PlanningGuardError(`cannot remove missing slice ${removedId}`);
          }
          const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(existing.status);
          const observedLifecycleStatus = legacyLifecycleStatus ?? "ready";
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: removedId,
            lifecycleStatus: observedLifecycleStatus === "completed" ? "completed" : "cancelled",
            adoptedFromStatus: observedLifecycleStatus,
          });
          if (lifecycle.lifecycleStatus === "completed") {
            throw new PlanningGuardError(`cannot remove completed slice ${removedId}`);
          }
          for (const task of getSliceTasks(params.milestoneId, removedId)) {
            const legacyTaskLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
            const observedTaskLifecycleStatus = legacyTaskLifecycleStatus ?? "ready";
            const taskLifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              taskId: task.id,
              lifecycleStatus: observedTaskLifecycleStatus === "completed" ? "completed" : "cancelled",
              adoptedFromStatus: observedTaskLifecycleStatus,
            });
            if (
              legacyTaskLifecycleStatus === "completed" ||
              taskLifecycle.lifecycleStatus === "completed"
            ) {
              throw new PlanningGuardError(
                `cannot remove slice ${removedId}: completed descendant task ${task.id}`,
              );
            }
          }
        }

        const removedIds = new Set<string>(params.sliceChanges.removed);
        const effectiveSliceIds = new Set<string>(
          existingSlices.map((slice) => slice.id).filter((id) => !removedIds.has(id)),
        );
        for (const added of params.sliceChanges.added) effectiveSliceIds.add(added.sliceId);
        const effectiveDependencies = new Map(
          existingSlices
            .filter((slice) => !removedIds.has(slice.id))
            .map((slice) => [slice.id, slice.depends] as const),
        );
        for (const modified of params.sliceChanges.modified) {
          if (modified.depends !== undefined) effectiveDependencies.set(modified.sliceId, modified.depends);
        }
        for (const added of params.sliceChanges.added) {
          effectiveDependencies.set(added.sliceId, added.depends ?? []);
        }
        for (const [sliceId, dependencies] of effectiveDependencies) {
          for (const dependency of dependencies) {
            if (!effectiveSliceIds.has(dependency)) {
              throw new PlanningGuardError(`effective slice ${sliceId} depends references unknown slice "${dependency}" — update or remove the dangling dependency`);
            }
          }
        }

        for (const added of params.sliceChanges.added) {
          const existing = existingSliceById.get(added.sliceId);
          if (!existing) continue;
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: added.sliceId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existing.status) ?? "ready",
          });
          if (existing.status === "skipped" || lifecycle.lifecycleStatus === "cancelled") {
            throw new PlanningGuardError(`cannot reuse cancelled slice ${added.sliceId} — use gsd_slice_reopen first`);
          }
          throw new PlanningGuardError(`cannot add existing slice ${added.sliceId}`);
        }

        for (const modified of params.sliceChanges.modified) {
          updateSliceFields(params.milestoneId, modified.sliceId, {
            title: modified.title,
            risk: modified.risk,
            depends: modified.depends,
            demo: modified.demo,
          });
        }

        const existingCount = getMilestoneSlices(params.milestoneId).length;
        for (let i = 0; i < params.sliceChanges.added.length; i++) {
          const added = params.sliceChanges.added[i]!;
          insertSlice({
            id: added.sliceId,
            milestoneId: params.milestoneId,
            title: added.title,
            status: "pending",
            risk: added.risk,
            depends: added.depends,
            demo: added.demo ?? "",
            sequence: existingCount + i + 1,
          });
          const lifecycleStatus = (added.depends ?? []).every((dependency) => completedSliceIds.has(dependency))
            ? "ready"
            : "pending";
          adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: added.sliceId,
            lifecycleStatus,
          });
        }

        for (const removedId of params.sliceChanges.removed) {
          for (const task of getSliceTasks(params.milestoneId, removedId)) {
            const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
            const lifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              taskId: task.id,
              lifecycleStatus: legacyLifecycleStatus ?? "ready",
            });
            if (lifecycle.lifecycleStatus === "completed") continue;
            if (lifecycle.lifecycleStatus !== "cancelled") {
              adoptOrTransitionLifecycle(context, {
                itemKind: "task",
                milestoneId: params.milestoneId,
                sliceId: removedId,
                taskId: task.id,
                lifecycleStatus: "cancelled",
              });
            }
            projectCanonicalStatusToLegacy(context, {
              entity: "task",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              taskId: task.id,
              status: "skipped",
            });
          }
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: removedId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existingSliceById.get(removedId)?.status ?? null) ?? "ready",
          });
          if (lifecycle.lifecycleStatus !== "cancelled") {
            adoptOrTransitionLifecycle(context, {
              itemKind: "slice",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              lifecycleStatus: "cancelled",
            });
          }
          projectCanonicalStatusToLegacy(context, {
            entity: "slice",
            milestoneId: params.milestoneId,
            sliceId: removedId,
            status: "skipped",
          });
        }

        if (hasStructuralChanges) {
          deleteAssessmentByScope(params.milestoneId, "milestone-validation");
        }

        insertAssessment({
          path: assessmentDbPathForRenderedFile(basePath, assessmentPath),
          milestoneId: params.milestoneId,
          sliceId: params.completedSliceId,
          status: params.verdict,
          scope: "roadmap",
          fullContent: params.assessment,
        });
      },
    });
    operationStatus = receipt.status;
  } catch (err) {
    if (err instanceof PlanningGuardError) return { error: err.message };
    return { error: `db write failed: ${(err as Error).message}` };
  }

  removeSlicePlanProjections(basePath, params.milestoneId, params.sliceChanges.removed);

  // ── Render artifacts ──────────────────────────────────────────────
  try {
    const roadmapResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    if ("skipped" in roadmapResult) {
      return { error: `roadmap render skipped: milestone ${params.milestoneId} has no planned slices` };
    }
    const durableAssessment = getAssessment(
      assessmentDbPathForRenderedFile(basePath, assessmentPath),
    );
    if (!durableAssessment) throw new Error("durable roadmap assessment not found");
    const assessmentResult = await renderAssessmentFromDb(basePath, params.milestoneId, params.completedSliceId, {
      verdict: String(durableAssessment["status"]),
      assessment: String(durableAssessment["full_content"]),
      completedSliceId: params.completedSliceId,
      createdAt: String(durableAssessment["created_at"]),
    });

    // ── Remove stale VALIDATION file from disk (#2957) ────────────
    if (hasStructuralChanges) {
      const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
      const validationFiles = new Set([
        resolveMilestoneFile(basePath, params.milestoneId, "VALIDATION"),
        targetMilestoneFile(
          basePath,
          params.milestoneId,
          "VALIDATION",
          getMilestone(params.milestoneId)?.title,
        ),
        milestoneDir ? join(milestoneDir, `${params.milestoneId}-VALIDATION.md`) : null,
      ].filter((file): file is string => Boolean(file)));
      for (const validationFile of validationFiles) {
        try {
          if (existsSync(validationFile)) unlinkSync(validationFile);
        } catch (e) {
          logWarning("tool", `validation file cleanup failed: ${(e as Error).message}`);
        }
      }
    }

    // ── Invalidate caches ─────────────────────────────────────────
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────
    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      writeManifest(basePath);
      if (operationStatus === "committed") {
        appendEvent(basePath, {
          cmd: "reassess-roadmap",
          params: { milestoneId: params.milestoneId, completedSliceId: params.completedSliceId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (hookErr) {
      logWarning("tool", `reassess-roadmap post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      completedSliceId: params.completedSliceId,
      assessmentPath: assessmentResult.assessmentPath,
      roadmapPath: roadmapResult.roadmapPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
