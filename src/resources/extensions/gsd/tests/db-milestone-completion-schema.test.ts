// Project/App: gsd-pi
// File Purpose: Executable v43 authorization contract for Milestone completion.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createSliceCompletionSchemaV41 } from "../db-slice-completion-schema.ts";
import type { DbAdapter } from "../db-adapter.ts";
import {
  SCHEMA_VERSION,
  _getAdapter,
  adoptOrTransitionLifecycle,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";

const require = createRequire(import.meta.url);
const tempDirs = new Set<string>();

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
}

function openRawDatabase(path: string): RawDb {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-milestone-completion-schema-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function projectId(db: RawDb): string {
  return String(db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.project_id);
}

function schemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version);
}

function insertOperation(
  db: RawDb,
  operationId: string,
  operationType: string,
  revision: number,
): void {
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'test', 'test', ?, ?)
  `).run(
    operationId,
    projectId(db),
    operationType,
    `key-${operationId}`,
    revision - 1,
    revision,
    `hash-${operationId}`,
    `2026-07-14T00:00:0${revision}.000Z`,
  );
}

function seedLifecycleFixture(db: RawDb): void {
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at) VALUES
      ('M-READY', 'Ready milestone', 'active', '2026-07-14T00:00:00.000Z'),
      ('M-ACTIVE', 'Active milestone', 'active', '2026-07-14T00:00:00.000Z'),
      ('M-INSERT', 'Inserted milestone', 'active', '2026-07-14T00:00:00.000Z'),
      ('M-SLICE', 'Slice parent', 'active', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at) VALUES
      ('M-SLICE', 'S01', 'Ready slice', 'pending', '2026-07-14T00:00:00.000Z'),
      ('M-SLICE', 'S02', 'Task parent', 'pending', '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status) VALUES
      ('M-SLICE', 'S02', 'T01', 'Ready task', 'pending');
  `);

  insertOperation(db, "op-plan", "workflow.milestone.plan", 1);
  insertOperation(db, "op-wrong", "slice.complete", 2);
  insertOperation(db, "op-complete", "milestone.complete", 3);

  const insertLifecycle = db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'op-plan', 1, 0)
  `);
  const createdAt = "2026-07-14T00:00:01.000Z";
  insertLifecycle.run(
    "life-ready", projectId(db), "milestone", "M-READY", null, null,
    "ready", createdAt, createdAt,
  );
  insertLifecycle.run(
    "life-active", projectId(db), "milestone", "M-ACTIVE", null, null,
    "in_progress", createdAt, createdAt,
  );
  insertLifecycle.run(
    "life-slice", projectId(db), "slice", "M-SLICE", "S01", null,
    "ready", createdAt, createdAt,
  );
  insertLifecycle.run(
    "life-task", projectId(db), "task", "M-SLICE", "S02", "T01",
    "ready", createdAt, createdAt,
  );
}

function transitionToCompleted(
  db: RawDb,
  lifecycleId: string,
  operationId: string,
  revision: number,
): void {
  db.prepare(`
    UPDATE workflow_item_lifecycles
    SET lifecycle_status = 'completed', state_version = state_version + 1,
        updated_at = ?, last_operation_id = ?,
        last_project_revision = ?, last_authority_epoch = 0
    WHERE lifecycle_id = ?
  `).run(
    `2026-07-14T00:00:0${revision}.000Z`,
    operationId,
    revision,
    lifecycleId,
  );
}

function createGenuineV42Database(path: string): void {
  assert.equal(openDatabase(path), true);
  closeDatabase();
  const db = openRawDatabase(path);
  try {
    createSliceCompletionSchemaV41(db as unknown as DbAdapter);
    db.exec("DELETE FROM schema_version WHERE version > 42");
    db.exec(`
      INSERT OR IGNORE INTO schema_version (version, applied_at)
      VALUES (42, '2026-07-14T00:00:00.000Z')
    `);
  } finally {
    db.close();
  }
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("v43 authorizes only milestone.complete for Milestone ready-to-completed", () => {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    assert.equal(SCHEMA_VERSION, 44);
    assert.equal(schemaVersion(db), 44);
    seedLifecycleFixture(db);

    assert.throws(
      () => transitionToCompleted(db, "life-ready", "op-wrong", 2),
      /invalid workflow lifecycle transition/,
    );
    transitionToCompleted(db, "life-ready", "op-complete", 3);

    assert.throws(
      () => transitionToCompleted(db, "life-active", "op-wrong", 2),
      /invalid workflow lifecycle transition/,
    );
    transitionToCompleted(db, "life-active", "op-complete", 3);

    assert.throws(() => db.prepare(`
      INSERT INTO workflow_item_lifecycles (
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, state_version, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES (?, ?, 'milestone', 'M-INSERT', NULL, NULL, 'completed', 1,
        '2026-07-14T00:00:02.000Z', '2026-07-14T00:00:02.000Z', 'op-wrong', 2, 0)
    `).run("life-insert-wrong", projectId(db)), /invalid workflow lifecycle transition/);
    db.prepare(`
      INSERT INTO workflow_item_lifecycles (
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, state_version, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES (?, ?, 'milestone', 'M-INSERT', NULL, NULL, 'completed', 1,
        '2026-07-14T00:00:03.000Z', '2026-07-14T00:00:03.000Z', 'op-complete', 3, 0)
    `).run("life-insert-complete", projectId(db));
    transitionToCompleted(db, "life-slice", "op-wrong", 2);
    assert.throws(
      () => transitionToCompleted(db, "life-task", "op-complete", 3),
      /invalid workflow lifecycle transition/,
    );
  } finally {
    db.close();
  }
});

test("the lifecycle writer accepts the v43 Milestone completion transition", () => {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M-WRITER", title: "Writer milestone", status: "active" });

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.complete",
    idempotencyKey: "fixture/milestone-complete",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M-WRITER" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M-WRITER",
      lifecycleStatus: "completed",
      adoptedFromStatus: "ready",
    });
    return {
      events: [{
        eventType: "milestone.completed",
        entityType: "milestone",
        entityId: "M-WRITER",
        payload: { milestoneId: "M-WRITER" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "lifecycle/m-writer",
        projectionKind: "milestone-lifecycle",
        rendererVersion: "1",
      }],
    };
  });

  assert.equal(_getAdapter()?.prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M-WRITER'
  `).get()?.lifecycle_status, "completed");
});

test("a genuine v42 database gains the narrow Milestone completion authorization on upgrade", () => {
  const dbPath = createDatabasePath();
  createGenuineV42Database(dbPath);
  const before = openRawDatabase(dbPath);
  try {
    assert.equal(schemaVersion(before), 42);
    seedLifecycleFixture(before);
    assert.throws(
      () => transitionToCompleted(before, "life-ready", "op-complete", 3),
      /invalid workflow lifecycle transition/,
    );
  } finally {
    before.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const upgraded = openRawDatabase(dbPath);
  try {
    assert.equal(schemaVersion(upgraded), 44);
    assert.throws(
      () => transitionToCompleted(upgraded, "life-ready", "op-wrong", 2),
      /invalid workflow lifecycle transition/,
    );
    transitionToCompleted(upgraded, "life-ready", "op-complete", 3);
    assert.equal(upgraded.prepare(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE lifecycle_id = 'life-ready'
    `).get()?.lifecycle_status, "completed");
  } finally {
    upgraded.close();
  }
});
