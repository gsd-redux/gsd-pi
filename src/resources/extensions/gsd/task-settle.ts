// Project/App: gsd-pi
// File Purpose: Operator Task settle — human-gated, dry-run-first reconciliation
// of a running Task Attempt whose executor is gone, plus optional lifecycle
// adopt after an interrupted Attempt (#1749).

import { executeDomainOperation } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { normalizeLegacyLifecycleStatus } from "./db/lifecycle-shadow-comparison.js";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { TASK_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import {
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "./task-execution-domain-operation.js";

export interface TaskSettleTask {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface TaskSettleRow {
  attemptId: string;
  currentStatus: string;
  targetStatus: "interrupted";
  rationale: string;
  leaseHeld: boolean;
}

export interface TaskLifecycleReconcileRow {
  currentStatus: string;
  targetStatus: "paused" | "ready" | "completed";
  rationale: string;
}

export interface TaskSettleProof {
  attemptId: string | null;
  note: string;
}

export interface TaskSettlePlan {
  task: TaskSettleTask;
  rows: TaskSettleRow[];
  lifecycleRows: TaskLifecycleReconcileRow[];
  proof: TaskSettleProof | null;
}

export interface TaskSettleOptions {
  reconcileLifecycle?: boolean;
}

interface RunningAttemptRow {
  attempt_id: string;
  worker_id: string | null;
  milestone_lease_token: number | null;
}

interface TaskLifecycleState {
  legacyStatus: string;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

function unitId(task: TaskSettleTask): string {
  return `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
}

function readRunningAttempts(task: TaskSettleTask): RunningAttemptRow[] {
  return getDb().prepare(`
    SELECT attempt.attempt_id, attempt.worker_id, attempt.milestone_lease_token
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND attempt.attempt_state = 'running'
    ORDER BY attempt.attempt_number DESC
  `).all({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as unknown as RunningAttemptRow[];
}

function readLeaseHeld(row: RunningAttemptRow, milestoneId: string): boolean {
  if (!row.worker_id || row.milestone_lease_token === null) return false;
  const lease = getDb().prepare(`
    SELECT 1 AS held
    FROM milestone_leases
    WHERE milestone_id = :milestone_id
      AND worker_id = :worker_id
      AND fencing_token = :fencing_token
      AND status = 'held'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).get({
    ":milestone_id": milestoneId,
    ":worker_id": row.worker_id,
    ":fencing_token": row.milestone_lease_token,
  });
  return lease !== undefined;
}

function requireSingleRunningAttempt(task: TaskSettleTask): RunningAttemptRow | null {
  const lifecycle = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  });
  if (!lifecycle) {
    throw new Error(
      `gsd_task_settle: unknown Task ${task.milestoneId}/${task.sliceId}/${task.taskId}`,
    );
  }
  const running = readRunningAttempts(task);
  if (running.length === 0) return null;
  if (running.length > 1) {
    throw new Error(
      `gsd_task_settle: ${task.milestoneId}/${task.sliceId}/${task.taskId} has ` +
      `${running.length} running Attempts; refusing to guess — settle them by Attempt id in the DB.`,
    );
  }
  return running[0];
}

function readTaskLifecycleState(task: TaskSettleTask): TaskLifecycleState {
  const state = getDb().prepare(`
    SELECT task.status AS task_status, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!state) {
    throw new Error(`gsd_task_settle: unknown Task ${unitId(task)}`);
  }
  return {
    legacyStatus: String(state["task_status"]),
    lifecycleStatus: state["lifecycle_status"]
      ? String(state["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
}

function readPassingProofAttempt(task: TaskSettleTask): string | null {
  const row = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
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
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as { attempt_id?: string } | undefined;
  return row?.attempt_id ? String(row.attempt_id) : null;
}

function planCompletionProof(
  task: TaskSettleTask,
  lifecycleRows: TaskLifecycleReconcileRow[],
): TaskSettleProof | null {
  if (!lifecycleRows.some((row) => row.targetStatus === "completed")) return null;
  const attemptId = readPassingProofAttempt(task);
  if (attemptId) {
    return {
      attemptId,
      note: `current passing Technical Verdict is on Attempt ${attemptId}`,
    };
  }
  return {
    attemptId: null,
    note: "no current passing Technical Verdict — gsd_slice_complete will still refuse until one is recorded",
  };
}

function targetCanonicalStatus(legacyStatus: string): "ready" | "completed" {
  const normalized = normalizeLegacyLifecycleStatus(legacyStatus);
  if (normalized === "pending") return "ready";
  if (normalized === "completed") return "completed";
  throw new Error(
    `gsd_task_settle: reconcileLifecycle only repairs a pending/complete mismatch ` +
    `after an interrupted Attempt; tasks.status is ${legacyStatus}`,
  );
}

function lifecycleTransitionSteps(
  from: CanonicalLifecycleStatus,
  to: "ready" | "completed",
): Array<"paused" | "ready" | "completed"> {
  if (from === to) return [];
  if (to === "ready") {
    if (from === "in_progress") return ["paused", "ready"];
    if (from === "paused") return ["ready"];
  } else if (from === "in_progress") {
    return ["completed"];
  }
  throw new Error(
    `gsd_task_settle: cannot reconcile lifecycle ${from} → ${to} after an interrupted Attempt`,
  );
}

function planLifecycleReconcile(
  task: TaskSettleTask,
  reason: string,
  hasRunningAttempt: boolean,
): TaskLifecycleReconcileRow[] {
  const latest = readLatestTaskAttempt(task);
  if (!hasRunningAttempt && latest?.outcome !== "interrupted") {
    throw new Error(
      "gsd_task_settle: reconcileLifecycle requires an interrupted Attempt " +
      "(settle the running Attempt first)",
    );
  }
  const state = readTaskLifecycleState(task);
  const target = targetCanonicalStatus(state.legacyStatus);
  const fromStatus = state.lifecycleStatus;
  if (fromStatus === null) {
    throw new Error(`gsd_task_settle: Task ${unitId(task)} has no canonical lifecycle to reconcile`);
  }
  if (fromStatus === target) return [];
  const steps = lifecycleTransitionSteps(fromStatus, target);
  const rows: TaskLifecycleReconcileRow[] = [];
  let current: CanonicalLifecycleStatus = fromStatus;
  for (const next of steps) {
    rows.push({
      currentStatus: current,
      targetStatus: next,
      rationale:
        `${reason} (adopt ${target} to match tasks.status=${state.legacyStatus}; ` +
        "SUMMARY projections are left in place)",
    });
    current = next;
  }
  return rows;
}

function applyLifecycleReconcile(
  invocation: ExecutionInvocation,
  task: TaskSettleTask,
  reason: string,
  rows: TaskLifecycleReconcileRow[],
): void {
  const entityId = unitId(task);
  for (const step of rows) {
    const idempotencyKey = `${invocation.idempotencyKey}:lifecycle:${step.targetStatus}`;
    const fence = readDomainOperationFence(idempotencyKey);
    executeDomainOperation({
      operationType: "task.lifecycle.reconcile",
      idempotencyKey,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: invocation.actorType,
      ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
      sourceTransport: invocation.sourceTransport,
      ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
      payload: {
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
        from: step.currentStatus,
        to: step.targetStatus,
        reason,
      },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
        lifecycleStatus: step.targetStatus,
      });
      return {
        events: [{
          eventType: "task.lifecycle.reconciled",
          entityType: "task",
          entityId,
          payload: {
            from: step.currentStatus,
            to: step.targetStatus,
            reason,
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `lifecycle/${entityId}`.toLowerCase(),
          projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        }],
      };
    });
  }
}

/**
 * Read-only settle plan: the exact Attempt and optional lifecycle rows an
 * apply would change. Zero rows of both kinds means an apply is a no-op.
 */
export function planTaskSettle(
  task: TaskSettleTask,
  reason: string,
  options: TaskSettleOptions = {},
): TaskSettlePlan {
  const attempt = requireSingleRunningAttempt(task);
  const lifecycleRows = options.reconcileLifecycle
    ? planLifecycleReconcile(task, reason, attempt !== null)
    : [];
  const proof = planCompletionProof(task, lifecycleRows);
  if (!attempt) return { task, rows: [], lifecycleRows, proof };
  const leaseHeld = readLeaseHeld(attempt, task.milestoneId);
  const rationale = leaseHeld
    ? reason
    : `${reason} (warning: the Attempt's milestone lease is no longer held — apply will refuse)`;
  return {
    task,
    rows: [{
      attemptId: attempt.attempt_id,
      currentStatus: "running",
      targetStatus: "interrupted",
      rationale,
      leaseHeld,
    }],
    lifecycleRows,
    proof,
  };
}

/**
 * Settle the Task's one running Attempt as `interrupted`. Only the own-lease
 * path is authorized: the worker that claimed the Attempt still holds its
 * milestone lease, so a plain attempt.settle is legal (V47 dispatch-scope
 * rule). A cross-process orphan whose lease is already gone belongs to the
 * replacement-lease interrupt path (#1748) — the next auto session settles it.
 *
 * Optional `reconcileLifecycle` then adopts ready/completed to match
 * tasks.status after that interrupted Attempt, without reopening or deleting
 * SUMMARY projections (#1749).
 */
export function applyTaskSettle(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  reason: string;
  reconcileLifecycle?: boolean;
}): TaskSettlePlan & { settled: boolean; reconciled: boolean; resultId?: string } {
  const plan = planTaskSettle(input.task, input.reason, {
    reconcileLifecycle: input.reconcileLifecycle,
  });
  let settled = false;
  let resultId: string | undefined;
  if (plan.rows.length > 0) {
    const row = plan.rows[0];
    if (!row.leaseHeld) {
      throw new Error(
        `gsd_task_settle: Attempt ${row.attemptId} was claimed under a milestone lease that is ` +
        "no longer held, so this operator settle is not authorized. Start `/gsd auto` — the next " +
        "session takes over the lease and interrupts the orphaned Attempt via the replacement-lease path.",
      );
    }
    const settlement = settleTaskAttempt({
      invocation: input.invocation,
      attemptId: row.attemptId,
      outcome: "interrupted",
      failureClass: "operator-settle",
      summary: input.reason,
      output: {
        operator: true,
        milestoneId: input.task.milestoneId,
        sliceId: input.task.sliceId,
        taskId: input.task.taskId,
        reason: input.reason,
      },
    });
    settled = true;
    resultId = settlement.resultId;
  }
  let lifecycleRows = plan.lifecycleRows;
  let proof = plan.proof;
  let reconciled = false;
  if (input.reconcileLifecycle) {
    const after = planTaskSettle(input.task, input.reason, { reconcileLifecycle: true });
    lifecycleRows = after.lifecycleRows;
    proof = after.proof;
    if (lifecycleRows.length > 0) {
      applyLifecycleReconcile(input.invocation, input.task, input.reason, lifecycleRows);
      reconciled = true;
    }
  }
  return {
    ...plan,
    lifecycleRows,
    proof,
    settled,
    reconciled,
    ...(resultId ? { resultId } : {}),
  };
}
