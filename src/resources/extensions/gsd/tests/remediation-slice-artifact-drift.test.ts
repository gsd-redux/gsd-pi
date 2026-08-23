// Project/App: gsd-pi
// File Purpose: #1975 — a remediation slice (R01) must never resolve to
// another slice's flat-phase plan files. sliceIdToPlanNum's fallback mapped
// every non-canonical slice id to plan 1, so the artifact/DB drift scan saw
// S01's 01-01-SUMMARY.md as R01's and paused auto right after
// gsd_reassess_roadmap with a false "SUMMARY on disk while DB status is
// pending". Genuine drift (R01's OWN summary on disk while pending) must
// still be reported.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { detectArtifactDbDrift } from "../state-reconciliation/drift/artifact-db.ts";
import { resolveSliceFile, targetSliceFile, _clearGsdRootCache } from "../paths.ts";
import { slicePlanSegment } from "../layout-policy.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

function stubState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "M" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
}

function setupFixture(base: string): string {
  const phaseDir = join(base, ".gsd", "phases", "01-answer-fixture");
  mkdirSync(phaseDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "M", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done slice", status: "complete", risk: "low", depends: [], sequence: 1 });
  insertSlice({ id: "R01", milestoneId: "M001", title: "Remediation", status: "pending", risk: "low", depends: [], sequence: 2 });
  // S01 completed normally; its SUMMARY projection is on disk.
  writeFileSync(join(phaseDir, "01-01-SUMMARY.md"), "# S01 Summary\n");
  return phaseDir;
}

test("#1975: fresh pending R01 does not inherit S01's 01-01-SUMMARY.md as drift", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-remediation-drift-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });
  _clearGsdRootCache();
  setupFixture(base);

  // R01 must not resolve to S01's file at the path layer.
  assert.equal(resolveSliceFile(base, "M001", "R01", "SUMMARY"), null);
  // And R01's canonical write target is its own distinct file.
  assert.match(targetSliceFile(base, "M001", "R01", "SUMMARY", "M"), /01-R01-SUMMARY\.md$/);

  const state = stubState();
  const ctx: DriftContext = { basePath: base, state };
  const drifts = detectArtifactDbDrift(state, ctx);
  const r01Drift = drifts.filter((d) => "sliceId" in d && d.sliceId === "R01");
  assert.deepEqual(r01Drift, [], "fresh remediation slice must not match another slice's SUMMARY");
});

test("#1975: R01's own SUMMARY on disk while R01 is pending is still drift", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-remediation-drift-pos-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });
  _clearGsdRootCache();
  const phaseDir = setupFixture(base);
  // R01's own SUMMARY was written while the DB still says pending.
  writeFileSync(join(phaseDir, "01-R01-SUMMARY.md"), "# R01 Summary\n");

  const state = stubState();
  const ctx: DriftContext = { basePath: base, state };
  const drifts = detectArtifactDbDrift(state, ctx);
  const r01Drift = drifts.find(
    (d) => d.kind === "artifact-db-status-divergence" && d.sliceId === "R01",
  );
  assert.ok(r01Drift, "R01's own SUMMARY while pending must still be reported as drift");
});

test("#1975: slicePlanSegment keeps S-ids numeric and other ids verbatim", () => {
  assert.equal(slicePlanSegment("S01"), "01");
  assert.equal(slicePlanSegment("S01-replan"), "01");
  assert.equal(slicePlanSegment("s03-x"), "03");
  assert.equal(slicePlanSegment("R01"), "R01");
  assert.equal(slicePlanSegment("R02"), "R02");
  assert.equal(slicePlanSegment("01"), "01");
});
