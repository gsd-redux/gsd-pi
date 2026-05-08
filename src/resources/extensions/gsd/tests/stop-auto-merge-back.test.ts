// GSD-2 — stopAuto worktree exit strategy regression tests.

import test from "node:test";
import assert from "node:assert/strict";

import { _resolveAutoWorktreeExitActionForTest } from "../auto.ts";

test("completed milestones merge the auto worktree back", () => {
  assert.equal(
    _resolveAutoWorktreeExitActionForTest("M001", false, true),
    "merge",
  );
});

test("incomplete milestones preserve the branch for resumption", () => {
  assert.equal(
    _resolveAutoWorktreeExitActionForTest("M001", false, false),
    "preserve",
  );
});

test("already-merged or missing milestone exits skip worktree teardown", () => {
  assert.equal(
    _resolveAutoWorktreeExitActionForTest("M001", true, true),
    "skip",
  );
  assert.equal(
    _resolveAutoWorktreeExitActionForTest(null, false, true),
    "skip",
  );
});
