// gsd-pi — Pre-merge stash characterization tests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPreMergeStash } from "../auto-worktree-merge-stash.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

function createRepo(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "gsd-merge-stash-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

function status(root: string): string {
  return git(root, ["status", "--porcelain"]);
}

test("pre-merge stash moves tracked and untracked local work out of the merge path", (t) => {
  const root = createRepo(t);
  writeFileSync(join(root, "tracked.txt"), "local edit\n");
  writeFileSync(join(root, "untracked.txt"), "local untracked\n");

  const stash = createPreMergeStash(root, "M001", false);
  stash.stash();

  assert.equal(status(root), "", "stash leaves the worktree clean for merge");
  assert.ok(!existsSync(join(root, "untracked.txt")), "untracked files are included in the pre-merge stash");

  stash.restoreForMergeFailure();

  assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "local edit\n");
  assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "local untracked\n");
  assert.equal(git(root, ["stash", "list"]).trim(), "", "targeted restore consumes the pre-merge stash");
});

test("post-commit stash restore brings local work back after merge commit", (t) => {
  const root = createRepo(t);
  writeFileSync(join(root, "tracked.txt"), "local edit\n");
  writeFileSync(join(root, "untracked.txt"), "local untracked\n");

  const stash = createPreMergeStash(root, "M002", false);
  stash.stash();
  writeFileSync(join(root, "merged.txt"), "merged\n");
  git(root, ["add", "merged.txt"]);
  git(root, ["commit", "-m", "merge result"]);

  stash.restoreAfterCommit();

  assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "local edit\n");
  assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "local untracked\n");
  assert.equal(git(root, ["stash", "list"]).trim(), "", "post-commit restore consumes the pre-merge stash");
});

test("authorization stash leaves canonical GSD state available to the closeout proof", (t) => {
  const root = createRepo(t);
  mkdirSync(join(root, ".gsd"));
  writeFileSync(join(root, ".gsd", "gsd.db"), "canonical state\n");
  writeFileSync(join(root, "ad-hoc-helper.ps1"), "Write-Output helper\n");

  const stash = createPreMergeStash(root, "M003", false, { excludeGsdState: true });
  stash.stash();

  assert.equal(readFileSync(join(root, ".gsd", "gsd.db"), "utf8"), "canonical state\n");
  assert.equal(existsSync(join(root, "ad-hoc-helper.ps1")), false);

  stash.restoreBeforeAutoCommit();
  assert.equal(readFileSync(join(root, "ad-hoc-helper.ps1"), "utf8"), "Write-Output helper\n");
});

test("authorization stash restore fails closed when protected files cannot be restored", (t) => {
  const root = createRepo(t);
  writeFileSync(join(root, "ad-hoc-helper.ps1"), "stashed helper\n");
  const stash = createPreMergeStash(root, "M004", false, { excludeGsdState: true });
  stash.stash();
  writeFileSync(join(root, "ad-hoc-helper.ps1"), "conflicting helper\n");

  assert.throws(
    () => stash.restoreBeforeAutoCommit(),
    /already exists|restore untracked|would be overwritten/i,
  );
  assert.match(git(root, ["stash", "list"]), /gsd: pre-merge stash for M004/);
});
