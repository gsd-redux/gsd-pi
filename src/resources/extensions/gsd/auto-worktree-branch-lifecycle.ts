// gsd-pi — Auto-worktree branch lifecycle module.
//
// Owns milestone branch naming, branch-mode entry, and safe fast-forward of
// reused milestone branches. Worktree creation/merge code imports this module
// instead of keeping branch policy inside the legacy auto-worktree barrel.

import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { readIntegrationBranch, runGit } from "./git-service.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { debugLog } from "./debug-logger.js";
import { checkoutBranchWithStashGuard } from "./worktree-git-recovery.js";
import {
  nativeAddAll,
  nativeBranchExists,
  nativeBranchForceReset,
  nativeCheckoutBranch,
  nativeCheckoutNewBranch,
  nativeCommit,
  nativeDetectMainBranch,
  nativeHasCommittedHead,
  nativeIsAncestor,
  nativeUpdateRef,
  nativeWorktreeList,
} from "./native-git-bridge.js";

/** Returns the git branch name for a milestone worktree (`milestone/<MID>`). */
export function autoWorktreeBranch(milestoneId: string): string {
  return `milestone/${milestoneId}`;
}

export function _resolveAutoWorktreeStartPoint(
  integrationBranch: string | null | undefined,
  gitMainBranch: string | null | undefined,
  branchExists: (branch: string) => boolean,
): string | undefined {
  if (integrationBranch) return integrationBranch;
  return gitMainBranch &&
    typeof gitMainBranch === "string" &&
    gitMainBranch.length > 0 &&
    branchExists(gitMainBranch)
    ? gitMainBranch
    : undefined;
}

/**
 * Enter branch isolation mode for a milestone.
 *
 * Creates `milestone/<MID>` from the integration branch (if it doesn't
 * exist yet) and checks out to it. No worktree directory is created — the
 * project root is the working copy; only HEAD changes.
 * An unborn repository first receives a baseline commit on its integration
 * branch so that branch remains available after milestone isolation begins.
 *
 * Uses the same 3-tier integration-branch fallback as createAutoWorktree:
 *   1. META.json recorded integration branch
 *   2. git.main_branch preference
 *   3. nativeDetectMainBranch (origin/HEAD auto-detection)
 */
export function enterBranchModeForMilestone(
  basePath: string,
  milestoneId: string,
): void {
  const branch = autoWorktreeBranch(milestoneId);

  if (!nativeHasCommittedHead(basePath)) {
    const currentBranch = runGit(
      basePath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
    );
    const gitMainBranch = loadEffectiveGSDPreferences(basePath)?.preferences?.git?.main_branch;
    const integrationBranch =
      readIntegrationBranch(basePath, milestoneId) ??
      gitMainBranch ??
      (currentBranch !== branch ? currentBranch : "main");

    if (currentBranch !== integrationBranch) {
      if (nativeBranchExists(basePath, integrationBranch)) {
        nativeCheckoutBranch(basePath, integrationBranch);
      } else {
        nativeCheckoutNewBranch(basePath, integrationBranch);
      }
    }
    nativeAddAll(basePath);
    nativeCommit(basePath, "chore: init project", { allowEmpty: true });
    debugLog("auto-worktree", {
      action: "establishIntegrationBranch",
      milestoneId,
      branch: integrationBranch,
      repositoryState: "unborn",
    });
  }

  const branchExists = nativeBranchExists(basePath, branch);

  if (!branchExists) {
    // Create the milestone branch from the integration branch start-point.
    const integrationBranch =
      readIntegrationBranch(basePath, milestoneId) ?? undefined;
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    const startPoint =
      _resolveAutoWorktreeStartPoint(
        integrationBranch,
        gitPrefs?.main_branch,
        (branchName) => nativeBranchExists(basePath, branchName),
      ) ??
      nativeDetectMainBranch(basePath);

    if (
      !startPoint ||
      !runGit(
        basePath,
        ["rev-parse", "--verify", "--quiet", `${startPoint}^{commit}`],
        { allowFailure: true },
      )
    ) {
      // An unborn repository has no commit-backed ref to branch from. Let Git
      // move symbolic HEAD directly while preserving the index and untracked
      // project files that will become the first milestone commit.
      runGit(basePath, ["checkout", "-b", branch]);
      debugLog("auto-worktree", {
        action: "enterBranchMode",
        milestoneId,
        branch,
        created: true,
      });
      return;
    }

    // TOCTOU ancestry guard (Issue #4980 HIGH-3).
    //
    // The outer `branchExists` check is racy: a concurrent process
    // (parallel-orchestrator worker, side-by-side `gsd` instance, or manual
    // `git branch` invocation) may have created the branch with real commits
    // between that check and this point. `nativeBranchForceReset` does
    // `git branch -f`, which silently overwrites the branch ref — orphaning
    // any commits not reachable from `startPoint`. Re-check immediately
    // before the destructive call and refuse if the branch suddenly exists
    // with non-ancestor commits.
    const concurrentlyCreated = nativeBranchExists(basePath, branch);
    if (
      concurrentlyCreated &&
      !nativeIsAncestor(basePath, branch, startPoint)
    ) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `Branch "${branch}" was created concurrently with commits not reachable from "${startPoint}". ` +
        `Refusing to force-reset — would orphan prior work. ` +
        `Resume the existing milestone or run \`git branch -D ${branch}\` to discard.`,
      );
    }
    // nativeBranchForceReset creates (or resets) branch at startPoint,
    // then checkout switches HEAD to it.
    nativeBranchForceReset(basePath, branch, startPoint);
    debugLog("auto-worktree", {
      action: "enterBranchMode",
      milestoneId,
      branch,
      startPoint,
      created: true,
    });
  } else {
    debugLog("auto-worktree", {
      action: "enterBranchMode",
      milestoneId,
      branch,
      reused: true,
    });
  }

  // A zero-commit repo has no commit-backed ref for the milestone branch even
  // when it is already checked out, and `git checkout <branch>` then fails with
  // "pathspec did not match". HEAD already points at the (unborn) milestone
  // branch in that case, so branch entry is complete.
  if (
    !runGit(
      basePath,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    ) &&
    runGit(basePath, ["branch", "--show-current"], { allowFailure: true }) ===
      branch
  ) {
    return;
  }

  checkoutBranchWithStashGuard(
    basePath,
    branch,
    `enter-branch-mode:${milestoneId}`,
  );
}

/**
 * True when `branch` is checked out in any worktree listed by
 * `git worktree list --porcelain`. Used to gate ref updates that would
 * otherwise leave a concurrent worktree's HEAD inconsistent with its
 * index/working tree (Codex peer-review of #5538-followup).
 *
 * Best-effort: a `nativeWorktreeList` failure returns true so we err on
 * the side of NOT moving the ref. Better to skip a fast-forward than to
 * silently corrupt another worktree.
 */
export function _isBranchCheckedOutElsewhere(
  basePath: string,
  branch: string,
): boolean {
  try {
    const entries = nativeWorktreeList(basePath);
    return entries.some((entry) => entry.branch === branch);
  } catch {
    return true;
  }
}

/**
 * Resolve the integration branch using the same 3-tier fallback as the
 * fresh-create path: META.json → git.main_branch preference → detected
 * main branch. Returns null when no usable target exists.
 */
function resolveIntegrationBranchForReuse(
  basePath: string,
  milestoneId: string,
): string | null {
  const fromMeta = readIntegrationBranch(basePath, milestoneId);
  if (fromMeta) return fromMeta;

  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
  const fromPref = gitPrefs?.main_branch &&
    typeof gitPrefs.main_branch === "string" &&
    gitPrefs.main_branch.length > 0 &&
    nativeBranchExists(basePath, gitPrefs.main_branch)
    ? gitPrefs.main_branch
    : null;
  if (fromPref) return fromPref;

  try {
    return nativeDetectMainBranch(basePath);
  } catch {
    return null;
  }
}

/**
 * When reusing an existing milestone branch, fast-forward it onto the
 * integration branch when that's safe (branch is a strict ancestor of
 * integration — no commits would be lost). Skips when the branch has its
 * own commits ahead of integration, when the integration branch can't be
 * resolved, or when any git operation fails — the merge gate at milestone
 * completion will surface real divergence as a conflict.
 *
 * The previous behavior re-attached the worktree to whatever stale tip
 * the branch held, which caused new milestone work to fork from a base
 * missing prior milestones' merges (#5538-followup).
 */
export function fastForwardReusedMilestoneBranchIfSafe(
  basePath: string,
  milestoneId: string,
  branch: string,
): void {
  try {
    const integrationBranch = resolveIntegrationBranchForReuse(
      basePath,
      milestoneId,
    );
    if (!integrationBranch || integrationBranch === branch) return;
    if (!nativeBranchExists(basePath, integrationBranch)) return;

    // Pure fast-forward only: branch must be a strict ancestor of integration.
    // If the branch has its own commits ahead, leave it alone.
    if (!nativeIsAncestor(basePath, branch, integrationBranch)) {
      debugLog("createAutoWorktree", {
        phase: "skip-ff-branch-not-ancestor",
        milestoneId,
        branch,
        integration: integrationBranch,
      });
      return;
    }

    // Codex peer-review: `nativeUpdateRef` succeeds even when the branch is
    // currently checked out in another worktree, leaving that worktree's HEAD
    // inconsistent with its index/work tree. Skip the fast-forward if any
    // listed worktree has this branch checked out — the merge gate at
    // milestone-completion will surface stale-base divergence as a conflict
    // instead of silently corrupting the other worktree's state.
    if (_isBranchCheckedOutElsewhere(basePath, branch)) {
      debugLog("createAutoWorktree", {
        phase: "skip-ff-branch-checked-out-elsewhere",
        milestoneId,
        branch,
      });
      return;
    }

    nativeUpdateRef(basePath, `refs/heads/${branch}`, integrationBranch);
    debugLog("createAutoWorktree", {
      phase: "fast-forward-reused-branch",
      milestoneId,
      branch,
      integration: integrationBranch,
    });
  } catch (err) {
    debugLog("createAutoWorktree", {
      phase: "fast-forward-reused-branch-failed",
      milestoneId,
      branch,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
