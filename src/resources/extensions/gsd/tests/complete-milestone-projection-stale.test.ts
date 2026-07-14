// Project/App: gsd-pi
// File Purpose: Complete-milestone surfaces and repairs swallowed projection obstructions.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeDatabase,
  getMilestone,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  updateSliceStatus,
} from "../gsd-db.ts";
import {
  handleCompleteMilestone,
  type CompleteMilestoneParams,
} from "../tools/complete-milestone.ts";

function completionParams(): CompleteMilestoneParams {
  return {
    milestoneId: "M001",
    title: "M001: Projection delivery",
    oneLiner: "Milestone authority remains committed while projections catch up.",
    narrative: "The readable status can be repaired by an exact completion retry.",
    verificationPassed: true,
  };
}

function seedCompletedMilestone(basePath: string): void {
  insertMilestone({ id: "M001", title: "Projection delivery", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Complete Slice" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Complete Task",
    status: "complete",
  });
  updateSliceStatus("M001", "S01", "complete", "2026-07-14T00:00:00.000Z");
  insertAssessment({
    path: join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass\n",
  });
}

test("complete-milestone surfaces a swallowed projection obstruction and repairs it on retry", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-complete-milestone-stale-"));
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  seedCompletedMilestone(basePath);

  const statePath = join(basePath, ".gsd", "STATE.md");
  mkdirSync(statePath);
  const obstructed = await handleCompleteMilestone(completionParams(), basePath);

  assert.ok(!("error" in obstructed));
  assert.equal(obstructed.stale, true);
  assert.equal(getMilestone("M001")?.status, "complete");

  rmSync(statePath, { recursive: true, force: true });
  const repaired = await handleCompleteMilestone(completionParams(), basePath);

  assert.ok(!("error" in repaired));
  assert.equal(repaired.alreadyComplete, true);
  assert.equal(repaired.stale, undefined);
  assert.equal(statSync(statePath).isFile(), true);
});
