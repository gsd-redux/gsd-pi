// Project/App: gsd-pi
// File Purpose: Resolves expected auto-mode artifact paths across project and worktree projections.
// GSD Auto-mode — Artifact Path Resolution
//
// resolveExpectedArtifactPath and diagnoseExpectedArtifact moved here from
// auto-recovery.ts (Phase 5 dead-code cleanup). The artifact verification
// function was removed entirely — callers now query WorkflowEngine directly.

import {
  gsdRoot,
  resolveDir,
  resolveFile,
  resolveMilestonePath,
  resolveMilestoneFile,
  resolveSliceFile,
  relMilestoneFile,
  relSliceFile,
  buildTaskFileName,
  resolveSlicePath,
  resolveTasksDir,
  dirIsMetaOnlyLegacyMilestone,
} from "./paths.js";
import { milestoneIdToPhaseNum } from "./layout-policy.js";
import { parseUnitId } from "./unit-id.js";
import { dirname, join } from "node:path";

function resolveMilestoneArtifactPath(
  base: string,
  mid: string,
  suffix: string,
): string | null {
  const existing = resolveProjectedMilestoneFile(base, mid, suffix) ?? resolveProjectMilestoneFile(base, mid, suffix);
  if (existing) return existing;
  // Try projected (worktree) path, then project-root path. Both can return
  // either a legacy (milestones/<MID>/) or flat-phase (phases/NN-slug/) dir.
  const dir = resolveProjectedMilestonePath(base, mid) ?? resolveProjectMilestonePath(base, mid) ?? resolveMilestonePath(base, mid);
  if (dir) {
    // The filename depends on the LAYOUT of the resolved directory, not on
    // which resolver found it. A flat-phase dir (phases/NN-slug/) uses the
    // phase-number prefix (15-CONTEXT.md); a legacy dir (milestones/<MID>/)
    // uses the milestone-id prefix (M015-CONTEXT.md). Building the wrong
    // filename for the resolved dir produces existsSync-false paths that trap
    // the unit in a finalize-retry loop (#852).
    //
    // Layout is determined structurally from the resolved directory's parent
    // segment name, NOT by comparing against a root-anchored legacyMilestonesDir
    // base path. On a canonical worktree (<project>/.gsd-worktrees/M001/),
    // legacyMilestonesDir uses gsdProjectionRoot (the worktree .gsd) while
    // resolveProjectMilestonePath uses gsdRoot (the project .gsd) — two
    // different roots. A dir returned by resolveProjectMilestonePath would
    // fail the startsWith check against the worktree root and incorrectly
    // produce a flat-phase filename for a legacy directory (#bugbot c5ee8eba).
    const parentDir = dirname(dir);
    const isLegacy = parentDir.endsWith("/milestones") || parentDir.endsWith("\\milestones");
    const phaseNum = milestoneIdToPhaseNum(mid);
    const filename = isLegacy
      ? `${mid}-${suffix}.md`
      : `${String(phaseNum).padStart(2, "0")}-${suffix}.md`;
    return join(dir, filename);
  }
  return null;
}

/**
 * Build the layout-aware filename for a milestone artifact suffix.
 * Exported so other callers (e.g. verification diagnostics) use the same
 * naming policy: flat-phase dirs use the phase-number prefix (15-CONTEXT.md),
 * legacy dirs use the milestone-id prefix (M015-CONTEXT.md).
 *
 * Layout is determined structurally: dirs whose immediate parent is named
 * "milestones" are legacy; all others are flat-phase. This avoids the
 * root-path ambiguity between gsdProjectionRoot (worktree .gsd) and gsdRoot
 * (project .gsd) that caused wrong filenames on canonical worktrees.
 */
export function buildMilestoneArtifactFilename(mid: string, suffix: string, dir: string): string {
  const parentDir = dirname(dir);
  const isLegacy = parentDir.endsWith("/milestones") || parentDir.endsWith("\\milestones");
  const phaseNum = milestoneIdToPhaseNum(mid);
  return isLegacy
    ? `${mid}-${suffix}.md`
    : `${String(phaseNum).padStart(2, "0")}-${suffix}.md`;
}

function resolveSliceArtifactPath(
  base: string,
  mid: string,
  sid: string,
  suffix: string,
): string | null {
  const existing = resolveProjectedSliceFile(base, mid, sid, suffix) ?? resolveProjectSliceFile(base, mid, sid, suffix);
  if (existing) return existing;
  // Flat-phase: plan files live at phases/NN-slug/NN-MM-SUFFIX.md — resolveSliceFile handles both layouts.
  const flatPhase = resolveSliceFile(base, mid, sid, suffix);
  if (flatPhase) return flatPhase;
  // File doesn't exist yet — use relSliceFile for the layout-aware canonical path.
  // buildSliceFileName(sid) only has sliceId → MM-SUFFIX.md, wrong for both layouts.
  return join(base, relSliceFile(base, mid, sid, suffix));
}

function resolveProjectMilestonePath(base: string, mid: string): string | null {
  const milestonesDir = join(gsdRoot(base), "milestones");
  const dir = resolveDir(milestonesDir, mid);
  if (!dir) return null;
  // git-service.ts creates milestones/<MID>/ for integration-branch metadata
  // (<MID>-META.json) even in flat-phase projects. A dir that holds ONLY
  // *-META.json files must not be treated as a real legacy milestone dir —
  // otherwise this early-return resolves CONTEXT/ROADMAP/SUMMARY to the legacy
  // path (milestones/<MID>/<MID>-<SUFFIX>.md) before the flat-phase fallback
  // can run, trapping the unit in a finalize-retry loop (#852 follow-up).
  //
  // We use dirIsMetaOnlyLegacyMilestone rather than !dirIsContentBearingLegacyMilestone
  // so that an EMPTY dir (a new milestone before any content is written) is NOT
  // blocked — it is a valid legacy target that write-paths should resolve to.
  if (dirIsMetaOnlyLegacyMilestone(join(milestonesDir, dir))) return null;
  return join(milestonesDir, dir);
}

function resolveProjectMilestoneFile(base: string, mid: string, suffix: string): string | null {
  const dir = resolveProjectMilestonePath(base, mid);
  if (!dir) return null;
  const file = resolveFile(dir, mid, suffix);
  return file ? join(dir, file) : null;
}

function resolveProjectSlicePath(base: string, mid: string, sid: string): string | null {
  const milestoneDir = resolveProjectMilestonePath(base, mid);
  if (!milestoneDir) return null;
  const slicesDir = join(milestoneDir, "slices");
  const dir = resolveDir(slicesDir, sid);
  return dir ? join(slicesDir, dir) : null;
}

function resolveProjectSliceFile(base: string, mid: string, sid: string, suffix: string): string | null {
  const dir = resolveProjectSlicePath(base, mid, sid);
  if (!dir) return null;
  const file = resolveFile(dir, sid, suffix);
  return file ? join(dir, file) : null;
}

function resolveProjectedMilestonePath(base: string, mid: string): string | null {
  return resolveMilestonePath(base, mid);
}

function resolveProjectedMilestoneFile(base: string, mid: string, suffix: string): string | null {
  return resolveMilestoneFile(base, mid, suffix);
}

function resolveProjectedSlicePath(base: string, mid: string, sid: string): string | null {
  const milestoneDir = resolveProjectedMilestonePath(base, mid);
  if (!milestoneDir) return null;
  const slicesDir = join(milestoneDir, "slices");
  const dir = resolveDir(slicesDir, sid);
  return dir ? join(slicesDir, dir) : null;
}

function resolveProjectedSliceFile(base: string, mid: string, sid: string, suffix: string): string | null {
  const dir = resolveProjectedSlicePath(base, mid, sid);
  if (!dir) return null;
  const file = resolveFile(dir, sid, suffix);
  return file ? join(dir, file) : null;
}

/**
 * Resolve the expected artifact for a unit to an absolute path.
 */
export function resolveExpectedArtifactPath(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "workflow-preferences":
      return join(gsdRoot(base), "PREFERENCES.md");
    case "discuss-project":
      return join(gsdRoot(base), "PROJECT.md");
    case "discuss-requirements":
      return join(gsdRoot(base), "REQUIREMENTS.md");
    case "research-decision":
      return join(gsdRoot(base), "runtime", "research-decision.json");
    case "research-project":
      return join(gsdRoot(base), "research", "PROJECT-RESEARCH-BLOCKER.md");
    case "discuss-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "CONTEXT");
    }
    case "discuss-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "CONTEXT");
    }
    case "research-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "RESEARCH");
    }
    case "plan-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "ROADMAP");
    }
    case "research-slice": {
      // #4414: Sentinel unitId "{mid}/parallel-research" fans out across
      // multiple slices. Resolve to a milestone-level placeholder path so
      // blocker escalation has somewhere to write. Verification for this
      // sentinel is handled directly in verifyExpectedArtifact.
      if (sid === "parallel-research") {
        return resolveMilestoneArtifactPath(base, mid, "PARALLEL-BLOCKER");
      }
      return resolveSliceArtifactPath(base, mid, sid!, "RESEARCH");
    }
    case "plan-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "refine-slice": {
      // ADR-011: refine-slice expands a sketch and writes the same PLAN.md as plan-slice.
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "reassess-roadmap": {
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "run-uat": {
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "execute-task": {
      const slicePath = resolveProjectedSlicePath(base, mid, sid!)
        ?? resolveProjectSlicePath(base, mid, sid!)
        ?? resolveSlicePath(base, mid, sid!);
      if (!slicePath || !tid) return null;
      const tasksDir = resolveTasksDir(base, mid, sid!) ?? slicePath;
      return join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
    }
    case "complete-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "SUMMARY");
    }
    case "validate-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "VALIDATION");
    }
    case "complete-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "SUMMARY");
    }
    case "replan-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "REPLAN");
    }
    case "triage-captures":
      // Verified against CAPTURES.md state in verifyExpectedArtifact.
      return null;
    case "quick-task":
      // Verified against the capture's Executed field in CAPTURES.md.
      return null;
    case "rewrite-docs":
      return null;
    case "gate-evaluate":
      // Gate evaluate writes to DB quality_gates table — verified via state derivation
      return null;
    case "reactive-execute":
      // Reactive execute normally produces multiple task summaries. On terminal
      // batch recovery, the engine writes a slice-level blocker sentinel.
      return mid && sid ? resolveSliceArtifactPath(base, mid, sid, "REACTIVE-BLOCKER") : null;
    default:
      return null;
  }
}

export function diagnoseExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "workflow-preferences":
      return ".gsd/PREFERENCES.md with workflow_prefs_captured: true";
    case "discuss-project":
      return ".gsd/PROJECT.md (valid project context)";
    case "discuss-requirements":
      return ".gsd/REQUIREMENTS.md (valid requirements registry)";
    case "research-decision":
      return ".gsd/runtime/research-decision.json with decision research|skip";
    case "research-project":
      return ".gsd/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md with at least one real research file; blocker-only outputs stop";
    case "discuss-milestone":
      return `${relMilestoneFile(base, mid, "CONTEXT")} (milestone context from discussion)`;
    case "discuss-slice":
      return `${relSliceFile(base, mid, sid!, "CONTEXT")} (slice context from discussion)`;
    case "research-milestone":
      return `${relMilestoneFile(base, mid, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      return `${relMilestoneFile(base, mid, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      if (sid === "parallel-research") {
        return `${relMilestoneFile(base, mid, "PARALLEL-BLOCKER")} (parallel slice research sentinel)`;
      }
      return `${relSliceFile(base, mid, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      return `${relSliceFile(base, mid, sid!, "PLAN")} plus tasks/T##-PLAN.md files (slice plan and task plans)`;
    case "refine-slice":
      return `${relSliceFile(base, mid, sid!, "PLAN")} plus tasks/T##-PLAN.md files (refined slice plan and task plans)`;
    case "execute-task": {
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid, "ROADMAP")} + summary + UAT written`;
    case "replan-slice":
      return `${relSliceFile(base, mid, sid!, "REPLAN")} + updated ${relSliceFile(base, mid, sid!, "PLAN")}`;
    case "triage-captures":
      return ".gsd/CAPTURES.md with no pending captures";
    case "quick-task":
      return `.gsd/CAPTURES.md capture ${sid ?? "<capture-id>"} marked executed`;
    case "rewrite-docs":
      return "Active overrides resolved in .gsd/OVERRIDES.md + plan documents updated";
    case "reassess-roadmap":
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (UAT assessment result)`;
    case "validate-milestone":
      return `${relMilestoneFile(base, mid, "VALIDATION")} (milestone validation report)`;
    case "complete-milestone":
      return `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}
