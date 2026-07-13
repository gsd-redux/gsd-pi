// Project/App: gsd-pi
// File Purpose: Context-bound coordination dispatch writes for canonical Task Attempts.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface TaskDispatchIdentity {
  dispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  unitId: string;
}

export function activateTaskExecutionDispatch(
  context: Readonly<DomainOperationContext>,
  input: TaskDispatchIdentity,
): void {
  if (requireActiveDomainOperationContext(context) !== "attempt.claim") {
    throw new Error("Task dispatch activation requires an attempt.claim Domain Operation");
  }
  const parameters = {
    ":dispatch_id": input.dispatchId,
    ":worker_id": input.workerId,
    ":lease_token": input.milestoneLeaseToken,
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
    ":task_id": input.taskId,
    ":unit_id": input.unitId,
  };
  const activated = getDb().prepare(`
    UPDATE unit_dispatches
    SET status = 'running'
    WHERE id = :dispatch_id
      AND worker_id = :worker_id
      AND milestone_lease_token = :lease_token
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
      AND unit_type = 'execute-task'
      AND unit_id = :unit_id
      AND status = 'claimed'
  `).run(parameters);
  if (Number((activated as { changes?: number }).changes ?? 0) === 1) return;

  const alreadyRunning = getDb().prepare(`
    SELECT 1 AS present FROM unit_dispatches
    WHERE id = :dispatch_id
      AND worker_id = :worker_id
      AND milestone_lease_token = :lease_token
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
      AND unit_type = 'execute-task'
      AND unit_id = :unit_id
      AND status = 'running'
  `).get(parameters);
  if (!alreadyRunning) {
    throw new Error("Task Attempt claim must activate exactly one matching coordination dispatch");
  }
}

export function terminalizeTaskExecutionDispatch(
  context: Readonly<DomainOperationContext>,
  input: Pick<TaskDispatchIdentity, "dispatchId" | "workerId" | "milestoneLeaseToken"> & {
    outcome: "succeeded" | "failed" | "interrupted";
    endedAt: string;
    cancellation?: boolean;
  },
): void {
  const operationType = requireActiveDomainOperationContext(context);
  let requiredOperationType = "attempt.settle";
  if (input.cancellation) requiredOperationType = "task.cancel";
  else if (input.outcome === "interrupted") requiredOperationType = "attempt.interrupt";
  if (operationType !== requiredOperationType) {
    throw new Error(`Task dispatch terminalization requires an ${requiredOperationType} Domain Operation`);
  }
  let dispatchStatus = "failed";
  if (input.cancellation) dispatchStatus = "canceled";
  else if (input.outcome === "succeeded") dispatchStatus = "completed";
  const result = getDb().prepare(`
    UPDATE unit_dispatches
    SET status = :status, ended_at = :ended_at
    WHERE id = :dispatch_id
      AND worker_id = :worker_id
      AND milestone_lease_token = :lease_token
      AND status IN ('claimed', 'running')
  `).run({
    ":status": dispatchStatus,
    ":ended_at": input.endedAt,
    ":dispatch_id": input.dispatchId,
    ":worker_id": input.workerId,
    ":lease_token": input.milestoneLeaseToken,
  });
  if (Number((result as { changes?: number }).changes ?? 0) === 1) return;

  if (input.outcome === "interrupted") {
    const canceled = getDb().prepare(`
      SELECT 1 AS present FROM unit_dispatches
      WHERE id = :dispatch_id
        AND worker_id = :worker_id
        AND milestone_lease_token = :lease_token
        AND status = 'canceled'
    `).get({
      ":dispatch_id": input.dispatchId,
      ":worker_id": input.workerId,
      ":lease_token": input.milestoneLeaseToken,
    });
    if (canceled) return;
  }
  throw new Error("Task execution settlement did not terminalize exactly one coordination dispatch");
}
