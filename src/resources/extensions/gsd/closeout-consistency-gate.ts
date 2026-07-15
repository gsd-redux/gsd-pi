// Project/App: gsd-pi
// File Purpose: Shared DB-backed guard for milestone closeout finalization.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  getLatestAssessmentByScope,
  getMilestone,
  getMilestoneSlices,
  getPendingGates,
  getSliceTasks,
  insertAssessment,
  isDbAvailable,
  transaction,
} from "./gsd-db.js";
import {
  getWorkflowDatabasePath,
  refreshWorkflowDatabaseFromDisk,
} from "./db-workspace.js";
import { isClosedStatus, isDeferredStatus } from "./status-guards.js";
import {
  closeQualityGatesFromEvidence,
  inspectQualityGatesFromEvidence,
  type QualityGateClosureOptions,
} from "./quality-gate-closure.js";
import { insertMilestoneValidationGates } from "./milestone-validation-gates.js";
import { relMilestoneFile, resolveSliceFile } from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import {
  isMilestoneLifecycleAdopted,
  readMilestoneCloseoutAuthorization,
} from "./db/milestone-closeout-readiness.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { captureMilestoneVerificationSourceRevision } from "./verification-source-integrity.js";

export const CLOSEOUT_CONSISTENCY_BLOCKED_REASON = "closeout-consistency-blocked";

export type CloseoutConsistencyFailureReason =
  | "db-unavailable"
  | "db-refresh-failed"
  | "milestone-missing"
  | "milestone-open"
  | "validation-not-pass"
  | "slice-missing"
  | "slice-open"
  | "task-open"
  | "quality-gate-pending";

export type CloseoutConsistencyResult =
  | { ok: true }
  | {
      ok: false;
      reason: CloseoutConsistencyFailureReason;
      recoveryReason: typeof CLOSEOUT_CONSISTENCY_BLOCKED_REASON;
      message: string;
    };

export interface CloseoutConsistencyOptions {
  refreshFromDisk?: boolean;
  allowOpenMilestone?: boolean;
  artifactBasePath?: string;
  allowPassThroughValidation?: boolean;
}

function blocked(reason: CloseoutConsistencyFailureReason, message: string): CloseoutConsistencyResult {
  return {
    ok: false,
    reason,
    recoveryReason: CLOSEOUT_CONSISTENCY_BLOCKED_REASON,
    message,
  };
}

function isFileBackedDbPath(path: string | null): boolean {
  return Boolean(path && path !== ":memory:");
}

function artifactBasePathFromDb(): string | undefined {
  const dbPath = getWorkflowDatabasePath();
  if (!isFileBackedDbPath(dbPath)) return undefined;
  return dirname(dirname(dbPath!));
}

function allSlicesHaveCloseoutSummaryEvidence(milestoneId: string, artifactBasePath: string): boolean {
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return false;

  return slices.every((slice) => {
    if (!isClosedStatus(slice.status)) return false;
    for (const task of getSliceTasks(milestoneId, slice.id)) {
      if (!isClosedStatus(task.status)) return false;
    }
    const summaryPath = resolveSliceFile(artifactBasePath, milestoneId, slice.id, "SUMMARY");
    return Boolean(summaryPath && existsSync(summaryPath));
  });
}

function renderCloseoutPassThroughValidation(milestoneId: string): string {
  return [
    "---",
    "verdict: pass",
    "skip_validation: true",
    "skip_validation_reason: closeout-recovery",
    "remediation_round: 0",
    "---",
    "",
    "# Milestone Validation (skipped)",
    "",
    `Milestone validation was recorded during closeout for ${milestoneId} because all slices already had SUMMARY evidence and no milestone-validation assessment was present.`,
    "",
  ].join("\n");
}

function recordCloseoutPassThroughValidationIfReady(
  milestoneId: string,
  artifactBasePath?: string,
): boolean {
  const basePath = artifactBasePath ?? artifactBasePathFromDb();
  if (!basePath) return false;

  const existing = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  if (existing?.status === "pass") return true;
  if (existing) return false;
  if (!allSlicesHaveCloseoutSummaryEvidence(milestoneId, basePath)) return false;

  const validationPath = join(basePath, relMilestoneFile(basePath, milestoneId, "VALIDATION"));
  const content = renderCloseoutPassThroughValidation(milestoneId);
  mkdirSync(dirname(validationPath), { recursive: true });
  writeFileSync(validationPath, content, "utf-8");

  try {
    transaction(() => {
      insertAssessment({
        path: validationPath,
        milestoneId,
        sliceId: null,
        taskId: null,
        status: "pass",
        scope: "milestone-validation",
        fullContent: content,
      });
      const gateSliceId = getMilestoneSlices(milestoneId)[0]?.id;
      if (gateSliceId) {
        insertMilestoneValidationGates(
          milestoneId,
          gateSliceId,
          "pass",
          new Date().toISOString(),
        );
      }
    });
  } catch (err) {
    try {
      unlinkSync(validationPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }

  invalidateAllCaches();
  return true;
}

export function checkCloseoutConsistencyGate(
  milestoneId: string,
  options: CloseoutConsistencyOptions = {},
): CloseoutConsistencyResult {
  if (!isDbAvailable()) {
    return blocked(
      "db-unavailable",
      `Closeout consistency blocked for ${milestoneId}: canonical DB is unavailable.`,
    );
  }

  if (options.refreshFromDisk && isFileBackedDbPath(getWorkflowDatabasePath()) && !refreshWorkflowDatabaseFromDisk()) {
    return blocked(
      "db-refresh-failed",
      `Closeout consistency blocked for ${milestoneId}: canonical DB refresh failed.`,
    );
  }

  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    return blocked(
      "milestone-missing",
      `Closeout consistency blocked for ${milestoneId}: milestone is missing from canonical DB.`,
    );
  }
  if (!isClosedStatus(milestone.status) && !options.allowOpenMilestone) {
    return blocked(
      "milestone-open",
      `Closeout consistency blocked for ${milestoneId}: canonical DB milestone status is "${milestone.status}".`,
    );
  }

  const adoptedMilestone = isMilestoneLifecycleAdopted(milestoneId);
  const validationRequired = adoptedMilestone || milestone.status !== "skipped";
  let validation = validationRequired && !adoptedMilestone
    ? getLatestAssessmentByScope(milestoneId, "milestone-validation")
    : null;
  if (
    validationRequired &&
    !adoptedMilestone &&
    validation?.status !== "pass" &&
    options.allowPassThroughValidation &&
    recordCloseoutPassThroughValidationIfReady(
      milestoneId,
      options.artifactBasePath ?? artifactBasePathFromDb(),
    )
  ) {
    validation = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  }
  let canonicalAuthorization = null;
  if (adoptedMilestone) {
    const artifactBasePath = options.artifactBasePath ?? artifactBasePathFromDb();
    if (!artifactBasePath) {
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: canonical verification source root is unavailable.`,
      );
    }
    const source = captureMilestoneVerificationSourceRevision(
      artifactBasePath,
      loadEffectiveGSDPreferences(artifactBasePath)?.preferences,
    );
    if (!source.ok) {
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: ${source.error}`,
      );
    }
    canonicalAuthorization = readMilestoneCloseoutAuthorization({
      milestoneId,
      sourceRevision: source.sourceRevision,
    });
  }
  if (validationRequired) {
    if (canonicalAuthorization) {
      if (!canonicalAuthorization.authorized) {
        return blocked(
          "validation-not-pass",
          `Closeout consistency blocked for ${milestoneId}: canonical milestone validation authorization is not current.`,
        );
      }
    } else if (validation?.status !== "pass") {
      const validationStatus = validation?.status ?? "absent";
      const recovery =
        validationStatus === "absent"
          ? ` Run \`/gsd validate-milestone ${milestoneId}\` to create the validation, or set \`phases.skip_milestone_validation: true\` in .gsd/PREFERENCES.md to skip it.`
          : "";
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: latest milestone validation is "${validationStatus}".${recovery}`,
      );
    }
  }

  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0 && milestone.status !== "skipped") {
    return blocked(
      "slice-missing",
      `Closeout consistency blocked for ${milestoneId}: no slices exist in canonical DB.`,
    );
  }

  let gateClosureOptions: QualityGateClosureOptions | null = null;
  if (validationRequired) {
    gateClosureOptions = canonicalAuthorization?.authorized
      ? { milestoneValidationAuthorization: canonicalAuthorization }
      : {
          artifactBasePath: options.artifactBasePath ?? artifactBasePathFromDb(),
          milestoneValidationPassed: validation?.status === "pass",
        };
  }
  const plannedGateClosure = gateClosureOptions
    ? inspectQualityGatesFromEvidence(milestoneId, gateClosureOptions)
    : { repaired: [], unresolved: [] };

  for (const slice of slices) {
    if (isDeferredStatus(slice.status)) continue;
    if (!isClosedStatus(slice.status)) {
      return blocked(
        "slice-open",
        `Closeout consistency blocked for ${milestoneId}: slice ${slice.id} status is "${slice.status}".`,
      );
    }

    for (const task of getSliceTasks(milestoneId, slice.id)) {
      if (!isClosedStatus(task.status)) {
        return blocked(
          "task-open",
          `Closeout consistency blocked for ${milestoneId}: task ${slice.id}/${task.id} status is "${task.status}".`,
        );
      }
    }

    const pendingGate = getPendingGates(milestoneId, slice.id).find((gate) =>
      !plannedGateClosure.repaired.some((repair) =>
        repair.gateId === gate.gate_id
        && repair.sliceId === gate.slice_id
        && (repair.taskId ?? "") === gate.task_id
      )
    );
    if (pendingGate) {
      return blocked(
        "quality-gate-pending",
        `Closeout consistency blocked for ${milestoneId}: quality gate ${pendingGate.gate_id} is still pending for ${slice.id}.`,
      );
    }
  }

  if (!adoptedMilestone && gateClosureOptions) {
    closeQualityGatesFromEvidence(milestoneId, gateClosureOptions);
  }

  return { ok: true };
}

export function formatCloseoutConsistencyBlock(result: CloseoutConsistencyResult): string {
  if (result.ok) return "";
  return `${result.message} Recovery reason: ${result.recoveryReason}. Resolve the canonical DB state and run /gsd auto to retry.`;
}
