// Project/App: gsd-pi
// File Purpose: Operator Task settle — human-gated, dry-run-first reconciliation
// of a running Task Attempt whose executor is gone (#1749).

import { getDb } from "./db/engine.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { settleTaskAttempt } from "./task-execution-domain-operation.js";

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

export interface TaskSettlePlan {
  task: TaskSettleTask;
  rows: TaskSettleRow[];
}

interface RunningAttemptRow {
  attempt_id: string;
  worker_id: string | null;
  milestone_lease_token: number | null;
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

/**
 * Read-only settle plan: the exact Attempt rows an apply would change. Zero
 * rows means the Task has no running Attempt — an apply is a no-op.
 */
export function planTaskSettle(task: TaskSettleTask, reason: string): TaskSettlePlan {
  const attempt = requireSingleRunningAttempt(task);
  if (!attempt) return { task, rows: [] };
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
  };
}

/**
 * Settle the Task's one running Attempt as `interrupted`. Only the own-lease
 * path is authorized: the worker that claimed the Attempt still holds its
 * milestone lease, so a plain attempt.settle is legal (V47 dispatch-scope
 * rule). A cross-process orphan whose lease is already gone belongs to the
 * replacement-lease interrupt path (#1748) — the next auto session settles it.
 */
export function applyTaskSettle(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  reason: string;
}): TaskSettlePlan & { settled: boolean; resultId?: string } {
  const plan = planTaskSettle(input.task, input.reason);
  if (plan.rows.length === 0) return { ...plan, settled: false };
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
  return { ...plan, settled: true, resultId: settlement.resultId };
}
