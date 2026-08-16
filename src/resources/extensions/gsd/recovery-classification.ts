// Project/App: gsd-pi
// File Purpose: ADR-015 Recovery Classification module for runtime failure taxonomy.

import { isToolUnavailableError } from "./auto-tool-tracking.js";
import { classifyError, isTransient, type ErrorClass } from "./error-classifier.js";
import { recoveryRemediation } from "./guidance.js";
import { isTerminalToolSurfaceError } from "./tool-surface-readiness.js";
import { ReconciliationFailedError } from "./state-reconciliation.js";
import { IllegalPhaseTransitionError } from "./state-transition-matrix.js";
import {
  isTransientProjectionLockError,
  ProjectionLockTransientError,
} from "./projection-root-errors.js";

export type RecoveryFailureKind =
  | "tool-schema"
  | "tool-contract"
  | "tool-unavailable"
  | "deterministic-policy"
  | "lifecycle-progression"
  | "stale-worker"
  | "worktree-invalid"
  | "verification-drift"
  | "reconciliation-drift"
  | "illegal-transition"
  | "projection-lock-transient"
  | "provider"
  | "runtime-unknown";

export type RecoveryAction = "retry" | "escalate" | "stop";

export interface RecoveryClassificationInput {
  error: unknown;
  unitType?: string;
  unitId?: string;
  failureKind?: RecoveryFailureKind;
  retryAfterMs?: number;
}

export interface RecoveryClassification {
  failureKind: RecoveryFailureKind;
  action: RecoveryAction;
  reason: string;
  exitReason: string;
  remediation: string;
  providerClass?: ErrorClass["kind"];
}

export function classifyFailure(input: RecoveryClassificationInput): RecoveryClassification {
  const message = errorMessage(input.error);
  // ADR-017: ReconciliationFailedError is a typed throw from the State
  // Reconciliation Module. Recognize it by class regardless of caller-supplied
  // failureKind so the taxonomy stays consistent.
  const failureKind =
    input.error instanceof ReconciliationFailedError
      ? "reconciliation-drift"
      : input.error instanceof IllegalPhaseTransitionError
        ? "illegal-transition"
        : input.error instanceof ProjectionLockTransientError
          ? "projection-lock-transient"
        : input.failureKind ?? inferFailureKind(message);

  if (failureKind === "provider") {
    const providerClass = classifyError(message, input.retryAfterMs);
    const transient = isTransient(providerClass);
    return {
      failureKind,
      action: transient ? "retry" : "escalate",
      reason: message,
      exitReason: `provider-${providerClass.kind}`,
      remediation: recoveryRemediation(transient ? "provider-transient" : "provider-permanent"),
      providerClass: providerClass.kind,
    };
  }

  const { action, label } = FAILURE_TAXONOMY[failureKind];
  return {
    failureKind,
    action,
    reason: label ? `${label}${unitSuffix(input)}: ${message}` : message,
    exitReason: failureKind,
    remediation: recoveryRemediation(failureKind),
  };
}

/** Per-kind action and reason label. Remediation lives in the Guidance module. */
const FAILURE_TAXONOMY: Record<
  Exclude<RecoveryFailureKind, "provider">,
  { action: RecoveryAction; label: string | null }
> = {
  "tool-schema": { action: "stop", label: "Tool schema failure" },
  "tool-contract": { action: "stop", label: "Tool Contract failure" },
  "tool-unavailable": { action: "retry", label: "Tool unavailable" },
  "deterministic-policy": { action: "stop", label: "Deterministic policy failure" },
  "lifecycle-progression": { action: "stop", label: "Lifecycle progression failure" },
  "stale-worker": { action: "stop", label: "Stale worker failure" },
  "worktree-invalid": { action: "stop", label: "Worktree invalid" },
  "verification-drift": { action: "escalate", label: "Verification drift" },
  "reconciliation-drift": { action: "escalate", label: "Reconciliation drift" },
  "illegal-transition": { action: "escalate", label: "Illegal phase transition" },
  "projection-lock-transient": { action: "retry", label: "Projection root busy" },
  "runtime-unknown": { action: "escalate", label: null },
};

function inferFailureKind(message: string): RecoveryFailureKind {
  // A terminal tool-surface failure (workflow MCP server in failed/needs-auth/
  // disabled) will not self-heal, so it must escalate rather than retry the
  // same model into the per-unit cost cap. Checked before the generic
  // tool-unavailable branch, which matches the same readiness prefix and
  // would otherwise route it to retry. See #783.
  if (isTerminalToolSurfaceError(message)) return "runtime-unknown";
  if (isToolUnavailableError(message)) return "tool-unavailable";
  if (isTransientProjectionLockError(message)) return "projection-lock-transient";
  if (/tool contract|auto-unit tool scope|phase-boundary gate|not permitted.*own/i.test(message)) return "tool-contract";
  if (/lifecycle progression|required artifact|missing .*assessment|missing .*closeout|cannot legally (?:advance|progress)/i.test(message)) return "lifecycle-progression";
  if (/schema|invalid.*tool|tool.*invalid|enum/i.test(message)) return "tool-schema";
  if (/deterministic policy|policy rejection|write gate|blocked by policy/i.test(message)) return "deterministic-policy";
  if (/stale worker|stale lock|worker.*stale/i.test(message)) return "stale-worker";
  if (/worktree|\.git|unit root|git metadata/i.test(message)) return "worktree-invalid";
  if (/verification drift|assessment drift|state drift/i.test(message)) return "verification-drift";

  const providerClass = classifyError(message);
  return providerClass.kind === "unknown" ? "runtime-unknown" : "provider";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown runtime failure");
}

function unitSuffix(input: RecoveryClassificationInput): string {
  if (!input.unitType && !input.unitId) return "";
  return ` for ${input.unitType ?? "unit"} ${input.unitId ?? ""}`.trimEnd();
}
