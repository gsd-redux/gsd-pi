// Project/App: gsd-pi
// File Purpose: Host-owned verification verdict policy for auto-mode units.

import type { VerificationResult as VerificationGateResult } from "./types.js";

export type VerificationVerdictReason =
  | "passed"
  | "no-host-checks"
  | "command-not-found"
  | "checks-failed";

export interface VerificationVerdict {
  passed: boolean;
  reason: VerificationVerdictReason;
  retryable: boolean;
  failureContext: string;
}

export const NO_HOST_CHECKS_FAILURE_CONTEXT =
  "No runnable host-owned verification command was discovered. Add project verification_commands in .gsd/PREFERENCES.md or a runnable task-plan Verify command, then resume with /gsd next.";

export const UNSAFE_TASK_VERIFY_FAILURE_CONTEXT =
  "The task-plan Verify field names commands, but none are shell-safe (unquoted redirects, `;`, `$(...)` or backticks). Project-wide checks were not run in their place. Rewrite the Verify field as plain newline-separated commands, then resume with /gsd next.";

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
  const unrunnableCheck = result.checks.find((check) => check.failureClass === "command-not-found");
  if (unrunnableCheck) {
    return {
      passed: false,
      reason: "command-not-found",
      retryable: false,
      failureContext: `Verify command not runnable on this platform: \`${unrunnableCheck.command}\``,
    };
  }

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

  if (
    unitType === "execute-task" &&
    (result.discoverySource === "none" || result.discoverySource === "task-plan-unsafe") &&
    result.checks.length === 0
  ) {
    return {
      passed: false,
      reason: "no-host-checks",
      retryable: false,
      failureContext: result.discoverySource === "task-plan-unsafe"
        ? UNSAFE_TASK_VERIFY_FAILURE_CONTEXT
        : NO_HOST_CHECKS_FAILURE_CONTEXT,
    };
  }

  return {
    passed: true,
    reason: "passed",
    retryable: false,
    failureContext: "",
  };
}
