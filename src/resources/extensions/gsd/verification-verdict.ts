// Project/App: gsd-pi
// File Purpose: Host-owned verification verdict policy for auto-mode units.

import type { VerificationResult as VerificationGateResult } from "./types.js";

export type VerificationVerdictReason =
  | "passed"
  | "no-host-checks"
  | "checks-failed";

export interface VerificationVerdict {
  passed: boolean;
  reason: VerificationVerdictReason;
  retryable: boolean;
  failureContext: string;
}

export const NO_HOST_CHECKS_FAILURE_CONTEXT =
  "No runnable host-owned verification command was discovered. Add project verification_commands in .gsd/PREFERENCES.md or a runnable task-plan Verify command, then resume with /gsd next.";

/** Diagnostic recovery rationale: check, observed vs expected, evidence, next action (#1747). */
export function describeHostVerificationRationale(input: {
  verdict: "fail" | "inconclusive";
  checkName: string;
  observed: string;
  expected: string;
  evidenceRef: string;
  nextAction?: string;
}): string {
  const next = input.nextAction
    ? ` ${input.nextAction}`
    : input.verdict === "inconclusive"
      ? " To become conclusive, supply the missing or matching evidence and resume."
      : "";
  return `Host verification ${input.verdict}: check ${input.checkName} observed ${input.observed}, expected ${input.expected}. Evidence: ${input.evidenceRef}.${next}`;
}

export function decideVerificationVerdict(
  unitType: string,
  result: VerificationGateResult,
): VerificationVerdict {
  if (!result.passed) {
    const failureContext = (result.runtimeErrors ?? [])
      .filter((error) => error.blocking)
      .map((error) => `[${error.source}] ${error.message}`)
      .join("\n");
    return {
      passed: false,
      reason: "checks-failed",
      retryable: true,
      failureContext,
    };
  }

  if (unitType === "execute-task" && result.discoverySource === "task-plan-prose" && result.checks.length === 0) {
    return {
      passed: true,
      reason: "passed",
      retryable: false,
      failureContext: "",
    };
  }

  if (unitType === "execute-task" && result.discoverySource === "none" && result.checks.length === 0) {
    return {
      passed: false,
      reason: "no-host-checks",
      retryable: false,
      failureContext: NO_HOST_CHECKS_FAILURE_CONTEXT,
    };
  }

  return {
    passed: true,
    reason: "passed",
    retryable: false,
    failureContext: "",
  };
}
