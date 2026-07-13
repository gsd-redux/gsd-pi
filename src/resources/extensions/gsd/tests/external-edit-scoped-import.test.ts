// Project/App: gsd-pi
// File Purpose: #027 regression — external-edit drift repair must scope status
// authority to the drifted milestone(s) so a stale checkbox in an unrelated
// projection can't revert a reopened slice/milestone in the DB.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  getSliceTasks,
  getSlice,
  openDatabase,
  _getAdapter,
  updateSliceStatus,
} from "../gsd-db.ts";
import { migrateHierarchyToDb, milestoneIdsFromEntities } from "../md-importer.ts";
import { externalMarkdownEditHandler } from "../state-reconciliation/drift/external-markdown-edit.ts";
import {
  computeProjectionSha,
  writeCompatMarker,
} from "../compat/compat-marker.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

const stubState = { phase: "idle" } as unknown as GSDState;

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-scoped-import-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    /* noop */
  }
  rmSync(base, { recursive: true, force: true });
}

const roadmapRel = (mid: string): string => join("milestones", mid, `${mid}-ROADMAP.md`);

/** Render a single-slice roadmap whose one slice is checked (`done`). */
function roadmapContent(mid: string, sliceTitle: string, done: boolean): string {
  return [
    `# ${mid}: ${mid} Milestone`,
    "",
    `**Vision:** ${mid} vision`,
    "",
    "## Slices",
    `- [${done ? "x" : " "}] **S01: ${sliceTitle}** \`risk:low\` \`depends:[]\``,
    "",
  ].join("\n");
}

function writeRoadmap(base: string, mid: string, sliceTitle: string, done: boolean): string {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  const content = roadmapContent(mid, sliceTitle, done);
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content, "utf-8");
  return content;
}

function planContent(taskDone: boolean): string {
  return [
    "# S01: Slice Plan",
    "",
    "**Goal:** Exercise scoped task status imports.",
    "",
    "## Tasks",
    "",
    `- [${taskDone ? "x" : " "}] **T01: Scoped Task** \`est:10m\``,
    "  Task body.",
    "",
  ].join("\n");
}

function writePlan(base: string, mid: string, taskDone: boolean): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", "S01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "S01-PLAN.md"), planContent(taskDone), "utf-8");
}

function taskStatus(mid: string): string | undefined {
  return getSliceTasks(mid, "S01").find((task) => task.id === "T01")?.status;
}

/**
 * Build two legacy-layout milestones (M001, M002) each with one checked slice,
 * import them so both slices land `complete`, then reopen M002/S01 to `pending`
 * while leaving M002's roadmap checkbox checked (a stale projection).
 */
function seedTwoMilestonesWithReopenedB(base: string): void {
  writeRoadmap(base, "M001", "Alpha Slice", true);
  writeRoadmap(base, "M002", "Beta Slice", true);
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  assert.equal(getSlice("M001", "S01")?.status, "complete");
  assert.equal(getSlice("M002", "S01")?.status, "complete");
  updateSliceStatus("M002", "S01", "pending");
  assert.equal(getSlice("M002", "S01")?.status, "pending", "precondition: B/S01 reopened");
}

/**
 * Same as seedTwoMilestonesWithReopenedB, but with checked task boxes too. The
 * reopened DB task is the authority for out-of-scope milestones.
 */
function seedTwoMilestonesWithReopenedBTask(base: string): void {
  writeRoadmap(base, "M001", "Alpha Slice", true);
  writePlan(base, "M001", true);
  writeRoadmap(base, "M002", "Beta Slice", true);
  writePlan(base, "M002", true);
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  assert.equal(getSlice("M002", "S01")?.status, "complete");
  assert.equal(taskStatus("M002"), "complete");
  updateSliceStatus("M002", "S01", "pending");
  // Fixture-only bypass: reproduce a legacy reopened row without asking the
  // guarded generic status writer to perform a forbidden closed→open change.
  _getAdapter()!.prepare(`
    UPDATE tasks SET status = 'pending', completed_at = NULL
    WHERE milestone_id = 'M002' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  assert.equal(getSlice("M002", "S01")?.status, "pending", "precondition: B/S01 reopened");
  assert.equal(taskStatus("M002"), "pending", "precondition: B/S01/T01 reopened");
}

test("milestoneIdsFromEntities derives milestone ids from DB entity ids (layout-independent)", () => {
  assert.deepEqual(
    [...milestoneIdsFromEntities(["M001", "M001/S01", "M001/S01/T01"])],
    ["M001"],
  );
  assert.deepEqual(
    [...milestoneIdsFromEntities(["M001/S01", "M002/S03/T02"])].sort(),
    ["M001", "M002"],
  );
  // Entity-less / blank entries yield an empty set → repair preserves DB status.
  assert.equal(milestoneIdsFromEntities([]).size, 0);
  assert.equal(milestoneIdsFromEntities([""]).size, 0);
});

test("scoped import preserves a reopened out-of-scope slice (the #027 bug, direct)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedTwoMilestonesWithReopenedB(base);

  // Only M001 drifted; M002 keeps DB status authority.
  migrateHierarchyToDb(base, { statusAuthoritativeMilestones: new Set(["M001"]) });

  assert.equal(
    getSlice("M002", "S01")?.status,
    "pending",
    "reopened out-of-scope slice must NOT be reverted to complete by a stale checkbox",
  );
});

test("scoped import preserves reopened tasks in an out-of-scope slice", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedTwoMilestonesWithReopenedBTask(base);

  // Only M001 drifted; M002's stale checked roadmap and plan boxes must not
  // re-complete either its reopened slice or its reopened task.
  migrateHierarchyToDb(base, { statusAuthoritativeMilestones: new Set(["M001"]) });

  assert.equal(
    getSlice("M002", "S01")?.status,
    "pending",
    "reopened out-of-scope slice must stay pending",
  );
  assert.equal(
    taskStatus("M002"),
    "pending",
    "reopened out-of-scope task must NOT be reverted to complete by a stale plan checkbox",
  );
});

test("scoped import keeps markdown authority for the in-scope (drifted) milestone", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedTwoMilestonesWithReopenedB(base);

  // Sanctioned interop: M002's own roadmap was externally edited — the checked
  // box IS authoritative for the drifted milestone.
  migrateHierarchyToDb(base, { statusAuthoritativeMilestones: new Set(["M002"]) });

  assert.equal(
    getSlice("M002", "S01")?.status,
    "complete",
    "the drifted milestone's checkbox must close its slice (markdown authority)",
  );
});

test("no-opts import is unchanged: markdown checkbox wins (pins the default)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedTwoMilestonesWithReopenedB(base);

  // No scope → full markdown authority, exactly as before #027. Initial-migration
  // and gsd-core full-import semantics must not silently change.
  migrateHierarchyToDb(base);

  assert.equal(
    getSlice("M002", "S01")?.status,
    "complete",
    "without a scope, the stale checkbox closes the slice — today's behavior",
  );
});

test("scoped import still imports NEW out-of-scope content with its parsed status", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  // Both milestones are on disk but neither is in the DB yet. M002 is out of the
  // authority scope, but a row that does not exist yet takes the parsed status
  // regardless of scope (new content is new content).
  writeRoadmap(base, "M001", "Alpha Slice", true);
  writeRoadmap(base, "M002", "Beta Slice", true);
  openDatabase(join(base, ".gsd", "gsd.db"));

  migrateHierarchyToDb(base, { statusAuthoritativeMilestones: new Set(["M001"]) });

  assert.equal(getSlice("M002", "S01")?.status, "complete", "new out-of-scope slice imports as parsed");
});

test("external-markdown-edit repair scopes authority to the drifted milestone (end-to-end)", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedTwoMilestonesWithReopenedB(base);

  // Externally edit M001's roadmap (change the slice title) so its sha drifts;
  // leave M002's roadmap byte-identical to its marker baseline (not drifted).
  writeRoadmap(base, "M001", "Alpha Slice EDITED", true);
  const m002Content = roadmapContent("M002", "Beta Slice", true);

  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-07T00:00:00.000Z",
    projections: {
      [roadmapRel("M001")]: { sha: "stale000000000000", entities: ["M001"] },
      [roadmapRel("M002")]: { sha: computeProjectionSha(m002Content), entities: ["M002"] },
    },
    piVersion: "1.8.1",
  });

  const ctx: DriftContext = { basePath: base, state: stubState };
  const drift = await externalMarkdownEditHandler.detect(stubState, ctx);
  assert.equal(drift.length, 1, "only M001's roadmap should be detected as drifted");
  assert.deepEqual(drift[0].entities, ["M001"]);

  await externalMarkdownEditHandler.repair(drift[0], ctx);

  // B was NOT the drifted file — its reopened slice must survive the repair.
  assert.equal(
    getSlice("M002", "S01")?.status,
    "pending",
    "repair of an unrelated file must not revert B/S01",
  );
  // A WAS drifted — its edit is imported (title updated, status stays complete).
  assert.equal(getSlice("M001", "S01")?.title, "Alpha Slice EDITED", "A's external edit is imported");
  assert.equal(getSlice("M001", "S01")?.status, "complete");
});
