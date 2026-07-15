// Project/App: gsd-pi
// File Purpose: Resolve the authoritative milestone validation verdict from SQLite.

import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { captureMilestoneVerificationSourceRevision } from "./verification-source-integrity.js";
import {
  isValidMilestoneVerdict,
  type ValidationVerdict,
} from "./verdict-parser.js";

export type MilestoneValidationStateVerdict = ValidationVerdict | "omitted";

/**
 * Resolve the current database verdict. VALIDATION.md is a projection and can
 * only enter authority through an explicit import operation.
 */
export function readMilestoneValidationVerdict(
  milestoneId: string,
): MilestoneValidationStateVerdict | undefined {
  if (!isDbAvailable()) return undefined;
  const assessment = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  const status = typeof assessment?.status === "string" ? assessment.status : undefined;
  if (status === "omitted") return status;
  return status && isValidMilestoneVerdict(status) ? status : undefined;
}

export async function resolveMilestoneValidationVerdict(
  basePath: string,
  milestoneId: string,
): Promise<MilestoneValidationStateVerdict | undefined> {
  const verdict = readMilestoneValidationVerdict(milestoneId);
  if (verdict !== "omitted") return verdict;

  const assessment = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  const content = typeof assessment?.full_content === "string" ? assessment.full_content : "";
  const testedSourceRevision = content.match(/^source_revision:\s*(\S+)$/im)?.[1];
  if (!testedSourceRevision) return undefined;
  try {
    const preferences = loadEffectiveGSDPreferences(basePath)?.preferences;
    const current = captureMilestoneVerificationSourceRevision(basePath, preferences);
    return current.ok && current.sourceRevision === testedSourceRevision ? verdict : undefined;
  } catch {
    return undefined;
  }
}
