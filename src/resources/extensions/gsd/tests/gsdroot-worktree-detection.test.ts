/**
 * gsdroot-worktree-detection.test.ts — Regression test for #2594 and #6140.
 *
 * gsdRoot() must return the worktree-local .gsd directory when basePath
 * is inside a .gsd/worktrees/<name>/ structure. This keeps the writer and
 * reader colocated under worktree isolation, preventing the plan-slice
 * verifier loop that occurred when they diverged (#6140).
 *
 * gsdProjectionRoot() always returns the worktree-local .gsd (including when
 * it does not exist yet), so after this fix gsdRoot() and gsdProjectionRoot()
 * agree for worktree paths.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { gsdProjectionRoot, gsdRoot, resolveGsdPathContract, _clearGsdRootCache } from "../paths.ts";

describe("gsdRoot() worktree detection (#2594)", () => {
  let projectRoot: string;
  let projectGsd: string;

  beforeEach(() => {
    _clearGsdRootCache();
    // Create a temporary project with a git repo to simulate real conditions.
    // realpathSync handles macOS /tmp -> /private/tmp.
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsdroot-wt-")));
    projectGsd = join(projectRoot, ".gsd");
    mkdirSync(projectGsd, { recursive: true });

    // Initialize a git repo in the project root so git rev-parse works
    spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.email", "test@test.com"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "Test"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    // Create an initial commit so we have a HEAD
    writeFileSync(join(projectRoot, "README.md"), "# Test");
    spawnSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    _clearGsdRootCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("returns worktree-local .gsd when basePath is a worktree with its own .gsd", () => {
    // Simulates a worktree that already had copyPlanningArtifacts() run,
    // so it has its own .gsd/ directory.
    const worktreeBase = join(projectGsd, "worktrees", "M008");
    const worktreeGsd = join(worktreeBase, ".gsd");
    mkdirSync(worktreeGsd, { recursive: true });

    const result = gsdRoot(worktreeBase);
    assert.equal(
      result,
      worktreeGsd,
      `Expected worktree-local .gsd (${worktreeGsd}), got ${result}.`,
    );
    assert.equal(resolveGsdPathContract(worktreeBase).worktreeGsd, worktreeGsd);
    assert.equal(gsdProjectionRoot(worktreeBase), worktreeGsd);
  });

  test("returns worktree-local .gsd path when worktree .gsd does not exist yet", () => {
    const worktreeBase = join(projectGsd, "worktrees", "M008");
    mkdirSync(worktreeBase, { recursive: true });
    // NOTE: no .gsd/ inside worktreeBase
    const expectedGsd = join(worktreeBase, ".gsd");

    const result = gsdRoot(worktreeBase);
    assert.equal(
      result,
      expectedGsd,
      `Expected worktree-local .gsd (${expectedGsd}), got ${result}.`,
    );
    assert.equal(gsdProjectionRoot(worktreeBase), expectedGsd);
  });

  test("returns worktree-local .gsd when basePath is a real git worktree inside .gsd/worktrees/", () => {
    // Create a real git worktree at .gsd/worktrees/M010
    const worktreeName = "M010";
    const worktreeBase = join(projectGsd, "worktrees", worktreeName);

    // Use git worktree add to create a real worktree
    const result = spawnSync(
      "git",
      ["worktree", "add", "-b", `milestone/${worktreeName}`, worktreeBase],
      { cwd: projectRoot, encoding: "utf-8" },
    );

    if (result.status !== 0) {
      // If git worktree add fails, skip the test gracefully
      assert.ok(true, "Skipped: git worktree add not available");
      return;
    }

    // The real git worktree exists at worktreeBase but has NO .gsd/ subdir yet
    const expectedGsd = join(worktreeBase, ".gsd");
    const gsdResult = gsdRoot(worktreeBase);
    assert.equal(
      gsdResult,
      expectedGsd,
      `Expected worktree-local .gsd (${expectedGsd}), got ${gsdResult}`,
    );
    assert.equal(gsdProjectionRoot(worktreeBase), expectedGsd);

    // Cleanup worktree
    spawnSync("git", ["worktree", "remove", "--force", worktreeBase], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  test("still returns project .gsd for normal (non-worktree) basePath", () => {
    const result = gsdRoot(projectRoot);
    assert.equal(result, projectGsd);
  });

  test("still returns project .gsd for a subdirectory of the project", () => {
    const subdir = join(projectRoot, "src", "lib");
    mkdirSync(subdir, { recursive: true });

    const result = gsdRoot(subdir);
    assert.equal(
      result,
      projectGsd,
      "Non-worktree subdirectories should still resolve to project .gsd",
    );
  });
});
