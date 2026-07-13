// Project/App: gsd-pi
// File Purpose: Executable contract for the v38 Task verification recovery trigger.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DbAdapter } from "../db-adapter.ts";
import { createRecoveryEvidenceFoundationSchemaV34 } from "../db-recovery-evidence-foundation-schema.ts";
import {
  SCHEMA_VERSION,
  _setMigrationFaultForTest,
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

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-v38-verification-recovery-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function openRawDatabase(path: string): RawDb {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function projectId(db: RawDb): string {
  return String(db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.["project_id"]);
}

function schemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.["version"]);
}

function insertOperation(db: RawDb, revision: number, operationType: string): void {
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'agent', 'test', ?, '')
  `).run(
    `op-${revision}`,
    projectId(db),
    operationType,
    `key-${revision}`,
    revision - 1,
    revision,
    `hash-${revision}`,
  );
}

function seedSucceededAttempt(db: RawDb): void {
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Verification recovery', 'active', '');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Verification recovery', 'active', '');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Verification recovery', 'in_progress');
  `);
  insertOperation(db, 1, "lifecycle.adopt");
  insertOperation(db, 2, "attempt.settle");
  insertOperation(db, 3, "criterion.define");
  insertOperation(db, 4, "verification.verdict");
  insertOperation(db, 5, "recovery.observe");

  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES ('life-task', ?, 'task', 'M001', 'S01', 'T01',
      'in_progress', '', '', 'op-1', 1, 0)
  `).run(projectId(db));
  db.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
      claimed_at, ended_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch,
      settle_operation_id, settle_project_revision, settle_authority_epoch,
      settle_outcome
    ) VALUES ('attempt-1', ?, 'life-task', 1, 'settled', '', '',
      'op-1', 1, 0, 'op-2', 2, 0, 'succeeded')
  `).run(projectId(db));
  db.prepare(`
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome,
      failure_class, summary, output_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('result-1', ?, 'life-task', 'attempt-1', 'succeeded',
      'none', 'Executor succeeded', '{}', '', 'op-2', 2, 0)
  `).run(projectId(db));
  db.prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id,
      criterion_kind, evidence_class, required, description,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('criterion-1', 'task-host-verification', ?, 'life-task',
      'technical', 'command', 1, 'Host verification must pass',
      '', 'op-3', 3, 0)
  `).run(projectId(db));
}

function insertVerdict(db: RawDb, verdict: "pass" | "fail" | "inconclusive"): void {
  db.prepare(`
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('verdict-1', ?, 'criterion-1', 'life-task', 'attempt-1',
      'sha256:tested-source', ?, 'host-verification', '1', 'Host result',
      '', 'op-4', 4, 0)
  `).run(projectId(db), verdict);
}

function insertVerifyFailure(db: RawDb): void {
  db.prepare(`
    INSERT INTO workflow_failure_observations (
      failure_observation_id, project_id, lifecycle_id, attempt_id, result_id,
      recovery_owner, boundary_stage, failure_kind, failure_fingerprint,
      summary, evidence_json, observed_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('failure-1', ?, 'life-task', 'attempt-1', 'result-1',
      'agent', 'verify', 'verification-failed', 'verification-failed:host',
      'Host verification did not pass', '{}', '', 'op-5', 5, 0)
  `).run(projectId(db));
}

function createCurrentFixture(): { dbPath: string; db: RawDb } {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  seedSucceededAttempt(db);
  return { dbPath, db };
}

function rewindToV37(db: RawDb): void {
  db.exec("DROP TRIGGER IF EXISTS trg_workflow_failure_result_scope");
  createRecoveryEvidenceFoundationSchemaV34(db as unknown as DbAdapter);
  db.exec(`
    DELETE FROM schema_version;
    INSERT INTO schema_version (version, applied_at) VALUES (37, '');
  `);
}

afterEach(() => {
  _setMigrationFaultForTest(false);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

for (const verdict of ["fail", "inconclusive"] as const) {
  const article = verdict === "inconclusive" ? "an" : "a";
  test(`v38 accepts a succeeded Result with ${article} ${verdict} Technical Verdict at verify`, () => {
    const { db } = createCurrentFixture();
    try {
      insertVerdict(db, verdict);
      assert.doesNotThrow(() => insertVerifyFailure(db));
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
        1,
      );
    } finally {
      db.close();
    }
  });
}

for (const verdict of [null, "pass"] as const) {
  const label = verdict ?? "no";
  test(`v38 rejects verify recovery with ${label} Technical Verdict`, () => {
    const { db } = createCurrentFixture();
    try {
      if (verdict) insertVerdict(db, verdict);
      assert.throws(
        () => insertVerifyFailure(db),
        /failed or interrupted result.*causal Task boundary/i,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
        0,
      );
    } finally {
      db.close();
    }
  });
}

test("faulted v38 trigger migration rolls back and retries cleanly", () => {
  const { dbPath, db } = createCurrentFixture();
  insertVerdict(db, "fail");
  rewindToV37(db);
  db.close();

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  try {
    assert.equal(schemaVersion(rolledBack), 37);
    assert.throws(() => insertVerifyFailure(rolledBack), /matching failed or interrupted result/i);
  } finally {
    rolledBack.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  try {
    assert.equal(schemaVersion(retried), 38);
    assert.doesNotThrow(() => insertVerifyFailure(retried));
    assert.equal(
      retried.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
      1,
    );
  } finally {
    retried.close();
  }
});
