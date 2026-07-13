/**
 * Regression test for #3607 — tighten verifyExpectedArtifact legacy branch.
 *
 * The legacy (pre-migration) fallback in verifyExpectedArtifact previously
 * accepted either a heading match (### T01 --) or a checked checkbox as proof
 * that gsd_complete_task ran. A heading alone does not prove completion —
 * it could result from a rogue write.
 *
 * These tests exercise verifyExpectedArtifact directly for execute-task units
 * when the DB is unavailable (legacy branch). Only a checked checkbox in the
 * slice plan counts as evidence of completion; a bare heading or an unchecked
 * checkbox must not pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, isDbAvailable, openDatabase } from "../gsd-db.ts";

/** Scaffold .gsd/milestones/M001/slices/S01/ with tasks/ and a T01-SUMMARY.md. */
function scaffoldProject(t: { after: (fn: () => void) => void }): {
  base: string;
  planPath: string;
} {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-artifact-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  // Summary file must exist so verifyExpectedArtifact reaches the legacy branch
  writeFileSync(join(sliceDir, "tasks", "T01-SUMMARY.md"), "# T01 summary\n");
  return { base, planPath: join(sliceDir, "S01-PLAN.md") };
}

test("#3607: execute-task legacy branch — checked checkbox [x] passes verification", (t) => {
  closeDatabase();
  assert.equal(isDbAvailable(), false, "DB must be closed to hit legacy branch");

  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
      "",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "checked checkbox [x] is accepted as completion evidence",
  );
});

test("#3607: execute-task legacy branch — checked checkbox [X] (uppercase) also passes", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [X] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "uppercase [X] checkbox is accepted",
  );
});

test("#3607: execute-task legacy branch — unchecked checkbox [ ] is rejected", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "unchecked checkbox [ ] must not pass verification (#3607)",
  );
});

test("#3607: execute-task legacy branch — bare heading ### T01 is no longer sufficient", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  // Old buggy behaviour would pass on a heading alone. This must now fail.
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "### T01 -- Implement feature",
      "",
      "Some description here, but no checkbox.",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "heading alone must not pass verification after #3607 fix",
  );
});

test("#3607: execute-task legacy branch — missing plan file returns false", (t) => {
  closeDatabase();
  const { base } = scaffoldProject(t);
  // Do not create S01-PLAN.md at all.

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "missing plan file must cause verification to return false",
  );
});

test("#3607: execute-task legacy branch — wrong task id in checkbox does not match", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T02: Some other task**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "checkbox for a different task id must not count as T01 completion",
  );
});

test("execute-task DB branch ignores checked plan and summary without an Attempt Result", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(isDbAvailable(), true, "DB must be open to hit the DB-lag branch");

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });

  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "DB-backed verification must not accept projection evidence without an Attempt Result",
  );
});

test("execute-task DB branch ignores legacy complete Task status without an Attempt Result", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "complete" });
  writeFileSync(planPath, "- [x] **T01: Implement feature**\n");

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "legacy Task completion and projections cannot replace canonical Attempt readiness",
  );
});

test("execute-task DB lag branch — summary without checked plan still fails", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });

  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "pending DB status plus summary is insufficient without a checked task checkbox",
  );
});

// ── #852 follow-up: worktree→project-root artifact fallback ──────────────────
//
// A milestone running in a worktree may not have its CONTEXT projected into the
// worktree (the worktree only has the META dir until planning writes its
// projections). When verifyExpectedArtifact can't find the artifact at the
// worktree base, it must fall back to the project root — where the artifact
// genuinely lives. Without this, discuss-milestone verification returned false
// ("resolveExpectedArtifactPath returned null") and trapped the unit in a
// finalize-retry loop.

test("#852: discuss-milestone falls back to project root when CONTEXT not in worktree", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-fallback-proj-"));
  try {
    // Flat-phase CONTEXT lives at the project root.
    const phaseDir = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    // Simulate the worktree: exists, registered with git (.git file), but has
    // NO phases/ dir and no real CONTEXT — only the META dir git-service.ts
    // created. resolveCanonicalMilestoneRoot redirects here.
    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    const wtGsd = join(wtRoot, ".gsd");
    mkdirSync(join(wtGsd, "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtGsd, "milestones", "M015", "M015-META.json"), '{"branch":"milestone/M015"}');
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    // Verification with the worktree as base must fall back to the project root
    // and find 15-CONTEXT.md there.
    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", projectRoot),
      true,
      "must fall back to project root when CONTEXT is not in the worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("#852: discuss-milestone passes when CONTEXT is in the worktree (no fallback needed)", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-present-"));
  try {
    // CONTEXT lives in BOTH the project root AND the worktree.
    const projPhase = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(projPhase, { recursive: true });
    writeFileSync(join(projPhase, "15-CONTEXT.md"), "# project context\n");

    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    const wtGsd = join(wtRoot, ".gsd");
    const wtPhase = join(wtGsd, "phases", "15-m015");
    mkdirSync(wtPhase, { recursive: true });
    writeFileSync(join(wtPhase, "15-CONTEXT.md"), "# worktree context\n");
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", projectRoot),
      true,
      "must pass when CONTEXT is in the worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("#852: discuss-milestone fails when CONTEXT is in neither worktree nor project root", () => {
  // If the artifact genuinely doesn't exist anywhere, verification must still
  // fail (fail-closed) — the fallback must not mask a real absence.
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-absent-"));
  try {
    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    mkdirSync(join(wtRoot, ".gsd", "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");
    // No phases/ anywhere, no CONTEXT anywhere.

    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", projectRoot),
      false,
      "must fail when CONTEXT exists in neither root",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #870: discuss-milestone verify-fail when the unit runs IN the worktree.
//
// The #852 tests above all pass `projectRoot` as the base. But the real call
// site (auto-post-unit.ts:1726) passes `s.currentUnit.workspaceRoot ?? s.basePath`
// — i.e. the WORKTREE path when the unit executed in a worktree. In the
// canonical layout (`<root>/.gsd-worktrees/<MID>/`) resolveCanonicalMilestoneRoot
// round-trips the worktree path back to itself, so `artifactBase === base` and
// the worktree→project-root fallback (guarded by `artifactBase !== base`) is
// skipped. CONTEXT is written to the project root, not projected into the
// worktree, so verification finds nothing → "existsSync false" → re-dispatch
// 3× → stuck-loop stop. These tests pin the real call site.
// ---------------------------------------------------------------------------

test("#870: discuss-milestone falls back to project root when base IS the canonical-layout worktree", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-canonical-wt-"));
  try {
    // CONTEXT lives ONLY at the project root (flat-phase layout).
    const phaseDir = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    // Canonical-layout worktree: <root>/.gsd-worktrees/<MID>/. Registered
    // with git (.git file) so resolveCanonicalMilestoneRoot treats it as the
    // canonical milestone root — but it has NO phases/ projection.
    const wtRoot = join(projectRoot, ".gsd-worktrees", "M015");
    mkdirSync(join(wtRoot, ".gsd", "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtRoot, ".gsd", "milestones", "M015", "M015-META.json"), '{"branch":"milestone/M015"}');
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    // Real call site: base = worktree path (workspaceRoot).
    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", wtRoot),
      true,
      "must fall back to project root when base is the canonical-layout worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("#870: discuss-milestone also falls back when base is the legacy-layout worktree", () => {
  closeDatabase();
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-legacy-wt-"));
  try {
    const phaseDir = join(projectRoot, ".gsd", "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    const wtRoot = join(projectRoot, ".gsd", "worktrees", "M015");
    mkdirSync(join(wtRoot, ".gsd", "milestones", "M015"), { recursive: true });
    writeFileSync(join(wtRoot, ".git"), "gitdir: /fake/path");

    assert.equal(
      verifyExpectedArtifact("discuss-milestone", "M015", wtRoot),
      true,
      "must fall back to project root when base is the legacy-layout worktree",
    );
  } finally {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
