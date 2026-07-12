import { resolve } from "node:path";
import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { getGateIdsForTurn } from "../gate-registry.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  getMilestone,
  getSlice,
  getSliceTasks,
  insertTask,
  normalizeLegacyLifecycleStatus,
  upsertSlicePlanning,
  upsertTaskPlanning,
  insertGateRow,
  updateTaskStatus,
  setSliceSketchFlag,
} from "../gsd-db.js";
import type { GateEvaluationConfig, GateId } from "../types.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanCheckboxes, renderPlanFromDb } from "../markdown-renderer.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { validatePathOnlyPlanningFields, validatePlanningPathScope } from "../planning-path-scope.js";
import { runTaskPathChecks } from "../pre-execution-checks.js";
import type { TaskRow } from "../db-task-slice-rows.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { normalizeRealPath, resolveSliceFile, resolveTaskFile } from "../paths.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { createRepositoryRegistryFromPreferences, defaultRepositoryTargets, type RepositoryRegistry } from "../repository-registry.js";
import { removeOwnedPlanProjection } from "../projection-cleanup.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "../planning-domain-operation.js";
import {
  type PlanningInvocation,
} from "../planning-invocation.js";


export interface PlanSliceTaskInput {
  taskId: string;
  title: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  observabilityImpact?: string;
  fullPlanMd?: string;
  targetRepositories?: string[];
}

export interface PlanSliceParams {
  milestoneId: string;
  sliceId: string;
  goal: string;
  tasks?: PlanSliceTaskInput[];
  /** @optional — omitted fields render as conservative defaults */
  successCriteria?: string;
  /** @optional — omitted fields render as conservative defaults */
  proofLevel?: string;
  /** @optional — omitted fields render as conservative defaults */
  integrationClosure?: string;
  /** @optional — omitted fields render as conservative defaults */
  observabilityImpact?: string;
  targetRepositories?: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface PlanSliceResult {
  milestoneId: string;
  sliceId: string;
  planPath: string;
  taskPlanPaths: string[];
}

function validateRepositoryTargetIds(
  field: string,
  value: unknown,
): string[] | null {
  if (value === undefined) return null;
  const ids = validateStringArray(value, field);
  if (ids.length === 0) throw new Error(`${field} must include at least one repository id when provided`);
  const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (deduped.length === 0) throw new Error(`${field} must include at least one repository id when provided`);
  return deduped;
}

function validateTasks(value: unknown): PlanSliceTaskInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("tasks must be an array");
  }
  if (value.length === 0) return undefined;

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`tasks[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const taskId = obj.taskId;
    const title = obj.title;
    const description = obj.description;
    const estimate = obj.estimate;
    const files = obj.files;
    const verify = obj.verify;
    const inputs = obj.inputs;
    const expectedOutput = obj.expectedOutput;
    const observabilityImpact = obj.observabilityImpact;
    const targetRepositories = obj.targetRepositories;

    if (!isNonEmptyString(taskId)) throw new Error(`tasks[${index}].taskId must be a non-empty string`);
    if (seen.has(taskId)) throw new Error(`tasks[${index}].taskId must be unique`);
    seen.add(taskId);
    if (!isNonEmptyString(title)) throw new Error(`tasks[${index}].title must be a non-empty string`);
    if (!isNonEmptyString(description)) throw new Error(`tasks[${index}].description must be a non-empty string`);
    if (!isNonEmptyString(estimate)) throw new Error(`tasks[${index}].estimate must be a non-empty string`);
    const validatedFiles = validateStringArray(files, `tasks[${index}].files`);
    if (!isNonEmptyString(verify)) throw new Error(`tasks[${index}].verify must be a non-empty string`);
    const validatedInputs = validateStringArray(inputs, `tasks[${index}].inputs`);
    const validatedExpectedOutput = validateStringArray(expectedOutput, `tasks[${index}].expectedOutput`);
    if (observabilityImpact !== undefined && !isNonEmptyString(observabilityImpact)) {
      throw new Error(`tasks[${index}].observabilityImpact must be a non-empty string when provided`);
    }
    const validatedTargetRepositories = validateRepositoryTargetIds(
      `tasks[${index}].targetRepositories`,
      targetRepositories,
    );

    return {
      taskId,
      title,
      description,
      estimate,
      files: validatedFiles,
      verify,
      inputs: validatedInputs,
      expectedOutput: validatedExpectedOutput,
      observabilityImpact: typeof observabilityImpact === "string" ? observabilityImpact : "",
      targetRepositories: validatedTargetRepositories ?? undefined,
    };
  });
}

function validateParams(params: PlanSliceParams): PlanSliceParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.goal)) throw new Error("goal is required");

  const validatedTargetRepositories = validateRepositoryTargetIds(
    "targetRepositories",
    params.targetRepositories,
  );

  return {
    ...params,
    // Keep optional enrichment fields empty when omitted. The renderer supplies
    // conservative defaults where needed, without surfacing placeholder prose.
    successCriteria: params.successCriteria ?? "",
    proofLevel: params.proofLevel ?? "",
    integrationClosure: params.integrationClosure ?? "",
    observabilityImpact: params.observabilityImpact ?? "",
    targetRepositories: validatedTargetRepositories ?? undefined,
    tasks: validateTasks(params.tasks),
  };
}

function loadPlanningContext(basePath: string): {
  repositoryRegistry: RepositoryRegistry;
  gateEvaluation?: GateEvaluationConfig;
} {
  const loaded = loadEffectiveGSDPreferences(basePath);
  return {
    repositoryRegistry: createRepositoryRegistryFromPreferences(basePath, loaded?.preferences),
    gateEvaluation: loaded?.preferences?.gate_evaluation,
  };
}

function resolveGateEvaluateSliceGates(config: GateEvaluationConfig | undefined): GateId[] {
  const ownedGateIds = [...getGateIdsForTurn("gate-evaluate")];
  if (!config?.slice_gates?.length) return ownedGateIds;
  const owned = new Set<string>(ownedGateIds);
  return config.slice_gates.filter((gateId): gateId is GateId => owned.has(gateId));
}

function resolveTaskGates(config: GateEvaluationConfig | undefined): GateId[] {
  if (config?.task_gates === false) return [];
  return [...getGateIdsForTurn("execute-task")];
}

function validateReferencedRepositories(
  params: PlanSliceParams,
  registry: RepositoryRegistry,
  defaultTargets: string[],
): string | null {
  const known = new Set(registry.repositories.map((repo) => repo.id));

  const missing: string[] = [];
  const noteMissing = (id: string) => {
    if (!known.has(id) && !missing.includes(id)) missing.push(id);
  };

  for (const id of params.targetRepositories ?? defaultTargets) noteMissing(id);
  for (const task of params.tasks ?? []) {
    for (const id of task.targetRepositories ?? params.targetRepositories ?? defaultTargets) noteMissing(id);
  }

  if (missing.length === 0) return null;
  return `unknown targetRepositories: ${missing.join(", ")}. Declared repositories: ${Array.from(known).join(", ")}`;
}

function resolveAllowedRootsForPathScope(params: PlanSliceParams, registry: RepositoryRegistry, defaultTargets: string[]): string[] {
  const requested = new Set<string>();
  for (const id of params.targetRepositories ?? defaultTargets) requested.add(id);
  for (const task of params.tasks ?? []) {
    for (const id of task.targetRepositories ?? params.targetRepositories ?? defaultTargets) requested.add(id);
  }
  if (requested.size === 0) return [registry.projectRoot];
  const roots = Array.from(requested)
    .map((id) => registry.byId.get(id)?.root)
    .filter((root): root is string => typeof root === "string");
  return roots.length > 0 ? roots : [registry.projectRoot];
}

function toTaskRows(params: PlanSliceParams, defaultTargets: string[]): TaskRow[] {
  return (params.tasks ?? []).map((task, index) => ({
    milestone_id: params.milestoneId,
    slice_id: params.sliceId,
    id: task.taskId,
    title: task.title,
    status: "pending",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: null,
    blocker_discovered: false,
    deviations: "",
    known_issues: "",
    key_files: [],
    key_decisions: [],
    full_summary_md: "",
    description: task.description,
    estimate: task.estimate,
    files: task.files,
    verify: task.verify,
    inputs: task.inputs,
    expected_output: task.expectedOutput,
    observability_impact: task.observabilityImpact ?? "",
    full_plan_md: task.fullPlanMd ?? "",
    target_repositories: task.targetRepositories ?? params.targetRepositories ?? defaultTargets,
    sequence: index + 1,
    blocker_source: "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
  }));
}

function validateTaskPathsBeforePersist(
  params: PlanSliceParams,
  basePath: string,
  defaultTargets: string[],
  allowedRoots: string[],
): string | null {
  const taskRows = toTaskRows(params, defaultTargets);
  const baseRoot = resolve(basePath);
  const additionalRoots = allowedRoots
    .map((root) => resolve(root))
    .filter((root) => root !== baseRoot);
  const resolvedCanonicalRoot = resolve(resolveWorktreeProjectRoot(basePath));
  const canonicalProjectRoot = resolvedCanonicalRoot !== baseRoot ? resolvedCanonicalRoot : undefined;
  const hasContext = additionalRoots.length > 0 || canonicalProjectRoot !== undefined;
  const context = hasContext
    ? {
        ...(additionalRoots.length > 0 ? { additionalRoots } : {}),
        ...(canonicalProjectRoot !== undefined ? { canonicalProjectRoot } : {}),
      }
    : undefined;
  const checks = runTaskPathChecks(taskRows, basePath, context);
  const blocking = checks.filter((check) => !check.passed && check.blocking);

  if (blocking.length === 0) return null;

  return blocking
    .map((check) => `[${check.category}] ${check.target}: ${check.message}`)
    .join("\n");
}

export async function handlePlanSlice(
  rawParams: PlanSliceParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<PlanSliceResult | { error: string }> {
  let params: PlanSliceParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  let repositoryRegistry: RepositoryRegistry;
  let gateEvaluation: GateEvaluationConfig | undefined;
  try {
    const context = loadPlanningContext(basePath);
    repositoryRegistry = context.repositoryRegistry;
    gateEvaluation = context.gateEvaluation;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `validation failed: ${message}` };
  }
  const defaultTargets = defaultRepositoryTargets(repositoryRegistry);
  const taskPayload = params.tasks ?? [];
  const hasTaskPayload = taskPayload.length > 0;
  const repoValidationError = validateReferencedRepositories(params, repositoryRegistry, defaultTargets);
  if (repoValidationError) {
    return { error: `validation failed: ${repoValidationError}` };
  }

  const allowedAbsoluteRoots = resolveAllowedRootsForPathScope(params, repositoryRegistry, defaultTargets);

  const pathOnlyError = validatePathOnlyPlanningFields(
    taskPayload.map((task, index) => ({
      field: `tasks[${index}].expectedOutput`,
      values: task.expectedOutput,
    })),
  );
  if (pathOnlyError) {
    return { error: `validation failed: ${pathOnlyError}` };
  }

  const pathScopeError = validatePlanningPathScope(
    basePath,
    taskPayload.flatMap((task, index) => [
      { field: `tasks[${index}].files`, values: task.files },
      { field: `tasks[${index}].inputs`, values: task.inputs },
      { field: `tasks[${index}].expectedOutput`, values: task.expectedOutput },
    ]),
    allowedAbsoluteRoots,
  );
  if (pathScopeError) {
    return { error: `validation failed: ${pathScopeError}` };
  }

  const pathError = validateTaskPathsBeforePersist(params, basePath, defaultTargets, allowedAbsoluteRoots);
  if (pathError) {
    return { error: `pre-execution validation failed:\n${pathError}` };
  }

  let operationStatus: "committed" | "replayed";
  try {
    const receipt = executePlanningDomainOperation({
      operationType: "workflow.slice.plan",
      invocation,
      actorId: params.actorName,
      payload: planningOperationPayload(params),
      event: {
        eventType: "workflow.slice.planned",
        entityType: "slice",
        entityId: `${params.milestoneId}/${params.sliceId}`,
        payload: {
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskIds: taskPayload.map((task) => task.taskId),
        },
        destinations: ["projection"],
      },
      projection: {
        projectionKey: `planning/${params.milestoneId}/${params.sliceId}`.toLowerCase(),
        projectionKind: "markdown",
        rendererVersion: "v1",
      },
      lifecycleItems: () => [
        { itemKind: "milestone", milestoneId: params.milestoneId },
        { itemKind: "slice", milestoneId: params.milestoneId, sliceId: params.sliceId },
        ...(hasTaskPayload
          ? getSliceTasks(params.milestoneId, params.sliceId).map((task) => ({
              itemKind: "task" as const,
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: task.id,
            }))
          : []),
      ],
      mutate(context) {
        const parentMilestone = getMilestone(params.milestoneId);
        if (!parentMilestone) {
          throw new PlanningGuardError(`milestone not found: ${params.milestoneId}`);
        }
        if (isClosedStatus(parentMilestone.status)) {
          throw new PlanningGuardError(`cannot plan slice in a closed milestone: ${params.milestoneId} (status: ${parentMilestone.status})`);
        }
        const legacyMilestoneLifecycle = normalizeLegacyLifecycleStatus(parentMilestone.status);
        const milestoneLifecycleStatus = legacyMilestoneLifecycle === "completed" || legacyMilestoneLifecycle === "cancelled"
          ? legacyMilestoneLifecycle
          : "ready";
        const milestoneLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "milestone",
          milestoneId: params.milestoneId,
          lifecycleStatus: milestoneLifecycleStatus,
        });
        if (milestoneLifecycle.lifecycleStatus === "completed" || milestoneLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `cannot plan slice in ${milestoneLifecycle.lifecycleStatus} milestone ${params.milestoneId} — use gsd_milestone_reopen first`,
          );
        }

        const parentSlice = getSlice(params.milestoneId, params.sliceId);
        if (!parentSlice) {
          throw new PlanningGuardError(`missing parent slice: ${params.milestoneId}/${params.sliceId}`);
        }
        if (isClosedStatus(parentSlice.status)) {
          throw new PlanningGuardError(`cannot re-plan slice ${params.sliceId}: it is already complete — use gsd_slice_reopen first`);
        }
        const legacySliceLifecycle = normalizeLegacyLifecycleStatus(parentSlice.status);
        let sliceLifecycleStatus: "pending" | "ready" | "completed" | "cancelled" = hasTaskPayload
          ? "ready"
          : "pending";
        if (legacySliceLifecycle === "completed" || legacySliceLifecycle === "cancelled") {
          sliceLifecycleStatus = legacySliceLifecycle;
        }
        const sliceLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          lifecycleStatus: sliceLifecycleStatus,
        });
        if (sliceLifecycle.lifecycleStatus === "completed" || sliceLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `cannot re-plan ${sliceLifecycle.lifecycleStatus} slice ${params.sliceId} — use gsd_slice_reopen first`,
          );
        }

        const newTaskIds = new Set(taskPayload.map((task) => task.taskId));
        const existingTasks = getSliceTasks(params.milestoneId, params.sliceId);
        if (hasTaskPayload) {
          for (const task of existingTasks) {
            const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
            const observedLifecycleStatus = legacyLifecycleStatus ?? "ready";
            const omitted = !newTaskIds.has(task.id);
            const lifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: task.id,
              lifecycleStatus: omitted && observedLifecycleStatus !== "completed"
                ? "cancelled"
                : observedLifecycleStatus,
              ...(omitted ? { adoptedFromStatus: observedLifecycleStatus } : {}),
            });
            if (
              newTaskIds.has(task.id) &&
              (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled")
            ) {
              throw new PlanningGuardError(
                `cannot re-plan ${lifecycle.lifecycleStatus} task ${task.id} — use gsd_task_reopen first`,
              );
            }
            if (omitted && lifecycle.lifecycleStatus === "completed") {
              throw new PlanningGuardError(`cannot remove completed task ${task.id}`);
            }
          }
        }
        const cancelledIncomingTask = existingTasks.find((task) => (
          newTaskIds.has(task.id) && task.status === "skipped"
        ));
        if (cancelledIncomingTask) {
          throw new PlanningGuardError(`cannot re-plan cancelled task ${cancelledIncomingTask.id} — use gsd_task_reopen first`);
        }
        const omittedTasks = hasTaskPayload
          ? existingTasks.filter((task) => !newTaskIds.has(task.id))
          : [];
        const completedOmission = omittedTasks.find((task) => isClosedStatus(task.status) && task.status !== "skipped");
        if (completedOmission) {
          throw new PlanningGuardError(`cannot remove completed task ${completedOmission.id}`);
        }

        upsertSlicePlanning(params.milestoneId, params.sliceId, {
          goal: params.goal,
          successCriteria: params.successCriteria,
          proofLevel: params.proofLevel,
          integrationClosure: params.integrationClosure,
          observabilityImpact: params.observabilityImpact,
          targetRepositories: params.targetRepositories ?? defaultTargets,
        });

        if (hasTaskPayload) {
          for (const task of omittedTasks) {
            updateTaskStatus(params.milestoneId, params.sliceId, task.id, "skipped");
            const lifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: task.id,
              lifecycleStatus: "ready",
            });
            if (lifecycle.lifecycleStatus !== "cancelled") {
              adoptOrTransitionLifecycle(context, {
                itemKind: "task",
                milestoneId: params.milestoneId,
                sliceId: params.sliceId,
                taskId: task.id,
                lifecycleStatus: "cancelled",
              });
            }
          }

          const existingTaskById = new Map(existingTasks.map((task) => [task.id, task]));
          for (const task of taskPayload) {
            if (!existingTaskById.has(task.taskId)) {
              insertTask({
                id: task.taskId,
                sliceId: params.sliceId,
                milestoneId: params.milestoneId,
                title: task.title,
                status: "pending",
              });
            }
            upsertTaskPlanning(params.milestoneId, params.sliceId, task.taskId, {
              title: task.title,
              description: task.description,
              estimate: task.estimate,
              files: task.files,
              verify: task.verify,
              inputs: task.inputs,
              expectedOutput: task.expectedOutput,
              observabilityImpact: task.observabilityImpact ?? "",
              fullPlanMd: task.fullPlanMd,
              targetRepositories: task.targetRepositories ?? params.targetRepositories ?? defaultTargets,
            });
            const lifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: task.taskId,
              lifecycleStatus: "ready",
            });
            if (lifecycle.lifecycleStatus === "cancelled") {
              throw new PlanningGuardError(`cannot re-plan cancelled task ${task.taskId} — use gsd_task_reopen first`);
            }
            if (lifecycle.lifecycleStatus === "pending") {
              adoptOrTransitionLifecycle(context, {
                itemKind: "task",
                milestoneId: params.milestoneId,
                sliceId: params.sliceId,
                taskId: task.taskId,
                lifecycleStatus: "ready",
              });
            }
          }
        }

        if (hasTaskPayload && sliceLifecycle.lifecycleStatus === "pending") {
          adoptOrTransitionLifecycle(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            lifecycleStatus: "ready",
          });
        }
        if (hasTaskPayload) setSliceSketchFlag(params.milestoneId, params.sliceId, false);

        for (const gid of resolveGateEvaluateSliceGates(gateEvaluation)) {
          insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: gid, scope: "slice" });
        }
        for (const task of taskPayload) {
          for (const gid of resolveTaskGates(gateEvaluation)) {
            insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: gid, scope: "task", taskId: task.taskId });
          }
        }
        insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: "Q8", scope: "slice" });
      },
    });
    operationStatus = receipt.status;
  } catch (err) {
    if (err instanceof PlanningGuardError) return { error: err.message };
    return { error: `db write failed: ${(err as Error).message}` };
  }

  try {
    const allSliceTasks = getSliceTasks(params.milestoneId, params.sliceId);
    const sliceTasks = allSliceTasks.filter((task) => task.status !== "skipped");
    for (const task of allSliceTasks.filter((candidate) => candidate.status === "skipped")) {
      const taskPlanPath = resolveTaskFile(basePath, params.milestoneId, params.sliceId, task.id, "PLAN");
      if (!taskPlanPath) continue;
      removeOwnedPlanProjection(basePath, taskPlanPath);
    }
    if (sliceTasks.length === 0) {
      const slicePlanPath = resolveSliceFile(basePath, params.milestoneId, params.sliceId, "PLAN");
      if (slicePlanPath) {
        removeOwnedPlanProjection(basePath, slicePlanPath);
      }
    }
    const hasClosedTasks = sliceTasks.some((task) => isClosedStatus(task.status));
    const renderResult = sliceTasks.length === 0
      ? { planPath: "", taskPlanPaths: [] as string[] }
      : await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
    if (sliceTasks.length > 0 && hasClosedTasks) {
      await renderPlanCheckboxes(basePath, params.milestoneId, params.sliceId);
    }
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: manifest, event log ─────────────────────────
    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      writeManifest(basePath);
      if (operationStatus === "committed") {
        appendEvent(basePath, {
          cmd: "plan-slice",
          params: { milestoneId: params.milestoneId, sliceId: params.sliceId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (hookErr) {
      logWarning("tool", `plan-slice post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      planPath: renderResult.planPath ? normalizeRealPath(renderResult.planPath) : "",
      taskPlanPaths: renderResult.taskPlanPaths.map(normalizeRealPath),
    };
  } catch (renderErr) {
    logWarning("tool", `plan_slice — render failed (DB rows preserved for debugging): ${(renderErr as Error).message}`);
    invalidateStateCache();
    return { error: `render failed: ${(renderErr as Error).message}` };
  }
}
