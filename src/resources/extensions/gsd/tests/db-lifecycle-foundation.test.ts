// Project/App: gsd-pi
// File Purpose: Executable contract for the additive v32 lifecycle foundation.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  _getAdapter,
  _setMigrationFaultForTest,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  createAttemptSettlementShapeTrigger,
  createAttemptTransitionFencingTrigger,
} from "../db-attempt-recovery-schema.ts";
import type { DbAdapter } from "../db-adapter.ts";

const require = createRequire(import.meta.url);
const tempDirs = new Set<string>();

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
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
  const dir = mkdtempSync(join(tmpdir(), "gsd-lifecycle-foundation-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function tableExists(db: RawDb, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function columnExists(db: RawDb, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function maxSchemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version);
}

function projectId(db: RawDb): string {
  return String(db.prepare("SELECT project_id FROM project_authority WHERE singleton = 1").get()?.project_id);
}

function seedHierarchy(db: RawDb): void {
  db.exec(`
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES
      ('M-A', 'First milestone', 'active', '2026-07-12T00:00:00.000Z'),
      ('M-B', 'Second milestone', 'active', '2026-07-12T00:00:00.000Z');
    INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
    VALUES
      ('M-A', 'S01', 'First slice', 'active', '2026-07-12T00:00:00.000Z'),
      ('M-B', 'S01', 'Second slice', 'active', '2026-07-12T00:00:00.000Z');
    INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES
      ('M-A', 'S01', 'T01', 'First task', 'in_progress'),
      ('M-B', 'S01', 'T01', 'Second task', 'in_progress');
    INSERT OR IGNORE INTO requirements (id, status, description)
    VALUES ('R-A', 'active', 'A durable requirement');
  `);
}

function insertOperation(
  db: RawDb,
  id: string,
  revision: number,
  authorityEpoch = 0,
  operationType = "attempt.settle",
): void {
  const project = projectId(db);
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, actor_id, source_transport, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', 'test', 'test', ?, ?)
  `).run(
    id,
    project,
    operationType,
    `key-${id}`,
    revision - 1,
    revision,
    authorityEpoch,
    authorityEpoch,
    `hash-${id}`,
    `2026-07-12T00:00:${String(revision).padStart(2, "0")}.000Z`,
  );
}

function insertOperations(db: RawDb, count: number): void {
  for (let revision = 1; revision <= count; revision += 1) {
    insertOperation(db, `op-${revision}`, revision);
  }
}

function insertTaskLifecycle(
  db: RawDb,
  lifecycleId: string,
  milestoneId: string,
  operationId: string,
  revision: number,
  status = "in_progress",
  authorityEpoch = 0,
): void {
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, 'task', ?, 'S01', 'T01', ?, 0, ?, ?, ?, ?, ?)
  `).run(
    lifecycleId,
    projectId(db),
    milestoneId,
    status,
    "2026-07-12T00:01:00.000Z",
    "2026-07-12T00:01:00.000Z",
    operationId,
    revision,
    authorityEpoch,
  );
}

function insertAttempt(
  db: RawDb,
  attemptId: string,
  lifecycleId: string,
  attemptNumber: number,
  operationId: string,
  revision: number,
  retryOfAttemptId: string | null = null,
  authorityEpoch = 0,
): void {
  db.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state, claimed_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch
    ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?)
  `).run(
    attemptId,
    projectId(db),
    lifecycleId,
    attemptNumber,
    retryOfAttemptId,
    `2026-07-12T00:02:${String(attemptNumber).padStart(2, "0")}.000Z`,
    operationId,
    revision,
    authorityEpoch,
  );
}

function settleAttempt(
  db: RawDb,
  attemptId: string,
  operationId: string,
  revision: number,
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
): void {
  db.prepare(`
    UPDATE workflow_execution_attempts
    SET attempt_state = 'settled', ended_at = ?, settle_outcome = ?,
        settle_operation_id = ?, settle_project_revision = ?, settle_authority_epoch = 0
    WHERE attempt_id = ?
  `).run("2026-07-12T00:03:00.000Z", outcome, operationId, revision, attemptId);
}

function openFreshFixture(): { dbPath: string; db: RawDb } {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  seedHierarchy(db);
  return { dbPath, db };
}

function rewindToV31(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    seedHierarchy(db);
    db.exec(`
      DROP TABLE IF EXISTS workflow_requirement_dispositions;
      DROP TABLE IF EXISTS workflow_waivers;
      DROP TABLE IF EXISTS workflow_blockers;
      DROP TABLE IF EXISTS workflow_attempt_results;
      DROP TABLE IF EXISTS workflow_execution_attempts;
      DROP TABLE IF EXISTS workflow_item_lifecycles;
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at)
      VALUES (31, '2026-07-12T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

function rewindToV35(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_workflow_attempt_transition_fencing;
      DROP TRIGGER IF EXISTS trg_workflow_attempt_transition_dispatch_scope;
      DROP TRIGGER IF EXISTS trg_workflow_attempt_settlement_shape_v36;
      DROP TRIGGER IF EXISTS trg_workflow_attempt_settlement_insert_shape_v36;
      DROP TRIGGER IF EXISTS trg_workflow_attempt_result_outcome_v36;
      DROP TRIGGER IF EXISTS trg_workflow_kernel_stage_transition_v36;
      DROP TRIGGER IF EXISTS trg_workflow_kernel_execute_result_v36;
      ALTER TABLE workflow_execution_attempts DROP COLUMN recovery_milestone_lease_token;
      ALTER TABLE workflow_execution_attempts DROP COLUMN recovery_worker_id;
      ALTER TABLE workflow_execution_attempts DROP COLUMN settle_outcome;
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at)
      VALUES (35, '2026-07-12T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

function rewindToV36(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    createAttemptSettlementShapeTrigger(db as unknown as DbAdapter);
    createAttemptTransitionFencingTrigger(db as unknown as DbAdapter);
    db.exec(`
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at)
      VALUES (36, '2026-07-12T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

afterEach(() => {
  _setMigrationFaultForTest(false);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("fresh databases expose distinct v32 lifecycle concepts with exact vocabularies", () => {
  assert.ok(SCHEMA_VERSION >= 32);
  const { db } = openFreshFixture();
  try {
    for (const table of [
      "workflow_item_lifecycles",
      "workflow_execution_attempts",
      "workflow_attempt_results",
      "workflow_requirement_dispositions",
      "workflow_waivers",
      "workflow_blockers",
    ]) {
      assert.equal(tableExists(db, table), true, `${table} should exist`);
    }

    insertOperation(db, "op-1", 1);
    for (const [index, status] of [
      "pending", "ready", "in_progress", "paused", "completed", "cancelled",
    ].entries()) {
      const milestone = index % 2 === 0 ? "M-A" : "M-B";
      db.exec("SAVEPOINT lifecycle_vocabulary");
      db.prepare(`
        INSERT INTO workflow_item_lifecycles (
          lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
          lifecycle_status, created_at, updated_at,
          last_operation_id, last_project_revision, last_authority_epoch
        ) VALUES (?, ?, 'task', ?, 'S01', 'T01', ?, '', '', 'op-1', 1, 0)
      `).run(`lifecycle-${index}`, projectId(db), milestone, status);
      db.exec("ROLLBACK TO lifecycle_vocabulary");
      db.exec("RELEASE lifecycle_vocabulary");
    }
    assert.throws(
      () => insertTaskLifecycle(db, "invalid-lifecycle", "M-A", "op-1", 1, "blocked"),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("database permits at most one active Attempt per fully scoped work item", () => {
  const { db } = openFreshFixture();
  try {
    insertOperation(db, "op-1", 1);
    insertOperation(db, "op-2", 2);
    insertOperation(db, "op-3", 3);
    insertOperation(db, "op-4", 4);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    insertTaskLifecycle(db, "life-b", "M-B", "op-2", 2);

    insertAttempt(db, "attempt-a1", "life-a", 1, "op-3", 3);
    assert.throws(
      () => insertAttempt(db, "attempt-a-race", "life-a", 2, "op-4", 4, "attempt-a1"),
      /UNIQUE constraint failed/,
    );
    assert.doesNotThrow(() => insertAttempt(db, "attempt-b1", "life-b", 1, "op-4", 4));
  } finally {
    db.close();
  }
});

test("lifecycle transitions preserve identity, provenance, and durable history", () => {
  const { db } = openFreshFixture();
  try {
    insertOperation(db, "op-1", 1);
    insertOperation(db, "op-2", 2);
    insertOperation(db, "op-3", 3);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);

    db.prepare(`
      UPDATE workflow_item_lifecycles
      SET lifecycle_status = 'completed', state_version = 1,
          updated_at = '2026-07-12T00:04:00.000Z',
          last_operation_id = 'op-2', last_project_revision = 2
      WHERE lifecycle_id = 'life-a'
    `).run();
    assert.equal(
      db.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'life-a'").get()?.lifecycle_status,
      "completed",
    );
    assert.throws(
      () => db.exec(`
        UPDATE workflow_item_lifecycles
        SET milestone_id = 'M-B', lifecycle_status = 'ready', state_version = 2,
            updated_at = '2026-07-12T00:05:00.000Z',
            last_operation_id = 'op-3', last_project_revision = 3
        WHERE lifecycle_id = 'life-a'
      `),
      /identity is immutable/,
    );
    assert.throws(
      () => db.exec("UPDATE workflow_item_lifecycles SET lifecycle_status = 'ready' WHERE lifecycle_id = 'life-a'"),
      /causal provenance/,
    );
    assert.throws(
      () => db.exec("DELETE FROM workflow_item_lifecycles WHERE lifecycle_id = 'life-a'"),
      /durable history/,
    );
  } finally {
    db.close();
  }
});

test("lifecycle histories reject backward revisions and Authority Epochs", () => {
  const { db } = openFreshFixture();
  try {
    insertOperation(db, "op-1", 1, 0);
    insertOperation(db, "op-2", 2, 1);
    insertOperation(db, "op-3", 3, 0);
    insertTaskLifecycle(db, "life-a", "M-A", "op-2", 2, "in_progress", 1);
    insertAttempt(db, "attempt-a1", "life-a", 1, "op-2", 2, null, 1);
    db.prepare(`
      INSERT INTO workflow_blockers (
        blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
        blocker_status, description, opened_at,
        opened_operation_id, opened_project_revision, opened_authority_epoch
      ) VALUES ('blocker-a', ?, 'life-a', 'ambiguous_intent', 'user',
        'open', 'Needs a decision', '', 'op-2', 2, 1)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_waivers (
        waiver_id, project_id, lifecycle_id, requirement_id, waiver_status,
        scope, rationale, granted_by_actor_type, granted_by_actor_id, granted_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('waiver-a', ?, 'life-a', 'R-A', 'active',
        'requirement:R-A', 'Exception', 'user', 'maintainer', '', 'op-2', 2, 1)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_requirement_dispositions (
        disposition_id, project_id, requirement_id, disposition,
        rationale, created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('disp-a', ?, 'R-A', 'unsatisfied',
        'Not yet met', '', 'op-2', 2, 1)
    `).run(projectId(db));

    assert.throws(
      () => db.exec(`
        UPDATE workflow_execution_attempts
        SET started_at = '2026-07-12T00:03:00.000Z'
        WHERE attempt_id = 'attempt-a1'
      `),
      /invalid workflow attempt transition/,
    );
    assert.throws(
      () => db.exec(`
        UPDATE workflow_item_lifecycles
        SET lifecycle_status = 'completed', state_version = 1,
            updated_at = '2026-07-12T00:04:00.000Z',
            last_operation_id = 'op-3', last_project_revision = 3,
            last_authority_epoch = 0
        WHERE lifecycle_id = 'life-a'
      `),
      /causal provenance/,
    );
    for (const [operationId, revision] of [["op-1", 1], ["op-3", 3]] as const) {
      assert.throws(
        () => db.prepare(`
          UPDATE workflow_execution_attempts
          SET attempt_state = 'settled', ended_at = '', settle_outcome = 'succeeded',
              settle_operation_id = ?, settle_project_revision = ?,
              settle_authority_epoch = 0
          WHERE attempt_id = 'attempt-a1'
        `).run(operationId, revision),
        /causal provenance/,
      );
      assert.throws(
        () => db.prepare(`
          UPDATE workflow_blockers
          SET blocker_status = 'resolved', resolution = 'answered', resolved_at = '',
              resolved_operation_id = ?, resolved_project_revision = ?,
              resolved_authority_epoch = 0
          WHERE blocker_id = 'blocker-a'
        `).run(operationId, revision),
        /causal provenance/,
      );
      assert.throws(
        () => db.prepare(`
          UPDATE workflow_waivers
          SET waiver_status = 'revoked', ended_at = '',
              ended_operation_id = ?, ended_project_revision = ?,
              ended_authority_epoch = 0
          WHERE waiver_id = 'waiver-a'
        `).run(operationId, revision),
        /causal provenance/,
      );
      assert.throws(
        () => db.prepare(`
          INSERT INTO workflow_requirement_dispositions (
            disposition_id, project_id, requirement_id, disposition,
            supersedes_disposition_id, rationale, created_at,
            operation_id, project_revision, authority_epoch
          ) VALUES (?, ?, 'R-A', 'satisfied', 'disp-a',
            'Now met', '', ?, ?, 0)
        `).run(`disp-${revision}`, projectId(db), operationId, revision),
        /causal provenance/,
      );
    }
  } finally {
    db.close();
  }
});

test("Attempt attribution rejects stale fencing and cross-scope dispatches", () => {
  const { db } = openFreshFixture();
  try {
    insertOperation(db, "op-1", 1);
    insertOperation(db, "op-2", 2);
    insertOperation(db, "op-3", 3);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    db.prepare(`
      INSERT INTO workflow_item_lifecycles (
        lifecycle_id, project_id, item_kind, milestone_id,
        lifecycle_status, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES ('life-m', ?, 'milestone', 'M-A',
        'in_progress', '', '', 'op-1', 1, 0)
    `).run(projectId(db));
    db.exec(`
      INSERT INTO workers (
        worker_id, host, pid, started_at, version,
        last_heartbeat_at, status, project_root_realpath
      ) VALUES ('worker-a', 'localhost', 1, '', '1', '', 'active', '/project');
      INSERT INTO milestone_leases (
        milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
      ) VALUES ('M-A', 'worker-a', 7, '', '2099-01-01T00:00:00.000Z', 'held');
      INSERT INTO unit_dispatches (
        trace_id, worker_id, milestone_lease_token, milestone_id,
        slice_id, task_id, unit_type, unit_id, status, started_at
      ) VALUES (
        'cross-scope', 'worker-a', 7, 'M-B',
        'S01', 'T01', 'execute-task', 'M-B/S01/T01', 'claimed', ''
      );
      INSERT INTO unit_dispatches (
        trace_id, worker_id, milestone_lease_token, milestone_id,
        slice_id, task_id, unit_type, unit_id, status, started_at
      ) VALUES (
        'child-scope', 'worker-a', 7, 'M-A',
        'S01', 'T01', 'execute-task', 'M-A/S01/T01', 'claimed', ''
      );
    `);
    const crossDispatchId = Number(
      db.prepare("SELECT id FROM unit_dispatches WHERE trace_id = 'cross-scope'").get()?.id,
    );
    const childDispatchId = Number(
      db.prepare("SELECT id FROM unit_dispatches WHERE trace_id = 'child-scope'").get()?.id,
    );

    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_execution_attempts (
          attempt_id, project_id, lifecycle_id, attempt_number,
          attempt_state, worker_id, milestone_lease_token, claimed_at,
          claim_operation_id, claim_project_revision, claim_authority_epoch
        ) VALUES ('attempt-stale', ?, 'life-a', 1,
          'claimed', 'worker-a', 6, '', 'op-2', 2, 0)
      `).run(projectId(db)),
      /current held lease/,
    );
    db.exec("UPDATE milestone_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE milestone_id = 'M-A'");
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_execution_attempts (
          attempt_id, project_id, lifecycle_id, attempt_number,
          attempt_state, worker_id, milestone_lease_token, claimed_at,
          claim_operation_id, claim_project_revision, claim_authority_epoch
        ) VALUES ('attempt-expired', ?, 'life-a', 1,
          'claimed', 'worker-a', 7, '', 'op-2', 2, 0)
      `).run(projectId(db)),
      /current held lease/,
    );
    db.exec("UPDATE milestone_leases SET expires_at = '2099-01-01T00:00:00.000Z' WHERE milestone_id = 'M-A'");
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_execution_attempts (
          attempt_id, project_id, lifecycle_id, attempt_number,
          attempt_state, coordination_dispatch_id,
          worker_id, milestone_lease_token, claimed_at,
          claim_operation_id, claim_project_revision, claim_authority_epoch
        ) VALUES ('attempt-cross', ?, 'life-a', 1,
          'claimed', ?, 'worker-a', 7, '', 'op-2', 2, 0)
      `).run(projectId(db), crossDispatchId),
      /does not match workflow attempt scope/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_execution_attempts (
          attempt_id, project_id, lifecycle_id, attempt_number,
          attempt_state, coordination_dispatch_id,
          worker_id, milestone_lease_token, claimed_at,
          claim_operation_id, claim_project_revision, claim_authority_epoch
        ) VALUES ('attempt-parent', ?, 'life-m', 1,
          'claimed', ?, 'worker-a', 7, '', 'op-2', 2, 0)
      `).run(projectId(db), childDispatchId),
      /does not match workflow attempt scope/,
    );
    insertAttempt(db, "attempt-workerless", "life-m", 1, "op-2", 2);
    assert.throws(
      () => db.exec(`
        UPDATE workflow_execution_attempts
        SET attempt_state = 'running', worker_id = 'worker-a',
            milestone_lease_token = 7, started_at = ''
        WHERE attempt_id = 'attempt-workerless'
      `),
      /identity is immutable/,
    );
    db.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number,
        attempt_state, coordination_dispatch_id,
        worker_id, milestone_lease_token, claimed_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch
      ) VALUES ('attempt-valid', ?, 'life-a', 1,
        'claimed', ?, 'worker-a', 7, '', 'op-2', 2, 0)
    `).run(projectId(db), childDispatchId);
    db.exec("UPDATE milestone_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE milestone_id = 'M-A'");
    assert.throws(
      () => db.exec(`
        UPDATE workflow_execution_attempts
        SET attempt_state = 'running', started_at = '2026-07-12T00:03:00.000Z'
        WHERE attempt_id = 'attempt-valid'
      `),
      /current held lease/,
    );
    db.exec("UPDATE milestone_leases SET expires_at = '2099-01-01T00:00:00.000Z' WHERE milestone_id = 'M-A'");
    db.exec(`
      UPDATE workflow_execution_attempts
      SET attempt_state = 'running', started_at = '2026-07-12T00:03:00.000Z'
      WHERE attempt_id = 'attempt-valid'
    `);
    db.prepare("UPDATE unit_dispatches SET status = 'completed' WHERE id = ?").run(childDispatchId);
    assert.throws(
      () => settleAttempt(db, "attempt-valid", "op-3", 3),
      /does not match workflow attempt scope/,
    );
  } finally {
    db.close();
  }
});

test("Attempt transitions preserve claim and start timestamps", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 4);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    insertTaskLifecycle(db, "life-b", "M-B", "op-1", 1);
    insertAttempt(db, "attempt-a1", "life-a", 1, "op-2", 2);
    db.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number,
        attempt_state, claimed_at, started_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch
      ) VALUES ('attempt-b1', ?, 'life-b', 1,
        'claimed', '2026-07-12T00:02:00.000Z', '2026-07-12T00:03:00.000Z',
        'op-2', 2, 0)
    `).run(projectId(db));

    assert.throws(
      () => db.exec(`
        UPDATE workflow_execution_attempts
        SET attempt_state = 'settled', claimed_at = 'rewritten', settle_outcome = 'succeeded',
            ended_at = '2026-07-12T00:03:00.000Z',
            settle_operation_id = 'op-3', settle_project_revision = 3,
            settle_authority_epoch = 0
        WHERE attempt_id = 'attempt-a1'
      `),
      /identity is immutable/,
    );
    assert.throws(
      () => db.exec(`
        UPDATE workflow_execution_attempts
        SET attempt_state = 'settled', started_at = 'rewritten', settle_outcome = 'succeeded',
            ended_at = '2026-07-12T00:04:00.000Z',
            settle_operation_id = 'op-4', settle_project_revision = 4,
            settle_authority_epoch = 0
        WHERE attempt_id = 'attempt-b1'
      `),
      /identity is immutable/,
    );
  } finally {
    db.close();
  }
});

test("v32 rejects conflated vocabularies and orphaned canonical records", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 4);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    insertAttempt(db, "attempt-a1", "life-a", 1, "op-2", 2);
    settleAttempt(db, "attempt-a1", "op-3", 3, "failed");

    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_attempt_results (
          result_id, project_id, lifecycle_id, attempt_id, outcome,
          failure_class, summary, output_json, created_at,
          operation_id, project_revision, authority_epoch
        ) VALUES ('result-wrong-operation', ?, 'life-a', 'attempt-a1', 'failed',
          'test_failure', '', '{}', '', 'op-4', 4, 0)
      `).run(projectId(db)),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_attempt_results (
          result_id, project_id, lifecycle_id, attempt_id, outcome,
          failure_class, summary, output_json, created_at,
          operation_id, project_revision, authority_epoch
        ) VALUES ('result-cancelled', ?, 'life-a', 'attempt-a1', 'cancelled',
          'none', '', '{}', '', 'op-3', 3, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_requirement_dispositions (
          disposition_id, project_id, requirement_id, disposition,
          rationale, created_at, operation_id, project_revision, authority_epoch
        ) VALUES ('disp-complete', ?, 'R-A', 'complete', '', '', 'op-4', 4, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_execution_attempts (
          attempt_id, project_id, lifecycle_id, attempt_number,
          attempt_state, claimed_at,
          claim_operation_id, claim_project_revision, claim_authority_epoch
        ) VALUES ('attempt-orphan', ?, 'missing-life', 1,
          'claimed', '', 'op-4', 4, 0)
      `).run(projectId(db)),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_blockers (
          blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
          blocker_status, description, opened_at,
          opened_operation_id, opened_project_revision, opened_authority_epoch
        ) VALUES ('blocker-technical', ?, 'life-a', 'technical', 'user',
          'open', 'an agent-fixable failure', '', 'op-4', 4, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("immutable Attempt Results never fabricate lifecycle or requirement state", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 5);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    insertAttempt(db, "attempt-a1", "life-a", 1, "op-2", 2);
    settleAttempt(db, "attempt-a1", "op-3", 3, "failed");

    db.prepare(`
      INSERT INTO workflow_attempt_results (
        result_id, project_id, lifecycle_id, attempt_id, outcome,
        failure_class, summary, output_json, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('result-a1', ?, 'life-a', 'attempt-a1', 'failed',
        'test_failure', 'tests failed', '{}', '', 'op-3', 3, 0)
    `).run(projectId(db));

    assert.equal(
      db.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'life-a'").get()?.lifecycle_status,
      "in_progress",
    );
    assert.equal(
      db.prepare("SELECT status FROM requirements WHERE id = 'R-A'").get()?.status,
      "active",
    );
    assert.throws(
      () => db.exec("UPDATE workflow_attempt_results SET outcome = 'succeeded' WHERE result_id = 'result-a1'"),
      /immutable/,
    );
    assert.throws(
      () => db.exec("DELETE FROM workflow_attempt_results WHERE result_id = 'result-a1'"),
      /immutable/,
    );
    assert.throws(
      () => db.exec(`
        INSERT INTO workflow_attempt_results (
          result_id, project_id, lifecycle_id, attempt_id, outcome,
          failure_class, summary, output_json, created_at,
          operation_id, project_revision, authority_epoch
        ) SELECT 'result-a1-duplicate', project_id, lifecycle_id, attempt_id,
          outcome, failure_class, summary, output_json, created_at,
          operation_id, project_revision, authority_epoch
        FROM workflow_attempt_results WHERE result_id = 'result-a1'
      `),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => db.exec("UPDATE workflow_attempt_results SET outcome = 'cancelled' WHERE result_id = 'result-a1'"),
      /immutable|CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("retry after restart preserves settled Attempt and Result history", () => {
  const { dbPath, db } = openFreshFixture();
  try {
    insertOperations(db, 6);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    insertAttempt(db, "attempt-a1", "life-a", 1, "op-2", 2);
    settleAttempt(db, "attempt-a1", "op-3", 3, "interrupted");
    db.prepare(`
      INSERT INTO workflow_attempt_results (
        result_id, project_id, lifecycle_id, attempt_id, outcome,
        failure_class, summary, output_json, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('result-a1', ?, 'life-a', 'attempt-a1', 'interrupted',
        'process_exit', 'worker stopped', '{}', '', 'op-3', 3, 0)
    `).run(projectId(db));
  } finally {
    db.close();
  }

  assert.equal(openDatabase(dbPath), true);
  const reopened = _getAdapter()!;
  reopened.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state, claimed_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch
    ) SELECT 'attempt-a2', project_id, 'life-a', 2, 'attempt-a1',
      'claimed', '', 'op-5', 5, 0
    FROM project_authority WHERE singleton = 1
  `).run();

  assert.deepEqual(
    reopened.prepare(`
      SELECT attempt_id, attempt_number, retry_of_attempt_id
      FROM workflow_execution_attempts
      WHERE lifecycle_id = 'life-a'
      ORDER BY attempt_number
    `).all(),
    [
      { attempt_id: "attempt-a1", attempt_number: 1, retry_of_attempt_id: null },
      { attempt_id: "attempt-a2", attempt_number: 2, retry_of_attempt_id: "attempt-a1" },
    ],
  );
  assert.equal(
    reopened.prepare("SELECT outcome FROM workflow_attempt_results WHERE attempt_id = 'attempt-a1'").get()?.outcome,
    "interrupted",
  );
});

test("Requirement Dispositions require Waivers and remain independent from Blockers", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 6);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);

    db.prepare(`
      INSERT INTO workflow_blockers (
        blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
        blocker_status, description, opened_at,
        opened_operation_id, opened_project_revision, opened_authority_epoch
      ) VALUES ('blocker-a', ?, 'life-a', 'ambiguous_intent', 'user',
        'open', 'Two materially different product routes remain', '', 'op-2', 2, 0)
    `).run(projectId(db));

    assert.equal(
      db.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'life-a'").get()?.lifecycle_status,
      "in_progress",
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_requirement_dispositions (
          disposition_id, project_id, requirement_id, disposition, waiver_id,
          rationale, created_at, operation_id, project_revision, authority_epoch
        ) VALUES ('disp-invalid', ?, 'R-A', 'waived', NULL, 'missing waiver', '', 'op-3', 3, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );

    db.prepare(`
      INSERT INTO workflow_waivers (
        waiver_id, project_id, lifecycle_id, requirement_id, blocker_id, waiver_status,
        scope, rationale, granted_by_actor_type, granted_by_actor_id, granted_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('waiver-a', ?, 'life-a', 'R-A', 'blocker-a', 'active',
        'requirement:R-A', 'Accepted product exception', 'user', 'maintainer', '',
        'op-3', 3, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_requirement_dispositions (
        disposition_id, project_id, requirement_id, disposition, waiver_id,
        rationale, created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('disp-a', ?, 'R-A', 'waived', 'waiver-a',
        'Authorized exception', '', 'op-4', 4, 0)
    `).run(projectId(db));

    assert.equal(
      db.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'life-a'").get()?.lifecycle_status,
      "in_progress",
    );
    assert.equal(
      db.prepare("SELECT blocker_status FROM workflow_blockers WHERE blocker_id = 'blocker-a'").get()?.blocker_status,
      "open",
    );
    assert.equal(
      db.prepare("SELECT disposition FROM workflow_requirement_dispositions WHERE disposition_id = 'disp-a'").get()?.disposition,
      "waived",
    );
    assert.throws(
      () => db.exec(`
        UPDATE workflow_blockers
        SET description = 'rewritten', blocker_status = 'resolved', resolution = 'answered',
            resolved_at = '2026-07-12T00:05:00.000Z',
            resolved_operation_id = 'op-5', resolved_project_revision = 5,
            resolved_authority_epoch = 0
        WHERE blocker_id = 'blocker-a'
      `),
      /opening is immutable/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_requirement_dispositions (
          disposition_id, project_id, requirement_id, disposition,
          rationale, created_at, operation_id, project_revision, authority_epoch
        ) VALUES ('disp-root-2', ?, 'R-A', 'satisfied',
          'competing root', '', 'op-5', 5, 0)
      `).run(projectId(db)),
      /current head/,
    );
    db.prepare(`
      INSERT INTO workflow_requirement_dispositions (
        disposition_id, project_id, requirement_id, disposition,
        supersedes_disposition_id, rationale, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('disp-b', ?, 'R-A', 'satisfied',
        'disp-a', 'new evidence', '', 'op-5', 5, 0)
    `).run(projectId(db));
    assert.throws(
      () => db.exec(`
        UPDATE workflow_waivers
        SET rationale = 'rewritten', waiver_status = 'revoked', ended_at = '',
            ended_operation_id = 'op-6', ended_project_revision = 6,
            ended_authority_epoch = 0
        WHERE waiver_id = 'waiver-a'
      `),
      /grant is immutable/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_requirement_dispositions (
          disposition_id, project_id, requirement_id, disposition,
          supersedes_disposition_id, rationale, created_at,
          operation_id, project_revision, authority_epoch
        ) VALUES ('disp-fork', ?, 'R-A', 'unsatisfied',
          'disp-a', 'stale branch', '', 'op-6', 6, 0)
      `).run(projectId(db)),
      /current head/,
    );
  } finally {
    db.close();
  }
});

test("only current active Waivers authorize waived dispositions", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 10);
    insertTaskLifecycle(db, "life-a", "M-A", "op-1", 1);
    const insertWaiver = db.prepare(`
      INSERT INTO workflow_waivers (
        waiver_id, project_id, lifecycle_id, requirement_id, waiver_status,
        scope, rationale, granted_by_actor_type, granted_by_actor_id, granted_at,
        expires_at, ended_at, operation_id, project_revision, authority_epoch,
        ended_operation_id, ended_project_revision, ended_authority_epoch
      ) VALUES (?, ?, 'life-a', 'R-A', ?, 'requirement:R-A', 'Exception',
        'user', 'maintainer', '', ?, ?, ?, ?, 0, ?, ?, ?)
    `);
    insertWaiver.run(
      "waiver-revoked", projectId(db), "revoked", null, "", "op-2", 2, "op-3", 3, 0,
    );
    insertWaiver.run(
      "waiver-expired", projectId(db), "expired", null, "", "op-4", 4, "op-5", 5, 0,
    );
    insertWaiver.run(
      "waiver-time-expired", projectId(db), "active", "2000-01-01T00:00:00.000Z",
      null, "op-6", 6, null, null, null,
    );
    insertWaiver.run(
      "waiver-live", projectId(db), "active", "2099-01-01T00:00:00.000Z",
      null, "op-7", 7, null, null, null,
    );
    insertWaiver.run(
      "waiver-future", projectId(db), "active", "2099-01-01T00:00:00.000Z",
      null, "op-10", 10, null, null, null,
    );

    for (const waiverId of [
      "waiver-revoked", "waiver-expired", "waiver-time-expired", "waiver-future",
    ]) {
      assert.throws(
        () => db.prepare(`
          INSERT INTO workflow_requirement_dispositions (
            disposition_id, project_id, requirement_id, disposition, waiver_id,
            rationale, created_at, operation_id, project_revision, authority_epoch
          ) VALUES (?, ?, 'R-A', 'waived', ?,
            'Invalid exception', '', 'op-8', 8, 0)
        `).run(`disp-${waiverId}`, projectId(db), waiverId),
        /active unexpired waiver/,
      );
    }
    db.prepare(`
      INSERT INTO workflow_requirement_dispositions (
        disposition_id, project_id, requirement_id, disposition, waiver_id,
        rationale, created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('disp-live', ?, 'R-A', 'waived', 'waiver-live',
        'Authorized exception', '', 'op-8', 8, 0)
    `).run(projectId(db));
    assert.throws(
      () => db.exec(`
        UPDATE workflow_waivers
        SET waiver_status = 'revoked', ended_at = '',
            ended_operation_id = 'op-9', ended_project_revision = 9,
            ended_authority_epoch = 0
        WHERE waiver_id = 'waiver-live'
      `),
      /supersede its current waived disposition/,
    );
    db.prepare(`
      INSERT INTO workflow_requirement_dispositions (
        disposition_id, project_id, requirement_id, disposition,
        supersedes_disposition_id, rationale, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('disp-satisfied', ?, 'R-A', 'satisfied',
        'disp-live', 'Requirement met', '', 'op-9', 9, 0)
    `).run(projectId(db));
    assert.doesNotThrow(() => db.exec(`
      UPDATE workflow_waivers
      SET waiver_status = 'revoked', ended_at = '',
          ended_operation_id = 'op-10', ended_project_revision = 10,
          ended_authority_epoch = 0
      WHERE waiver_id = 'waiver-live'
    `));
  } finally {
    db.close();
  }
});

test("v31 upgrade is additive, backed up, and preserves legacy values", () => {
  const dbPath = createDatabasePath();
  rewindToV31(dbPath);

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  const upgraded = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(upgraded), SCHEMA_VERSION);
    assert.equal(tableExists(upgraded, "workflow_execution_attempts"), true);
    assert.equal(upgraded.prepare("SELECT status FROM tasks WHERE milestone_id = 'M-A' AND id = 'T01'").get()?.status, "in_progress");
    assert.equal(upgraded.prepare("SELECT status FROM requirements WHERE id = 'R-A'").get()?.status, "active");
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_item_lifecycles").get()?.count, 0);
    assert.equal(upgraded.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    upgraded.close();
  }

  const backup = openRawDatabase(`${dbPath}.backup-v31`);
  try {
    assert.equal(maxSchemaVersion(backup), 31);
    assert.equal(tableExists(backup, "workflow_item_lifecycles"), false);
    assert.equal(backup.prepare("SELECT status FROM tasks WHERE milestone_id = 'M-A' AND id = 'T01'").get()?.status, "in_progress");
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    backup.close();
  }

  const restoredPath = join(dirname(dbPath), "restored.db");
  copyFileSync(`${dbPath}.backup-v31`, restoredPath);
  assert.equal(openDatabase(restoredPath), true);
  closeDatabase();
  const restored = openRawDatabase(restoredPath);
  try {
    assert.equal(maxSchemaVersion(restored), SCHEMA_VERSION);
    assert.equal(restored.prepare("SELECT status FROM tasks WHERE milestone_id = 'M-A' AND id = 'T01'").get()?.status, "in_progress");
  } finally {
    restored.close();
  }
});

test("faulted v31 migration rolls back all v32 state and retries cleanly", () => {
  const dbPath = createDatabasePath();
  rewindToV31(dbPath);

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(rolledBack), 31);
    assert.equal(tableExists(rolledBack, "workflow_item_lifecycles"), false);
    assert.equal(tableExists(rolledBack, "workflow_execution_attempts"), false);
    assert.equal(tableExists(rolledBack, "workflow_attempt_results"), false);
    assert.equal(tableExists(rolledBack, "workflow_requirement_dispositions"), false);
    assert.equal(tableExists(rolledBack, "workflow_waivers"), false);
    assert.equal(tableExists(rolledBack, "workflow_blockers"), false);
  } finally {
    rolledBack.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(retried), SCHEMA_VERSION);
    assert.equal(tableExists(retried, "workflow_execution_attempts"), true);
    assert.equal(retried.prepare("SELECT COUNT(*) AS count FROM tasks WHERE milestone_id = 'M-A'").get()?.count, 1);
  } finally {
    retried.close();
  }
});

test("faulted v35 Attempt recovery migration rolls back its columns and retries cleanly", () => {
  const dbPath = createDatabasePath();
  rewindToV35(dbPath);
  const legacy = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(legacy), 35);
    assert.equal(columnExists(legacy, "workflow_execution_attempts", "settle_outcome"), false);
    seedHierarchy(legacy);
    insertOperations(legacy, 3);
    insertTaskLifecycle(legacy, "life-v35", "M-A", "op-1", 1);
    legacy.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
        claimed_at, started_at, ended_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch,
        settle_operation_id, settle_project_revision, settle_authority_epoch
      ) VALUES (
        'attempt-v35', ?, 'life-v35', 1, 'settled',
        '2026-07-12T00:01:00.000Z', '2026-07-12T00:01:00.000Z', '2026-07-12T00:02:00.000Z',
        'op-2', 2, 0, 'op-3', 3, 0
      )
    `).run(projectId(legacy));
    legacy.prepare(`
      INSERT INTO workflow_attempt_results (
        result_id, project_id, lifecycle_id, attempt_id, outcome,
        failure_class, summary, output_json, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        'result-v35', ?, 'life-v35', 'attempt-v35', 'failed',
        'test', 'legacy failure', '{}', '2026-07-12T00:02:00.000Z',
        'op-3', 3, 0
      )
    `).run(projectId(legacy));
  } finally {
    legacy.close();
  }

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(rolledBack), 35);
    assert.equal(columnExists(rolledBack, "workflow_execution_attempts", "settle_outcome"), false);
    assert.equal(columnExists(rolledBack, "workflow_execution_attempts", "recovery_worker_id"), false);
    assert.equal(columnExists(rolledBack, "workflow_execution_attempts", "recovery_milestone_lease_token"), false);
    assert.equal(rolledBack.prepare("SELECT outcome FROM workflow_attempt_results WHERE result_id = 'result-v35'").get()?.outcome, "failed");
  } finally {
    rolledBack.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(retried), SCHEMA_VERSION);
    assert.equal(columnExists(retried, "workflow_execution_attempts", "settle_outcome"), true);
    assert.equal(columnExists(retried, "workflow_execution_attempts", "recovery_worker_id"), true);
    assert.equal(columnExists(retried, "workflow_execution_attempts", "recovery_milestone_lease_token"), true);
    assert.equal(retried.prepare(`
      SELECT settle_outcome FROM workflow_execution_attempts WHERE attempt_id = 'attempt-v35'
    `).get()?.settle_outcome, "failed");
    assert.throws(() => retried.prepare(`
      UPDATE workflow_execution_attempts SET ended_at = 'rewritten' WHERE attempt_id = 'attempt-v35'
    `).run(), /immutable|invalid workflow attempt transition/);
    assert.equal(retried.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    retried.close();
  }
});

test("settled Attempt inserts require an explicit outcome and attempt.settle provenance", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 3);
    insertOperation(db, "op-4", 4, 0, "test");
    insertTaskLifecycle(db, "life-insert-shape", "M-A", "op-1", 1);
    const insertSettled = db.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
        claimed_at, started_at, ended_at, settle_outcome,
        claim_operation_id, claim_project_revision, claim_authority_epoch,
        settle_operation_id, settle_project_revision, settle_authority_epoch
      ) VALUES (?, ?, 'life-insert-shape', 1, 'settled', '', '', '', ?, 'op-2', 2, 0, ?, ?, 0)
    `);
    assert.throws(() => insertSettled.run("attempt-missing-outcome", projectId(db), null, "op-3", 3), /settlement|outcome|identity/i);
    assert.throws(() => insertSettled.run("attempt-wrong-operation", projectId(db), "succeeded", "op-4", 4), /settlement|operation|identity/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.count, 0);
  } finally {
    db.close();
  }
});

test("v37 narrowly authorizes interrupted running Attempt cancellation and retries after rollback", () => {
  const dbPath = createDatabasePath();
  rewindToV36(dbPath);

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(rolledBack), 36);
    const sql = String(rolledBack.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'trg_workflow_attempt_settlement_shape_v36'
    `).get()?.sql);
    assert.doesNotMatch(sql, /task\.cancel/);
    const fencingSql = String(rolledBack.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'trg_workflow_attempt_transition_fencing'
    `).get()?.sql);
    assert.doesNotMatch(fencingSql, /task\.cancel/);
  } finally {
    rolledBack.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const upgraded = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(upgraded), SCHEMA_VERSION);
    const sql = String(upgraded.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'trg_workflow_attempt_settlement_shape_v36'
    `).get()?.sql);
    assert.match(sql, /task\.cancel/);
    const fencingSql = String(upgraded.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'trg_workflow_attempt_transition_fencing'
    `).get()?.sql);
    assert.match(fencingSql, /task\.cancel/);

    seedHierarchy(upgraded);
    insertOperation(upgraded, "op-v37-claim", 1);
    insertOperation(upgraded, "op-v37-cancel", 2, 0, "task.cancel");
    insertTaskLifecycle(upgraded, "life-v37-cancel", "M-A", "op-v37-claim", 1);
    upgraded.exec(`
      INSERT INTO workers (
        worker_id, host, pid, started_at, version, last_heartbeat_at, status,
        project_root_realpath
      ) VALUES (
        'worker-v37', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
        '2026-07-12T00:00:00.000Z', 'active', '/tmp/v37'
      );
      INSERT INTO milestone_leases (
        milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
      ) VALUES (
        'M-A', 'worker-v37', 7, '2026-07-12T00:00:00.000Z',
        '2099-07-12T00:00:00.000Z', 'held'
      );
    `);
    upgraded.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
        worker_id, milestone_lease_token, claimed_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch
      ) VALUES (
        'attempt-v37-cancel', ?, 'life-v37-cancel', 1, 'claimed',
        'worker-v37', 7, '2026-07-12T00:02:00.000Z', 'op-v37-claim', 1, 0
      )
    `).run(projectId(upgraded));
    upgraded.prepare(`
      UPDATE workflow_execution_attempts
      SET attempt_state = 'running', started_at = '2026-07-12T00:02:30.000Z'
      WHERE attempt_id = 'attempt-v37-cancel'
    `).run();

    assert.throws(
      () => settleAttempt(upgraded, "attempt-v37-cancel", "op-v37-cancel", 2, "succeeded"),
      /recovery requires interrupted outcome|settlement/i,
    );
    settleAttempt(upgraded, "attempt-v37-cancel", "op-v37-cancel", 2, "interrupted");
    assert.equal(upgraded.prepare(`
      SELECT settle_outcome FROM workflow_execution_attempts
      WHERE attempt_id = 'attempt-v37-cancel'
    `).get()?.settle_outcome, "interrupted");
  } finally {
    upgraded.close();
  }
});

test("v36 migration rejects settled history without an immutable Result", () => {
  const dbPath = createDatabasePath();
  rewindToV35(dbPath);
  const legacy = openRawDatabase(dbPath);
  try {
    seedHierarchy(legacy);
    insertOperations(legacy, 2);
    insertTaskLifecycle(legacy, "life-incomplete", "M-A", "op-1", 1);
    legacy.prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
        claimed_at, ended_at, claim_operation_id, claim_project_revision, claim_authority_epoch,
        settle_operation_id, settle_project_revision, settle_authority_epoch
      ) VALUES ('attempt-incomplete', ?, 'life-incomplete', 1, 'settled', '', '', 'op-1', 1, 0, 'op-2', 2, 0)
    `).run(projectId(legacy));
  } finally {
    legacy.close();
  }

  assert.throws(() => openDatabase(dbPath), /cannot derive outcomes/i);
  const unchanged = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(unchanged), 35);
    assert.equal(columnExists(unchanged, "workflow_execution_attempts", "settle_outcome"), false);
    assert.equal(unchanged.prepare("SELECT attempt_state FROM workflow_execution_attempts").get()?.attempt_state, "settled");
  } finally {
    unchanged.close();
  }
});
