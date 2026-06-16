// Project/App: gsd-pi
// File Purpose: Tests milestone closeout settlement helper.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertMilestone, closeDatabase } from "../gsd-db.js";
import {
  isMilestoneCloseoutSettled,
  evaluateCompleteMilestoneDispatch,
} from "../milestone-closeout.js";
import type { DispatchContext } from "../auto-dispatch.js";

/** Build a minimal DispatchContext for the dispatch-policy branches under test. */
function makeDispatchCtx(base: string, phase: string): DispatchContext {
  return {
    basePath: base,
    mid: "M001",
    midTitle: "M001: Test",
    state: { phase } as DispatchContext["state"],
    prefs: undefined,
  } as DispatchContext;
}

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  closeDatabase();
});

test("isMilestoneCloseoutSettled requires DB closed and summary artifact", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\n");

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, true);
});

test("isMilestoneCloseoutSettled returns false when summary artifact is missing", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-missing-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Open", status: "active" });

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, false);
});

// ─── evaluateCompleteMilestoneDispatch: early-return branches ──────────────
// These two branches resolve before the git-commit step, so they are pure of
// any working-tree/git state and safe to unit test.

test("evaluateCompleteMilestoneDispatch returns null when phase is not completing-milestone", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-phase-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Open", status: "active" });

  const action = await evaluateCompleteMilestoneDispatch(makeDispatchCtx(base, "executing"));
  assert.equal(action, null, "non-closeout phase should not produce a dispatch action");
});

test("evaluateCompleteMilestoneDispatch skips when milestone is already closed", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-closed-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });

  const action = await evaluateCompleteMilestoneDispatch(
    makeDispatchCtx(base, "completing-milestone"),
  );
  assert.ok(action, "an already-closed milestone in completing-milestone should yield an action");
  assert.equal(action!.action, "skip", "already-closed milestone should resolve to skip (idempotent)");
});
