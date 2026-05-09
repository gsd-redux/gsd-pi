// Project/App: GSD-2
// File Purpose: Worktree Safety module contract for validating source-writing Unit roots.

import { existsSync, lstatSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

import { normalizeWorktreePathForCompare } from "./worktree-root.js";
import { listWorktrees } from "./worktree-manager.js";
import { getCurrentBranch } from "./worktree.js";

export type WorktreeSafetyWriteScope = "planning-only" | "source-writing";

export type WorktreeSafetyFailureKind =
  | "milestone-id-invalid"
  | "milestone-id-missing"
  | "invalid-root"
  | "worktree-missing"
  | "worktree-git-marker-missing"
  | "worktree-git-marker-not-file"
  | "worktree-unregistered"
  | "branch-mismatch"
  | "lease-lost"
  | "empty-worktree-with-project-content";

export type WorktreeSafetyResult =
  | {
      ok: true;
      kind: "not-required";
      reason: string;
    }
  | {
      ok: true;
      kind: "safe";
      projectRoot: string;
      unitRoot: string;
      milestoneId: string;
      branch?: string;
    }
  | {
      ok: false;
      kind: WorktreeSafetyFailureKind;
      reason: string;
      remediation: string;
      details?: Record<string, string | number | boolean | null>;
    };

export interface WorktreeSafetyInput {
  unitType: string;
  unitId: string;
  writeScope: WorktreeSafetyWriteScope;
  projectRoot: string;
  unitRoot: string;
  milestoneId?: string | null;
  expectedBranch?: string | null;
  emptyWorktreeWithProjectContent?: boolean;
  lease?: {
    required: boolean;
    held: boolean;
    owner?: string | null;
  };
}

export interface RegisteredWorktree {
  path: string;
  branch?: string | null;
}

export interface WorktreeSafetyDeps {
  existsSync(path: string): boolean;
  lstatSync(path: string): Pick<Stats, "isFile">;
  listRegisteredWorktrees?(projectRoot: string): readonly RegisteredWorktree[];
  getCurrentBranch?(unitRoot: string): string;
}

export interface WorktreeSafetyModule {
  validateUnitRoot(input: WorktreeSafetyInput): WorktreeSafetyResult;
}

const fsOnlyDeps: WorktreeSafetyDeps = {
  existsSync,
  lstatSync,
};

const defaultDeps: WorktreeSafetyDeps = {
  ...fsOnlyDeps,
  listRegisteredWorktrees(projectRoot) {
    try {
      return listWorktrees(projectRoot).map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
      }));
    } catch {
      return [];
    }
  },
  getCurrentBranch,
};

function isValidMilestoneId(milestoneId: string): boolean {
  return milestoneId.length > 0 && !/[\/\\]|\.\./.test(milestoneId);
}

function samePath(a: string, b: string): boolean {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}

function failure(
  kind: WorktreeSafetyFailureKind,
  reason: string,
  remediation: string,
  details?: Record<string, string | number | boolean | null>,
): WorktreeSafetyResult {
  return { ok: false, kind, reason, remediation, details };
}

export function createWorktreeSafetyModule(
  deps: WorktreeSafetyDeps = defaultDeps,
): WorktreeSafetyModule {
  return {
    validateUnitRoot(input) {
      if (input.writeScope === "planning-only") {
        return {
          ok: true,
          kind: "not-required",
          reason: "planning-only Units may write GSD artifacts without a source worktree",
        };
      }

      const milestoneId = input.milestoneId?.trim();
      if (!milestoneId) {
        return failure(
          "milestone-id-missing",
          `Source-writing Unit ${input.unitType} ${input.unitId} has no milestone id.`,
          "Resolve the Unit milestone before preparing a worktree root.",
        );
      }
      if (!isValidMilestoneId(milestoneId)) {
        return failure(
          "milestone-id-invalid",
          `Milestone id "${milestoneId}" is not safe for worktree path resolution.`,
          "Use a milestone id without path separators or traversal segments.",
          { milestoneId },
        );
      }

      const projectRoot = resolve(input.projectRoot);
      const unitRoot = resolve(input.unitRoot);
      const expectedRoot = join(projectRoot, ".gsd", "worktrees", milestoneId);
      if (!samePath(unitRoot, expectedRoot)) {
        return failure(
          "invalid-root",
          `Unit root ${unitRoot} is not the expected worktree root for ${milestoneId}.`,
          "Prepare the Unit in its canonical milestone worktree before allowing source writes.",
          { expectedRoot, unitRoot },
        );
      }

      if (!deps.existsSync(unitRoot)) {
        return failure(
          "worktree-missing",
          `Worktree root ${unitRoot} does not exist.`,
          "Create or recover the milestone worktree before dispatching the source-writing Unit.",
          { unitRoot },
        );
      }

      const gitMarker = join(unitRoot, ".git");
      if (!deps.existsSync(gitMarker)) {
        return failure(
          "worktree-git-marker-missing",
          `Worktree root ${unitRoot} has no .git marker.`,
          "Recover or recreate the milestone worktree before dispatching the source-writing Unit.",
          { gitMarker },
        );
      }

      if (!deps.lstatSync(gitMarker).isFile()) {
        return failure(
          "worktree-git-marker-not-file",
          `Worktree root ${unitRoot} has a .git directory, not a registered worktree .git file.`,
          "Use a registered GSD worktree instead of a copied or nested repository.",
          { gitMarker },
        );
      }

      const registered = deps.listRegisteredWorktrees?.(projectRoot);
      if (registered && !registered.some((worktree) => samePath(worktree.path, unitRoot))) {
        return failure(
          "worktree-unregistered",
          `Worktree root ${unitRoot} is not registered with git worktree list.`,
          "Recreate or re-register the milestone worktree before dispatching the source-writing Unit.",
          { unitRoot },
        );
      }

      if (input.emptyWorktreeWithProjectContent) {
        return failure(
          "empty-worktree-with-project-content",
          `Worktree root ${unitRoot} has no project content, but the project root does.`,
          "Resolve untracked project-root content or recreate the worktree so source writes stay isolated.",
          { unitRoot, projectRoot },
        );
      }

      const expectedBranch = input.expectedBranch?.trim();
      let branch: string | undefined;
      if (expectedBranch && deps.getCurrentBranch) {
        branch = deps.getCurrentBranch(unitRoot);
        if (branch !== expectedBranch) {
          return failure(
            "branch-mismatch",
            `Worktree root ${unitRoot} is on branch ${branch}, expected ${expectedBranch}.`,
            "Switch to the expected milestone branch or recover the worktree before dispatching the Unit.",
            { branch, expectedBranch },
          );
        }
      }

      if (input.lease?.required && !input.lease.held) {
        return failure(
          "lease-lost",
          `Milestone lease for ${milestoneId} is not held by the current worker.`,
          "Reclaim the milestone lease before dispatching the source-writing Unit.",
          { owner: input.lease.owner ?? null },
        );
      }

      return {
        ok: true,
        kind: "safe",
        projectRoot,
        unitRoot,
        milestoneId,
        branch,
      };
    },
  };
}

export function createFsOnlyWorktreeSafetyModule(): WorktreeSafetyModule {
  return createWorktreeSafetyModule(fsOnlyDeps);
}
