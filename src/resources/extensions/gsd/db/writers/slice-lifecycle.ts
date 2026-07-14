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
  if (!milestone) throw new SliceLifecycleValidationError(`Milestone ${slice.milestoneId} not found`);
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
