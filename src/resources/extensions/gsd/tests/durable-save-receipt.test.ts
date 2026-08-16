// Project/App: gsd-pi
// File Purpose: Verify-after-write receipt checks for save-tool units (#1714/#1761).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { _missingDurableSaveReceiptForTest } from "../auto-post-unit.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function openFixture(): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-save-receipt-"));
  tempDirs.add(dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Receipts', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Receipt slice', 'active', '2026-07-13T00:00:00.000Z');
  `);
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

test("run-uat without a persisted UAT gate row is an explicit error naming gsd_uat_result_save", () => {
  openFixture();
  const error = _missingDurableSaveReceiptForTest("run-uat", "M001/S01");
  assert.ok(error);
  assert.match(error, /not durably persisted/);
  assert.match(error, /gsd_uat_result_save/);
});

test("run-uat with a persisted UAT gate row passes the receipt check", () => {
  openFixture();
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'UAT', 'slice', '', 'complete')
  `).run();
  assert.equal(_missingDurableSaveReceiptForTest("run-uat", "M001/S01"), null);
});

test("validate-milestone without a persisted verdict names gsd_validate_milestone", () => {
  openFixture();
  const error = _missingDurableSaveReceiptForTest("validate-milestone", "M001");
  assert.ok(error);
  assert.match(error, /not durably persisted/);
  assert.match(error, /gsd_validate_milestone/);
});

test("validate-milestone with a persisted verdict passes the receipt check", () => {
  openFixture();
  db().prepare(`
    INSERT INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content)
    VALUES ('.gsd/milestones/M001/M001-VALIDATION.md', 'M001', NULL, NULL, 'pass', 'milestone-validation', '# Validation')
  `).run();
  assert.equal(_missingDurableSaveReceiptForTest("validate-milestone", "M001"), null);
});

test("other unit types have no save receipt to verify", () => {
  openFixture();
  assert.equal(_missingDurableSaveReceiptForTest("execute-task", "M001/S01/T01"), null);
});
