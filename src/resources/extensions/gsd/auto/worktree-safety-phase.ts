// Project/App: gsd-pi
// File Purpose: Worktree-safety helpers shared across auto-loop phase modules.

import { classifyProject } from "../detection.js";
import { resolveEffectiveUnitIsolationMode, getIsolationMode } from "../preferences.js";
import { createWorktreeSafetyModule, type WorktreeSafetyResult } from "../worktree-safety.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { resolveManifest } from "../unit-context-manifest.js";
import { debugLog } from "../debug-logger.js";
import { isSamePathLocal } from "./phase-helpers.js";
import { hasHeldMilestoneLease, reclaimMissingMilestoneLease } from "./milestone-lease-reclaim.js";
import type { IterationContext } from "./types.js";

export function shouldDegradeEmptyWorktreeToProjectRoot(
  worktreeClassification: ReturnType<typeof classifyProject>,
  projectRootClassification: ReturnType<typeof classifyProject>,
): boolean {
  return (
    worktreeClassification.kind === "greenfield" &&
    projectRootClassification.kind !== "greenfield" &&
    projectRootClassification.kind !== "invalid-repo"
  );
}

export function unitWritesSource(unitType: string): boolean | null {
  if (unitType.startsWith("hook/")) return false;
  // Backward compatibility: sidecar queues from older builds may persist
  // prefixed unit types (e.g. "sidecar/quick-task").
  const normalizedUnitType = unitType.startsWith("sidecar/")
    ? unitType.slice("sidecar/".length)
    : unitType;
  const manifest = resolveManifest(normalizedUnitType);
  if (!manifest) return null;
  return manifest.tools.mode === "all" || manifest.tools.mode === "docs";
}

export function formatWorktreeSafetyFailure(result: Extract<WorktreeSafetyResult, { ok: false }>): string {
  return `Worktree Safety failed (${result.kind}): ${result.reason} ${result.remediation}`;
}

export function formatWorktreeSafetyStopReason(result: Extract<WorktreeSafetyResult, { ok: false }>): string {
  if (result.kind === "empty-worktree-with-project-content") {
    return `Worktree Safety failed (${result.kind}). Run /gsd doctor fix, then /gsd auto.`;
  }
  return `Worktree Safety failed (${result.kind}).`;
}

export function resolveEmptyWorktreeWithProjectContent(
  unitRoot: string,
  projectRoot: string,
): boolean {
  if (isSamePathLocal(unitRoot, projectRoot)) return false;
  const worktreeClassification = classifyProject(unitRoot);
  if (worktreeClassification.kind !== "greenfield") return false;
  const projectRootClassification = classifyProject(projectRoot);
  return shouldDegradeEmptyWorktreeToProjectRoot(worktreeClassification, projectRootClassification);
}

export async function validateSourceWriteWorktreeSafety(
  ic: IterationContext,
  unitType: string,
  unitId: string,
  milestoneId: string | undefined,
  phase: string,
): Promise<{ action: "break"; reason: string } | null> {
  const { ctx, pi, s, deps } = ic;
  if (!s.basePath) return null;

  // Custom engine workflows (graph-driven, registered via run dirs) define
  // their own step ids that are not in the GSD UnitContextManifest. Don't
  // fail closed for those — the custom engine owns its own dispatch
  // contract. The fail-closed safety check applies only to built-in GSD
  // units whose Tool Contract is registered in the manifest. Use a truthy
  // check so undefined (test sessions that never set the field) routes
  // through the safety check, matching the regression test contract.
  if (s.activeEngineId) return null;

  const writesSource = unitWritesSource(unitType);
  if (writesSource === null) {
    const msg = `Worktree Safety failed (missing-tool-contract): missing Tool Contract for ${unitType}. Add a UnitContextManifest entry before dispatching this Unit.`;
    debugLog("worktreeSafety", {
      phase,
      unitType,
      unitId,
      milestoneId,
      result: { ok: false, kind: "missing-tool-contract", reason: msg },
      basePath: s.basePath,
    });
    ctx.ui.notify(msg, "error");
    await deps.stopAuto(ctx, pi, msg);
    return { action: "break", reason: "missing-tool-contract" };
  }
  if (!writesSource) return null;

  const projectRoot = s.canonicalProjectRoot ?? resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
  // A degraded session already fell back to the milestone branch in the
  // project root — validating against the canonical worktree root there
  // would fail every dispatch with a false invalid-root. The same applies
  // to a stranded-recovery session that adopted the milestone branch.
  const isolationMode = resolveEffectiveUnitIsolationMode(
    deps.getIsolationMode(projectRoot),
    s.isolationDegraded,
    s.strandedRecoveryIsolationMode,
  );
  reclaimMissingMilestoneLease(s, milestoneId, isolationMode, phase);
  const safety = createWorktreeSafetyModule();
  const result = safety.validateUnitRoot({
    unitType,
    unitId,
    writeScope: "source-writing",
    projectRoot,
    unitRoot: s.basePath,
    milestoneId,
    isolationMode,
    expectedBranch:
      isolationMode !== "none" && milestoneId ? deps.autoWorktreeBranch(milestoneId) : null,
    emptyWorktreeWithProjectContent: resolveEmptyWorktreeWithProjectContent(s.basePath, projectRoot),
    // The milestone lease coordinates concurrent workers on an isolated
    // milestone worktree/branch, which is established by enterMilestone in
    // worktree/branch modes. `none` mode has no per-milestone isolation and
    // does not reliably claim a lease (e.g. a fresh headless resume of an
    // already-active milestone never re-enters it), so requiring a held lease
    // there would falsely fail dispatch. Enforce the lease only in isolated
    // modes; none-mode safety still validates the unit root.
    lease: s.workerId
      ? {
          required: isolationMode !== "none",
          held: hasHeldMilestoneLease(s, milestoneId),
          owner: s.workerId,
        }
      : undefined,
  });

  if (result.ok) return null;

  const msg = formatWorktreeSafetyFailure(result);
  debugLog("worktreeSafety", {
    phase,
    unitType,
    unitId,
    milestoneId,
    result,
    basePath: s.basePath,
    projectRoot,
  });
  ctx.ui.notify(msg, "error");
  await deps.stopAuto(ctx, pi, formatWorktreeSafetyStopReason(result));
  return { action: "break", reason: result.kind };
}
