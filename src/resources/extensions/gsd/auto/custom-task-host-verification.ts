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
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.js";
import {
  invalidateTaskTechnicalPass,
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

function parseTaskIdentity(unitId: string): { milestoneId: string; sliceId: string; taskId: string } {
  const parts = unitId.split("/");
  if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Custom execute-task id must be milestone/slice/task, received ${unitId}`);
  }
  return { milestoneId: parts[0], sliceId: parts[1], taskId: parts[2] };
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
        verificationPolicy: "custom-engine",
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
): VerificationOutcome {
  if (!attempt.resultId) throw new Error("Custom Task host verification Result is missing");
  const recovery = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation(`internal:auto:attempt.route:${attempt.resultId}`),
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

async function runCustomTaskHostVerification(
  input: CustomTaskHostVerificationInput,
): Promise<VerificationOutcome> {
  const task = parseTaskIdentity(input.unitId);
  const attempt = readLatestTaskAttempt(task);
  if (attempt?.state !== "settled" || attempt.outcome !== "succeeded") {
    throw new Error("Custom Task host verification requires a succeeded Attempt at the verify stage");
  }
  const existing = readTaskTechnicalVerdict(attempt.attemptId);
  if (existing && existing.verdict !== "pass") {
    return routeFailedVerification(attempt, {
      verdictId: existing.verdictId,
      evidenceId: existing.evidenceId,
      verdict: existing.verdict,
    }, existing.supersedesVerdictId ? "verification-drift" : "verification-failed");
  }
  if (!isTaskAttemptAwaitingVerification(attempt)) {
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
    }, "verification-drift");
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
  if (policyResult === "pause" && input.humanReviewPolicy) return "pause";
  const after = captureVerificationSourceSnapshot(targets);
  const captureError = after.ok ? undefined : after.error;
  const drifted = after.ok && verificationSourceChanged(before.snapshot, after.snapshot);
  let rationale = "Custom-engine host verification requested retry.";
  let verdict: RecordTaskTechnicalVerdictInput["verdict"] = "fail";
  if (captureError || drifted) {
    rationale = captureError ?? "Verification target source changed while custom policy verification was running";
    verdict = "inconclusive";
  } else if (policyResult === "continue") {
    rationale = "Custom-engine host verification passed.";
    verdict = "pass";
  } else if (policyResult === "pause") {
    rationale = "Custom-engine host verification requested a pause without human-owned policy.";
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
  });
  if (verdict === "pass") return "continue";
  return routeFailedVerification(attempt, { ...recorded, verdict });
}

export async function runCustomEngineHostVerification(
  input: CustomEngineHostVerificationInput,
): Promise<VerificationOutcome> {
  if (input.unitType !== "execute-task") return input.verifyPolicy();
  return runCustomTaskHostVerification(input);
}
