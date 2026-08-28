/**
 * Lightweight content validator for auto-mode safety harness.
 * Validates that high-value unit outputs contain minimum expected content.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { existsSync, readFileSync } from "node:fs";
import { logWarning } from "../workflow-logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContentViolation {
  severity: "error" | "warning";
  reason: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate content quality for a completed unit.
 * Returns an array of violations. Empty array = content looks acceptable.
 *
 * @param unitType - The type of unit that completed (e.g. "plan-slice")
 * @param artifactPath - Absolute path to the primary artifact file
 */
export function validateContent(
  unitType: string,
  artifactPath: string | null,
): ContentViolation[] {
  if (!artifactPath || !existsSync(artifactPath)) return [];

  const validator = VALIDATORS[unitType];
  if (!validator) return [];

  try {
    const content = readFileSync(artifactPath, "utf-8");
    return validator(content);
  } catch (e) {
    logWarning("safety", `content validation read failed: ${(e as Error).message}`);
    return [];
  }
}

// ─── Validators ─────────────────────────────────────────────────────────────

type ContentValidatorFn = (content: string) => ContentViolation[];

// Matches local or slice-qualified task IDs in legacy and flat-phase formats.
const TASK_MARKER_RE = /^\s*(?:-\s+\[[ xX]\]\s+\*\*(?:S\d+[.-])?T\d+(?:\*\*)?:|#{2,4}\s+(?:S\d+[.-])?T\d+\b)/gm;
const SLICE_MARKER_RE = /^\s*(?:-\s+\[[ xX]\]\s+\*\*S\d+:|#{2,4}\s+S\d+\b)/gm;

const VALIDATORS: Record<string, ContentValidatorFn> = {
  "plan-slice": validatePlanSlice,
  "plan-milestone": validatePlanMilestone,
};

function validatePlanSlice(content: string): ContentViolation[] {
  const violations: ContentViolation[] = [];

  // Must have at least 1 task entry — single-task slices are valid (#3649)
  const taskCount = (content.match(TASK_MARKER_RE) || []).length;
  if (taskCount < 1) {
    violations.push({
      severity: "error",
      reason: `Slice plan has ${taskCount} task(s) — expected at least 1`,
    });
  }

  // Should have a Files Likely Touched section
  if (!content.includes("## Files Likely Touched") && !content.includes("## Files")) {
    violations.push({
      severity: "warning",
      reason: "Slice plan missing 'Files Likely Touched' section",
    });
  }

  // Should have a verification section
  if (!content.includes("Verify") && !content.includes("verify")) {
    violations.push({
      severity: "warning",
      reason: "Slice plan has no verification instructions",
    });
  }

  return violations;
}

function validatePlanMilestone(content: string): ContentViolation[] {
  const violations: ContentViolation[] = [];

  // Must have at least 1 slice entry
  const sliceCount = (content.match(SLICE_MARKER_RE) || []).length;
  if (sliceCount < 1) {
    violations.push({
      severity: "error",
      reason: `Milestone roadmap has ${sliceCount} slice(s) — expected at least 1`,
    });
  }

  return violations;
}
