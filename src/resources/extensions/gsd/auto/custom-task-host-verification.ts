// Project/App: gsd-pi
// File Purpose: Canonical host-verdict boundary around custom-engine Task verification.

import { getSlice, getTask } from "../gsd-db.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import type { GSDPreferences } from "../preferences-types.js";
import { isTaskAttemptAwaitingVerification, readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import {
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
  type RecordTaskTechnicalVerdictInput,
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
}): void {
  const targetSourceRevisions = Object.fromEntries(
    (input.before?.targets ?? []).map((target) => [target.targetId, target.revision]),
  );
  let observation: RecordTaskTechnicalVerdictInput["evidence"]["observation"] = "inconclusive";
  if (input.verdict === "pass") observation = "passed";
  else if (input.verdict === "fail") observation = "failed";
  recordTaskTechnicalVerdict({
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

async function runCustomTaskHostVerification(
  input: CustomTaskHostVerificationInput,
): Promise<VerificationOutcome> {
  const task = parseTaskIdentity(input.unitId);
  const attempt = readLatestTaskAttempt(task);
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
  const existing = readTaskTechnicalVerdict(attempt.attemptId);
  if (existing) {
    if (existing.verdict !== "pass") return "retry";
    const current = captureVerificationSourceSnapshot(targets);
    return current.ok && current.snapshot.aggregateRevision === existing.testedSourceRevision
      ? "continue"
      : "retry";
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
    recordVerdict({
      basePath: input.basePath,
      attemptId: attempt.attemptId,
      verdict: "inconclusive",
      rationale: before.error,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    return "retry";
  }

  const policyResult = await input.verifyPolicy();
  if (policyResult === "pause") return "pause";
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
  }
  recordVerdict({
    basePath: input.basePath,
    attemptId: attempt.attemptId,
    verdict,
    rationale,
    startedAt,
    endedAt: new Date().toISOString(),
    before: before.snapshot,
    ...(after.ok ? { after: after.snapshot } : {}),
  });
  return verdict === "pass" ? "continue" : "retry";
}

export async function runCustomEngineHostVerification(
  input: CustomEngineHostVerificationInput,
): Promise<VerificationOutcome> {
  if (input.unitType !== "execute-task") return input.verifyPolicy();
  return runCustomTaskHostVerification(input);
}
