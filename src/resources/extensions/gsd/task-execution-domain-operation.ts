// Project/App: gsd-pi
// File Purpose: Atomic, replay-safe Task execution Domain Operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import type { KernelStage } from "./db/kernel-stage-policy.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  claimRunningAttempt,
  readDomainOperationFence,
  settleAttemptWithResult,
  type ClaimRunningAttemptResult,
} from "./db/writers/lifecycle-commands.js";
import {
  activateTaskExecutionDispatch,
  terminalizeTaskExecutionDispatch,
} from "./db/writers/task-execution.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { ensureHostTechnicalCriterion } from "./task-verification-domain-operation.js";

export interface ClaimTaskAttemptInput {
  invocation: ExecutionInvocation;
  task: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
  };
  workerId: string;
  milestoneLeaseToken: number;
  coordinationDispatchId: number;
  retryOfAttemptId?: string;
}

export interface ClaimTaskAttemptReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  attemptId: string;
  attemptNumber: number;
}

export interface SettleTaskAttemptInput {
  invocation: ExecutionInvocation;
  attemptId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
  recovery?: {
    workerId: string;
    milestoneLeaseToken: number;
  };
}

export interface SettleTaskAttemptReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultId: string;
  nextStage: "verify" | "route";
}

export interface TaskExecutionAttemptSnapshot {
  attemptId: string;
  attemptNumber: number;
  retryOfAttemptId?: string;
  state: "running" | "settled";
  outcome?: "succeeded" | "failed" | "interrupted";
  nextStage: KernelStage;
  coordinationDispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
}

export function isTaskAttemptAwaitingVerification<
  T extends Pick<TaskExecutionAttemptSnapshot, "state" | "outcome" | "nextStage">,
>(attempt: T | null | undefined): attempt is T & {
  state: "settled";
  outcome: "succeeded";
  nextStage: "verify";
} {
  return attempt?.state === "settled" &&
    attempt.outcome === "succeeded" &&
    attempt.nextStage === "verify";
}

interface ClaimedAttemptRow {
  attempt_id: string;
  attempt_number: number;
}

interface AttemptExecutionRow {
  lifecycle_id: string;
  milestone_id: string;
  slice_id: string;
  task_id: string;
  kernel_checkpoint_id: string;
  coordination_dispatch_id: number;
  worker_id: string;
  milestone_lease_token: number;
}

interface SettledResultRow {
  result_id: string;
  outcome: SettleTaskAttemptInput["outcome"];
}

interface AttemptSnapshotRow {
  attempt_id: string;
  attempt_number: number;
  retry_of_attempt_id: string | null;
  attempt_state: "running" | "settled";
  outcome: TaskExecutionAttemptSnapshot["outcome"] | null;
  next_stage: KernelStage;
  coordination_dispatch_id: number;
  worker_id: string;
  milestone_lease_token: number;
}

function taskIdentity(input: ClaimTaskAttemptInput): string {
  return `${input.task.milestoneId}/${input.task.sliceId}/${input.task.taskId}`;
}

function operationPayload(input: ClaimTaskAttemptInput): DomainJsonValue {
  return {
    task: input.task,
    workerId: input.workerId,
    milestoneLeaseToken: input.milestoneLeaseToken,
    coordinationDispatchId: input.coordinationDispatchId,
    retryOfAttemptId: input.retryOfAttemptId ?? null,
  };
}

function claimAttempt(
  context: Readonly<DomainOperationContext>,
  input: ClaimTaskAttemptInput,
): ClaimRunningAttemptResult {
  activateTaskExecutionDispatch(context, {
    dispatchId: input.coordinationDispatchId,
    workerId: input.workerId,
    milestoneLeaseToken: input.milestoneLeaseToken,
    milestoneId: input.task.milestoneId,
    sliceId: input.task.sliceId,
    taskId: input.task.taskId,
    unitId: taskIdentity(input),
  });
  const lifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "task",
    milestoneId: input.task.milestoneId,
    sliceId: input.task.sliceId,
    taskId: input.task.taskId,
    lifecycleStatus: "in_progress",
    adoptedFromStatus: "ready",
  });
  ensureHostTechnicalCriterion(context, {
    projectId: context.projectId,
    lifecycleId: lifecycle.lifecycleId,
  });
  return claimRunningAttempt(context, {
    lifecycleId: lifecycle.lifecycleId,
    ...(input.retryOfAttemptId ? { retryOfAttemptId: input.retryOfAttemptId } : {}),
    coordinationDispatchId: input.coordinationDispatchId,
    workerId: input.workerId,
    milestoneLeaseToken: input.milestoneLeaseToken,
  });
}

function loadClaimedAttempt(operationId: string): ClaimedAttemptRow {
  const attempt = getDb().prepare(`
    SELECT attempt_id, attempt_number
    FROM workflow_execution_attempts
    WHERE claim_operation_id = :operation_id
  `).get({ ":operation_id": operationId }) as unknown as ClaimedAttemptRow | undefined;
  if (!attempt) throw new Error("Task execution claim receipt is missing its Attempt");
  return attempt;
}

function receipt(
  operation: DomainOperationResult,
  attempt: ClaimedAttemptRow,
): ClaimTaskAttemptReceipt {
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    attemptId: attempt.attempt_id,
    attemptNumber: attempt.attempt_number,
  };
}

function loadAttemptExecution(attemptId: string): AttemptExecutionRow {
  const attempt = getDb().prepare(`
    SELECT attempt.lifecycle_id, lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id,
           checkpoint.kernel_checkpoint_id, attempt.coordination_dispatch_id,
           attempt.worker_id, attempt.milestone_lease_token
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND checkpoint.next_stage = 'execute'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get({ ":attempt_id": attemptId }) as unknown as AttemptExecutionRow | undefined;
  if (!attempt) throw new Error("Task execution Attempt or execute checkpoint is missing");
  return attempt;
}

function loadSettledResult(operationId: string): SettledResultRow {
  const result = getDb().prepare(`
    SELECT result_id, outcome
    FROM workflow_attempt_results
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operationId }) as unknown as SettledResultRow | undefined;
  if (!result) throw new Error("Task execution settlement receipt is missing its Result");
  return result;
}

function nextStage(outcome: SettleTaskAttemptInput["outcome"]): "verify" | "route" {
  return outcome === "succeeded" ? "verify" : "route";
}

function snapshot(row: AttemptSnapshotRow | undefined): TaskExecutionAttemptSnapshot | null {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    ...(row.retry_of_attempt_id ? { retryOfAttemptId: row.retry_of_attempt_id } : {}),
    state: row.attempt_state,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    nextStage: row.next_stage,
    coordinationDispatchId: row.coordination_dispatch_id,
    workerId: row.worker_id,
    milestoneLeaseToken: row.milestone_lease_token,
  };
}

export function readTaskAttempt(attemptId: string): TaskExecutionAttemptSnapshot | null {
  const row = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.attempt_number, attempt.retry_of_attempt_id,
           attempt.attempt_state,
           attempt.coordination_dispatch_id, attempt.worker_id, attempt.milestone_lease_token,
           result.outcome, checkpoint.next_stage
    FROM workflow_execution_attempts attempt
    LEFT JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    WHERE attempt.attempt_id = :attempt_id
    ORDER BY checkpoint.sequence DESC
    LIMIT 1
  `).get({ ":attempt_id": attemptId }) as unknown as AttemptSnapshotRow | undefined;
  return snapshot(row);
}

export function readLatestTaskAttempt(
  task: ClaimTaskAttemptInput["task"],
): TaskExecutionAttemptSnapshot | null {
  const row = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.attempt_number, attempt.retry_of_attempt_id,
           attempt.attempt_state,
           attempt.coordination_dispatch_id, attempt.worker_id, attempt.milestone_lease_token,
           result.outcome, checkpoint.next_stage
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    LEFT JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
    ORDER BY attempt.attempt_number DESC, checkpoint.sequence DESC
    LIMIT 1
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as unknown as AttemptSnapshotRow | undefined;
  return snapshot(row);
}

export function claimTaskAttempt(input: ClaimTaskAttemptInput): ClaimTaskAttemptReceipt {
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let claimed: ClaimRunningAttemptResult | undefined;
  const operation = executeDomainOperation({
    operationType: "attempt.claim",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: operationPayload(input),
  }, (context) => {
    claimed = claimAttempt(context, input);
    return {
      events: [{
        eventType: "task.attempt.claimed",
        entityType: "task",
        entityId: taskIdentity(input),
        payload: {
          task: input.task,
          attemptId: claimed.attemptId,
          attemptNumber: claimed.attemptNumber,
          retryOfAttemptId: claimed.retryOfAttemptId,
          coordinationDispatchId: input.coordinationDispatchId,
          workerId: input.workerId,
          milestoneLeaseToken: input.milestoneLeaseToken,
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `execution/${taskIdentity(input)}`.toLowerCase(),
        projectionKind: "task-execution",
        rendererVersion: "1",
      }],
    };
  });
  const attempt = claimed
    ? { attempt_id: claimed.attemptId, attempt_number: claimed.attemptNumber }
    : loadClaimedAttempt(operation.operationId);
  return receipt(operation, attempt);
}

export function settleTaskAttempt(input: SettleTaskAttemptInput): SettleTaskAttemptReceipt {
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let settledResultId: string | undefined;
  const operation = executeDomainOperation({
    operationType: input.recovery ? "attempt.interrupt" : "attempt.settle",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      attemptId: input.attemptId,
      outcome: input.outcome,
      failureClass: input.failureClass,
      summary: input.summary,
      output: input.output,
      recovery: input.recovery ?? null,
    },
  }, (context) => {
    const attempt = loadAttemptExecution(input.attemptId);
    const settled = settleAttemptWithResult(context, input);
    terminalizeTaskExecutionDispatch(context, {
      dispatchId: attempt.coordination_dispatch_id,
      workerId: attempt.worker_id,
      milestoneLeaseToken: attempt.milestone_lease_token,
      outcome: input.outcome,
      endedAt: new Date().toISOString(),
    });
    settledResultId = settled.resultId;
    const stage = nextStage(input.outcome);
    appendKernelCheckpoint(context, {
      lifecycleId: attempt.lifecycle_id,
      attemptId: input.attemptId,
      nextStage: stage,
      previousKernelCheckpointId: attempt.kernel_checkpoint_id,
    });
    const entityId = `${attempt.milestone_id}/${attempt.slice_id}/${attempt.task_id}`;
    return {
      events: [{
        eventType: `task.attempt.${input.outcome}`,
        entityType: "task",
        entityId,
        payload: {
          attemptId: input.attemptId,
          resultId: settled.resultId,
          outcome: input.outcome,
          failureClass: input.failureClass,
          summary: input.summary,
          nextStage: stage,
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `execution/${entityId}`.toLowerCase(),
        projectionKind: "task-execution",
        rendererVersion: "1",
      }],
    };
  });
  const result = settledResultId === undefined
    ? loadSettledResult(operation.operationId)
    : { result_id: settledResultId, outcome: input.outcome };
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultId: result.result_id,
    nextStage: nextStage(result.outcome),
  };
}
