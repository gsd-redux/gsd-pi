// Project/App: gsd-pi
// File Purpose: Regression tests for DB-backed closeout consistency before merge.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { mergeMilestoneToMain } from "../auto-worktree-merge.ts";
import {
  checkCloseoutConsistencyGate,
  formatCloseoutAuthorizationBlockers,
  formatCloseoutConsistencyBlock,
} from "../closeout-consistency-gate.ts";
import {
  _getAdapter,
  closeDatabase,
  getGateResults,
  insertAssessment,
  insertGateRow,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "merge-closeout-gate-")));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);

  git(["checkout", "-b", "milestone/M001"], dir);
  writeFileSync(join(dir, "feature.ts"), "export const feature = true;\n");
  git(["add", "feature.ts"], dir);
  git(["commit", "-m", "feat: milestone work"], dir);
  git(["checkout", "main"], dir);
  return dir;
}

test("mergeMilestoneToMain blocks when project DB closeout is still open", () => {
  const savedCwd = process.cwd();
  const repo = createRepo();
  try {
    assert.equal(openDatabase(join(repo, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const mainHeadBefore = git(["rev-parse", "main"], repo);
    writeFileSync(join(repo, "ad-hoc-helper.ps1"), "Write-Output helper\n");
    process.chdir(repo);

    assert.throws(
      () => mergeMilestoneToMain(repo, "M001", "# M001\n- [x] **S01: Done**\n"),
      /closeout-consistency-blocked/,
    );

    assert.equal(git(["rev-parse", "main"], repo), mainHeadBefore);
    assert.equal(git(["branch", "--show-current"], repo), "main");
    assert.equal(existsSync(join(repo, "ad-hoc-helper.ps1")), true);
    assert.match(git(["status", "--porcelain"], repo), /\?\? ad-hoc-helper\.ps1/);
  } finally {
    closeDatabase();
    process.chdir(savedCwd);
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});

test("closeout source mismatch preserves revision and offending-path diagnostics", () => {
  const message = formatCloseoutAuthorizationBlockers(
    [{
      kind: "validation-source-revision-mismatch",
      expectedSourceRevision: "sha256:current",
      testedSourceRevision: "sha256:validated",
    }],
    { paths: ["ad-hoc-helper.ps1"], autoCommitDetected: true },
  );
  assert.match(message, /expected source revision sha256:current/);
  assert.match(message, /tested source revision sha256:validated/);
  assert.match(message, /ad-hoc-helper\.ps1/);
  assert.match(message, /pre-merge auto-commit/);

  const formatted = formatCloseoutConsistencyBlock({
    ok: false,
    reason: "validation-source-revision-mismatch",
    recoveryReason: "closeout-consistency-blocked",
    message,
  });
  assert.match(formatted, /working-tree drift/);
  assert.doesNotMatch(formatted, /Resolve the canonical DB state/);
});

test("closeout consistency treats deferred slices as inactive", () => {
  try {
    assert.equal(openDatabase(":memory:"), true);
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete" });
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Done", status: "complete" });
    insertSlice({ milestoneId: "M001", id: "S02", title: "Deferred", status: "deferred" });
    insertTask({ milestoneId: "M001", sliceId: "S02", id: "T02", title: "Deferred", status: "pending" });
    insertAssessment({
      path: "milestones/M001/M001-VALIDATION.md",
      milestoneId: "M001",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass",
    });

    assert.deepEqual(checkCloseoutConsistencyGate("M001"), { ok: true });
  } finally {
    closeDatabase();
  }
});

test("closeout consistency persists evidence-backed gate closures before checking pending gates", (t) => {
  const artifactBasePath = realpathSync(mkdtempSync(join(tmpdir(), "closeout-gate-order-")));
  t.after(() => {
    closeDatabase();
    rmSync(artifactBasePath, { recursive: true, force: true });
  });
  assert.equal(openDatabase(":memory:"), true);
  insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  insertAssessment({
    path: "milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });
  _getAdapter()!.prepare(
    `INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
     VALUES ('M001', 'S01', 'unknown', 'slice', '', 'pending')`,
  ).run();

  const result = checkCloseoutConsistencyGate("M001", { artifactBasePath });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "quality-gate-pending");
  assert.equal(getGateResults("M001", "S01").find((gate) => gate.gate_id === "Q3")?.status, "complete");
});
