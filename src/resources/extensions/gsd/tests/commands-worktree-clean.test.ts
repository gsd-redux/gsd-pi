import test from "node:test";
import assert from "node:assert/strict";

import {
  formatCleanKeepReason,
  type WorktreeStatus,
} from "../commands-worktree.ts";

function mkStatus(over: Partial<WorktreeStatus>): WorktreeStatus {
  const name = over.name ?? "feat-x";
  return {
    name,
    path: `/repo/.gsd/worktrees/${name}`,
    branch: `gsd/${name}`,
    exists: true,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    uncommitted: false,
    commits: 0,
    ...over,
  };
}

test("clean keep reason shows uncommitted-only worktrees clearly", () => {
  const reason = formatCleanKeepReason(mkStatus({ uncommitted: true }));
  assert.equal(reason, "uncommitted changes");
});

test("clean keep reason includes uncommitted context with changed files", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 2, uncommitted: true }));
  assert.equal(reason, "2 changed files, uncommitted");
});

test("clean keep reason flags missing directory with prune hint", () => {
  const reason = formatCleanKeepReason(mkStatus({ exists: false }));
  assert.equal(reason, "directory missing — run 'git worktree prune' to unregister");
});

test("clean keep reason reports changed files without uncommitted suffix", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 2, uncommitted: false }));
  assert.equal(reason, "2 changed files");
});

test("clean keep reason uses singular form for a single changed file", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 1, uncommitted: false }));
  assert.equal(reason, "1 changed file");
});
