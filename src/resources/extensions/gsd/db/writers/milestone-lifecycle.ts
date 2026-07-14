// Project/App: gsd-pi
// File Purpose: Context-bound, database-authoritative Milestone lifecycle writes.

import type { DomainOperationContext } from "../domain-operation.js";
import {
  readMilestoneCloseoutReadiness,
  type MilestoneCloseoutBlocker,
} from "../milestone-closeout-readiness.js";
import {
  compareLifecycleShadow,
  normalizeLegacyLifecycleStatus,
  type CanonicalLifecycleStatus,
} from "../lifecycle-shadow-comparison.js";
import { getDb } from "../engine.js";
import {
  adoptOrTransitionLifecycle,
  readLifecycleShadowComparison,
  requireActiveDomainOperationContext,
  type LifecycleShadowRecord,
} from "./lifecycle-commands.js";

export interface MilestoneCompletionHierarchyInput {
  milestoneId: string;
  sourceRevision: string;
}

export interface MilestoneCompletionCancellationAuthorization {
  [key: string]: string | null;
  itemKind: "slice" | "task";
  sliceId: string;
  taskId: string | null;
  lifecycleId: string;
  waiverId: string;
  dispositionId: string | null;
}

export interface MilestoneCompletionHierarchyResult {
  milestoneLifecycleId: string;
  completedAt: string;
  validationEventId: string;
  validationRevision: number;
  completedSliceIds: string[];
  cancelledSliceIds: string[];
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  cancellationAuthorizations: MilestoneCompletionCancellationAuthorization[];
  waiverIds: string[];
  dispositionIds: string[];
  shadow: LifecycleShadowRecord;
}

export class MilestoneLifecycleValidationError extends Error {}

interface HierarchyRow {
  itemKind: "milestone" | "slice" | "task";
  sliceId: string | null;
  taskId: string | null;
  legacyStatus: string;
  lifecycleId: string | null;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

interface CancellationAuthorizationRow {
  waiver_id: string;
  disposition_id: string | null;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MilestoneLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function requireOperationTimestamp(context: Readonly<DomainOperationContext>): string {
  const operation = getDb().prepare(`
    SELECT created_at
    FROM workflow_operations
    WHERE operation_id = :operation_id
      AND project_id = :project_id
  `).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  }) as Record<string, unknown> | undefined;
  const completedAt = String(operation?.["created_at"] ?? "");
  if (!operation || !Number.isFinite(Date.parse(completedAt))) {
    throw new Error("Milestone completion operation timestamp is missing or invalid");
  }
  return completedAt;
}

function blockerSummary(blockers: MilestoneCloseoutBlocker[]): string {
  return blockers.map((blocker) => blocker.kind).join(", ");
}

function requireMatchingShadow(row: HierarchyRow, identity: string): void {
  if (!row.lifecycleId || !row.lifecycleStatus) {
    throw new MilestoneLifecycleValidationError(`${identity} is missing canonical lifecycle authority`);
  }
  const comparison = compareLifecycleShadow(row.legacyStatus, row.lifecycleStatus);
  if (comparison.kind !== "match" && comparison.kind !== "semantic_match_exact_delta") {
    throw new MilestoneLifecycleValidationError(
      `${identity} canonical and legacy lifecycle mismatch`,
    );
  }
}

function requireTerminalState(row: HierarchyRow, identity: string): "completed" | "cancelled" {
  requireMatchingShadow(row, identity);
  const legacyStatus = normalizeLegacyLifecycleStatus(row.legacyStatus);
  if (legacyStatus === "completed" && row.lifecycleStatus === "completed") return "completed";
  if (legacyStatus === "cancelled" && row.lifecycleStatus === "cancelled") return "cancelled";
  throw new MilestoneLifecycleValidationError(
    `${identity} is not terminal with canonical and legacy parity`,
  );
}

function requireNoActiveAttempts(milestoneId: string): void {
  const active = getDb().prepare(`
    SELECT lifecycle.item_kind, lifecycle.slice_id, lifecycle.task_id,
           attempt.attempt_id, attempt.attempt_state
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.project_id = lifecycle.project_id
     AND attempt.lifecycle_id = lifecycle.lifecycle_id
    WHERE lifecycle.milestone_id = :milestone_id
      AND attempt.attempt_state != 'settled'
    ORDER BY lifecycle.item_kind, lifecycle.slice_id, lifecycle.task_id,
             attempt.attempt_number, attempt.attempt_id
    LIMIT 1
  `).get({ ":milestone_id": milestoneId }) as Record<string, unknown> | undefined;
  if (!active) return;
  let suffix = "";
  if (active["task_id"]) {
    suffix = `/${String(active["slice_id"])}/${String(active["task_id"])}`;
  } else if (active["slice_id"]) {
    suffix = `/${String(active["slice_id"])}`;
  }
  throw new MilestoneLifecycleValidationError(
    `${String(active["item_kind"])} ${milestoneId}${suffix} has active ` +
      `${String(active["attempt_state"])} Attempt ${String(active["attempt_id"])}`,
  );
}

function currentSliceCancellationAuthorization(
  context: Readonly<DomainOperationContext>,
  row: HierarchyRow,
  milestoneId: string,
  completedAt: string,
): MilestoneCompletionCancellationAuthorization {
  const sliceId = row.sliceId!;
  const authorizations = getDb().prepare(`
    SELECT waiver.waiver_id, NULL AS disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_operations operation
      ON operation.operation_id = waiver.operation_id
     AND operation.project_id = waiver.project_id
     AND operation.operation_type = 'slice.cancel'
    JOIN workflow_domain_events cancelled
      ON cancelled.operation_id = waiver.operation_id
     AND cancelled.project_id = waiver.project_id
     AND cancelled.event_type = 'slice.cancelled'
     AND cancelled.entity_type = 'slice'
     AND cancelled.entity_id = :entity_id
     AND json_extract(cancelled.payload_json, '$.sliceLifecycleId') = waiver.lifecycle_id
     AND json_extract(cancelled.payload_json, '$.waiverId') = waiver.waiver_id
    WHERE waiver.project_id = :project_id
      AND waiver.lifecycle_id = :lifecycle_id
      AND waiver.waiver_status = 'active'
      AND waiver.requirement_id IS NULL
      AND waiver.blocker_id IS NULL
      AND waiver.scope = :scope
      AND (waiver.expires_at IS NULL OR waiver.expires_at > :completed_at)
    ORDER BY waiver.project_revision DESC, waiver.waiver_id
  `).all({
    ":entity_id": `${milestoneId}/${sliceId}`,
    ":project_id": context.projectId,
    ":lifecycle_id": row.lifecycleId,
    ":scope": `slice:${milestoneId}/${sliceId}`,
    ":completed_at": completedAt,
  }) as unknown as CancellationAuthorizationRow[];
  if (authorizations.length !== 1) {
    throw new MilestoneLifecycleValidationError(
      `Cancelled Slice ${sliceId} requires exactly one current cancellation Waiver`,
    );
  }
  return {
    itemKind: "slice",
    sliceId,
    taskId: null,
    lifecycleId: row.lifecycleId!,
    waiverId: authorizations[0]!.waiver_id,
    dispositionId: null,
  };
}

function currentTaskCancellationAuthorization(
  context: Readonly<DomainOperationContext>,
  row: HierarchyRow,
  milestoneId: string,
  completedAt: string,
): MilestoneCompletionCancellationAuthorization[] {
  const sliceId = row.sliceId!;
  const taskId = row.taskId!;
  const authorizations = getDb().prepare(`
    SELECT waiver.waiver_id, disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_operations waiver_operation
      ON waiver_operation.operation_id = waiver.operation_id
     AND waiver_operation.project_id = waiver.project_id
     AND waiver_operation.operation_type = 'task.waiver.grant'
    JOIN workflow_requirement_dispositions disposition
      ON disposition.project_id = waiver.project_id
     AND disposition.requirement_id = waiver.requirement_id
     AND disposition.waiver_id = waiver.waiver_id
     AND disposition.disposition = 'waived'
    JOIN workflow_operations disposition_operation
      ON disposition_operation.operation_id = disposition.operation_id
     AND disposition_operation.project_id = disposition.project_id
     AND disposition_operation.operation_type = 'task.disposition.record'
    WHERE waiver.project_id = :project_id
      AND waiver.lifecycle_id = :lifecycle_id
      AND waiver.waiver_status = 'active'
      AND waiver.scope = :scope
      AND (waiver.expires_at IS NULL OR waiver.expires_at > :completed_at)
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = disposition.disposition_id
      )
    ORDER BY waiver.project_revision DESC, waiver.waiver_id
  `).all({
    ":project_id": context.projectId,
    ":lifecycle_id": row.lifecycleId,
    ":scope": `${milestoneId}/${sliceId}/${taskId} cancellation`,
    ":completed_at": completedAt,
  }) as unknown as CancellationAuthorizationRow[];
  if (authorizations.length === 0) {
    throw new MilestoneLifecycleValidationError(
      `Cancelled Task ${sliceId}/${taskId} requires a current Waiver disposition`,
    );
  }
  return authorizations.map((authorization) => ({
    itemKind: "task",
    sliceId,
    taskId,
    lifecycleId: row.lifecycleId!,
    waiverId: authorization.waiver_id,
    dispositionId: authorization.disposition_id!,
  }));
}

function loadMilestone(context: Readonly<DomainOperationContext>, milestoneId: string): HierarchyRow {
  const row = getDb().prepare(`
    SELECT milestone.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
     AND lifecycle.task_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new MilestoneLifecycleValidationError(`milestone not found: ${milestoneId}`);
  return {
    itemKind: "milestone",
    sliceId: null,
    taskId: null,
    legacyStatus: String(row["legacy_status"]),
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"]
      ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
}

function loadSlices(context: Readonly<DomainOperationContext>, milestoneId: string): HierarchyRow[] {
  return getDb().prepare(`
    SELECT slice.id AS slice_id, slice.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
     AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id
    ORDER BY slice.sequence, slice.id
  `).all({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }).map((row) => ({
    itemKind: "slice" as const,
    sliceId: String(row["slice_id"]),
    taskId: null,
    legacyStatus: String(row["legacy_status"]),
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"]
      ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  }));
}

function loadTasks(context: Readonly<DomainOperationContext>, milestoneId: string): HierarchyRow[] {
  return getDb().prepare(`
    SELECT task.slice_id, task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
    ORDER BY task.slice_id, task.sequence, task.id
  `).all({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }).map((row) => ({
    itemKind: "task" as const,
    sliceId: String(row["slice_id"]),
    taskId: String(row["task_id"]),
    legacyStatus: String(row["legacy_status"]),
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"]
      ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  }));
}

export function completeMilestoneHierarchy(
  context: Readonly<DomainOperationContext>,
  input: MilestoneCompletionHierarchyInput,
): MilestoneCompletionHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "milestone.complete") {
    throw new Error("Milestone completion requires a milestone.complete Domain Operation");
  }
  const milestoneId = requireText(input.milestoneId, "milestoneId");
  const sourceRevision = requireText(input.sourceRevision, "sourceRevision");
  const completedAt = requireOperationTimestamp(context);
  const milestone = loadMilestone(context, milestoneId);
  requireMatchingShadow(milestone, `Milestone ${milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(milestone.legacyStatus);
  if (milestoneStatus !== "pending" && milestoneStatus !== "in_progress") {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} is not open for completion`,
    );
  }
  if (milestone.lifecycleStatus !== "ready" && milestone.lifecycleStatus !== "in_progress") {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} canonical lifecycle is not ready for completion`,
    );
  }

  const readiness = readMilestoneCloseoutReadiness({ milestoneId, sourceRevision });
  if (!readiness.ready) {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} canonical validation is not current (${blockerSummary(readiness.blockers)})`,
    );
  }

  const slices = loadSlices(context, milestoneId);
  if (slices.length === 0) {
    throw new MilestoneLifecycleValidationError(`no slices found for Milestone ${milestoneId}`);
  }
  const tasks = loadTasks(context, milestoneId);
  requireNoActiveAttempts(milestoneId);

  const completedSliceIds: string[] = [];
  const cancelledSliceIds: string[] = [];
  const completedTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const cancellationAuthorizations: MilestoneCompletionCancellationAuthorization[] = [];
  const cancelledSlices = new Set<string>();

  for (const slice of slices) {
    const state = requireTerminalState(slice, `Slice ${slice.sliceId}`);
    if (state === "completed") {
      completedSliceIds.push(slice.sliceId!);
    } else {
      cancelledSliceIds.push(slice.sliceId!);
      cancelledSlices.add(slice.sliceId!);
      cancellationAuthorizations.push(
        currentSliceCancellationAuthorization(context, slice, milestoneId, completedAt),
      );
    }
  }

  for (const task of tasks) {
    const taskIdentity = `${task.sliceId}/${task.taskId}`;
    const state = requireTerminalState(task, `Task ${taskIdentity}`);
    if (state === "completed") {
      completedTaskIds.push(taskIdentity);
    } else {
      cancelledTaskIds.push(taskIdentity);
      if (!cancelledSlices.has(task.sliceId!)) {
        cancellationAuthorizations.push(
          ...currentTaskCancellationAuthorization(context, task, milestoneId, completedAt),
        );
      }
    }
  }

  const lifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "milestone",
    milestoneId,
    lifecycleStatus: "completed",
    occurredAt: completedAt,
  });
  const updated = getDb().prepare(`
    UPDATE milestones
    SET status = 'complete', completed_at = :completed_at
    WHERE id = :milestone_id AND status = :expected_status
  `).run({
    ":completed_at": completedAt,
    ":milestone_id": milestoneId,
    ":expected_status": milestone.legacyStatus,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Milestone completion must update exactly one compatibility Milestone");
  }

  const shadow = readLifecycleShadowComparison(context, {
    itemKind: "milestone",
    milestoneId,
  });
  if (shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta") {
    throw new Error("Milestone completion did not converge canonical and legacy lifecycle state");
  }
  const waiverIds = cancellationAuthorizations.map((authorization) => authorization.waiverId);
  const dispositionIds = cancellationAuthorizations.flatMap((authorization) =>
    authorization.dispositionId ? [authorization.dispositionId] : []
  );
  return {
    milestoneLifecycleId: lifecycle.lifecycleId,
    completedAt,
    validationEventId: readiness.validationEventId,
    validationRevision: readiness.validationRevision,
    completedSliceIds,
    cancelledSliceIds,
    completedTaskIds,
    cancelledTaskIds,
    cancellationAuthorizations,
    waiverIds,
    dispositionIds,
    shadow,
  };
}
