// Project/App: gsd-pi
// File Purpose: Executable v44 authorization contract for hierarchy reopen transitions.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  closeDatabase,
  openDatabase,
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

type ItemKind = "milestone" | "slice" | "task";
type TerminalStatus = "completed" | "cancelled";

function openRawDatabase(path: string): RawDb {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-milestone-reopen-schema-"));
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

function insertOperation(db: RawDb, operationType: string): void {
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES ('op-reopen', ?, ?, 'key-reopen', 1, 2, 0, 0,
      'test', 'test', 'hash-reopen', '2026-07-14T00:00:02.000Z')
  `).run(projectId(db), operationType);
}

function seedTerminalLifecycle(
  db: RawDb,
  itemKind: ItemKind,
  terminalStatus: TerminalStatus,
  operationType: string,
): void {
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Milestone', 'complete', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Slice', 'complete', '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Task', 'complete');
  `);
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES ('op-seed', ?, 'fixture.seed', 'key-seed', 0, 1, 0, 0,
      'test', 'test', 'hash-seed', '2026-07-14T00:00:01.000Z')
  `).run(projectId(db));
  insertOperation(db, operationType);

  const sliceId = itemKind === "milestone" ? null : "S01";
  const taskId = itemKind === "task" ? "T01" : null;
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES ('life-target', ?, ?, 'M001', ?, ?, ?, 0,
      '2026-07-14T00:00:01.000Z', '2026-07-14T00:00:01.000Z',
      'op-seed', 1, 0)
  `).run(projectId(db), itemKind, sliceId, taskId, terminalStatus);
}

function transitionToReady(db: RawDb): void {
  db.prepare(`
    UPDATE workflow_item_lifecycles
    SET lifecycle_status = 'ready', state_version = state_version + 1,
        updated_at = '2026-07-14T00:00:02.000Z',
        last_operation_id = 'op-reopen', last_project_revision = 2,
        last_authority_epoch = 0
    WHERE lifecycle_id = 'life-target'
  `).run();
}

function createGenuineV43Database(path: string): void {
  assert.equal(openDatabase(path), true);
  closeDatabase();
  const db = openRawDatabase(path);
  try {
    db.exec("DROP TRIGGER IF EXISTS trg_workflow_lifecycle_reopen_authorization");
    db.exec("DELETE FROM schema_version WHERE version > 43");
    db.exec(`
      INSERT OR IGNORE INTO schema_version (version, applied_at)
      VALUES (43, '2026-07-14T00:00:00.000Z')
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

const authorizationCases: Array<{
  itemKind: ItemKind;
  allowed: string[];
  denied: string[];
}> = [
  {
    itemKind: "milestone",
    allowed: ["milestone.reopen"],
    denied: ["slice.reopen", "task.reopen", "fixture.wrong"],
  },
  {
    itemKind: "slice",
    allowed: ["slice.reopen", "milestone.reopen"],
    denied: ["task.reopen", "fixture.wrong"],
  },
  {
    itemKind: "task",
    allowed: ["task.reopen", "slice.reopen", "milestone.reopen"],
    denied: ["fixture.wrong"],
  },
];

test("v44 authorizes terminal-to-ready by exact hierarchy reopen operation", async (t) => {
  for (const terminalStatus of ["completed", "cancelled"] as const) {
    for (const authorization of authorizationCases) {
      for (const operationType of authorization.allowed) {
        await t.test(`${terminalStatus} ${authorization.itemKind} accepts ${operationType}`, () => {
          const dbPath = createDatabasePath();
          assert.equal(openDatabase(dbPath), true);
          closeDatabase();
          const db = openRawDatabase(dbPath);
          try {
            seedTerminalLifecycle(db, authorization.itemKind, terminalStatus, operationType);
            transitionToReady(db);
            assert.equal(db.prepare(`
              SELECT lifecycle_status FROM workflow_item_lifecycles
              WHERE lifecycle_id = 'life-target'
            `).get()?.lifecycle_status, "ready");
          } finally {
            db.close();
          }
        });
      }
      for (const operationType of authorization.denied) {
        await t.test(`${terminalStatus} ${authorization.itemKind} rejects ${operationType}`, () => {
          const dbPath = createDatabasePath();
          assert.equal(openDatabase(dbPath), true);
          closeDatabase();
          const db = openRawDatabase(dbPath);
          try {
            seedTerminalLifecycle(db, authorization.itemKind, terminalStatus, operationType);
            assert.throws(() => transitionToReady(db), /reopen authorization/i);
          } finally {
            db.close();
          }
        });
      }
    }
  }
});

test("a genuine v43 database gains hierarchy reopen authorization on upgrade", () => {
  const dbPath = createDatabasePath();
  createGenuineV43Database(dbPath);

  const before = openRawDatabase(dbPath);
  try {
    assert.equal(schemaVersion(before), 43);
    seedTerminalLifecycle(before, "milestone", "completed", "slice.reopen");
    before.exec("BEGIN");
    transitionToReady(before);
    before.exec("ROLLBACK");
  } finally {
    before.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const upgraded = openRawDatabase(dbPath);
  try {
    assert.equal(SCHEMA_VERSION, 44);
    assert.equal(schemaVersion(upgraded), 44);
    assert.throws(() => transitionToReady(upgraded), /reopen authorization/i);
  } finally {
    upgraded.close();
  }
});
