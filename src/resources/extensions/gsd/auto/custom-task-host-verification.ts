// Project/App: gsd-pi
// File Purpose: Canonical host-verdict boundary around custom-engine Task verification.

import { getSlice, getTask } from "../gsd-db.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import type { GSDPreferences } from "../preferences-types.js";
import {
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
  type TaskExecutionAttemptSnapshot,
} from "../task-execution-domain-operation.js";
import {
  readResolvedTaskHumanReviewBlocker,
  readTaskRecoveryBlocker,
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
  resolveTaskBlocker,
} from "../task-recovery-domain-operation.js";
import {
  confirmResolvedTaskHumanReview,
  invalidateTaskTechnicalPass,
  isPendingTaskHumanReviewVerdict,
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
  type RecordTaskTechnicalVerdictInput,
  type TaskTechnicalVerdictReceipt,
} from "../task-verification-domain-operation.js";
import type { VerificationOutcome } from "../custom-verification.js";
import {
  captureVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
  verificationSourceChanged,
  type VerificationSourceSnapshot,
} from "../verification-source-integrity.js";

export interface CustomTaskHostVerificationInput {
  basePath: string;
  unitId: string;
  preferences?: GSDPreferences;
  humanReviewPolicy?: boolean;
  verifyPolicy(): Promise<VerificationOutcome>;
}

export interface CustomEngineHostVerificationInput extends CustomTaskHostVerificationInput {
  unitType: string;
}

export type CustomTaskHumanReviewResponse = "approve" | "reject" | undefined;

export interface ResolvePendingCustomTaskHumanReviewInput {
  unitId: string;
  responseIdentity: {
    actorId: string;
    workerId: string;
    traceId: string;
    turnId: string;
  };
  requestReview(input: {
    title: string;
    message: string;
  }): Promise<CustomTaskHumanReviewResponse>;
}

interface CustomTaskHumanReviewUi {
  select(title: string, options: string[]): Promise<string | string[] | undefined>;
}

const APPROVE_HUMAN_REVIEW = "Approve (Recommended when the output matches the intended result)";
const REJECT_HUMAN_REVIEW = "Reject and stop publication";

export async function requestCustomTaskHumanReviewFromUi(
  ui: CustomTaskHumanReviewUi,
  input: { title: string; message: string },
): Promise<CustomTaskHumanReviewResponse> {
  const choice = await ui.select(`${input.title}\n\n${input.message}`, [
    APPROVE_HUMAN_REVIEW,
    REJECT_HUMAN_REVIEW,
  ]);
  if (choice === APPROVE_HUMAN_REVIEW || choice === "approve") return "approve";
  if (choice === REJECT_HUMAN_REVIEW || choice === "reject") return "reject";
  return undefined;
}

function parseTaskIdentity(unitId: string): { milestoneId: string; sliceId: string; taskId: string } {
  const parts = unitId.split("/");
  if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Custom execute-task id must be milestone/slice/task, received ${unitId}`);
  }
  return { milestoneId: parts[0], sliceId: parts[1], taskId: parts[2] };
}

export async function resolvePendingCustomTaskHumanReview(
  input: ResolvePendingCustomTaskHumanReviewInput,
): Promise<"resolved" | "dismissed" | "pending" | "not-found"> {
  const task = parseTaskIdentity(input.unitId);
  const attempt = readLatestTaskAttempt(task);
  if (!attempt) return "not-found";
  const blocker = readTaskRecoveryBlocker(attempt.attemptId);
  if (!blocker || blocker.blockerKind !== "subjective_uat") return "not-found";
  if (blocker.blockerStatus !== "open") return blocker.blockerStatus;

  const response = await input.requestReview({
    title: `Review ${input.unitId}`,
    message: [
      "This custom workflow requires your judgment before its Task can be published.",
      "Recommendation: approve only when the output matches the intended result, because your explicit judgment is the required evidence for this subjective policy. Otherwise reject it so the Task stops without publishing.",
    ].join(" "),
  });
  if (!response) return "pending";

  const approved = response === "approve";
  const identity = input.responseIdentity;
  resolveTaskBlocker({
    invocation: {
      idempotencyKey: `internal:auto:task-human-review:${blocker.blockerId}:${response}`,
      sourceTransport: "internal",
      actorType: "user",
      actorId: identity.actorId,
      traceId: identity.traceId,
      turnId: identity.turnId,
    },
    blockerId: blocker.blockerId,
    disposition: approved ? "resolved" : "dismissed",
    resolution: approved
      ? "The user approved the custom workflow output."
      : "The user rejected the custom workflow output.",
    checkpoint: {
      checkpointKind: "answer",
      confirmedContext: approved
        ? "The user approved the custom workflow output."
        : "The user rejected the custom workflow output.",
      unresolvedSummary: approved ? "" : "The custom workflow output was not accepted.",
      evidenceSummary: [
        `The decision was received through worker ${identity.workerId}.`,
        `Trace ${identity.traceId}; turn ${identity.turnId}; actor ${identity.actorId}.`,
      ].join(" "),
      suggestedNextAction: approved
        ? "Publish the verified Task."
        : "Stop before Task publication.",
    },
  });
  return approved ? "resolved" : "dismissed";
}

function recordVerdict(input: {
  basePath: string;
  attemptId: string;
  verdict: RecordTaskTechnicalVerdictInput["verdict"];
  rationale: string;
  startedAt: string;
  endedAt: string;
  before?: VerificationSourceSnapshot;
  after?: VerificationSourceSnapshot;
  verificationPolicy?: "custom-engine" | "custom-engine-human-review";
}): TaskTechnicalVerdictReceipt {
  const targetSourceRevisions = Object.fromEntries(
    (input.before?.targets ?? []).map((target) => [target.targetId, target.revision]),
  );
  let observation: RecordTaskTechnicalVerdictInput["evidence"]["observation"] = "inconclusive";
  if (input.verdict === "pass") observation = "passed";
  else if (input.verdict === "fail") observation = "failed";
  return recordTaskTechnicalVerdict({
    invocation: internalExecutionInvocation(`internal:auto:attempt.verify:${input.attemptId}`),
    attemptId: input.attemptId,
    testedSourceRevision: input.before?.aggregateRevision ?? "unavailable",
    verdict: input.verdict,
    rationale: input.rationale,
    evidence: {
      evidenceClass: "command",
      commandOrTool: "custom-engine-policy.verify",
      workingDirectory: input.basePath,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      exitCode: input.verdict === "pass" ? 0 : 1,
      observation,
      durableOutputRef: `db://host-verification/${input.attemptId}`,
      environment: {
        node: process.version,
        platform: process.platform,
        verificationPolicy: input.verificationPolicy ?? "custom-engine",
        targetSourceRevisions,
        sourceRevisionAfter: input.after?.aggregateRevision ?? "unavailable",
      },
    },
  });
}

interface FailedVerdictIdentity {
  verdictId: string;
  evidenceId: string;
  verdict: "fail" | "inconclusive";
}

function routeFailedVerification(
  attempt: TaskExecutionAttemptSnapshot,
  verdict: FailedVerdictIdentity,
  failureKind: "verification-failed" | "verification-drift" = "verification-failed",
  supersedesResolvedBlockerId?: string,
): VerificationOutcome {
  if (!attempt.resultId) throw new Error("Custom Task host verification Result is missing");
  const recovery = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation(failureKind === "verification-drift"
      ? `internal:auto:attempt.route:${attempt.resultId}:verification-drift:${verdict.verdictId}`
      : `internal:auto:attempt.route:${attempt.resultId}`),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "agent",
    classification: { failureKind },
    summary: failureKind === "verification-drift"
      ? "Stored custom-engine host verification pass no longer matches the current source"
      : "Custom-engine host verification did not pass",
    evidence: {
      verdictId: verdict.verdictId,
      evidenceId: verdict.evidenceId,
      verdict: verdict.verdict,
    },
    rationale: "Route custom-engine host verification through the durable recovery policy",
    ...(supersedesResolvedBlockerId ? { supersedesResolvedBlockerId } : {}),
  });
  switch (recovery.action) {
    case "retry":
    case "repair":
    case "remediate":
    case "replan":
      return "retry";
    case "abort":
      return "abort";
    default:
      throw new Error(`Unsupported agent recovery action ${recovery.action}`);
  }
}

function routeHumanReview(
  attempt: TaskExecutionAttemptSnapshot,
  verdict: FailedVerdictIdentity,
): VerificationOutcome {
  if (!attempt.resultId) throw new Error("Custom Task human review Result is missing");
  recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation(`internal:auto:attempt.route:${attempt.resultId}`),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "user",
    classification: { failureKind: "verification-failed" },
    blocker: {
      blockerKind: "subjective_uat",
      description: "The custom workflow output requires human review before publication.",
      requestedAction: "Review the custom workflow output and resolve this blocker with the decision.",
    },
    summary: "Custom-engine human review is awaiting a user decision",
    evidence: {
      verdictId: verdict.verdictId,
      evidenceId: verdict.evidenceId,
      verdict: verdict.verdict,
    },
    rationale: "The configured human-review policy assigns this subjective decision to the user.",
  });
  return "pause";
}

async function runCustomTaskHostVerification(
  input: CustomTaskHostVerificationInput,
): Promise<VerificationOutcome> {
  const task = parseTaskIdentity(input.unitId);
  const attempt = readLatestTaskAttempt(task);
  if (attempt?.state !== "settled" || attempt.outcome !== "succeeded") {
    throw new Error("Custom Task host verification requires a succeeded Attempt at the verify stage");
  }
  const resolved = resolveVerificationRepositoryTargets(
    input.basePath,
    input.preferences,
    getTask(task.milestoneId, task.sliceId, task.taskId),
    getSlice(task.milestoneId, task.sliceId),
  );
  const targets = resolved.repositories.map((repository) => ({
    id: repository.id,
    cwd: repository.root,
  }));
  const existing = readTaskTechnicalVerdict(attempt.attemptId);
  if (existing && existing.verdict !== "pass") {
    const recovery = readTaskRecoveryRoute(attempt.attemptId);
    const blocker = recovery?.blocker ?? null;
    if (blocker?.blockerKind === "subjective_uat") {
      if (blocker.blockerStatus === "open") return "pause";
      if (blocker.blockerStatus === "dismissed") return "abort";
      const current = captureVerificationSourceSnapshot(targets);
      if (!current.ok || current.snapshot.aggregateRevision !== existing.testedSourceRevision) {
        return routeFailedVerification(attempt, {
          verdictId: existing.verdictId,
          evidenceId: existing.evidenceId,
          verdict: existing.verdict,
        }, "verification-drift", blocker.blockerId);
      }
      const now = new Date().toISOString();
      confirmResolvedTaskHumanReview({
        invocation: internalExecutionInvocation(`internal:auto:attempt.verify-human:${blocker.blockerId}`),
        attemptId: attempt.attemptId,
        blockerId: blocker.blockerId,
        testedSourceRevision: existing.testedSourceRevision,
        rationale: "The required human review blocker was resolved and the reviewed source is unchanged.",
        evidence: {
          evidenceClass: "command",
          commandOrTool: "gsd-task-human-review-resolution",
          workingDirectory: input.basePath,
          startedAt: now,
          endedAt: now,
          exitCode: 0,
          observation: "passed",
          durableOutputRef: `db://workflow-blockers/${blocker.blockerId}`,
          environment: {
            node: process.version,
            platform: process.platform,
            verificationPolicy: "human-review",
            blockerResolutionOperationId: blocker.resolvedOperationId ?? "unavailable",
            blockerResolutionProjectRevision: blocker.resolvedProjectRevision ?? 0,
          },
        },
      });
      return "continue";
    }
    if (!recovery && isPendingTaskHumanReviewVerdict(attempt.attemptId, existing.verdictId)) {
      return routeHumanReview(attempt, {
        verdictId: existing.verdictId,
        evidenceId: existing.evidenceId,
        verdict: existing.verdict,
      });
    }
    const failureKind = recovery?.failureKind === "verification-drift" || existing.supersedesVerdictId
      ? "verification-drift"
      : "verification-failed";
    const supersededBlockerId = failureKind === "verification-drift"
      ? readResolvedTaskHumanReviewBlocker(attempt.attemptId)?.blockerId
      : undefined;
    return routeFailedVerification(attempt, {
      verdictId: existing.verdictId,
      evidenceId: existing.evidenceId,
      verdict: existing.verdict,
    }, failureKind, supersededBlockerId);
  }
  if (existing) {
    const current = captureVerificationSourceSnapshot(targets);
    if (current.ok && current.snapshot.aggregateRevision === existing.testedSourceRevision) {
      return "continue";
    }
    const now = new Date().toISOString();
    const currentSourceRevision = current.ok ? current.snapshot.aggregateRevision : "unavailable";
    const invalidated = invalidateTaskTechnicalPass({
      invocation: internalExecutionInvocation(`internal:auto:attempt.verify-drift:${existing.verdictId}`),
      attemptId: attempt.attemptId,
      supersedesVerdictId: existing.verdictId,
      rationale: `Stored passing custom-engine host verdict no longer matches the current verification source (${currentSourceRevision}).`,
      evidence: {
        evidenceClass: "command",
        commandOrTool: "gsd-source-integrity",
        workingDirectory: input.basePath,
        startedAt: now,
        endedAt: now,
        exitCode: 1,
        observation: "inconclusive",
        durableOutputRef: `db://host-verification/${attempt.attemptId}/source-drift`,
        environment: {
          node: process.version,
          platform: process.platform,
          verificationPolicy: "custom-engine",
          sourceRevisionBefore: existing.testedSourceRevision,
          sourceRevisionAfter: currentSourceRevision,
        },
      },
    });
    return routeFailedVerification(attempt, {
      verdictId: invalidated.verdictId,
      evidenceId: invalidated.evidenceId,
      verdict: "inconclusive",
    }, "verification-drift", readTaskRecoveryBlocker(attempt.attemptId)?.blockerId);
  }
  if (!isTaskAttemptAwaitingVerification(attempt)) {
    throw new Error("Custom Task host verification requires a succeeded Attempt at the verify stage");
  }

  const startedAt = new Date().toISOString();
  const before = resolved.missingRepositoryIds.length === 0
    ? captureVerificationSourceSnapshot(targets)
    : {
      ok: false as const,
      targetId: resolved.missingRepositoryIds[0] ?? "<targets>",
      error: `Missing verification repositories: ${resolved.missingRepositoryIds.join(", ")}`,
    };
  if (!before.ok) {
    const recorded = recordVerdict({
      basePath: input.basePath,
      attemptId: attempt.attemptId,
      verdict: "inconclusive",
      rationale: before.error,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    return routeFailedVerification(attempt, { ...recorded, verdict: "inconclusive" });
  }

  let policyResult: VerificationOutcome;
  try {
    policyResult = await input.verifyPolicy();
  } catch (error) {
    const recorded = recordVerdict({
      basePath: input.basePath,
      attemptId: attempt.attemptId,
      verdict: "inconclusive",
      rationale: `Custom-engine host verification errored: ${(error as Error).message}`,
      startedAt,
      endedAt: new Date().toISOString(),
      before: before.snapshot,
    });
    return routeFailedVerification(attempt, { ...recorded, verdict: "inconclusive" });
  }
  const after = captureVerificationSourceSnapshot(targets);
  const captureError = after.ok ? undefined : after.error;
  const drifted = after.ok && verificationSourceChanged(before.snapshot, after.snapshot);
  const pendingHumanReview = input.humanReviewPolicy === true &&
    policyResult === "pause" &&
    !captureError &&
    !drifted;
  let rationale = "Custom-engine host verification requested retry.";
  let verdict: RecordTaskTechnicalVerdictInput["verdict"] = "fail";
  if (captureError || drifted) {
    rationale = captureError ?? "Verification target source changed while custom policy verification was running";
    verdict = "inconclusive";
  } else if (policyResult === "continue") {
    rationale = "Custom-engine host verification passed.";
    verdict = "pass";
  } else if (policyResult === "pause") {
    rationale = pendingHumanReview
      ? "Custom-engine host verification is awaiting the configured human review."
      : "Custom-engine host verification requested a pause without human-owned policy.";
    if (pendingHumanReview) verdict = "inconclusive";
  }
  const recorded = recordVerdict({
    basePath: input.basePath,
    attemptId: attempt.attemptId,
    verdict,
    rationale,
    startedAt,
    endedAt: new Date().toISOString(),
    before: before.snapshot,
    ...(after.ok ? { after: after.snapshot } : {}),
    ...(pendingHumanReview ? { verificationPolicy: "custom-engine-human-review" as const } : {}),
  });
  if (verdict === "pass") return "continue";
  if (pendingHumanReview) {
    return routeHumanReview(attempt, { ...recorded, verdict });
  }
  return routeFailedVerification(attempt, { ...recorded, verdict });
}

export async function runCustomEngineHostVerification(
  input: CustomEngineHostVerificationInput,
): Promise<VerificationOutcome> {
  if (input.unitType !== "execute-task") return input.verifyPolicy();
  return runCustomTaskHostVerification(input);
}
