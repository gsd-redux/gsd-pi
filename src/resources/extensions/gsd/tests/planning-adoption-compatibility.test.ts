// Project/App: gsd-pi
// File Purpose: RED compatibility contracts for durable lifecycle adoption.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { capturePlanningCompatIfNeeded } from "../compat/planning-compat.ts";
import { readCompatMarker } from "../compat/compat-marker.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  bulkInsertLegacyHierarchy,
  clearEngineHierarchy,
  closeDatabase,
  copyWorktreeDb,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  reconcileWorktreeDb,
  restoreManifest,
} from "../gsd-db.ts";
import type { StateManifest } from "../workflow-manifest.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function openFixture(t: TestContext): string {
  const path = join(tempDir("gsd-adoption-compat-"), "gsd.db");
  assert.equal(openDatabase(path), true);
  seedLegacyHierarchy();
  t.after(closeDatabase);
  return path;
}

function seedLegacyHierarchy(): void {
  insertMilestone({ id: "M001", title: "Original milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Original slice",
    status: "active",
    sequence: 1,
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Original task",
    status: "pending",
    sequence: 1,
  });
}

function legacyManifest(): StateManifest {
  const milestones = getAllMilestones();
  const slices = milestones.flatMap((milestone) => getMilestoneSlices(milestone.id));
  const tasks = slices.flatMap((slice) => getSliceTasks(slice.milestone_id, slice.id));
  return {
    version: 1,
    exported_at: "2026-07-12T00:00:00.000Z",
    milestones,
    slices,
    tasks,
    decisions: [],
    verification_evidence: [],
  };
}

function adoptHierarchy(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "planning.compatibility.adopt",
    idempotencyKey: "planning/compatibility/adopt/M001",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "planning.compatibility.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "planning/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function hierarchyIdentitySnapshot(): Record<string, unknown> {
  return {
    milestone: db().prepare("SELECT rowid AS row_id, id, title FROM milestones WHERE id = 'M001'").get(),
    slice: db().prepare("SELECT rowid AS row_id, milestone_id, id, title FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get(),
    task: db().prepare("SELECT rowid AS row_id, milestone_id, slice_id, id, title FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").get(),
    lifecycles: db().prepare(`
      SELECT lifecycle_id, item_kind, milestone_id, slice_id, task_id,
             lifecycle_status, state_version, last_operation_id,
             last_project_revision, last_authority_epoch
      FROM workflow_item_lifecycles
      ORDER BY item_kind
    `).all(),
  };
}

function explicitAdoptionGuardError(action: () => void): Error {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "destructive compatibility path must reject adopted hierarchy");
  assert.match(
    thrown.message,
    /(?:adopted|canonical).*lifecycle|lifecycle.*(?:adopted|canonical)/i,
    "rejection must explain that canonical lifecycle history prevents destructive restore",
  );
  return thrown;
}

test("worktree reconcile updates adopted hierarchy in place without deleting lifecycle identity", (t) => {
  const mainDb = openFixture(t);
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();
  const worktreeDb = join(tempDir("gsd-adoption-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  db().exec(`
    UPDATE milestones SET title = 'Worktree milestone' WHERE id = 'M001';
    UPDATE slices SET title = 'Worktree slice' WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE tasks SET title = 'Worktree task' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01';
  `);
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const result = reconcileWorktreeDb(mainDb, worktreeDb);
  assert.ok(result.milestones > 0 && result.slices > 0 && result.tasks > 0);

  const after = hierarchyIdentitySnapshot();
  assert.deepEqual(after, {
    ...before,
    milestone: { ...(before["milestone"] as object), title: "Worktree milestone" },
    slice: { ...(before["slice"] as object), title: "Worktree slice" },
    task: { ...(before["task"] as object), title: "Worktree task" },
  });
});

test("manifest restore rejects adopted hierarchy before changing either authority surface", (t) => {
  openFixture(t);
  const manifest = legacyManifest();
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();

  explicitAdoptionGuardError(() => restoreManifest(manifest));

  assert.deepEqual(hierarchyIdentitySnapshot(), before, "failed restore must leave hierarchy and lifecycles unchanged");
});

test("recover hierarchy clear rejects adopted rows before deleting legacy state", (t) => {
  openFixture(t);
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();

  explicitAdoptionGuardError(clearEngineHierarchy);

  assert.deepEqual(hierarchyIdentitySnapshot(), before, "failed recover clear must leave adopted state unchanged");
});

test("legacy markdown bulk restore rejects adopted rows before replacing identities", (t) => {
  openFixture(t);
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();

  explicitAdoptionGuardError(() => bulkInsertLegacyHierarchy({
    milestones: [{ id: "M001", title: "Imported milestone", status: "active" }],
    slices: [{ id: "S01", milestoneId: "M001", title: "Imported slice", status: "active", risk: "low", sequence: 1 }],
    tasks: [{ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Imported task", status: "pending", sequence: 1 }],
    clearMilestoneIds: ["M001"],
    createdAt: "2026-07-12T00:00:00.000Z",
  }));

  assert.deepEqual(hierarchyIdentitySnapshot(), before, "failed bulk restore must leave adopted state unchanged");
});

test("legacy-only restore, recover clear, and bulk import retain their existing behavior", (t) => {
  openFixture(t);
  const manifest = legacyManifest();
  db().prepare("UPDATE milestones SET title = 'Changed' WHERE id = 'M001'").run();

  restoreManifest(manifest);
  assert.equal(getAllMilestones()[0]?.title, "Original milestone");

  clearEngineHierarchy();
  assert.equal(getAllMilestones().length, 0);

  bulkInsertLegacyHierarchy({
    milestones: [{ id: "M002", title: "Legacy import", status: "active" }],
    slices: [{ id: "S02", milestoneId: "M002", title: "Legacy slice", status: "pending", risk: "medium", sequence: 2 }],
    tasks: [{ id: "T02", sliceId: "S02", milestoneId: "M002", title: "Legacy task", status: "pending", sequence: 3 }],
    clearMilestoneIds: ["M002"],
    createdAt: "2026-07-12T00:00:00.000Z",
  });
  assert.equal(getAllMilestones()[0]?.title, "Legacy import");
  assert.equal(getMilestoneSlices("M002")[0]?.title, "Legacy slice");
  assert.equal(getSliceTasks("M002", "S02")[0]?.title, "Legacy task");
});

test("failed first planning capture leaves compatibility inactive", async () => {
  const base = tempDir("gsd-planning-capture-closed-");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(base, ".planning"), { recursive: true });
  writeFileSync(
    join(base, ".planning", "ROADMAP.md"),
    "# Roadmap\n\n## Phases\n\n- [ ] 01 — Foundation\n",
    "utf8",
  );

  closeDatabase();
  await capturePlanningCompatIfNeeded(base);

  const marker = readCompatMarker(base);
  assert.equal(marker.planning?.active, false);
  assert.equal(marker.planning?.layout, null);
});
