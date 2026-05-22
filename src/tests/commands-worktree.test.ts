// GSD-2 — Unit tests for /gsd worktree formatter and dispatcher
import test from "node:test";
import assert from "node:assert/strict";

import {
  formatWorktreeList,
  type WorktreeStatus,
} from "../../dist/resources/extensions/gsd/commands-worktree.js";

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

test("empty list shows hint to create one", () => {
  const out = formatWorktreeList([]);
  assert.match(out, /No worktrees\./);
  assert.match(out, /gsd -w/);
});

test("clean worktree shows (clean) badge and no diff line", () => {
  const out = formatWorktreeList([mkStatus({ name: "alpha" })]);
  assert.match(out, /alpha \(clean\)/);
  assert.match(out, /branch\s+gsd\/alpha/);
  assert.match(out, /path\s+\/repo\/\.gsd/);
  assert.doesNotMatch(out, /diff\s+/);
});

test("uncommitted worktree shows (uncommitted) badge", () => {
  const out = formatWorktreeList([mkStatus({ name: "wip", uncommitted: true })]);
  assert.match(out, /wip \(uncommitted\)/);
});

test("unmerged worktree shows (unmerged) badge with diff stats", () => {
  const out = formatWorktreeList([
    mkStatus({
      name: "feature-y",
      filesChanged: 3,
      linesAdded: 42,
      linesRemoved: 7,
      commits: 2,
    }),
  ]);
  assert.match(out, /feature-y \(unmerged\)/);
  assert.match(out, /\bdiff\s+3 files, \+42 -7, 2 commits\b/);
});

test("singular file/commit pluralization", () => {
  const out = formatWorktreeList([
    mkStatus({
      name: "single",
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
      commits: 1,
    }),
  ]);
  assert.match(out, /\bdiff\s+1 file, \+1 -0, 1 commit\b/);
});

test("count header matches number of worktrees", () => {
  const out = formatWorktreeList([
    mkStatus({ name: "a" }),
    mkStatus({ name: "b" }),
    mkStatus({ name: "c" }),
  ]);
  assert.match(out, /Worktrees — 3/);
});
