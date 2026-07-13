// Project/App: gsd-pi
// File Purpose: Fail-closed canonical Task Attempt boundary around auto-mode unit execution.

import type {
  ClaimTaskAttemptInput,
  ClaimTaskAttemptReceipt,
  SettleTaskAttemptInput,
  SettleTaskAttemptReceipt,
} from "../task-execution-domain-operation.js";
import type { KernelStage } from "../db/kernel-stage-policy.js";
import type { PublishVerifiedTaskCompletionInput } from "../task-completion-compatibility-adapter.js";
import type { UnitPhaseResult } from "./workflow-unit-dispatch.js";

export interface TaskExecutionAttemptSnapshot {
  attemptId: string;
  attemptNumber: number;
  state: "running" | "settled";
  outcome?: "succeeded" | "failed" | "interrupted";
  nextStage: KernelStage;
}

export interface TaskExecutionCutoverInput {
  unitType: string;
  unitId: string;
  dispatchId: number | null;
  workerId: string | null;
  milestoneLeaseToken: number | null;
  traceId: string;
  turnId: string;
  markCanonicalDispatchSettled(): void;
}

export interface TaskExecutionCutoverDeps {
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): TaskExecutionAttemptSnapshot | null;
  readTaskAttempt(attemptId: string): TaskExecutionAttemptSnapshot | null;
  claimTaskAttempt(input: ClaimTaskAttemptInput): ClaimTaskAttemptReceipt;
  settleTaskAttempt(input: SettleTaskAttemptInput): SettleTaskAttemptReceipt;
}

export interface VerifiedTaskPublicationDeps {
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): TaskExecutionAttemptSnapshot | null;
  publishVerifiedTaskCompletion(input: PublishVerifiedTaskCompletionInput): Promise<unknown>;
}

export interface VerifiedTaskPublicationInput {
  unitType: string;
  unitId: string;
  workerId: string | null;
  traceId: string;
  turnId: string;
  basePath: string;
}

function parseTaskIdentity(unitId: string): ClaimTaskAttemptInput["task"] {
  const parts = unitId.split("/");
  if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`execute-task unit id must be milestone/slice/task, received ${unitId}`);
  }
  return {
    milestoneId: parts[0],
    sliceId: parts[1],
    taskId: parts[2],
  };
}

function requireTaskClaimIdentity(input: TaskExecutionCutoverInput): {
  dispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
} {
  if (!Number.isSafeInteger(input.dispatchId) || Number(input.dispatchId) <= 0) {
    throw new Error("execute-task requires a positive coordination dispatch identity");
  }
  if (typeof input.workerId !== "string" || input.workerId.trim().length === 0) {
    throw new Error("execute-task requires a worker identity");
  }
  if (!Number.isSafeInteger(input.milestoneLeaseToken) || Number(input.milestoneLeaseToken) <= 0) {
    throw new Error("execute-task requires a positive milestone lease identity");
  }
  return {
    dispatchId: input.dispatchId as number,
    workerId: input.workerId,
    milestoneLeaseToken: input.milestoneLeaseToken as number,
  };
}

function failureReason(result: UnitPhaseResult): string {
  if (result.action === "break" || result.action === "retry") return result.reason;
  if (result.action === "continue") return "unit requested continuation without an executor Result";
  return "unit ended without an executor Result";
}

function settleRunningAttempt(
  input: TaskExecutionCutoverInput,
  attemptId: string,
  failureClass: string,
  summary: string,
  deps: TaskExecutionCutoverDeps,
): void {
  const attempt = deps.readTaskAttempt(attemptId);
  if (attempt?.state !== "settled") {
    deps.settleTaskAttempt({
      invocation: {
        idempotencyKey: `internal:auto:attempt.settle:${attemptId}`,
        sourceTransport: "internal",
        actorType: "agent",
      },
      attemptId,
      outcome: "failed",
      failureClass,
      summary,
      output: { unitType: input.unitType, unitId: input.unitId },
    });
  }
  input.markCanonicalDispatchSettled();
}

function reconcileNext(
  input: TaskExecutionCutoverInput,
  attemptId: string,
  result: UnitPhaseResult,
  deps: TaskExecutionCutoverDeps,
): UnitPhaseResult {
  const attempt = deps.readTaskAttempt(attemptId);
  if (
    attempt?.state === "settled" &&
    attempt.outcome === "succeeded" &&
    attempt.nextStage === "verify"
  ) {
    input.markCanonicalDispatchSettled();
    return result;
  }
  if (attempt?.state === "settled") {
    input.markCanonicalDispatchSettled();
    if ((attempt.outcome === "failed" || attempt.outcome === "interrupted") && attempt.nextStage === "route") {
      return { action: "retry", reason: "executor-result-failed" };
    }
    throw new Error("execute-task next requires a succeeded Result at the verify stage");
  }

  settleRunningAttempt(
    input,
    attemptId,
    "missing-executor-result",
    "execute-task ended without a succeeded executor Result",
    deps,
  );
  return { action: "retry", reason: "missing-executor-result" };
}

export async function runWithTaskExecutionAttempt(
  input: TaskExecutionCutoverInput,
  run: () => Promise<UnitPhaseResult>,
  deps: TaskExecutionCutoverDeps,
): Promise<UnitPhaseResult> {
  if (input.unitType !== "execute-task") return run();

  const task = parseTaskIdentity(input.unitId);
  const identity = requireTaskClaimIdentity(input);
  const predecessor = deps.readLatestTaskAttempt(task);
  const claim = deps.claimTaskAttempt({
    invocation: {
      idempotencyKey: `internal:auto:attempt.claim:${identity.dispatchId}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: identity.workerId,
      traceId: input.traceId,
      turnId: input.turnId,
    },
    task,
    workerId: identity.workerId,
    milestoneLeaseToken: identity.milestoneLeaseToken,
    coordinationDispatchId: identity.dispatchId,
    ...(predecessor?.state === "settled" ? { retryOfAttemptId: predecessor.attemptId } : {}),
  });

  let result: UnitPhaseResult;
  try {
    result = await run();
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    settleRunningAttempt(input, claim.attemptId, "executor-error", summary, deps);
    throw error;
  }

  if (result.action === "next") {
    return reconcileNext(input, claim.attemptId, result, deps);
  }

  settleRunningAttempt(
    input,
    claim.attemptId,
    `executor-${result.action}`,
    failureReason(result),
    deps,
  );
  return result;
}

export async function publishVerifiedTaskExecution(
  input: VerifiedTaskPublicationInput,
  deps: VerifiedTaskPublicationDeps,
): Promise<void> {
  if (input.unitType !== "execute-task") {
    throw new Error("Verified Task publication requires an execute-task unit");
  }
  const task = parseTaskIdentity(input.unitId);
  const attempt = deps.readLatestTaskAttempt(task);
  if (
    attempt?.state !== "settled" ||
    attempt.outcome !== "succeeded" ||
    attempt.nextStage !== "verify"
  ) {
    throw new Error("Verified Task publication requires a succeeded Attempt at the verify stage");
  }
  await deps.publishVerifiedTaskCompletion({
    invocation: {
      idempotencyKey: `internal:auto:task.publish:${attempt.attemptId}`,
      sourceTransport: "internal",
      actorType: "agent",
      ...(input.workerId ? { actorId: input.workerId } : {}),
      traceId: input.traceId,
      turnId: input.turnId,
    },
    basePath: input.basePath,
    task,
    attemptId: attempt.attemptId,
  });
}
