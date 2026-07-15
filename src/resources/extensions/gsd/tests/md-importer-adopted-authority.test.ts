import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeProjectionSha, writeCompatMarker } from "../compat/compat-marker.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  getAllMilestones,
  getSlice,
  getSliceTasks,
  openDatabase,
} from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { clearPathCache } from "../paths.ts";
import { externalMarkdownEditHandler } from "../state-reconciliation/drift/external-markdown-edit.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

const stubState = { phase: "idle" } as unknown as GSDState;

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-adopted-import-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), {
    recursive: true,
  });
  return base;
}

function cleanup(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function roadmap(title: string, done: boolean): string {
  return [
    "# M001: Import authority",
    "",
    "**Vision:** Keep the database authoritative after adoption.",
    "",
    "## Slices",
    `- [${done ? "x" : " "}] **S01: ${title}** \`risk:low\` \`depends:[]\``,
    "",
  ].join("\n");
}

function plan(title: string, done: boolean): string {
  return [
    "# S01: Slice Plan",
    "",
    "**Goal:** Exercise adopted import authority.",
    "",
    "## Tasks",
    "",
    `- [${done ? "x" : " "}] **T01: ${title}** \`est:10m\``,
    "  Task body.",
    "",
  ].join("\n");
}

function writeHierarchy(
  base: string,
  input: { sliceTitle: string; sliceDone: boolean; taskTitle: string; taskDone: boolean },
): void {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    roadmap(input.sliceTitle, input.sliceDone),
  );
  writeFileSync(join(sliceDir, "S01-PLAN.md"), plan(input.taskTitle, input.taskDone));
}

function writePlanWithoutTasks(base: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01: Slice Plan\n\n**Goal:** Task was removed from the projection.\n\n## Tasks\n",
  );
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function adoptTask(includeSlice = true): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.import.adopt",
    idempotencyKey: "test/import/adopt/M001/S01",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
  }, (context) => {
    if (includeSlice) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "ready",
      });
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.import.adopted",
        entityType: "slice",
        entityId: "M001/S01",
        payload: {},
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "test/import/m001/s01",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function adoptMilestone(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.import.adopt-milestone",
    idempotencyKey: "test/import/adopt/M001",
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
    return {
      events: [{
        eventType: "test.import.milestone-adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: {},
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "test/import/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function canonicalSnapshot(): unknown {
  return {
    lifecycles: db().prepare(`
      SELECT lifecycle_id, item_kind, milestone_id, slice_id, task_id,
             lifecycle_status, state_version, updated_at, last_operation_id,
             last_project_revision, last_authority_epoch
      FROM workflow_item_lifecycles
      ORDER BY item_kind, slice_id, task_id
    `).all(),
    events: db().prepare(`
      SELECT event_id, operation_id, event_index, project_id, project_revision,
             authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
      FROM workflow_domain_events
      ORDER BY project_revision, event_index
    `).all(),
  };
}

function task() {
  return getSliceTasks("M001", "S01").find((row) => row.id === "T01");
}

function milestone() {
  return getAllMilestones().find((row) => row.id === "M001");
}

test("external ROADMAP repair refreshes adopted PLAN and ROADMAP metadata without changing DB lifecycle state", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  writeHierarchy(base, {
    sliceTitle: "Original slice",
    sliceDone: false,
    taskTitle: "Original task",
    taskDone: false,
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  adoptTask();

  const sliceCompletedAt = "2026-07-01T00:00:00.000Z";
  const taskCompletedAt = "2026-07-02T00:00:00.000Z";
  db().prepare(`
    UPDATE slices SET completed_at = :completed_at
    WHERE milestone_id = 'M001' AND id = 'S01'
  `).run({ ":completed_at": sliceCompletedAt });
  db().prepare(`
    UPDATE tasks SET completed_at = :completed_at
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({ ":completed_at": taskCompletedAt });
  const beforeCanonical = canonicalSnapshot();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-14T00:00:00.000Z",
    projections: {
      [join("milestones", "M001", "M001-ROADMAP.md")]: {
        sha: computeProjectionSha(roadmap("Original slice", false)),
        entities: ["M001/S01"],
      },
    },
    piVersion: "test",
  });

  writeHierarchy(base, {
    sliceTitle: "Edited slice metadata",
    sliceDone: true,
    taskTitle: "Edited task metadata",
    taskDone: true,
  });
  const ctx: DriftContext = { basePath: base, state: stubState };
  const drift = await externalMarkdownEditHandler.detect(stubState, ctx);
  assert.equal(drift.length, 1);
  await externalMarkdownEditHandler.repair(drift[0]!, ctx);

  assert.equal(getSlice("M001", "S01")?.title, "Edited slice metadata");
  assert.equal(task()?.title, "Edited task metadata");
  assert.equal(getSlice("M001", "S01")?.status, "pending");
  assert.equal(task()?.status, "pending");
  assert.equal(milestone()?.status, "active");
  assert.equal(getSlice("M001", "S01")?.completed_at, sliceCompletedAt);
  assert.equal(task()?.completed_at, taskCompletedAt);
  assert.deepEqual(canonicalSnapshot(), beforeCanonical);
});

test("adopted task projection state does not auto-complete its unadopted parent slice", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  writeHierarchy(base, {
    sliceTitle: "Original slice",
    sliceDone: false,
    taskTitle: "Original task",
    taskDone: false,
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  adoptTask(false);
  const beforeCanonical = canonicalSnapshot();

  writeHierarchy(base, {
    sliceTitle: "Edited slice metadata",
    sliceDone: true,
    taskTitle: "Removed task",
    taskDone: true,
  });
  writePlanWithoutTasks(base);
  clearPathCache();
  migrateHierarchyToDb(base);

  assert.equal(getSlice("M001", "S01")?.title, "Edited slice metadata");
  assert.equal(getSlice("M001", "S01")?.status, "pending");
  assert.equal(getSlice("M001", "S01")?.completed_at, null);
  assert.equal(task()?.status, "pending");
  assert.equal(task()?.completed_at, null);
  assert.deepEqual(canonicalSnapshot(), beforeCanonical);
});

test("adopted task blocks milestone completion inferred from a Markdown SUMMARY", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  writeHierarchy(base, {
    sliceTitle: "Original slice",
    sliceDone: false,
    taskTitle: "Original task",
    taskDone: false,
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  adoptTask(false);
  const beforeCanonical = canonicalSnapshot();

  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    "# M001 Summary\n\nDone.\n",
  );
  clearPathCache();
  migrateHierarchyToDb(base);

  assert.equal(milestone()?.status, "active");
  assert.equal(milestone()?.completed_at, null);
  assert.equal(getSlice("M001", "S01")?.status, "pending");
  assert.equal(task()?.status, "pending");
  assert.deepEqual(canonicalSnapshot(), beforeCanonical);
});

test("milestone-only adoption blocks completion inferred from a Markdown SUMMARY", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  writeHierarchy(base, {
    sliceTitle: "Original slice",
    sliceDone: false,
    taskTitle: "Original task",
    taskDone: false,
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);
  adoptMilestone();
  const beforeCanonical = canonicalSnapshot();

  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    "# M001 Summary\n\nDone.\n",
  );
  clearPathCache();

  assert.doesNotThrow(() => migrateHierarchyToDb(base));
  assert.equal(milestone()?.status, "active");
  assert.equal(milestone()?.completed_at, null);
  assert.deepEqual(canonicalSnapshot(), beforeCanonical);
});

test("unadopted re-import keeps existing checkbox completion behavior", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  writeHierarchy(base, {
    sliceTitle: "Original slice",
    sliceDone: false,
    taskTitle: "Original task",
    taskDone: false,
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  migrateHierarchyToDb(base);

  writeHierarchy(base, {
    sliceTitle: "Completed slice",
    sliceDone: true,
    taskTitle: "Completed task",
    taskDone: true,
  });
  migrateHierarchyToDb(base);

  assert.equal(getSlice("M001", "S01")?.status, "complete");
  assert.ok(getSlice("M001", "S01")?.completed_at);
  assert.equal(task()?.status, "complete");
  assert.ok(task()?.completed_at);
});
