// Project/App: gsd-pi
// File Purpose: Regression test for the flat-phase `task_file_not_in_plan`
// false positive. In flat-phase layouts resolveSlicePath() falls back to the
// phase dir, so resolveTasksDir() returns ONE shared <phase>/tasks/ for every
// slice. Comparing that shared listing against a single slice's plan reported
// each foreign summary as missing from every slice that did not own it — one
// stray summary produced an issue per sibling slice.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

const PHASE_DIR = "01-m001-shared-tasks";

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

/**
 * Flat-phase milestone with two slices, each planned with one task, plus a
 * single shared <phase>/tasks/ directory. No slices/<SID>/ subdirs — that is
 * what makes resolveSlicePath() fall back to the phase dir.
 */
function makeFlatPhaseBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-shared-tasks-"));
  const phase = join(base, ".gsd", "phases", PHASE_DIR);
  mkdirSync(join(phase, "tasks"), { recursive: true });

  writeFileSync(
    join(phase, "01-ROADMAP.md"),
    [
      "# M001: Shared Tasks",
      "",
      "- [ ] **S01: First slice** `risk:medium` `depends:[]`",
      "- [ ] **S02: Second slice** `risk:medium` `depends:[S01]`",
      "",
    ].join("\n"),
  );

  // Each slice's plan lists only its own task.
  writeFileSync(
    join(phase, "01-01-PLAN.md"),
    ["# S01 Plan", "", "- [ ] **S01.T01**: First task", ""].join("\n"),
  );
  writeFileSync(
    join(phase, "01-02-PLAN.md"),
    ["# S02 Plan", "", "- [ ] **S02.T01**: Second task", ""].join("\n"),
  );

  // The shared tasks/ dir holds a summary owned by S02 only.
  writeFileSync(join(phase, "tasks", "S02.T01-SUMMARY.md"), "# S02.T01 summary\n");

  return base;
}

function seed(): void {
  insertMilestone({ id: "M001", title: "Shared Tasks", status: "active" });
  for (const [id, title, seq] of [["S01", "First slice", 1], ["S02", "Second slice", 2]] as const) {
    insertSlice({
      id, milestoneId: "M001", title, status: "pending",
      risk: "medium", depends: [], demo: `${id} demo.`, sequence: seq,
    });
  }
  insertTask({ id: "S01.T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "pending" });
  insertTask({ id: "S02.T01", sliceId: "S02", milestoneId: "M001", title: "Second task", status: "pending" });
}

test("task_file_not_in_plan is not reported on sibling slices sharing a flat-phase tasks/ dir", async (t) => {
  const base = makeFlatPhaseBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seed();

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });

  const reported = issues.filter((i) => i.code === "task_file_not_in_plan");

  // S02.T01-SUMMARY.md is listed in S02's plan and owned by S02. S01 shares the
  // same tasks/ dir but must not claim it: before the fix S01 reported it as
  // "S02.T01 is not in S01-PLAN.md".
  assert.deepEqual(
    reported.map((i) => i.unitId),
    [],
    `no slice should report a foreign summary; got: ${reported.map((i) => `${i.unitId}: ${i.message}`).join(" | ")}`,
  );
});
