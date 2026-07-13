// Project/App: gsd-pi
// File Purpose: Fail-closed canonical Task Attempt boundary around auto-mode unit execution.

import type {
  ClaimTaskAttemptInput,
  ClaimTaskAttemptReceipt,
  SettleTaskAttemptInput,
  SettleTaskAttemptReceipt,
  TaskExecutionAttemptSnapshot,
} from "../task-execution-domain-operation.js";
import {
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
} from "../task-execution-domain-operation.js";
import type { PublishVerifiedTaskCompletionInput } from "../task-completion-compatibility-adapter.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import type { UnitPhaseResult } from "./workflow-unit-dispatch.js";

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

export interface TaskHostVerificationReadinessDeps {
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): Pick<
    TaskExecutionAttemptSnapshot,
    "state" | "outcome" | "nextStage"
  > | null;
}

const DEFAULT_READINESS_DEPS: TaskHostVerificationReadinessDeps = {
  readLatestTaskAttempt,
};

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

export function isTaskExecutionReadyForHostVerification(
  unitType: string,
  unitId: string,
  deps: TaskHostVerificationReadinessDeps = DEFAULT_READINESS_DEPS,
): boolean {
  if (unitType !== "execute-task") return false;
  try {
    return isTaskAttemptAwaitingVerification(
      deps.readLatestTaskAttempt(parseTaskIdentity(unitId)),
    );
  } catch {
    return false;
  }
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

function interruptStaleAttempt(
  input: TaskExecutionCutoverInput,
  predecessor: TaskExecutionAttemptSnapshot,
  identity: ReturnType<typeof requireTaskClaimIdentity>,
  deps: TaskExecutionCutoverDeps,
): void {
  if (identity.milestoneLeaseToken <= predecessor.milestoneLeaseToken) {
    throw new Error("execute-task cannot replace an active running Attempt without a newer milestone lease");
  }
  deps.settleTaskAttempt({
    invocation: internalExecutionInvocation(
      `internal:auto:attempt.interrupt:${predecessor.attemptId}:${identity.workerId}:${identity.milestoneLeaseToken}`,
      { actorId: identity.workerId },
    ),
    attemptId: predecessor.attemptId,
    outcome: "interrupted",
    failureClass: "stale-worker",
    summary: "Replaced stale Task Attempt after milestone lease takeover",
    output: {
      unitType: input.unitType,
      unitId: input.unitId,
      staleDispatchId: predecessor.coordinationDispatchId,
      staleWorkerId: predecessor.workerId,
      staleMilestoneLeaseToken: predecessor.milestoneLeaseToken,
      replacementDispatchId: identity.dispatchId,
      replacementWorkerId: identity.workerId,
      replacementMilestoneLeaseToken: identity.milestoneLeaseToken,
    },
    recovery: {
      workerId: identity.workerId,
      milestoneLeaseToken: identity.milestoneLeaseToken,
    },
  });
}

function isClaimReplay(
  predecessor: TaskExecutionAttemptSnapshot,
  identity: ReturnType<typeof requireTaskClaimIdentity>,
): boolean {
  return predecessor.coordinationDispatchId === identity.dispatchId &&
    predecessor.workerId === identity.workerId &&
    predecessor.milestoneLeaseToken === identity.milestoneLeaseToken;
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
      invocation: internalExecutionInvocation(`internal:auto:attempt.settle:${attemptId}`),
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
  if (isTaskAttemptAwaitingVerification(attempt)) {
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
  let retryOfAttemptId: string | undefined;
  if (predecessor?.state === "running") {
    if (isClaimReplay(predecessor, identity)) {
      retryOfAttemptId = predecessor.retryOfAttemptId;
    } else {
      interruptStaleAttempt(input, predecessor, identity, deps);
      retryOfAttemptId = predecessor.attemptId;
    }
  } else if (predecessor) {
    retryOfAttemptId = predecessor.attemptId;
  }
  const claim = deps.claimTaskAttempt({
    invocation: internalExecutionInvocation(
      `internal:auto:attempt.claim:${identity.dispatchId}`,
      {
        actorId: identity.workerId,
      },
    ),
    task,
    workerId: identity.workerId,
    milestoneLeaseToken: identity.milestoneLeaseToken,
    coordinationDispatchId: identity.dispatchId,
    ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
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
  if (!isTaskAttemptAwaitingVerification(attempt)) {
    throw new Error("Verified Task publication requires a succeeded Attempt at the verify stage");
  }
  await deps.publishVerifiedTaskCompletion({
    invocation: internalExecutionInvocation(`internal:auto:task.publish:${attempt.attemptId}`),
    basePath: input.basePath,
    task,
    attemptId: attempt.attemptId,
  });
}
