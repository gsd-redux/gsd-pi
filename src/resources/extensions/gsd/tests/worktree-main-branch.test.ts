// GSD-2 — Auto-worktree main branch preference regression tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { _resolveAutoWorktreeStartPointForTest } from "../auto-worktree.ts";

test("auto-worktree start point prefers milestone integration branch", () => {
  const startPoint = _resolveAutoWorktreeStartPointForTest(
    "release/integration",
    "dev",
    () => true,
  );

  assert.equal(startPoint, "release/integration");
});

test("auto-worktree start point uses git.main_branch only when it exists", () => {
  assert.equal(
    _resolveAutoWorktreeStartPointForTest(null, "dev", (branch) => branch === "dev"),
    "dev",
  );
  assert.equal(
    _resolveAutoWorktreeStartPointForTest(null, "stale", () => false),
    undefined,
  );
});
