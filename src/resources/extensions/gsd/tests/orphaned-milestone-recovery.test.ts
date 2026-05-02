// GSD-2 — regression tests for orphaned-milestone recovery (Fix B).
//
// Background: when gsd_plan_milestone is HARD BLOCKED by the depth gate after
// M###-CONTEXT.md is already on disk, the user lands in a stuck state where
// disk has milestone artifacts but the DB has no row. The next /gsd then
// dropped them into "Create next milestone" without acknowledging the orphan.
//
// Fix B adds:
//   1) findOrphanedMilestones() helper — pin its detection contract here.
//   2) doctor check `orphan_milestone_artifacts` — pin reporting contract.
//   3) wizard recovery prompt — covered by the helper test plus the doctor
//      check, since the wizard is hard to exercise in isolation (showNextAction
//      depends on a TUI surface).

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findOrphanedMilestones } from "../guided-flow.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

function mkBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-orphan-recovery-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function withContext(base: string, mid: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), `# ${mid}\n`);
}

function emptyDir(base: string, mid: string): void {
  mkdirSync(join(base, ".gsd", "milestones", mid, "slices"), { recursive: true });
}

describe("findOrphanedMilestones — disk/DB divergence detection", () => {
  let base: string | undefined;

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
      base = undefined;
    }
  });

  test("CONTEXT.md on disk + no DB row → flagged as orphan", () => {
    base = mkBase();
    withContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));

    const orphans = findOrphanedMilestones(base, ["M001"]);
    assert.deepEqual(orphans, ["M001"]);
  });

  test("CONTEXT.md on disk + queued DB row → flagged (gsd_milestone_generate_id seed)", () => {
    base = mkBase();
    withContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", status: "queued" });

    const orphans = findOrphanedMilestones(base, ["M001"]);
    assert.deepEqual(orphans, ["M001"]);
  });

  test("CONTEXT.md on disk + active DB row → NOT flagged", () => {
    base = mkBase();
    withContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", status: "active" });

    const orphans = findOrphanedMilestones(base, ["M001"]);
    assert.deepEqual(orphans, []);
  });

  test("empty stub dir (no CONTEXT.md / no ROADMAP.md) → NOT flagged (handled by orphan_milestone_dir)", () => {
    base = mkBase();
    emptyDir(base, "M002");
    openDatabase(join(base, ".gsd", "gsd.db"));

    const orphans = findOrphanedMilestones(base, ["M002"]);
    assert.deepEqual(orphans, [], "empty stubs are a separate doctor check; do not double-report");
  });

  test("multiple milestones, mixed → returns only the orphans", () => {
    base = mkBase();
    withContext(base, "M001"); // orphan: no DB row
    withContext(base, "M002"); // valid: active row
    withContext(base, "M003"); // orphan: queued row only
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M002", status: "active" });
    insertMilestone({ id: "M003", status: "queued" });

    const orphans = findOrphanedMilestones(base, ["M001", "M002", "M003"]);
    assert.deepEqual(orphans.sort(), ["M001", "M003"]);
  });

  test("DB unavailable → returns [] (markdown-fallback mode cannot distinguish)", () => {
    base = mkBase();
    withContext(base, "M001");
    // Intentionally do NOT openDatabase — isDbAvailable() returns false.
    // closeDatabase from a prior test is run via afterEach, so the adapter is null.

    const orphans = findOrphanedMilestones(base, ["M001"]);
    assert.deepEqual(orphans, [], "DB unavailable must not produce false positives");
  });
});

describe("doctor orphan_milestone_artifacts check", () => {
  let base: string | undefined;

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
      base = undefined;
    }
  });

  test("populated dir with no DB row reports orphan_milestone_artifacts (warning, not fixable)", async () => {
    base = mkBase();
    withContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(
      (i) => i.code === "orphan_milestone_artifacts" && i.unitId === "M001",
    );
    assert.ok(orphan, "should report orphan_milestone_artifacts for populated dir + no DB row");
    assert.equal(orphan?.severity, "warning");
    assert.equal(orphan?.fixable, false, "must not be auto-fixable — recover/discard is a user decision");
    assert.match(
      orphan!.message,
      /Run \/gsd to choose recover or discard/,
      "message should point user to the wizard prompt",
    );
  });

  test("populated dir with queued DB row reports orphan_milestone_artifacts", async () => {
    base = mkBase();
    withContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", status: "queued" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(
      (i) => i.code === "orphan_milestone_artifacts" && i.unitId === "M001",
    );
    assert.ok(orphan, "queued-only DB row counts as orphan");
    assert.match(orphan!.message, /DB row is still queued/);
  });

  test("populated dir with active DB row does NOT report orphan_milestone_artifacts", async () => {
    base = mkBase();
    withContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", status: "active" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(
      (i) => i.code === "orphan_milestone_artifacts" && i.unitId === "M001",
    );
    assert.equal(orphan, undefined, "active DB row → no divergence to report");
  });
});
