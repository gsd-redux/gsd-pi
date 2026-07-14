// Project/App: gsd-pi
// File Purpose: Resolve the authoritative milestone validation verdict from SQLite.

import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";
import {
  isMilestoneLifecycleAdopted,
  readMilestoneCloseoutReadiness,
} from "./db/milestone-closeout-readiness.js";
import {
  isValidMilestoneVerdict,
  type ValidationVerdict,
} from "./verdict-parser.js";

const CANONICAL_VERDICT_MAP: Readonly<Record<string, ValidationVerdict>> = {
  pass: "pass",
  fail: "needs-remediation",
  inconclusive: "needs-attention",
};

function resolveCanonicalValidationVerdict(
  milestoneId: string,
): ValidationVerdict | undefined {
  const readiness = readMilestoneCloseoutReadiness({ milestoneId });
  if (readiness.ready) return "pass";
  if (readiness.blockers.some((blocker) =>
    blocker.kind === "validation-missing" || blocker.kind === "validation-receipt-invalid"
  )) return undefined;
  const verdictBlocker = readiness.blockers.find(
    (blocker) => blocker.kind === "validation-not-pass",
  );
  if (verdictBlocker?.kind === "validation-not-pass") {
    return CANONICAL_VERDICT_MAP[verdictBlocker.overallVerdict];
  }
  return "needs-attention";
}

/**
 * Resolve the current database verdict. VALIDATION.md is a projection and can
 * only enter authority through an explicit import operation.
 */
export function readMilestoneValidationVerdict(
  milestoneId: string,
): ValidationVerdict | undefined {
  if (!isDbAvailable()) return undefined;
  if (isMilestoneLifecycleAdopted(milestoneId)) {
    return resolveCanonicalValidationVerdict(milestoneId);
  }
  const assessment = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  const status = typeof assessment?.status === "string" ? assessment.status : undefined;
  return status && isValidMilestoneVerdict(status) ? status : undefined;
}

export async function resolveMilestoneValidationVerdict(
  _basePath: string,
  milestoneId: string,
): Promise<ValidationVerdict | undefined> {
  return readMilestoneValidationVerdict(milestoneId);
}
