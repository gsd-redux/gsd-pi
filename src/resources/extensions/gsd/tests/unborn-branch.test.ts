/**
 * unborn-branch.test.ts — Regression test for #1771.
 *
 * Verifies that nativeBranchExists returns true for the current branch
 * in a repo with zero commits (unborn branch). Previously, show-ref
 * would fail for unborn branches, causing a dispatch deadlock when
 * the branch was recorded as integration branch but could never be
 * verified.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  branchExistsIncludingUnborn,
  currentBranchIncludingUnborn,
  nativeBranchExists,
  nativeDetectMainBranch,
} from "../native-git-bridge.ts";
import { enterBranchModeForMilestone } from "../auto-worktree-branch-lifecycle.ts";
import { preDispatchHealthGate } from "../doctor-proactive.ts";
import { checkGitHealth } from "../doctor-git-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { captureIntegrationBranch } from "../worktree.ts";
import { readIntegrationBranch } from "../git-service.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeUnbornIsolationFixture(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-test-")));
  const gsdHome = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-home-")));
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  t.after(() => {
    closeDatabase();
    invalidateStateCache();
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(gsdHome, { recursive: true, force: true });
  });

  process.chdir(dir);
  process.env.GSD_HOME = gsdHome;
  git(["init", "--initial-branch=main"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, ".gitignore"), ".gsd/\n");
  writeFileSync(join(dir, "project.txt"), "project content\n");
  mkdirSync(join(dir, ".gsd"));
  return dir;
}

test("nativeBranchExists: returns true for unborn branch (zero commits)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-test-")));
  try {
    git(["init"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);

    // Repo has zero commits — HEAD exists but points to refs/heads/main
    // which does not yet exist in the ref store.
    const currentBranch = git(["branch", "--show-current"], dir);
    assert.ok(currentBranch, "git branch --show-current should return a branch name");

    // This is the bug: nativeBranchExists would return false because
    // show-ref --verify fails on an unborn branch.
    const exists = nativeBranchExists(dir, currentBranch);
    assert.strictEqual(exists, true, "unborn current branch should be treated as existing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nativeBranchExists: returns false for non-existent branch in unborn repo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-test-")));
  try {
    git(["init"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);

    // A branch that is NOT the current unborn branch should still return false.
    const exists = nativeBranchExists(dir, "nonexistent-branch");
    assert.strictEqual(exists, false, "non-current branch should not exist in unborn repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native branch lookup recognizes symbolic unborn HEAD across reruns", () => {
  assert.equal(
    branchExistsIncludingUnborn(false, "milestone/M001", "milestone/M001"),
    true,
  );
  assert.equal(
    branchExistsIncludingUnborn(false, "milestone/M001", "milestone/M002"),
    false,
  );
});

test("native branch lookup falls back when unborn HEAD throws", () => {
  const currentBranch = currentBranchIncludingUnborn(
    () => {
      throw new Error("unborn HEAD");
    },
    () => "milestone/M001",
  );

  assert.equal(currentBranch, "milestone/M001");
  assert.equal(branchExistsIncludingUnborn(false, currentBranch, "milestone/M001"), true);
});

test("branch mode re-enters a dirty current milestone branch", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);

  enterBranchModeForMilestone(dir, "M001");
  writeFileSync(join(dir, "draft.txt"), "uncommitted work\n");
  enterBranchModeForMilestone(dir, "M001");

  assert.equal(git(["symbolic-ref", "--short", "HEAD"], dir), "milestone/M001");
  assert.equal(git(["status", "--short", "draft.txt"], dir), "?? draft.txt");
});

test("branch isolation preserves the integration ref in an unborn repo", async (t) => {
  const dir = makeUnbornIsolationFixture(t);

  assert.equal(nativeDetectMainBranch(dir), "");
  captureIntegrationBranch(dir, "M001");
  assert.equal(readIntegrationBranch(dir, "M001"), "main");

  enterBranchModeForMilestone(dir, "M001");

  assert.equal(git(["branch", "--show-current"], dir), "milestone/M001");
  assert.ok(git(["rev-parse", "--verify", "main^{commit}"], dir));

  // Re-entry must remain idempotent after the baseline commit.
  enterBranchModeForMilestone(dir, "M001");

  assert.equal(git(["branch", "--show-current"], dir), "milestone/M001");
  assert.equal(
    git(["status", "--short"], dir),
    "",
    "the integration baseline should include existing project content",
  );

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  invalidateStateCache();

  const health = await preDispatchHealthGate(dir);
  assert.equal(health.proceed, true, health.reason);
});

test("doctor repairs a legacy unborn milestone branch with a missing integration ref", async (t) => {
  const dir = makeUnbornIsolationFixture(t);
  writeFileSync(
    join(dir, ".gsd", "M001-META.json"),
    JSON.stringify({ integrationBranch: "main" }),
  );
  git(["checkout", "-b", "milestone/M001"], dir);

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  invalidateStateCache();

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGitHealth(
    dir,
    issues,
    fixesApplied,
    (code) => code === "integration_branch_missing",
    "branch",
  );

  assert.equal(
    issues.find((issue) => issue.code === "integration_branch_missing")?.fixable,
    true,
  );
  assert.ok(git(["rev-parse", "--verify", "main^{commit}"], dir));
  assert.equal(git(["branch", "--show-current"], dir), "milestone/M001");

  const health = await preDispatchHealthGate(dir);
  assert.equal(health.proceed, true, health.reason);
});

test("nativeDetectMainBranch: still throws for a path that is not a repo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-nonrepo-")));
  try {
    // "" is reserved for an unborn HEAD inside a real repo. A non-repo path
    // must keep failing loudly so callers (e.g. the orchestrator's branch
    // discovery guard) still take their error path.
    assert.throws(() => nativeDetectMainBranch(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nativeBranchExists: still works for real branches with commits", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unborn-branch-test-")));
  try {
    git(["init"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "file.txt"), "test\n");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);

    // After a commit, the branch exists in refs and should return true.
    const currentBranch = git(["branch", "--show-current"], dir);
    const exists = nativeBranchExists(dir, currentBranch);
    assert.strictEqual(exists, true, "branch with commits should exist");

    // Non-existent branch should still return false.
    const noExists = nativeBranchExists(dir, "no-such-branch");
    assert.strictEqual(noExists, false, "non-existent branch should not exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
