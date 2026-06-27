// Regression tests for issue #912:
// validatePlanBoundary and validateCompleteBoundary must load all task
// artifact files and collect issues from every file, not just the first.
//
// The bug was sequential await-inside-loop loading; the fix batches reads
// with Promise.all. These tests assert the observable outcome: issues are
// returned for every task file present, not only one.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validatePlanBoundary, validateCompleteBoundary } from "../observability-validator.ts";
import { clearPathCache, _clearGsdRootCache } from "../paths.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────
//
// Each file is intentionally minimal so it triggers at least one deterministic
// validation issue (missing ## Steps → empty_steps_section, missing frontmatter
// observability_surfaces → missing_observability_frontmatter). The exact issue
// count is not asserted; we only verify that at least one issue refers to each
// task file path, proving all files were loaded and validated.

const BARE_TASK_PLAN = (id: string) => `# ${id}: Bare Task\n\n## Description\n\nDoes something.\n`;

const BARE_TASK_SUMMARY = (id: string) => `# ${id}-SUMMARY\n\n## Summary\n\nCompleted.\n`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create an isolated temp project root and return its path plus a cleanup
 * function that clears path caches and removes the directory.
 */
function makeProject(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-obs-boundary-")));
  return {
    root,
    cleanup() {
      _clearGsdRootCache();
      clearPathCache();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Create the legacy tasks directory structure inside a temp project root:
 *   {root}/.gsd/milestones/{mid}/slices/{sid}/tasks/
 *
 * Legacy layout is used because flat-phase projects embed tasks as inline
 * checkboxes in the slice plan file (no tasks/ subdir). The legacy layout
 * has an explicit tasks/ directory that resolveTasksDir returns.
 */
function makeLegacyTasksDir(root: string, mid: string, sid: string): string {
  const dir = join(root, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// ── validatePlanBoundary ────────────────────────────────────────────────────

test("#912 validatePlanBoundary: issues collected from every task plan file", async (t) => {
  const { root, cleanup } = makeProject();
  t.after(cleanup);

  _clearGsdRootCache();
  clearPathCache();

  const tasksDir = makeLegacyTasksDir(root, "M001", "S01");
  writeFileSync(join(tasksDir, "T01-PLAN.md"), BARE_TASK_PLAN("T01"), "utf-8");
  writeFileSync(join(tasksDir, "T02-PLAN.md"), BARE_TASK_PLAN("T02"), "utf-8");
  writeFileSync(join(tasksDir, "T03-PLAN.md"), BARE_TASK_PLAN("T03"), "utf-8");

  _clearGsdRootCache();
  clearPathCache();

  const issues = await validatePlanBoundary(root, "M001", "S01");

  // Every task file must appear in at least one issue — proving all three
  // were loaded. Before the fix only the last file in the loop would be
  // validated because the loop re-used a stale `content` binding.
  const paths = new Set(issues.map(i => i.file));
  assert.ok(
    paths.size >= 3,
    `expected issues from at least 3 task plan files, got paths: ${JSON.stringify([...paths])}`,
  );

  const t01Issues = issues.filter(i => i.file.includes("T01"));
  const t02Issues = issues.filter(i => i.file.includes("T02"));
  const t03Issues = issues.filter(i => i.file.includes("T03"));
  assert.ok(t01Issues.length > 0, "T01-PLAN.md should produce at least one validation issue");
  assert.ok(t02Issues.length > 0, "T02-PLAN.md should produce at least one validation issue");
  assert.ok(t03Issues.length > 0, "T03-PLAN.md should produce at least one validation issue");
});

test("#912 validatePlanBoundary: no issues when tasks directory is empty", async (t) => {
  const { root, cleanup } = makeProject();
  t.after(cleanup);

  _clearGsdRootCache();
  clearPathCache();

  // Create the tasks dir but leave it empty — no PLAN files.
  makeLegacyTasksDir(root, "M001", "S01");

  _clearGsdRootCache();
  clearPathCache();

  const issues = await validatePlanBoundary(root, "M001", "S01");

  // No slice plan and no task plans → no issues.
  assert.strictEqual(issues.length, 0, "empty tasks dir should produce no issues");
});

test("#912 validatePlanBoundary: returns empty array when basePath has no .gsd dir", async (t) => {
  const { root, cleanup } = makeProject();
  t.after(cleanup);

  _clearGsdRootCache();
  clearPathCache();

  // Don't create any .gsd structure — resolveTasksDir returns null.
  const issues = await validatePlanBoundary(root, "M001", "S01");

  assert.strictEqual(issues.length, 0, "missing .gsd layout should produce no issues");
});

// ── validateCompleteBoundary ─────────────────────────────────────────────────

test("#912 validateCompleteBoundary: issues collected from every task summary file", async (t) => {
  const { root, cleanup } = makeProject();
  t.after(cleanup);

  _clearGsdRootCache();
  clearPathCache();

  const tasksDir = makeLegacyTasksDir(root, "M001", "S01");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), BARE_TASK_SUMMARY("T01"), "utf-8");
  writeFileSync(join(tasksDir, "T02-SUMMARY.md"), BARE_TASK_SUMMARY("T02"), "utf-8");
  writeFileSync(join(tasksDir, "T03-SUMMARY.md"), BARE_TASK_SUMMARY("T03"), "utf-8");

  _clearGsdRootCache();
  clearPathCache();

  const issues = await validateCompleteBoundary(root, "M001", "S01");

  // Every task file must appear in at least one issue — proving all three
  // summary files were loaded in parallel and validated.
  const paths = new Set(issues.map(i => i.file));
  assert.ok(
    paths.size >= 3,
    `expected issues from at least 3 task summary files, got paths: ${JSON.stringify([...paths])}`,
  );

  const t01Issues = issues.filter(i => i.file.includes("T01"));
  const t02Issues = issues.filter(i => i.file.includes("T02"));
  const t03Issues = issues.filter(i => i.file.includes("T03"));
  assert.ok(t01Issues.length > 0, "T01-SUMMARY.md should produce at least one validation issue");
  assert.ok(t02Issues.length > 0, "T02-SUMMARY.md should produce at least one validation issue");
  assert.ok(t03Issues.length > 0, "T03-SUMMARY.md should produce at least one validation issue");
});

test("#912 validateCompleteBoundary: no issues when tasks directory is empty", async (t) => {
  const { root, cleanup } = makeProject();
  t.after(cleanup);

  _clearGsdRootCache();
  clearPathCache();

  makeLegacyTasksDir(root, "M001", "S01");

  _clearGsdRootCache();
  clearPathCache();

  const issues = await validateCompleteBoundary(root, "M001", "S01");

  assert.strictEqual(issues.length, 0, "empty tasks dir should produce no issues");
});

test("#912 validateCompleteBoundary: returns empty array when basePath has no .gsd dir", async (t) => {
  const { root, cleanup } = makeProject();
  t.after(cleanup);

  _clearGsdRootCache();
  clearPathCache();

  const issues = await validateCompleteBoundary(root, "M001", "S01");

  assert.strictEqual(issues.length, 0, "missing .gsd layout should produce no issues");
});
