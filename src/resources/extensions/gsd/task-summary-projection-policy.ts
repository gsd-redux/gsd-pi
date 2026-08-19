// Project/App: gsd-pi
// File Purpose: Shared eligibility policy for staged Task SUMMARY projections.

import { readLatestTaskAttempt } from "./task-execution-domain-operation.js";
import { readTaskTechnicalVerdict } from "./task-verification-domain-operation.js";

export function isCanonicalStagedTaskSummaryState(input: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}): boolean {
  const attempt = readLatestTaskAttempt(input);
  if (attempt?.state !== "settled" || attempt.outcome !== "succeeded") {
    return false;
  }
  if (attempt.nextStage === "verify") return true;
  if (attempt.nextStage !== "route") return false;

  const verdict = readTaskTechnicalVerdict(attempt.attemptId);
  return verdict !== null && verdict.verdict !== "pass";
}
