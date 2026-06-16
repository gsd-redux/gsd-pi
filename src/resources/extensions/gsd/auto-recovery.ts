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
import { atomicWriteSync } from "./atomic-write.js";
import { clearParseCache } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap, parsePlan as parseLegacyPlan } from "./parsers-legacy.js";
import { isDbAvailable, getTask, getSlice, getSliceTasks, getPendingGates, updateTaskStatus, updateSliceStatus, insertSlice, getMilestone, getMilestoneSlices, getLatestAssessmentByScope, updateMilestoneStatus, refreshOpenDatabaseFromDisk, getCompletedMilestoneTaskFileHints, getMilestoneCommitAttributionShas, recordMilestoneCommitAttribution, transaction } from "./gsd-db.js";
import { isValidationTerminal } from "./state.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning, logError } from "./workflow-logger.js";
import { readIntegrationBranch } from "./git-service.js";
import { isClosedStatus } from "./status-guards.js";
import {
  resolveSlicePath,
  resolveSliceFile,
  resolveTasksDir,
  resolveTaskFiles,
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
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";

import { dirname, join } from "node:path";
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
import { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";
import { loadAllCaptures, loadPendingCaptures } from "./captures.js";

// Re-export so existing consumers of auto-recovery.ts keep working.
export { resolveExpectedArtifactPath, diagnoseExpectedArtifact };
export {
  classifyMilestoneSummaryContent,
  type MilestoneSummaryOutcome,
} from "./milestone-summary-classifier.js";
export { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";

// ─── Artifact Resolution & Verification ───────────────────────────────────────

export function diagnoseWorktreeIntegrityFailure(basePath: string): string | null {
  if (!isGsdWorktreePath(basePath)) return null;
  if (!existsSync(basePath)) {
    return `Worktree integrity failure: ${basePath} does not exist. Repair or recreate the worktree before retrying.`;
  }

  const gitPath = join(basePath, ".git");
  if (!existsSync(gitPath)) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (.git missing). Repair or recreate the worktree before retrying.`;
  }

  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return null;
  } catch (err) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (git rev-parse failed: ${getErrorMessage(err).split("\n")[0]}). Repair or recreate the worktree before retrying.`;
  }
}

function resolveArtifactVerificationBase(unitId: string, base: string): string {
  const { milestone } = parseUnitId(unitId);
  if (!MILESTONE_ID_RE.test(milestone)) return base;
  return resolveCanonicalMilestoneRoot(base, milestone);
}

export type ArtifactRecoveryDbRefreshResult =
  | { ok: true }
  | { ok: false; fatal: boolean; message: string; reason: string };

export function refreshRecoveryDbForArtifact(
  unitType: string,
  unitId: string,
  basePath: string,
): ArtifactRecoveryDbRefreshResult {
  if (unitType !== "plan-slice" && unitType !== "execute-task" && unitType !== "complete-milestone") return { ok: true };
  if (!isDbAvailable()) return { ok: true };

  if (!refreshOpenDatabaseFromDisk()) {
    return {
      ok: false,
      fatal: unitType === "execute-task" || unitType === "complete-milestone",
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

    const milestone = getMilestone(mid);
    if (!milestone) {
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-artifact-db-missing",
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but no matching DB milestone row exists after refresh.`,
      };
    }
    if (isClosedStatus(milestone.status)) return { ok: true };

    const validation = getLatestAssessmentByScope(mid, "milestone-validation");
    if (validation?.status !== "pass") {
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-validation-not-pass",
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but milestone-validation is "${validation?.status ?? "absent"}" in the DB.`,
      };
    }

    const slices = getMilestoneSlices(mid);
    if (slices.length === 0) {
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-slices-missing",
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but no slices exist in the DB.`,
      };
    }
    const openSlice = slices.find((slice) => !isClosedStatus(slice.status));
    if (openSlice) {
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-slice-open",
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but slice ${openSlice.id} is still "${openSlice.status}" in the DB.`,
      };
    }
    for (const slice of slices) {
      const openTask = getSliceTasks(mid, slice.id).find((task) => !isClosedStatus(task.status));
      if (openTask) {
        return {
          ok: false,
          fatal: true,
          reason: "complete-milestone-task-open",
          message: `Stuck recovery found complete-milestone ${unitId} artifacts, but task ${slice.id}/${openTask.id} is still "${openTask.status}" in the DB.`,
        };
      }
    }

    if (hasImplementationArtifacts(basePath, mid) !== "present") {
      return {
        ok: false,
        fatal: true,
        reason: "complete-milestone-implementation-missing",
        message: `Stuck recovery found complete-milestone ${unitId} artifacts, but implementation evidence is not present.`,
      };
    }

    updateMilestoneStatus(mid, "complete", new Date().toISOString());
    void import("../github-sync/sync.js")
      .then(({ finalizeMilestoneGitHubSync }) => finalizeMilestoneGitHubSync(basePath, mid))
      .catch((err) => {
        logWarning("recovery", `GitHub milestone finalize failed after DB closeout: ${getErrorMessage(err)}`);
      });
    return { ok: true };
  }

  if (unitType !== "execute-task") return { ok: true };

  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) {
    return {
      ok: false,
      fatal: true,
      reason: "execute-task-invalid-unit-id",
      message: `Stuck recovery found execute-task ${unitId} artifacts, but the unit id could not be parsed for DB verification.`,
    };
  }

  const task = getTask(mid, sid, tid);
  if (!task) {
    return {
      ok: false,
      fatal: true,
      reason: "execute-task-artifact-db-missing",
      message: `Stuck recovery found execute-task ${unitId} artifacts, but no matching DB task row exists after refresh.`,
    };
  }

  if (!isClosedStatus(task.status)) {
    return {
      ok: false,
      fatal: true,
      reason: "execute-task-artifact-db-mismatch",
      message: `Stuck recovery found execute-task ${unitId} artifacts, but the DB task status is still '${task.status}' after refresh.`,
    };
  }

  return { ok: true };
}

function hasCapturedWorkflowPrefs(base: string): boolean {
  const prefsPath = resolveExpectedArtifactPath("workflow-preferences", "WORKFLOW-PREFS", base);
  if (!prefsPath || !existsSync(prefsPath)) return false;
  const content = readFileSync(prefsPath, "utf-8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!match && /^workflow_prefs_captured:\s*true\s*$/m.test(match[1]);
}

function hasValidResearchDecision(base: string): boolean {
  const decisionPath = resolveExpectedArtifactPath("research-decision", "RESEARCH-DECISION", base);
  if (!decisionPath || !existsSync(decisionPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(decisionPath, "utf-8")) as Record<string, unknown>;
    return cfg.decision === "research" || cfg.decision === "skip";
  } catch {
    return false;
  }
}

function hasCompleteProjectResearch(base: string): boolean {
  return getProjectResearchStatus(base).complete;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCheckedTaskCompletionOnDisk(base: string, mid: string, sid: string, tid: string): boolean {
  const tasksDir = resolveTasksDir(base, mid, sid);
  if (!tasksDir) return false;
  if (!existsSync(join(tasksDir, `${tid}-SUMMARY.md`))) return false;

  const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
  if (!planAbs || !existsSync(planAbs)) return false;

  const planContent = readFileSync(planAbs, "utf-8");
  const cbRe = new RegExp(`^\\s*-\\s+\\[[xX]\\]\\s+\\*\\*${escapeRegExp(tid)}:`, "m");
  return cbRe.test(planContent);
}

/**
 * Check whether the expected artifact(s) for a unit exist on disk.
 * Returns true if all required artifacts exist, or if the unit type has no
 * single verifiable artifact (e.g., replan-slice).
 *
 * complete-slice requires both SUMMARY and UAT files — verifying only
 * the summary allowed the unit to be marked complete when the LLM
 * skipped writing the UAT file (see #176).
 */
export function verifyExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): boolean {
  // Hook units have no standard artifact — always pass. Their lifecycle
  // is managed by the hook engine, not the artifact verification system.
  if (unitType.startsWith("hook/")) return true;

  // Clear stale directory listing cache AND parse cache so artifact checks see
  // fresh disk state (#431). The parse cache must also be cleared because
  // cacheKey() uses length + first/last 100 chars — when a checkbox changes
  // from [ ] to [x], the key collides with the pre-edit version, returning
  // stale parsed results (e.g., slice.done = false when it's actually true).
  clearPathCache();
  clearParseCache();

  if (unitType === "rewrite-docs") {
    const overridesPath = resolveGsdRootFile(base, "OVERRIDES");
    if (!existsSync(overridesPath)) return true;
    const content = readFileSync(overridesPath, "utf-8");
    return !content.includes("**Scope:** active");
  }

  if (unitType === "workflow-preferences") {
    return hasCapturedWorkflowPrefs(base);
  }

  if (unitType === "triage-captures") {
    const pending = loadPendingCaptures(base);
    if (pending.length === 0) return true;
    logWarning("recovery", `verify-fail triage-captures ${unitId}: ${pending.length} pending capture(s) remain in CAPTURES.md`);
    return false;
  }

  if (unitType === "quick-task") {
    const { slice: captureId } = parseUnitId(unitId);
    const capture = captureId ? loadAllCaptures(base).find((entry) => entry.id === captureId) : undefined;
    if (capture?.executed === true) return true;
    logWarning("recovery", `verify-fail quick-task ${unitId}: capture ${captureId ?? "(missing capture id)"} not found or not marked executed`);
    return false;
  }

  if (unitType === "discuss-project") {
    const projectPath = resolveExpectedArtifactPath(unitType, unitId, base);
    return !!projectPath && existsSync(projectPath) && validateArtifact(projectPath, "project").ok;
  }

  if (unitType === "discuss-requirements") {
    const requirementsPath = resolveExpectedArtifactPath(unitType, unitId, base);
    return !!requirementsPath && existsSync(requirementsPath) && validateArtifact(requirementsPath, "requirements").ok;
  }

  if (unitType === "research-decision") {
    return hasValidResearchDecision(base);
  }

  if (unitType === "research-project") {
    return hasCompleteProjectResearch(base);
  }

  // Reactive-execute: verify that each dispatched task's summary exists.
  // The unitId encodes the batch: "{mid}/{sid}/reactive+T02,T03"
  if (unitType === "reactive-execute") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;
    const blockerPath = resolveExpectedArtifactPath(unitType, unitId, base);
    if (blockerPath && existsSync(blockerPath)) {
      return true;
    }
    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) {
      // Legacy format "reactive" without batch IDs — fall back to "any summary"
      const tDir = resolveTasksDir(base, mid, sid);
      if (!tDir) return false;
      const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
      return summaryFiles.length > 0;
    }

    const batchIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (batchIds.length === 0) return false;

    const tDir = resolveTasksDir(base, mid, sid);
    if (!tDir) return false;

    const existingSummaries = new Set(
      resolveTaskFiles(tDir, "SUMMARY").map((f) =>
        f.replace(/-SUMMARY\.md$/i, "").toUpperCase(),
      ),
    );

    // Every dispatched task must have a summary file
    for (const tid of batchIds) {
      if (!existingSummaries.has(tid.toUpperCase())) return false;
    }
    return true;
  }

  // Gate-evaluate: verify that each dispatched gate has been resolved in the DB.
  // The unitId encodes the batch: "{mid}/{sid}/gates+Q3,Q4"
  if (unitType === "gate-evaluate") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;

    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) return true; // no specific gates encoded — pass

    const gateIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (gateIds.length === 0) return true;

    try {
      const pending = getPendingGates(mid, sid, "slice");
      const pendingIds = new Set(pending.map((g: any) => g.gate_id));
      // All dispatched gates must no longer be pending
      for (const gid of gateIds) {
        if (pendingIds.has(gid)) return false;
      }
    } catch (err) {
      // DB unavailable — treat as verified to avoid blocking
      logWarning("recovery", `gate-evaluate DB check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  // #4414: research-slice parallel-research sentinel. The unitId
  // `{mid}/parallel-research` is not a real slice — it triggers a single agent
  // that fans out research across multiple slices. Verify success by checking
  // that every slice which was "research-ready" in the roadmap now has a
  // RESEARCH file. Without this, resolveExpectedArtifactPath returns null and
  // the retry/escalation machinery silently re-dispatches forever.
  //
  // #4068: Also treat a PARALLEL-BLOCKER placeholder as a terminal completion
  // so that timeout-recovery can write the blocker, have verifyExpectedArtifact
  // return true, and let the dispatch loop advance past this unit.  Without
  // this, the blocker is written but verification still returns false, the unit
  // is never cleared from unitDispatchCount, and on the next iteration the
  // dispatch rule (which correctly skips parallel-research when PARALLEL-BLOCKER
  // exists) returns null — leaving the loop stuck re-deriving indefinitely.
  //
  // NOTE: this predicate mirrors the dispatch rule at
  // auto-dispatch.ts parallel-research-slices — keep the two in sync.
  if (unitType === "research-slice" && unitId.endsWith("/parallel-research")) {
    const { milestone: mid } = parseUnitId(unitId);
    if (!mid) return false;

    // #4068: PARALLEL-BLOCKER written by timeout-recovery is a terminal state.
    const blockerPath = resolveExpectedArtifactPath(unitType, unitId, base);
    if (blockerPath && existsSync(blockerPath)) {
      return true;
    }

    const roadmapFile = resolveExpectedArtifactPath("plan-milestone", mid, base);
    if (!roadmapFile || !existsSync(roadmapFile)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap missing`);
      return false;
    }
    try {
      const roadmap = parseLegacyRoadmap(readFileSync(roadmapFile, "utf-8"));
      const milestoneResearchFile = resolveExpectedArtifactPath("research-milestone", mid, base);
      const hasMilestoneResearch = !!milestoneResearchFile && existsSync(milestoneResearchFile);
      for (const slice of roadmap.slices) {
        if (slice.done) continue;
        if (hasMilestoneResearch && slice.id === "S01") continue;
        const depsComplete = (slice.depends ?? []).every((depId) => {
          const summaryPath = resolveExpectedArtifactPath("complete-slice", `${mid}/${depId}`, base);
          return !!summaryPath && existsSync(summaryPath);
        });
        if (!depsComplete) continue;
        const researchPath = resolveExpectedArtifactPath("research-slice", `${mid}/${slice.id}`, base);
        if (!researchPath || !existsSync(researchPath)) {
          logWarning("recovery", `verify-fail ${unitType} ${unitId}: slice ${slice.id} missing RESEARCH`);
          return false;
        }
      }
      return true;
    } catch (err) {
      logWarning("recovery", `parallel-research verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  const artifactBase = resolveArtifactVerificationBase(unitId, base);
  const absPath = resolveExpectedArtifactPath(unitType, unitId, artifactBase);
  // For unit types with no registered artifact contract (null path), treat the
  // completion state as stale so the key gets evicted (#313).
  if (!absPath) {
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: resolveExpectedArtifactPath returned null (no artifact contract registered for this unit type)`);
    return false;
  }
  if (!existsSync(absPath)) {
    const worktreeFailure = diagnoseWorktreeIntegrityFailure(artifactBase);
    if (worktreeFailure) {
      logError("recovery", `${worktreeFailure} Unit: ${unitType} ${unitId}.`);
      return false;
    }
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: existsSync false for ${absPath}`);
    return false;
  }

  if (unitType === "validate-milestone") {
    const validationContent = readFileSync(absPath, "utf-8");
    if (!isValidationTerminal(validationContent)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: validation not terminal (len=${validationContent.length}) at ${absPath}`);
      return false;
    }
  }

  if (unitType === "run-uat") {
    const assessmentContent = readFileSync(absPath, "utf-8");
    if (!hasVerdict(assessmentContent)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: assessment missing verdict at ${absPath}`);
      return false;
    }
  }

  if (unitType === "plan-milestone") {
    try {
      const roadmap = parseLegacyRoadmap(readFileSync(absPath, "utf-8"));
      if (roadmap.slices.length === 0) {
        logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap has zero slices at ${absPath}`);
        return false;
      }
    } catch (err) {
      logWarning("recovery", `plan-milestone roadmap verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // plan-slice verification is DB-primary. The slice plan is a projection, so
  // DB task rows prove the slice was planned even if the rendered markdown no
  // longer uses legacy checkbox/heading syntax.
  if (unitType === "plan-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      try {
        let taskIds: string[] | null = null;
        if (isDbAvailable()) {
          const refreshed = refreshOpenDatabaseFromDisk();
          if (refreshed) {
            const tasks = getSliceTasks(mid, sid);
            if (tasks.length > 0) taskIds = tasks.map(t => t.id);
          }
        }

        if (!taskIds) {
          // LEGACY: DB unavailable or no tasks in DB. Require actual task
          // entries so an empty scaffold cannot advance the pipeline (#699).
          const planContent = readFileSync(absPath, "utf-8");
          const hasCheckboxTask = /^\s*- \[[xX ]\] \*\*T\d+:/m.test(planContent);
          const hasHeadingTask = /^\s*#{2,4}\s+T\d+\s*(?:--|—|:)/m.test(planContent);
          if (!hasCheckboxTask && !hasHeadingTask) {
            logWarning("recovery", `verify-fail ${unitType} ${unitId}: plan has no task checkbox/heading (len=${planContent.length}) at ${absPath}`);
            return false;
          }
          const plan = parseLegacyPlan(planContent);
          if (plan.tasks.length > 0) taskIds = plan.tasks.map((t: { id: string }) => t.id);
        }

        if (taskIds && taskIds.length > 0) {
          const tasksDir = join(dirname(absPath), "tasks");
          if (!existsSync(tasksDir)) {
            logWarning("recovery", `verify-fail ${unitType} ${unitId}: tasks dir missing at ${tasksDir}`);
            return false;
          }
          for (const tid of taskIds) {
            const taskPlanFile = join(tasksDir, `${tid}-PLAN.md`);
            if (!existsSync(taskPlanFile)) {
              logWarning("recovery", `verify-fail ${unitType} ${unitId}: task plan missing ${taskPlanFile}`);
              return false;
            }
          }
        }
      } catch (err) {
        // Parse failure — don't block; slice plan may have non-standard format
        logWarning("recovery", `plan-slice task plan verification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // execute-task: DB status is authoritative. Fall back to checked-checkbox
  // detection when the DB is unavailable (unmigrated projects), or when the
  // disk artifacts already reflect completion but the DB replay is one beat
  // behind the completion write.
  if (unitType === "execute-task") {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    if (mid && sid && tid) {
      const dbTask = getTask(mid, sid, tid);
      if (dbTask) {
        if (dbTask.status !== "complete" && dbTask.status !== "done" && !hasCheckedTaskCompletionOnDisk(base, mid, sid, tid)) {
          return false;
        }
      } else if (!isDbAvailable()) {
        // LEGACY: Pre-migration fallback for projects without DB.
        // Require a CHECKED checkbox — a bare heading or unchecked checkbox
        // does not prove gsd_complete_task ran. Summary file on disk alone
        // is not sufficient evidence (could be a rogue write) (#3607).
        if (!hasCheckedTaskCompletionOnDisk(base, mid, sid, tid)) return false;
      } else {
        // DB available but task row not found — completion tool never ran (#3607)
        return false;
      }
    }
  }

  // complete-slice: DB status is authoritative for whether the slice is done.
  // Fall back to file-based check (roadmap [x]) when DB is unavailable.
  if (unitType === "complete-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      const dir = resolveSlicePath(base, mid, sid);
      if (dir) {
        const uatPath = join(dir, buildSliceFileName(sid, "UAT"));
        if (!existsSync(uatPath)) return false;
      }

      const dbSlice = getSlice(mid, sid);
      if (dbSlice) {
        // DB available — trust it
        if (dbSlice.status !== "complete") return false;
      } else if (!isDbAvailable()) {
        // LEGACY: Pre-migration fallback for projects without DB.
        // Fall back to roadmap checkbox check via parsers-legacy
        const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
        if (roadmapFile && existsSync(roadmapFile)) {
          try {
            const roadmapContent = readFileSync(roadmapFile, "utf-8");
            const roadmap = parseLegacyRoadmap(roadmapContent);
            const slice = roadmap.slices.find((s) => s.id === sid);
            if (slice && !slice.done) return false;
          } catch (e) {
            logWarning("recovery", `roadmap parse failed: ${(e as Error).message}`);
            return false;
          }
        }
      }
      // else: DB available but slice not found — summary + UAT exist,
      // treat as verified (slice may not be imported yet)
    }
  }

  // complete-milestone must have produced implementation artifacts (#1703).
  // A milestone with only .gsd/ plan files and zero implementation code is
  // not genuinely complete — the LLM wrote plan files but skipped actual work.
  if (unitType === "complete-milestone") {
    const summaryOutcome = classifyMilestoneSummaryContent(readFileSync(absPath, "utf-8"));
    if (summaryOutcome === "failure") return false;
    const { milestone: mid } = parseUnitId(unitId);
    if (mid && isDbAvailable()) {
      const dbMilestone = getMilestone(mid);
      if (!dbMilestone) return false;
      if (!isClosedStatus(dbMilestone.status) && summaryOutcome !== "success") return false;
    }
    if (hasImplementationArtifacts(base, mid) === "absent") return false;
  }

  return true;
}

export interface ReactiveExecuteBlockerRecovery {
  blockerPath: string;
  completedTaskIds: string[];
  skippedTaskIds: string[];
  unchangedTaskIds: string[];
}

/**
 * Terminal recovery for a failed reactive-execute batch.
 *
 * Summary-present tasks are reconciled closed as complete; missing-summary
 * tasks are closed as skipped. The slice-level blocker sentinel makes the
 * failed batch terminal without fabricating per-task summaries.
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

  const tasksDir = resolveTasksDir(base, mid, sid);
  const existingSummaries = new Set(
    tasksDir
      ? resolveTaskFiles(tasksDir, "SUMMARY").map((f) => f.replace(/-SUMMARY\.md$/i, "").toUpperCase())
      : [],
  );

  const summaryPresent = batchIds.filter((tid) => existingSummaries.has(tid.toUpperCase()));
  const summaryMissing = batchIds.filter((tid) => !existingSummaries.has(tid.toUpperCase()));
  const completedTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];
  const unchangedTaskIds: string[] = [];
  const ts = new Date().toISOString();

  transaction(() => {
    for (const tid of summaryPresent) {
      const task = getTask(mid, sid, tid);
      if (!task || isClosedStatus(task.status)) {
        unchangedTaskIds.push(tid);
        continue;
      }
      updateTaskStatus(mid, sid, tid, "complete", ts);
      completedTaskIds.push(tid);
    }
    for (const tid of summaryMissing) {
      const task = getTask(mid, sid, tid);
      if (!task || isClosedStatus(task.status)) {
        unchangedTaskIds.push(tid);
        continue;
      }
      updateTaskStatus(mid, sid, tid, "skipped", ts);
      skippedTaskIds.push(tid);
    }
  });

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
    `**Marked complete**: ${completedTaskIds.length > 0 ? completedTaskIds.join(", ") : "none"}`,
    `**Marked skipped**: ${skippedTaskIds.length > 0 ? skippedTaskIds.join(", ") : "none"}`,
    "",
    "This placeholder was written by auto-mode so the pipeline can advance without re-dispatching the same reactive batch.",
    "Review skipped tasks before relying on downstream artifacts.",
  ].join("\n");
  writeFileSync(blockerPath, content, "utf-8");

  for (const tid of completedTaskIds) {
    try {
      appendEvent(base, {
        cmd: "complete-task",
        params: { milestoneId: mid, sliceId: sid, taskId: tid },
        ts,
        actor: "system",
        trigger_reason: "reactive-execute-blocker-recovery",
      });
    } catch (e) {
      logWarning("recovery", `appendEvent failed for reactive complete recovery: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const tid of skippedTaskIds) {
    try {
      appendEvent(base, {
        cmd: "skip-task",
        params: { milestoneId: mid, sliceId: sid, taskId: tid },
        ts,
        actor: "system",
        trigger_reason: "reactive-execute-blocker-recovery",
      });
    } catch (e) {
      logWarning("recovery", `appendEvent failed for reactive skip recovery: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  clearPathCache();
  clearParseCache();

  return { blockerPath, completedTaskIds, skippedTaskIds, unchangedTaskIds };
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

  // Mark the task/slice as complete in the DB so verifyExpectedArtifact passes.
  // Without this, the DB status stays "pending" and the dispatch loop
  // re-derives the same unit indefinitely (#2531, #2653).
  if (isDbAvailable()) {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const ts = new Date().toISOString();
    if (unitType === "execute-task" && mid && sid && tid) {
      try {
        updateTaskStatus(mid, sid, tid, "complete", ts);
        const planPath = resolveExpectedArtifactPath("plan-slice", `${mid}/${sid}`, artifactBase);
        if (planPath && existsSync(planPath)) {
          const planContent = readFileSync(planPath, "utf-8");
          const updatedPlan = planContent.replace(
            new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${tid}:`, "m"),
            `$1[x] **${tid}:`,
          );
          if (updatedPlan !== planContent) {
            atomicWriteSync(planPath, updatedPlan);
          }
        }
      } catch (e) {
        logWarning("recovery", `updateTaskStatus failed during context exhaustion: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Append event so worktree reconciliation can replay this recovery completion
      try { appendEvent(base, { cmd: "complete-task", params: { milestoneId: mid, sliceId: sid, taskId: tid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" }); } catch (e) { logWarning("recovery", `appendEvent failed for task recovery: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (unitType === "complete-slice" && mid && sid) {
      try { updateSliceStatus(mid, sid, "complete", ts); } catch (e) { logWarning("recovery", `updateSliceStatus failed during context exhaustion: ${e instanceof Error ? e.message : String(e)}`); }
      try { appendEvent(base, { cmd: "complete-slice", params: { milestoneId: mid, sliceId: sid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" }); } catch (e) { logWarning("recovery", `appendEvent failed for slice recovery: ${e instanceof Error ? e.message : String(e)}`); }
    }
    // Insert a placeholder complete slice so deriveState sees activeMilestoneSlices.length > 0
    // and exits the pre-planning phase. Without this, activeMilestoneSlices stays empty
    // after the blocker ROADMAP.md is written, causing deriveState to return phase:'pre-planning'
    // indefinitely and re-dispatching plan-milestone in an infinite loop (#4378).
    if (unitType === "plan-milestone" && mid) {
      try {
        insertSlice({ id: "S00-blocker", milestoneId: mid, title: "Blocker placeholder — planning failed", status: "complete", sequence: 0 });
      } catch (e) { logWarning("recovery", `insertSlice placeholder failed for plan-milestone recovery: ${e instanceof Error ? e.message : String(e)}`); }
      try { appendEvent(base, { cmd: "plan-milestone", params: { milestoneId: mid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" }); } catch (e) { logWarning("recovery", `appendEvent failed for plan-milestone recovery: ${e instanceof Error ? e.message : String(e)}`); }
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
