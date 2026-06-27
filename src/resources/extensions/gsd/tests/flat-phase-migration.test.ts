// Project/App: gsd-pi
// File Purpose: Tests the one-time migration from nested to flat-phase layout.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { migrateToFlatPhase, needsFlatPhaseMigration } from "../flat-phase-migration.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(options: { withTask?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-mig-${randomUUID()}`));
  // Create legacy nested structure
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(
    options.withTask === false ? join(sliceDir, "tasks") : join(sliceDir, "tasks", "T01"),
    { recursive: true },
  );
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  if (options.withTask !== false) {
    insertTask({
      milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
      status: "pending", sequence: 1,
    });
  }
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("needsFlatPhaseMigration returns true when .gsd/milestones/ exists", () => {
  const base = makeTmp();
  assert.equal(needsFlatPhaseMigration(base), true);
});

test("needsFlatPhaseMigration returns false when no .gsd/milestones/", () => {
  const base = mkdtempSync(join(tmpdir(), `gsd-nomig-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  tmpDirs.push(base);
  assert.equal(needsFlatPhaseMigration(base), false);
});

test("migrateToFlatPhase moves content from milestones/ to phases/", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases")), "phases/ should exist");
  assert.ok(!existsSync(join(base, ".gsd", "milestones")), "milestones/ should be removed");
});

test("migrateToFlatPhase creates a backup", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  assert.ok(existsSync(join(base, ".gsd-backups")), "backup should exist");
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.ok(backups.length >= 1, "at least one migrate-* backup dir should exist");
});

test("migrateToFlatPhase preserves milestone/slice/task counts in DB", async () => {
  const base = makeTmp();
  const msBefore = getAllMilestones().length;
  const slicesBefore = getMilestoneSlices("M001").length;
  const tasksBefore = getSliceTasks("M001", "S01").length;
  await migrateToFlatPhase(base);
  assert.equal(getAllMilestones().length, msBefore);
  assert.equal(getMilestoneSlices("M001").length, slicesBefore);
  assert.equal(getSliceTasks("M001", "S01").length, tasksBefore);
});

test("migrateToFlatPhase is idempotent (second run is a no-op)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  // Second run should not throw and should not create a second backup
  await migrateToFlatPhase(base);
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "should only have one backup");
});

test("migrateToFlatPhase preserves slice sidecar artifacts and skips recovery placeholder PLAN", async () => {
  const base = makeTmp({ withTask: false });
  const legacySliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(legacySliceDir, "S01-CONTEXT.md"), "# Final Slice Context\n\nPrior discussion.", "utf-8");
  writeFileSync(join(legacySliceDir, "S01-RESEARCH.md"), "# Slice Research\n\nPrior research.", "utf-8");
  writeFileSync(join(legacySliceDir, "S01-CONTINUE.md"), "# Continue\n\nCompacted marker.", "utf-8");
  writeFileSync(
    join(legacySliceDir, "S01-PLAN.md"),
    "# BLOCKER - auto-mode recovery failed\n\nUnit `plan-slice` failed to produce this artifact.",
    "utf-8",
  );

  await migrateToFlatPhase(base);

  const phaseDir = join(base, ".gsd", "phases", "01-foundation");
  assert.equal(readFileSync(join(phaseDir, "01-01-CONTEXT.md"), "utf-8"), "# Final Slice Context\n\nPrior discussion.");
  assert.equal(readFileSync(join(phaseDir, "01-01-RESEARCH.md"), "utf-8"), "# Slice Research\n\nPrior research.");
  assert.equal(readFileSync(join(phaseDir, "01-01-CONTINUE.md"), "utf-8"), "# Continue\n\nCompacted marker.");
  assert.equal(
    existsSync(join(phaseDir, "01-01-PLAN.md")),
    false,
    "recovery placeholder PLAN should not be promoted when no DB tasks can render a real plan",
  );
});
