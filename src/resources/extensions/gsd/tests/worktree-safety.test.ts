// Project/App: GSD-2
// File Purpose: Unit tests for the Worktree Safety module contract.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktreeSafetyModule } from "../worktree-safety.ts";

describe("Worktree Safety module", () => {
  let root: string;
  let projectRoot: string;
  let unitRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gsd-worktree-safety-"));
    projectRoot = join(root, "project");
    unitRoot = join(projectRoot, ".gsd", "worktrees", "M001");
    mkdirSync(unitRoot, { recursive: true });
    writeFileSync(join(unitRoot, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("allows planning-only Units without requiring a source worktree", () => {
    const safety = createWorktreeSafetyModule();

    const result = safety.validateUnitRoot({
      unitType: "plan-milestone",
      unitId: "M001",
      writeScope: "planning-only",
      projectRoot,
      unitRoot: projectRoot,
      milestoneId: "M001",
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, "not-required");
  });

  test("accepts a source-writing Unit with a registered worktree and expected branch", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }],
      getCurrentBranch: () => "milestone/M001",
    });

    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      expectedBranch: "milestone/M001",
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, "safe");
    assert.equal(result.milestoneId, "M001");
    assert.equal(result.branch, "milestone/M001");
  });

  test("rejects a source-writing Unit when the worktree root is missing", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: (path) => path !== unitRoot,
      lstatSync: () => ({ isFile: () => true }),
    });

    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-missing");
    assert.match(result.remediation, /Create or recover/);
  });

  test("rejects a standalone repository masquerading as a worktree", () => {
    unlinkSync(join(unitRoot, ".git"));
    mkdirSync(join(unitRoot, ".git"), { recursive: true });
    const safety = createWorktreeSafetyModule();

    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-git-marker-not-file");
  });

  test("rejects an unregistered worktree path", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [],
    });

    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-unregistered");
  });

  test("rejects a branch mismatch with a typed failure", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }],
      getCurrentBranch: () => "feature/unexpected",
    });

    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      expectedBranch: "milestone/M001",
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "branch-mismatch");
    assert.equal(result.details?.branch, "feature/unexpected");
  });
});
