// Project/App: gsd-pi
// File Purpose: Fail-closed canonical Task Attempt boundary around auto-mode unit execution.

import type {
  ClaimTaskAttemptInput,
  ClaimTaskAttemptReceipt,
  SettleTaskAttemptInput,
  SettleTaskAttemptReceipt,
  TaskExecutionAttemptSnapshot,
  TaskResultRecoveryClassification,
} from "../task-execution-domain-operation.js";
import {
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
} from "../task-execution-domain-operation.js";
import type {
  RouteFailureInput,
  TaskRecoveryReceipt,
  TaskRecoveryRouteSnapshot,
} from "../task-recovery-domain-operation.js";
import { classifyFailure } from "../recovery-classification.js";
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
  readTaskRecoveryRoute(attemptId: string): Pick<
    TaskRecoveryRouteSnapshot,
    "action" | "recoveryOwner" | "resumeAuthorized"
  > | null;
  claimTaskAttempt(input: ClaimTaskAttemptInput): ClaimTaskAttemptReceipt;
  settleTaskAttempt(input: SettleTaskAttemptInput): SettleTaskAttemptReceipt;
  routeTaskFailure(input: RouteFailureInput): TaskRecoveryReceipt;
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

const TRANSIENT_PHASE_FAILURE_REASONS = new Set([
  "api-timeout",
  "ghost-completion",
  "provider-pause",
  "rate-limit",
  "session-timeout",
  "unit-aborted-pause",
]);

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
): TaskRecoveryReceipt {
  if (identity.milestoneLeaseToken <= predecessor.milestoneLeaseToken) {
    throw new Error("execute-task cannot replace an active running Attempt without a newer milestone lease");
  }
  const summary = "Replaced stale Task Attempt after milestone lease takeover";
  const recovery = taskRecoveryClassification(input, "stale-worker", new Error(summary));
  const settlement = deps.settleTaskAttempt({
    invocation: internalExecutionInvocation(
      `internal:auto:attempt.interrupt:${predecessor.attemptId}:${identity.workerId}:${identity.milestoneLeaseToken}`,
      { actorId: identity.workerId },
    ),
    attemptId: predecessor.attemptId,
    outcome: "interrupted",
    failureClass: "stale-worker",
    summary,
    output: {
      unitType: input.unitType,
      unitId: input.unitId,
      staleDispatchId: predecessor.coordinationDispatchId,
      staleWorkerId: predecessor.workerId,
      staleMilestoneLeaseToken: predecessor.milestoneLeaseToken,
      replacementDispatchId: identity.dispatchId,
      replacementWorkerId: identity.workerId,
      replacementMilestoneLeaseToken: identity.milestoneLeaseToken,
      recoveryClassification: {
        failureKind: recovery.failureKind,
        action: recovery.action,
        rationale: recovery.rationale,
      },
    },
    recovery: {
      workerId: identity.workerId,
      milestoneLeaseToken: identity.milestoneLeaseToken,
    },
  });
  return routeTaskFailure(
    input,
    predecessor.attemptId,
    settlement.resultId,
    summary,
    recovery,
    deps,
  );
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
  error: unknown = new Error(summary),
): TaskRecoveryReceipt {
  const attempt = deps.readTaskAttempt(attemptId);
  let resultId = attempt?.resultId;
  const recovery = attempt?.resultRecovery ?? taskRecoveryClassification(
    input,
    attempt?.resultFailureClass ?? failureClass,
    error,
  );
  if (attempt?.state !== "settled") {
    resultId = deps.settleTaskAttempt({
      invocation: internalExecutionInvocation(`internal:auto:attempt.settle:${attemptId}`),
      attemptId,
      outcome: "failed",
      failureClass: recovery.failureKind,
      summary,
      output: {
        unitType: input.unitType,
        unitId: input.unitId,
        rawFailureClass: failureClass,
        recoveryClassification: {
          failureKind: recovery.failureKind,
          action: recovery.action,
          rationale: recovery.rationale,
        },
      },
    }).resultId;
  }
  input.markCanonicalDispatchSettled();
  if (!resultId) throw new Error("Task recovery requires the settled Attempt Result identity");
  return routeTaskFailure(input, attemptId, resultId, summary, recovery, deps);
}

function taskRecoveryClassification(
  input: TaskExecutionCutoverInput,
  failureClass: string,
  error: unknown,
): TaskResultRecoveryClassification {
  const reason = error instanceof Error ? error.message : String(error);
  if (
    failureClass === "executor-retry" ||
    failureClass === "transient-execution" ||
    TRANSIENT_PHASE_FAILURE_REASONS.has(reason)
  ) {
    return {
      failureKind: "transient-execution",
      action: "retry",
      rationale: "Retry the bounded transient Task execution failure.",
    };
  }
  if (failureClass === "verification-failed") {
    return {
      failureKind: "verification-failed",
      action: "escalate",
      rationale: "Repair the failed host verification evidence before retrying the Task.",
    };
  }
  const classified = classifyFailure({
    error,
    unitType: input.unitType,
    unitId: input.unitId,
    ...(failureClass === "stale-worker"
      ? { failureKind: "stale-worker" as const }
      : failureClass === "missing-executor-result"
        ? { failureKind: "lifecycle-progression" as const }
        : {}),
  });
  return {
    failureKind: classified.failureKind,
    action: classified.action,
    rationale: classified.remediation,
  };
}

function routeTaskFailure(
  input: TaskExecutionCutoverInput,
  attemptId: string,
  resultId: string,
  summary: string,
  recovery: TaskResultRecoveryClassification,
  deps: TaskExecutionCutoverDeps,
): TaskRecoveryReceipt {
  return deps.routeTaskFailure({
    invocation: internalExecutionInvocation(`internal:auto:attempt.route:${resultId}`),
    attemptId,
    resultId,
    owner: "agent",
    classification: {
      failureKind: recovery.failureKind,
      action: recovery.action,
    },
    summary,
    evidence: {
      unitType: input.unitType,
      unitId: input.unitId,
      resultId,
    },
    rationale: recovery.rationale,
  });
}

function applyRecoveryDecision(
  recovery: TaskRecoveryReceipt,
): UnitPhaseResult {
  switch (recovery.action) {
    case "retry":
    case "repair":
    case "remediate":
    case "replan":
      return { action: "retry", reason: `task-recovery-${recovery.action}` };
    case "abort":
      if (recovery.status === "replayed" && recovery.resumeAuthorized) {
        return { action: "retry", reason: "task-recovery-resumed" };
      }
      return { action: "break", reason: "task-recovery-abort" };
    case "clarify":
    case "pause":
      throw new Error("Agent-owned Task recovery cannot return a human-owned action");
  }
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
      if (!attempt.resultId) throw new Error("Task recovery requires the settled Attempt Result identity");
      const summary = attempt.resultSummary ?? "Task executor recorded a failed Result";
      return applyRecoveryDecision(routeTaskFailure(
        input,
        attemptId,
        attempt.resultId,
        summary,
        attempt.resultRecovery ?? taskRecoveryClassification(
          input,
          attempt.resultFailureClass ?? "executor-result-failed",
          new Error(summary),
        ),
        deps,
      ));
    }
    throw new Error("execute-task next requires a succeeded Result at the verify stage");
  }

  const recovery = settleRunningAttempt(
    input,
    attemptId,
    "missing-executor-result",
    "execute-task ended without a succeeded executor Result",
    deps,
  );
  return applyRecoveryDecision(recovery);
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
      const recovery = interruptStaleAttempt(input, predecessor, identity, deps);
      const decision = applyRecoveryDecision(recovery);
      if (decision.action === "break" || recovery.status === "committed") return decision;
      retryOfAttemptId = predecessor.attemptId;
    }
  } else if (predecessor) {
    if (isTaskAttemptAwaitingVerification(predecessor)) {
      return { action: "next", data: {} };
    }
    if (predecessor.nextStage === "route") {
      if (predecessor.outcome === "succeeded") {
        const recovery = deps.readTaskRecoveryRoute(predecessor.attemptId);
        if (recovery?.recoveryOwner !== "agent") {
          return { action: "next", data: {} };
        }
        if (recovery.action === "abort" && !recovery.resumeAuthorized) {
          return { action: "break", reason: "task-recovery-abort" };
        }
      } else {
        if (!predecessor.resultId) {
          throw new Error("Task recovery requires the predecessor Result identity");
        }
        const summary = predecessor.resultSummary ?? "Task executor recorded a failed Result";
        const recovery = routeTaskFailure(
          input,
          predecessor.attemptId,
          predecessor.resultId,
          summary,
          predecessor.resultRecovery ?? taskRecoveryClassification(
            input,
            predecessor.resultFailureClass ?? "executor-result-failed",
            new Error(summary),
          ),
          deps,
        );
        const decision = applyRecoveryDecision(recovery);
        if (decision.action === "break" || recovery.status === "committed") return decision;
      }
    }
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
    return applyRecoveryDecision(
      settleRunningAttempt(input, claim.attemptId, "executor-error", summary, deps, error),
    );
  }

  if (result.action === "next") {
    return reconcileNext(input, claim.attemptId, result, deps);
  }

  const recovery = settleRunningAttempt(
    input,
    claim.attemptId,
    `executor-${result.action}`,
    failureReason(result),
    deps,
  );
  return applyRecoveryDecision(recovery);
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
  const publicationReplayCandidate = attempt?.state === "settled" &&
    attempt.outcome === "succeeded" && attempt.nextStage === "settled";
  const resolvedHumanReviewCandidate = attempt?.state === "settled" &&
    attempt.outcome === "succeeded" && attempt.nextStage === "route";
  if (!isTaskAttemptAwaitingVerification(attempt) &&
      !resolvedHumanReviewCandidate &&
      !publicationReplayCandidate) {
    throw new Error("Verified Task publication requires a succeeded Attempt at the verify stage");
  }
  await deps.publishVerifiedTaskCompletion({
    invocation: internalExecutionInvocation(`internal:auto:task.publish:${attempt.attemptId}`),
    basePath: input.basePath,
    task,
    attemptId: attempt.attemptId,
  });
}
