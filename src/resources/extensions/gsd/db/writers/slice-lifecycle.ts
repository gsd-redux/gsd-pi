// Project/App: gsd-pi
// File Purpose: Context-bound Slice cancellation across canonical and compatibility state.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  readLifecycleShadowComparison,
  requireActiveDomainOperationContext,
  settleAttemptWithResult,
  type CanonicalLifecycleStatus,
  type LifecycleShadowRecord,
} from "./lifecycle-commands.js";
import { compareLifecycleShadow, normalizeLegacyLifecycleStatus } from "../lifecycle-shadow-comparison.js";
import { terminalizeTaskExecutionDispatch } from "./task-execution.js";

interface SliceIdentity {
  milestoneId: string;
  sliceId: string;
}

interface HierarchyRow {
  taskId: string | null;
  legacyStatus: string;
  lifecycleId: string | null;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

interface RunningAttempt {
  attemptId: string;
  kernelCheckpointId: string;
  dispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
}

interface PlannedTask extends HierarchyRow {
  taskId: string;
  normalizedLegacyStatus: CanonicalLifecycleStatus;
  running: RunningAttempt | null;
  preserve: boolean;
}

export interface SliceCancellationInterruption {
  taskId: string;
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
  dispatchId: number;
}

export interface SliceCancellationHierarchyResult {
  sliceLifecycleId: string;
  wasAlreadySkipped: boolean;
  cancelledTaskIds: string[];
  preservedTaskIds: string[];
  interruptions: SliceCancellationInterruption[];
  shadows: LifecycleShadowRecord[];
}

export interface SliceReopenHierarchyResult {
  sliceLifecycleId: string;
  reopenedTaskIds: string[];
  shadows: LifecycleShadowRecord[];
}

export interface SliceCompletionProof {
  taskId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  verdictId: string;
  evidenceId: string;
  kernelCheckpointId: string;
  testedSourceRevision: string;
}

export interface SliceCompletionHierarchyResult {
  sliceLifecycleId: string;
  completedAt: string;
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  proofs: SliceCompletionProof[];
  q8Verdict: "pass" | "omitted";
  shadows: LifecycleShadowRecord[];
}

export class SliceLifecycleValidationError extends Error {}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SliceLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function runningAttempt(lifecycleId: string): RunningAttempt | null {
  const attempts = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.coordination_dispatch_id,
           attempt.worker_id, attempt.milestone_lease_token
    FROM workflow_execution_attempts attempt
    WHERE attempt.lifecycle_id = :lifecycle_id
      AND attempt.attempt_state = 'running'
  `).all({ ":lifecycle_id": lifecycleId }) as Array<Record<string, unknown>>;
  if (attempts.length > 1) throw new SliceLifecycleValidationError("Task lifecycle has multiple running Attempts");
  const attempt = attempts[0];
  if (!attempt) return null;
  const checkpoint = getDb().prepare(`
    SELECT checkpoint.kernel_checkpoint_id
    FROM workflow_kernel_checkpoints checkpoint
    WHERE checkpoint.lifecycle_id = :lifecycle_id
      AND checkpoint.attempt_id = :attempt_id
      AND checkpoint.next_stage = 'execute'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get({
    ":lifecycle_id": lifecycleId,
    ":attempt_id": attempt["attempt_id"],
  }) as Record<string, unknown> | undefined;
  if (!checkpoint) throw new SliceLifecycleValidationError("Running Task Attempt requires the current execute Kernel head");
  const dispatchId = Number(attempt["coordination_dispatch_id"]);
  const leaseToken = Number(attempt["milestone_lease_token"]);
  const workerId = String(attempt["worker_id"] ?? "");
  if (!Number.isSafeInteger(dispatchId) || dispatchId <= 0 ||
      !Number.isSafeInteger(leaseToken) || leaseToken <= 0 || !workerId) {
    throw new SliceLifecycleValidationError("Running Task Attempt has incomplete dispatch ownership");
  }
  return {
    attemptId: String(attempt["attempt_id"]),
    kernelCheckpointId: String(checkpoint["kernel_checkpoint_id"]),
    dispatchId,
    workerId,
    milestoneLeaseToken: leaseToken,
  };
}

function requireMatchingShadow(row: HierarchyRow, entity: string): void {
  if (!row.lifecycleStatus) return;
  const comparison = compareLifecycleShadow(row.legacyStatus, row.lifecycleStatus);
  if (comparison.kind !== "match" && comparison.kind !== "semantic_match_exact_delta") {
    throw new SliceLifecycleValidationError(`${entity} canonical and legacy lifecycle mismatch`);
  }
}

function currentCompletionProof(lifecycleId: string, taskId: string): SliceCompletionProof | null {
  const proof = getDb().prepare(`
    SELECT attempt.attempt_id, result.result_id, verdict.verdict_id,
           evidence.evidence_id, checkpoint.kernel_checkpoint_id,
           verdict.tested_source_revision
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_operations publication
      ON publication.operation_id = lifecycle.last_operation_id
     AND publication.operation_type = 'task.completion.publish'
    JOIN workflow_domain_events published
      ON published.operation_id = publication.operation_id
     AND published.event_type = 'task.completion.published'
     AND published.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
    JOIN workflow_execution_attempts attempt
      ON attempt.attempt_id = json_extract(published.payload_json, '$.attemptId')
     AND attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.attempt_state = 'settled'
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = lifecycle.lifecycle_id
     AND result.outcome = 'succeeded'
    JOIN workflow_acceptance_criteria criterion
      ON criterion.lifecycle_id = lifecycle.lifecycle_id
     AND criterion.criterion_key = 'host-technical-verification'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_acceptance_criteria successor
       WHERE successor.supersedes_criterion_id = criterion.criterion_id
     )
    JOIN workflow_technical_verdicts verdict
      ON verdict.criterion_id = criterion.criterion_id
     AND verdict.lifecycle_id = lifecycle.lifecycle_id
     AND verdict.attempt_id = attempt.attempt_id
     AND verdict.verdict = 'pass'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_technical_verdicts successor
       WHERE successor.supersedes_verdict_id = verdict.verdict_id
     )
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.attempt_id = attempt.attempt_id
     AND evidence.observation = 'passed'
     AND evidence.source_revision = verdict.tested_source_revision
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.next_stage = 'settled'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_kernel_checkpoints successor
       WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
     )
    WHERE lifecycle.lifecycle_id = :lifecycle_id
      AND lifecycle.item_kind = 'task'
      AND lifecycle.lifecycle_status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_execution_attempts running
        WHERE running.lifecycle_id = lifecycle.lifecycle_id
          AND running.attempt_state = 'running'
      )
  `).get({ ":lifecycle_id": lifecycleId }) as Record<string, unknown> | undefined;
  if (!proof) return null;
  return {
    taskId,
    lifecycleId,
    attemptId: String(proof["attempt_id"]),
    resultId: String(proof["result_id"]),
    verdictId: String(proof["verdict_id"]),
    evidenceId: String(proof["evidence_id"]),
    kernelCheckpointId: String(proof["kernel_checkpoint_id"]),
    testedSourceRevision: String(proof["tested_source_revision"]),
  };
}

export function completeSliceHierarchy(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { operationalReadiness: string },
): SliceCompletionHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "slice.complete") {
    throw new Error("Slice completion requires a slice.complete Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  const operation = getDb().prepare(`
    SELECT created_at FROM workflow_operations WHERE operation_id = :operation_id
  `).get({ ":operation_id": context.operationId }) as Record<string, unknown> | undefined;
  if (!operation) throw new Error("Slice completion operation timestamp is missing");
  const completedAt = String(operation["created_at"]);

  const milestone = getDb().prepare(`
    SELECT milestone.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": slice.milestoneId }) as Record<string, unknown> | undefined;
  if (!milestone) throw new SliceLifecycleValidationError(`milestone not found: ${slice.milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(String(milestone["legacy_status"]));
  if (!milestoneStatus || milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`cannot complete slice in a closed milestone: ${slice.milestoneId}`);
  }
  if (!milestone["lifecycle_id"] || !milestone["lifecycle_status"]) {
    throw new SliceLifecycleValidationError("Slice completion requires canonical Milestone lifecycle authority");
  }
  requireMatchingShadow({
    taskId: null,
    legacyStatus: String(milestone["legacy_status"]),
    lifecycleId: String(milestone["lifecycle_id"]),
    lifecycleStatus: String(milestone["lifecycle_status"]) as CanonicalLifecycleStatus,
  }, `Milestone ${slice.milestoneId}`);

  const target = getDb().prepare(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND slice.id = :slice_id
  `).get({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Record<string, unknown> | undefined;
  if (!target) throw new SliceLifecycleValidationError(`slice not found: ${slice.milestoneId}/${slice.sliceId}`);
  if (!target["lifecycle_id"] || !target["lifecycle_status"]) {
    throw new SliceLifecycleValidationError("Slice completion requires canonical Slice lifecycle authority");
  }
  const sliceState: HierarchyRow = {
    taskId: null,
    legacyStatus: String(target["legacy_status"]),
    lifecycleId: String(target["lifecycle_id"]),
    lifecycleStatus: String(target["lifecycle_status"]) as CanonicalLifecycleStatus,
  };
  requireMatchingShadow(sliceState, `Slice ${slice.sliceId}`);
  if (sliceState.lifecycleStatus === "completed" || sliceState.lifecycleStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} is already terminal`);
  }

  const tasks = getDb().prepare(`
    SELECT task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task' AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id AND task.slice_id = :slice_id
    ORDER BY task.sequence, task.id
  `).all({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Array<Record<string, unknown>>;
  if (tasks.length === 0) throw new SliceLifecycleValidationError(`no tasks found for slice ${slice.sliceId}`);

  const completedTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const proofs: SliceCompletionProof[] = [];
  for (const task of tasks) {
    const taskId = String(task["task_id"]);
    const lifecycleId = task["lifecycle_id"] ? String(task["lifecycle_id"]) : "";
    if (!lifecycleId || !task["lifecycle_status"]) {
      throw new SliceLifecycleValidationError(`Task ${taskId} is missing canonical lifecycle authority`);
    }
    if (runningAttempt(lifecycleId)) {
      throw new SliceLifecycleValidationError(`Task ${taskId} has a running Attempt descendant`);
    }
    const state: HierarchyRow = {
      taskId,
      legacyStatus: String(task["legacy_status"]),
      lifecycleId,
      lifecycleStatus: String(task["lifecycle_status"]) as CanonicalLifecycleStatus,
    };
    requireMatchingShadow(state, `Task ${taskId}`);
    const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
    if (legacyStatus === "completed" && state.lifecycleStatus === "completed") {
      const proof = currentCompletionProof(lifecycleId, taskId);
      if (!proof) {
        throw new SliceLifecycleValidationError(`Task ${taskId} lacks current passing Technical Verdict and verification evidence`);
      }
      completedTaskIds.push(taskId);
      proofs.push(proof);
    } else if (legacyStatus === "cancelled" && state.lifecycleStatus === "cancelled") {
      cancelledTaskIds.push(taskId);
    } else {
      throw new SliceLifecycleValidationError(`Task ${taskId} is not terminal with canonical and legacy parity`);
    }
  }

  const sliceLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "slice", ...slice, lifecycleStatus: "completed",
  });
  const updated = getDb().prepare(`
    UPDATE slices SET status = 'complete', completed_at = :completed_at
    WHERE milestone_id = :milestone_id AND id = :slice_id
  `).run({
    ":completed_at": completedAt,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice completion must update exactly one compatibility Slice");
  }

  const readiness = input.operationalReadiness.trim();
  const q8Verdict = readiness ? "pass" : "omitted";
  const rationale = readiness
    ? "Operational Readiness section populated in slice summary"
    : "Operational Readiness section left empty — recorded as omitted";
  const q8Rows = getDb().prepare(`
    SELECT status FROM quality_gates
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
  `).all({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Array<Record<string, unknown>>;
  if (q8Rows.length !== 1 || String(q8Rows[0]!["status"]) !== "pending") {
    throw new SliceLifecycleValidationError("Slice completion requires exactly one pending Q8 quality gate");
  }
  const gate = getDb().prepare(`
    UPDATE quality_gates
    SET status = 'complete', verdict = :verdict, rationale = :rationale,
        findings = :findings, evaluated_at = :evaluated_at
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL) AND status = 'pending'
  `).run({
    ":verdict": q8Verdict,
    ":rationale": rationale,
    ":findings": readiness,
    ":evaluated_at": completedAt,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  });
  if (Number((gate as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice completion must close exactly one pending Q8 quality gate");
  }
  getDb().prepare(`
    INSERT INTO gate_runs (
      trace_id, turn_id, gate_id, gate_type, milestone_id, slice_id,
      outcome, failure_class, rationale, findings, attempt, max_attempts,
      retryable, evaluated_at
    ) VALUES (
      :trace_id, 'gate:Q8:slice', 'Q8', 'quality-gate', :milestone_id, :slice_id,
      :outcome, :failure_class, :rationale, :findings, 1, 1, 0, :evaluated_at
    )
  `).run({
    ":trace_id": `quality-gate:${slice.milestoneId}:${slice.sliceId}`,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":outcome": q8Verdict === "pass" ? "pass" : "manual-attention",
    ":failure_class": q8Verdict === "pass" ? "none" : "manual-attention",
    ":rationale": rationale,
    ":findings": readiness,
    ":evaluated_at": completedAt,
  });

  const allSlicesClosed = (getDb().prepare(`
    SELECT status FROM slices WHERE milestone_id = :milestone_id
  `).all({ ":milestone_id": slice.milestoneId }) as Array<Record<string, unknown>>)
    .every((row) => {
      const status = normalizeLegacyLifecycleStatus(String(row["status"]));
      return status === "completed" || status === "cancelled";
    });
  if (String(milestone["legacy_status"]) === "planned" && allSlicesClosed) {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: slice.milestoneId, lifecycleStatus: "in_progress",
    });
    getDb().prepare(`UPDATE milestones SET status = 'active' WHERE id = :milestone_id`)
      .run({ ":milestone_id": slice.milestoneId });
  }

  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "slice", ...slice }),
    ...tasks.map((task) => readLifecycleShadowComparison(context, {
      itemKind: "task",
      ...slice,
      taskId: String(task["task_id"]),
    })),
  ];
  if (shadows.some((shadow) => shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Slice completion did not converge canonical and legacy lifecycle state");
  }
  return {
    sliceLifecycleId: sliceLifecycle.lifecycleId,
    completedAt,
    completedTaskIds,
    cancelledTaskIds,
    proofs,
    q8Verdict,
    shadows,
  };
}

function loadPlan(slice: SliceIdentity): {
  slice: HierarchyRow;
  normalizedSliceStatus: CanonicalLifecycleStatus;
  tasks: PlannedTask[];
} {
  const milestone = getDb().prepare(`
    SELECT milestone.status AS legacy_status,
           lifecycle.lifecycle_status AS lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": slice.milestoneId }) as Record<string, unknown> | undefined;
  if (!milestone) throw new SliceLifecycleValidationError(`milestone not found: ${slice.milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(String(milestone["legacy_status"]));
  if (!milestoneStatus) throw new SliceLifecycleValidationError(`Milestone ${slice.milestoneId} has an unknown legacy status`);
  if (milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`Cannot cancel a Slice in terminal Milestone ${slice.milestoneId}`);
  }
  if (milestone["lifecycle_status"]) {
    const parentShadow = compareLifecycleShadow(
      String(milestone["legacy_status"]),
      String(milestone["lifecycle_status"]),
    );
    if (parentShadow.kind !== "match" && parentShadow.kind !== "semantic_match_exact_delta") {
      throw new SliceLifecycleValidationError(`Milestone ${slice.milestoneId} canonical and legacy lifecycle mismatch`);
    }
    const canonicalParent = String(milestone["lifecycle_status"]);
    if (canonicalParent === "completed" || canonicalParent === "cancelled") {
      throw new SliceLifecycleValidationError(`Cannot cancel a Slice under terminal canonical Milestone ${slice.milestoneId}`);
    }
  }

  const sliceRow = getDb().prepare(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
     AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND slice.id = :slice_id
  `).get({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Record<string, unknown> | undefined;
  if (!sliceRow) throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} not found in milestone ${slice.milestoneId}`);
  const target: HierarchyRow = {
    taskId: null,
    legacyStatus: String(sliceRow["legacy_status"]),
    lifecycleId: sliceRow["lifecycle_id"] ? String(sliceRow["lifecycle_id"]) : null,
    lifecycleStatus: sliceRow["lifecycle_status"]
      ? String(sliceRow["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
  const normalizedSliceStatus = normalizeLegacyLifecycleStatus(target.legacyStatus);
  if (!normalizedSliceStatus) throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} has an unknown legacy status`);
  if (normalizedSliceStatus === "completed") {
    throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} is already complete — cannot skip.`);
  }
  requireMatchingShadow(target, `Slice ${slice.sliceId}`);

  const taskRows = getDb().prepare(`
    SELECT task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id AND task.slice_id = :slice_id
    ORDER BY task.sequence, task.id
  `).all({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Array<Record<string, unknown>>;
  const tasks = taskRows.map((row): PlannedTask => {
    const taskId = String(row["task_id"]);
    const task = {
      taskId,
      legacyStatus: String(row["legacy_status"]),
      lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
      lifecycleStatus: row["lifecycle_status"]
        ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
        : null,
    };
    const normalizedLegacyStatus = normalizeLegacyLifecycleStatus(task.legacyStatus);
    if (!normalizedLegacyStatus) throw new SliceLifecycleValidationError(`Task ${taskId} has an unknown legacy status`);
    const healsCancelledCompatibility = normalizedSliceStatus === "cancelled" &&
      task.lifecycleStatus === "cancelled" &&
      normalizedLegacyStatus !== "completed";
    if (!healsCancelledCompatibility) requireMatchingShadow(task, `Task ${task.taskId}`);
    const running = task.lifecycleId ? runningAttempt(task.lifecycleId) : null;
    if (task.lifecycleStatus === "in_progress" && !running) {
      throw new SliceLifecycleValidationError(`In-progress Task ${task.taskId} cancellation requires its running Attempt`);
    }
    if (task.lifecycleStatus !== "in_progress" && running) {
      throw new SliceLifecycleValidationError(`Only an in-progress Task may own a running Attempt (${task.taskId})`);
    }
    return {
      ...task,
      normalizedLegacyStatus,
      running,
      preserve: normalizedLegacyStatus === "completed" || normalizedLegacyStatus === "cancelled",
    };
  });
  return { slice: target, normalizedSliceStatus, tasks };
}

function updateLegacyTask(slice: SliceIdentity, taskId: string): void {
  const updated = getDb().prepare(`
    UPDATE tasks SET status = 'skipped', completed_at = NULL
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
  `).run({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":task_id": taskId,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice cancellation must update exactly one compatibility Task");
  }
}

export function cancelSliceHierarchy(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { reason: string },
): SliceCancellationHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "slice.cancel") {
    throw new Error("Slice cancellation requires a slice.cancel Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  const reason = requireText(input.reason, "reason");
  const plan = loadPlan(slice);
  const cancelledTaskIds: string[] = [];
  const preservedTaskIds: string[] = [];
  const interruptions: SliceCancellationInterruption[] = [];

  for (const task of plan.tasks) {
    if (task.preserve) {
      if (!task.lifecycleId) {
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          ...slice,
          taskId: task.taskId,
          lifecycleStatus: task.normalizedLegacyStatus,
        });
      }
      preservedTaskIds.push(task.taskId);
      continue;
    }
    if (task.running) {
      const endedAt = new Date().toISOString();
      const result = settleAttemptWithResult(context, {
        attemptId: task.running.attemptId,
        outcome: "interrupted",
        failureClass: "slice-cancelled",
        summary: reason,
        output: { reason, slice },
        endedAt,
        cancellation: true,
      });
      terminalizeTaskExecutionDispatch(context, {
        dispatchId: task.running.dispatchId,
        workerId: task.running.workerId,
        milestoneLeaseToken: task.running.milestoneLeaseToken,
        outcome: "interrupted",
        endedAt,
        cancellation: true,
      });
      const kernel = appendKernelCheckpoint(context, {
        lifecycleId: task.lifecycleId!,
        attemptId: task.running.attemptId,
        nextStage: "route",
        previousKernelCheckpointId: task.running.kernelCheckpointId,
      });
      interruptions.push({
        taskId: task.taskId,
        attemptId: task.running.attemptId,
        resultId: result.resultId,
        kernelCheckpointId: kernel.kernelCheckpointId,
        dispatchId: task.running.dispatchId,
      });
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      ...slice,
      taskId: task.taskId,
      lifecycleStatus: "cancelled",
      ...(!task.lifecycleId ? { adoptedFromStatus: task.normalizedLegacyStatus } : {}),
    });
    updateLegacyTask(slice, task.taskId);
    cancelledTaskIds.push(task.taskId);
  }

  const sliceLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "slice",
    ...slice,
    lifecycleStatus: "cancelled",
    ...(!plan.slice.lifecycleId ? { adoptedFromStatus: plan.normalizedSliceStatus } : {}),
  });
  const updated = getDb().prepare(`
    UPDATE slices SET status = 'skipped', completed_at = NULL
    WHERE milestone_id = :milestone_id AND id = :slice_id
  `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice cancellation must update exactly one compatibility Slice");
  }

  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "slice", ...slice }),
    ...plan.tasks.map((task) => readLifecycleShadowComparison(context, {
      itemKind: "task",
      ...slice,
      taskId: task.taskId,
    })),
  ];
  if (shadows.some((shadow) =>
    shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Slice cancellation did not converge canonical and legacy lifecycle state");
  }
  return {
    sliceLifecycleId: sliceLifecycle.lifecycleId,
    wasAlreadySkipped: plan.normalizedSliceStatus === "cancelled",
    cancelledTaskIds,
    preservedTaskIds,
    interruptions,
    shadows,
  };
}

export function reopenSliceHierarchy(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { reason: string },
): SliceReopenHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "slice.reopen") {
    throw new Error("Slice reopen requires a slice.reopen Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  requireText(input.reason, "reason");
  const milestone = getDb().prepare(`
    SELECT milestone.status AS legacy_status, lifecycle.lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": slice.milestoneId }) as Record<string, unknown> | undefined;
  if (!milestone) throw new SliceLifecycleValidationError(`milestone not found: ${slice.milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(String(milestone["legacy_status"]));
  if (!milestoneStatus || milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`cannot reopen slice in a closed milestone: ${slice.milestoneId}`);
  }
  if (milestone["lifecycle_status"]) {
    if (["completed", "cancelled"].includes(String(milestone["lifecycle_status"]))) {
      throw new SliceLifecycleValidationError("cannot reopen slice under a terminal canonical milestone");
    }
    const shadow = compareLifecycleShadow(String(milestone["legacy_status"]), String(milestone["lifecycle_status"]));
    if (shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta") {
      throw new SliceLifecycleValidationError("Milestone canonical and legacy lifecycle mismatch");
    }
  }
  const sliceRow = getDb().prepare(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND slice.id = :slice_id
  `).get({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Record<string, unknown> | undefined;
  if (!sliceRow) throw new SliceLifecycleValidationError(`slice not found: ${slice.milestoneId}/${slice.sliceId}`);
  const legacySliceStatus = normalizeLegacyLifecycleStatus(String(sliceRow["legacy_status"]));
  if (!legacySliceStatus) throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} has an unknown legacy status`);
  const sliceState: HierarchyRow = {
    taskId: null,
    legacyStatus: String(sliceRow["legacy_status"]),
    lifecycleId: sliceRow["lifecycle_id"] ? String(sliceRow["lifecycle_id"]) : null,
    lifecycleStatus: sliceRow["lifecycle_status"] ? String(sliceRow["lifecycle_status"]) as CanonicalLifecycleStatus : null,
  };
  requireMatchingShadow(sliceState, `Slice ${slice.sliceId}`);
  const tasks = getDb().prepare(`
    SELECT task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task' AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id AND task.slice_id = :slice_id
    ORDER BY task.sequence, task.id
  `).all({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Array<Record<string, unknown>>;
  for (const task of tasks) {
    const lifecycleId = task["lifecycle_id"] ? String(task["lifecycle_id"]) : null;
    if (lifecycleId && runningAttempt(lifecycleId)) {
      throw new SliceLifecycleValidationError(`Task ${String(task["task_id"])} has a running Attempt descendant`);
    }
    const state: HierarchyRow = {
      taskId: String(task["task_id"]),
      legacyStatus: String(task["legacy_status"]),
      lifecycleId,
      lifecycleStatus: task["lifecycle_status"] ? String(task["lifecycle_status"]) as CanonicalLifecycleStatus : null,
    };
    requireMatchingShadow(state, `Task ${state.taskId}`);
    const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
    if (legacyStatus !== "completed" && legacyStatus !== "cancelled") {
      throw new SliceLifecycleValidationError(
        `slice ${slice.sliceId} is not complete because Task ${state.taskId} is not terminal`,
      );
    }
  }
  const terminalSlice = legacySliceStatus === "completed" || legacySliceStatus === "cancelled";
  if (!terminalSlice && (sliceState.lifecycleId || tasks.length === 0)) {
    throw new SliceLifecycleValidationError(`slice ${slice.sliceId} is not complete — nothing to reopen`);
  }
  const reopenedTaskIds: string[] = [];
  for (const task of tasks) {
    const taskId = String(task["task_id"]);
    const legacyStatus = normalizeLegacyLifecycleStatus(String(task["legacy_status"]))!;
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", ...slice, taskId, lifecycleStatus: "ready",
      ...(!task["lifecycle_id"] ? { adoptedFromStatus: legacyStatus } : {}),
    });
    const updated = getDb().prepare(`
      UPDATE tasks SET status = 'pending', completed_at = NULL
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
    `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId, ":task_id": taskId });
    if (Number((updated as { changes?: number }).changes ?? 0) !== 1) throw new Error("Slice reopen must update one Task");
    reopenedTaskIds.push(taskId);
  }
  const sliceLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "slice", ...slice, lifecycleStatus: "ready",
    ...(!sliceState.lifecycleId ? { adoptedFromStatus: legacySliceStatus } : {}),
  });
  const updated = getDb().prepare(`
    UPDATE slices SET status = 'in_progress', completed_at = NULL
    WHERE milestone_id = :milestone_id AND id = :slice_id
  `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) throw new Error("Slice reopen must update one Slice");
  const q8Rows = getDb().prepare(`
    SELECT 1 FROM quality_gates
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
  `).all({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId });
  if (q8Rows.length > 1) {
    throw new SliceLifecycleValidationError("Slice reopen found multiple Q8 quality gates");
  }
  const q8Write = q8Rows.length === 0
    ? getDb().prepare(`
        INSERT INTO quality_gates (
          milestone_id, slice_id, gate_id, scope, task_id, status
        ) VALUES (
          :milestone_id, :slice_id, 'Q8', 'slice', '', 'pending'
        )
      `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId })
    : getDb().prepare(`
        UPDATE quality_gates
        SET status = 'pending', verdict = '', rationale = '',
            findings = '', evaluated_at = NULL
        WHERE milestone_id = :milestone_id AND slice_id = :slice_id
          AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
      `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId });
  if (Number((q8Write as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice reopen must establish exactly one pending Q8 quality gate");
  }
  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "slice", ...slice }),
    ...reopenedTaskIds.map((taskId) => readLifecycleShadowComparison(context, { itemKind: "task", ...slice, taskId })),
  ];
  if (shadows.some((shadow) => shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Slice reopen did not converge canonical and legacy lifecycle state");
  }
  return { sliceLifecycleId: sliceLifecycle.lifecycleId, reopenedTaskIds, shadows };
}
