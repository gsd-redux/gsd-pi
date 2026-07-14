// Project/App: gsd-pi
// File Purpose: Verifies auto-mode artifacts and manages recovery placeholders.
/**
 * Auto-mode Recovery — artifact resolution, verification, blocker placeholders,
 * skip artifacts, merge state reconciliation,
 * self-heal runtime records, and loop remediation steps.
 *
 * Pure functions that receive all needed state as parameters — no module-level
 * globals or AutoContext dependency.
 */

import { parseUnitId } from "./unit-id.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { appendEvent } from "./workflow-events.js";
import { clearParseCache } from "./files.js";
import {
  isDbAvailable,
  getDb,
  getTask,
  getSlice,
  getSliceTasks,
  getPendingGatesForTurn,
  insertSlice,
  getMilestone,
  immediateTransaction,
  updateMilestoneStatus,
  getCompletedMilestoneTaskFileHints,
  getMilestoneCommitAttributionShas,
  recordMilestoneCommitAttribution,
} from "./gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { isValidationTerminal } from "./state.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning, logError } from "./workflow-logger.js";
import { readIntegrationBranch } from "./git-service.js";
import { isClosedStatus } from "./status-guards.js";
import {
  resolveSlicePath,
  resolveSliceFile,
  resolveTaskFile,
  relMilestoneFile,
  relSliceFile,
  buildSliceFileName,
  resolveMilestoneFile,
  clearPathCache,
  resolveGsdRootFile,
} from "./paths.js";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";

import { LAYOUT_SEGMENTS } from "./layout-policy.js";
import { dirname, join, resolve } from "node:path";
import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact,
} from "./auto-artifact-paths.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { hasVerdict } from "./verdict-parser.js";
import { validateArtifact } from "./schemas/validate.js";
import { getProjectResearchStatus } from "./project-research-policy.js";
import { isGsdWorktreePath } from "./worktree-root.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";
import { loadAllCaptures, loadPendingCaptures } from "./captures.js";
import {
  readExecuteTaskArtifactReadiness,
  resolveArtifactVerificationBase,
} from "./artifact-verification.js";
import {
  proveMilestoneCloseout,
  type CloseoutProofFailureReason,
} from "./milestone-closeout-proof.js";
import { isMilestoneLifecycleAdopted } from "./db/milestone-closeout-readiness.js";
import { compareLifecycleShadow } from "./db/lifecycle-shadow-comparison.js";
import { readCurrentMilestoneCompletionReceipt } from "./milestone-lifecycle-domain-operation.js";

// Re-export so existing consumers of auto-recovery.ts keep working.
export { resolveExpectedArtifactPath, diagnoseExpectedArtifact };
export {
  classifyMilestoneSummaryContent,
  type MilestoneSummaryOutcome,
} from "./milestone-summary-classifier.js";
export { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";
export {
  verifyExpectedArtifact,
  diagnoseWorktreeIntegrityFailure,
  resolveArtifactVerificationBase,
  _setRoadmapParserFnForTests,
} from "./artifact-verification.js";

/**
 * Optional override for the detached GitHub milestone finalize invoked after DB
 * closeout in refreshRecoveryDbForArtifact. Production leaves this null so the
 * real finalizeMilestoneGitHubSync runs; tests inject a throwing function to
 * deterministically exercise the best-effort catch (auto-recovery.ts:232),
 * which otherwise needs a real GitHub remote + network failure.
 * @internal
 */
let _githubFinalizeFn: ((basePath: string, mid: string) => void | Promise<void>) | null = null;

export function _setGithubFinalizeFnForTests(
  fn: ((basePath: string, mid: string) => void | Promise<void>) | null,
): () => void {
  const previous = _githubFinalizeFn;
  _githubFinalizeFn = fn;
  return () => { _githubFinalizeFn = previous; };
}

// ─── Recovery DB refresh ──────────────────────────────────────────────────────

export type ArtifactRecoveryDbRefreshResult =
  | { ok: true }
  | { ok: false; fatal: boolean; message: string; reason: string };

function closeoutProofRecoveryReason(reason: CloseoutProofFailureReason): string {
  switch (reason) {
    case "slice-missing":
      return "complete-milestone-slices-missing";
    case "summary-artifact-missing":
      return "complete-milestone-summary-missing";
    case "summary-artifact-failed":
      return "complete-milestone-summary-failed";
    default:
      return `complete-milestone-${reason}`;
  }
}

function adoptedMilestoneRecoveryResult(
  milestoneId: string,
  legacyStatus: string,
): ArtifactRecoveryDbRefreshResult {
  try {
    const completion = readCurrentMilestoneCompletionReceipt(milestoneId);
    if (completion) {
      const shadow = compareLifecycleShadow(legacyStatus, "completed");
      const matchesCompletedShadow = shadow.normalizedLegacyStatus === "completed" &&
        shadow.normalizedCanonicalStatus === "completed";
      if (matchesCompletedShadow) return { ok: true };
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-adopted-state-mismatch",
        message: `Stuck recovery found a current canonical completion receipt for ${milestoneId}, but legacy status is ${legacyStatus}; refusing to hide the lifecycle mismatch.`,
      };
    }

    return {
      ok: false,
      fatal: true,
      reason: "complete-milestone-canonical-command-required",
      message: `Stuck recovery cannot complete adopted Milestone ${milestoneId} from artifacts; retry the original completion invocation or dispatch the normal completion command.`,
    };
  } catch (error) {
    return {
      ok: false,
      fatal: true,
      reason: "complete-milestone-canonical-receipt-invalid",
      message: `Stuck recovery could not verify the canonical completion receipt for ${milestoneId}: ${getErrorMessage(error)}`,
    };
  }
}

export function refreshRecoveryDbForArtifact(
  unitType: string,
  unitId: string,
  basePath: string,
): ArtifactRecoveryDbRefreshResult {
  if (unitType !== "plan-slice" && unitType !== "execute-task" && unitType !== "complete-milestone") return { ok: true };
  if (!isDbAvailable()) {
    if (unitType === "execute-task") {
      return {
        ok: false,
        fatal: false,
        reason: "execute-task-attempt-db-unavailable",
        message: `Stuck recovery cannot confirm canonical Task Attempt readiness for execute-task ${unitId} because the workflow DB is unavailable.`,
      };
    }
    return { ok: true };
  }

  if (unitType === "execute-task") {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    if (!mid || !sid || !tid) {
      return {
        ok: false,
        fatal: true,
        reason: "execute-task-invalid-unit-id",
        message: `Stuck recovery found execute-task ${unitId} artifacts, but the unit id could not be parsed for DB verification.`,
      };
    }
    if (!getTask(mid, sid, tid)) {
      return {
        ok: false,
        fatal: true,
        reason: "execute-task-artifact-db-missing",
        message: `Stuck recovery found execute-task ${unitId} artifacts, but no matching DB task row exists.`,
      };
    }
    let readiness: ReturnType<typeof readExecuteTaskArtifactReadiness>;
    try {
      readiness = readExecuteTaskArtifactReadiness(mid, sid, tid);
    } catch (err) {
      return {
        ok: false,
        fatal: true,
        reason: "execute-task-attempt-read-failed",
        message: `Stuck recovery could not read canonical Task Attempt state for execute-task ${unitId}: ${getErrorMessage(err)}`,
      };
    }
    if (!readiness) {
      return {
        ok: false,
        fatal: true,
        reason: "execute-task-attempt-not-actionable",
        message: `Stuck recovery found execute-task ${unitId} artifacts, but its latest canonical Task Attempt has no actionable verify or route Result.`,
      };
    }
    return { ok: true };
  }

  if (!refreshWorkflowDatabaseFromDisk()) {
    return {
      ok: false,
      fatal: unitType === "complete-milestone",
      reason: `${unitType}-db-refresh-failed`,
      message: `Stuck recovery found ${unitType} ${unitId} artifacts, but the DB refresh failed.`,
    };
  }

  if (unitType === "complete-milestone") {
    const { milestone: mid } = parseUnitId(unitId);
    if (!mid) {
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-invalid-unit-id",
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but the unit id could not be parsed for DB reconciliation.`,
      };
    }

    const observedResult = immediateTransaction<ArtifactRecoveryDbRefreshResult | null>(() => {
      const milestone = getMilestone(mid);
      if (!milestone) {
        return {
          ok: false,
          fatal: true,
          reason: "complete-milestone-artifact-db-missing",
          message: `Stuck recovery found complete-milestone ${unitId} artifacts, but no matching DB milestone row exists after refresh.`,
        };
      }
      if (isMilestoneLifecycleAdopted(mid)) {
        return adoptedMilestoneRecoveryResult(mid, milestone.status);
      }
      return isClosedStatus(milestone.status) ? { ok: true } : null;
    });
    if (observedResult) return observedResult;

    const artifactBasePath = resolveArtifactVerificationBase(unitId, basePath);
    const closeoutProof = proveMilestoneCloseout(mid, {
      allowOpenMilestone: true,
      summaryArtifactBasePath: artifactBasePath,
      implementationEvidence: {
        basePath,
        requirement: "present",
      },
    });
    if (!closeoutProof.ok) {
      if (closeoutProof.reason === "implementation-evidence-missing") {
        return {
          ok: false,
          fatal: true,
          reason: "complete-milestone-implementation-missing",
          message: `Stuck recovery found complete-milestone ${unitId} artifacts, but implementation evidence is not present.`,
        };
      }
      return {
        ok: false,
        fatal: true,
        reason: closeoutProofRecoveryReason(closeoutProof.reason),
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but ${closeoutProof.message}`,
      };
    }

    const concurrentResult = immediateTransaction<ArtifactRecoveryDbRefreshResult | null>(() => {
      const currentMilestone = getMilestone(mid);
      if (!currentMilestone) {
        return {
          ok: false,
          fatal: true,
          reason: "complete-milestone-artifact-db-missing",
          message: `Stuck recovery found complete-milestone ${unitId} artifacts, but the DB milestone disappeared before compatibility closeout.`,
        };
      }
      if (isMilestoneLifecycleAdopted(mid)) {
        return adoptedMilestoneRecoveryResult(mid, currentMilestone.status);
      }
      if (isClosedStatus(currentMilestone.status)) return { ok: true };
      updateMilestoneStatus(mid, "complete", new Date().toISOString());
      return null;
    });
    if (concurrentResult) return concurrentResult;
    // Detached GitHub sync — best-effort. Test seam: when
    // _githubFinalizeFn is injected, route through it so the catch
    // (:232) is deterministically reachable (otherwise it needs a real
    // GitHub remote + network failure). Production leaves it null. The
    // seam is wrapped so a synchronous throw becomes a rejected promise,
    // matching the real import-then-call deferred semantics.
    const finalizePromise = _githubFinalizeFn
      ? new Promise<void>((resolve) => { resolve(_githubFinalizeFn!(basePath, mid)); })
      : import("../github-sync/sync.js").then(({ finalizeMilestoneGitHubSync }) => finalizeMilestoneGitHubSync(basePath, mid));
    void finalizePromise.catch((err) => {
      logWarning("recovery", `GitHub milestone finalize failed after DB closeout: ${getErrorMessage(err)}`);
    });
    return { ok: true };
  }

  return { ok: true };
}

export interface ReactiveExecuteBlockerRecovery {
  blockerPath: string;
  completedTaskIds: string[];
  skippedTaskIds: string[];
  unchangedTaskIds: string[];
}

/**
 * Diagnostic placeholder for a failed reactive-execute batch.
 *
 * SUMMARY files are projection evidence only. This records which projections
 * exist without changing canonical Task state or appending lifecycle events.
 */
export function writeReactiveExecuteBlocker(
  unitId: string,
  base: string,
  reason: string,
): ReactiveExecuteBlockerRecovery | null {
  if (!isDbAvailable()) return null;

  const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
  if (!mid || !sid || !batchPart) return null;

  const plusIdx = batchPart.indexOf("+");
  if (plusIdx === -1) return null;
  const batchIds = batchPart.slice(plusIdx + 1).split(",").map((id) => id.trim()).filter(Boolean);
  if (batchIds.length === 0) return null;

  const blockerPath = resolveExpectedArtifactPath("reactive-execute", unitId, base);
  if (!blockerPath) return null;

  const slicePath = resolveSlicePath(base, mid, sid);
  if (!slicePath) return null;

  // Resolve each batch task's SUMMARY with slice-qualified paths so flat-phase
  // slices that reuse a task id (e.g. two T03s in one phase) don't collide: a
  // sibling slice's summary must never make this slice's task look complete.
  const hasSummary = (tid: string): boolean => {
    const summaryPath = resolveTaskFile(base, mid, sid, tid, "SUMMARY");
    return summaryPath !== null && existsSync(summaryPath);
  };

  const summaryPresent = batchIds.filter((tid) => hasSummary(tid));
  const summaryMissing = batchIds.filter((tid) => !hasSummary(tid));

  const dir = dirname(blockerPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = [
    "# BLOCKER — reactive-execute batch recovery",
    "",
    `Unit \`reactive-execute\` for \`${unitId}\` failed to produce all task summaries after verification retries were exhausted.`,
    "",
    `**Reason**: ${reason}`,
    "",
    `**Batch tasks**: ${batchIds.join(", ")}`,
    `**Summary present**: ${summaryPresent.length > 0 ? summaryPresent.join(", ") : "none"}`,
    `**Summary missing**: ${summaryMissing.length > 0 ? summaryMissing.join(", ") : "none"}`,
    "**Canonical Task changes**: none",
    "",
    "This diagnostic placeholder does not complete, skip, or cancel Tasks.",
    "Review the durable recovery state before relying on downstream artifacts.",
  ].join("\n");
  writeFileSync(blockerPath, content, "utf-8");

  clearPathCache();
  clearParseCache();

  return {
    blockerPath,
    completedTaskIds: [],
    skippedTaskIds: [],
    unchangedTaskIds: batchIds,
  };
}

/**
 * Whether a milestone already has canonical Domain-Operation lifecycle
 * history. Adopted milestones must not have a fabricated blocker slice
 * inserted to paper over a stuck plan-milestone unit (fail-closed).
 */
function hasAdoptedMilestoneHistory(milestoneId: string): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1 AS adopted
    FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone'
      AND milestone_id = :milestone_id
      AND slice_id IS NULL
      AND task_id IS NULL
  `).get({ ":milestone_id": milestoneId }));
}

/**
 * Write a placeholder artifact so the pipeline can advance past a stuck unit.
 * Returns the relative path written, or null if the path couldn't be resolved.
 */
export function writeBlockerPlaceholder(
  unitType: string,
  unitId: string,
  base: string,
  reason: string,
): string | null {
  const artifactBase = resolveArtifactVerificationBase(unitId, base);
  const absPath = resolveExpectedArtifactPath(unitType, unitId, artifactBase);
  if (!absPath) return null;
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const recoveryLine = unitType === "research-project"
    ? "This placeholder was written by auto-mode so the project research gate can stop fail-closed."
    : "This placeholder was written by auto-mode so the pipeline can advance.";
  const content = [
    `# BLOCKER — auto-mode recovery failed`,
    ``,
    `Unit \`${unitType}\` for \`${unitId}\` failed to produce this artifact after idle recovery exhausted all retries.`,
    ``,
    `**Reason**: ${reason}`,
    ``,
    recoveryLine,
    `Review and replace this file before relying on downstream artifacts.`,
  ].join("\n");
  writeFileSync(absPath, content, "utf-8");

  // #4414: Clear caches so subsequent dispatch guards (e.g.
  // resolveMilestoneFile) see the placeholder file. Without this, the
  // cached directory listing is stale and the dispatch rule re-fires,
  // producing an infinite loop despite the placeholder being on disk.
  // Matches the pattern used in verifyExpectedArtifact above.
  clearPathCache();
  clearParseCache();

  // Legacy non-Task placeholder handling remains until its owning lifecycle
  // cutover. Task placeholders are diagnostic-only.
  if (isDbAvailable()) {
    const { milestone: mid } = parseUnitId(unitId);
    const ts = new Date().toISOString();
    // Insert a placeholder complete slice so deriveState sees activeMilestoneSlices.length > 0
    // and exits the pre-planning phase. Without this, activeMilestoneSlices stays empty
    // after the blocker ROADMAP.md is written, causing deriveState to return phase:'pre-planning'
    // indefinitely and re-dispatching plan-milestone in an infinite loop (#4378).
    if (unitType === "plan-milestone" && mid) {
      if (hasAdoptedMilestoneHistory(mid)) {
        logWarning("recovery", `Skipping fabricated S00-blocker slice for ${mid}: adopted canonical milestone history exists (fail-closed; see S05 for the real cascade).`);
      } else {
        try {
          insertSlice({ id: "S00-blocker", milestoneId: mid, title: "Blocker placeholder — planning failed", status: "complete", sequence: 0 });
        } catch (e) { logWarning("recovery", `insertSlice placeholder failed for plan-milestone recovery: ${e instanceof Error ? e.message : String(e)}`); }
        try { appendEvent(base, { cmd: "plan-milestone", params: { milestoneId: mid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" }); } catch (e) { logWarning("recovery", `appendEvent failed for plan-milestone recovery: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
  }

  return diagnoseExpectedArtifact(unitType, unitId, base);
}

// ─── Merge State Reconciliation ───────────────────────────────────────────────
// Body relocated to state-reconciliation/drift/merge-state.ts (ADR-017 #5701).
// Re-exported here for backward compatibility with existing call sites:
// auto.ts, auto/loop-deps.ts, tests/integration/auto-recovery.test.ts.

export {
  reconcileMergeState,
  type MergeReconcileResult,
} from "./state-reconciliation/drift/merge-state.js";

// ─── Loop Remediation ─────────────────────────────────────────────────────────

/**
 * Build concrete, manual remediation steps for a loop-detected unit failure.
 * These are shown when automatic reconciliation is not possible.
 */
export function buildLoopRemediationSteps(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      return [
        `   1. Run \`gsd undo-task ${mid}/${sid}/${tid}\` to reset the task state`,
        `   2. Resume auto-mode — it will re-execute the task`,
        `   3. If the task keeps failing and markdown should repopulate the DB, run \`gsd recover --confirm\``,
      ].join("\n");
    }
    case "plan-slice":
    case "research-slice": {
      if (!mid || !sid) break;
      const artifactRel =
        unitType === "plan-slice"
          ? relSliceFile(base, mid, sid, "PLAN")
          : relSliceFile(base, mid, sid, "RESEARCH");
      return [
        `   1. Write ${artifactRel} manually (or with the LLM in interactive mode)`,
        `   2. Run \`gsd recover --confirm\` to import the markdown into the DB`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Run \`gsd reset-slice ${mid}/${sid}\` to reset the slice and all its tasks`,
        `   2. Resume auto-mode — it will re-execute incomplete tasks and re-complete the slice`,
        `   3. If the slice keeps failing and markdown should repopulate the DB, run \`gsd recover --confirm\``,
      ].join("\n");
    }
    case "validate-milestone": {
      if (!mid) break;
      const artifactRel = relMilestoneFile(base, mid, "VALIDATION");
      return [
        `   1. Write ${artifactRel} with verdict: pass`,
        `   2. Run \`gsd recover --confirm\` to import the markdown into the DB`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
