// Project/App: gsd-pi
// File Purpose: Resolve the authoritative milestone validation verdict from SQLite.

import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";
import {
  isValidMilestoneVerdict,
  type ValidationVerdict,
} from "./verdict-parser.js";

/**
 * Resolve the current database verdict. VALIDATION.md is a projection and can
 * only enter authority through an explicit import operation.
 */
export function readMilestoneValidationVerdict(
  milestoneId: string,
): ValidationVerdict | undefined {
  if (!isDbAvailable()) return undefined;
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
