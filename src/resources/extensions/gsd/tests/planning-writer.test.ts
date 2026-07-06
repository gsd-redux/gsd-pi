// Project/App: gsd-pi
// File Purpose: Tests for the DB → .planning/ projection writer.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { writePlanningDirectory } from "../migrate/planning-writer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, updateTaskStatus } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-pw-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
    planning: { estimate: "30m" },
  });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("writePlanningDirectory emits flat-phases layout: ROADMAP.md + phases/NN-slug/", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");

  assert.ok(existsSync(join(base, ".planning", "ROADMAP.md")), "ROADMAP.md missing");
  assert.ok(existsSync(join(base, ".planning", "STATE.md")), "STATE.md missing");
  assert.ok(existsSync(join(base, ".planning", "PROJECT.md")), "PROJECT.md missing");

  const phaseDirs = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(phaseDirs.length >= 1, `expected ≥1 phase dir, got ${JSON.stringify(phaseDirs)}`);
  assert.ok(/^01-/.test(phaseDirs[0]!), `phase dir should start with 01-, got ${phaseDirs[0]}`);
});

test("writePlanningDirectory emits phase plan file with XML structure", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");

  const phaseDir = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)[0]!;
  const planFiles = readdirSync(join(base, ".planning", "phases", phaseDir))
    .filter((f) => f.endsWith("PLAN.md"));
  assert.ok(planFiles.length >= 1, "expected ≥1 plan file");
  const plan = readFileSync(join(base, ".planning", "phases", phaseDir, planFiles[0]!), "utf-8");
  // Planning plans use XML tags per parsers.ts extractXmlTag
  assert.match(plan, /<objective>/);
  assert.match(plan, /<tasks>/);
});

test("writePlanningDirectory renders completed task checkboxes as [x] (#1276)", async () => {
  const base = makeTmp();
  updateTaskStatus("M001", "S01", "T01", "complete");
  await writePlanningDirectory(base, "flat-phases");

  const phaseDir = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)[0]!;
  const planFile = readdirSync(join(base, ".planning", "phases", phaseDir))
    .filter((f) => f.endsWith("PLAN.md"))[0]!;
  const plan = readFileSync(join(base, ".planning", "phases", phaseDir, planFile), "utf-8");
  assert.match(plan, /- \[x\] \*\*T01\*\*/, "completed task should project as [x], not [ ]");

  const roadmap = readFileSync(join(base, ".planning", "ROADMAP.md"), "utf-8");
  assert.match(roadmap, /- \[x\] 01 —/, "phase with all tasks complete should be [x] in ROADMAP");
});

test("writePlanningDirectory is idempotent: writing twice produces stable content", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");
  const snap = (p: string) => readFileSync(p, "utf-8").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  const roadmap1 = snap(join(base, ".planning", "ROADMAP.md"));
  await writePlanningDirectory(base, "flat-phases");
  const roadmap2 = snap(join(base, ".planning", "ROADMAP.md"));
  assert.equal(roadmap2, roadmap1);
});

test("writePlanningDirectory throws for unsupported layouts", async () => {
  const base = makeTmp();
  await assert.rejects(() => writePlanningDirectory(base, "multi-milestone"), /not yet supported/);
  await assert.rejects(() => writePlanningDirectory(base, "legacy-milestone-dir"), /not yet supported/);
});
