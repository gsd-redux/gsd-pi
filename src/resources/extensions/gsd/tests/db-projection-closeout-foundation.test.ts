// Project/App: gsd-pi
// File Purpose: Executable contract for the additive v35 projection, import, kernel, and closeout foundation.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  SCHEMA_VERSION,
  _setMigrationFaultForTest,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";

const require = createRequire(import.meta.url);
const V35_TABLES = [
  "workflow_projection_work",
  "workflow_import_applications",
  "workflow_kernel_checkpoints",
  "workflow_closeout_plans",
  "workflow_closeout_effects",
  "workflow_settlement_receipts",
] as const;

function sha256(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function previewHash(revision: number): string {
  return sha256(String(revision));
}

interface RawDb {
  readonly isOpen: boolean;
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

function createDatabasePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-projection-closeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "gsd.db");
}

function openFreshFixture(t: TestContext): { dbPath: string; db: RawDb } {
  const dbPath = createDatabasePath(t);
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  t.after(() => {
    if (db.isOpen) db.close();
    closeDatabase();
    _setMigrationFaultForTest(false);
  });
  seedHierarchy(db);
  return { dbPath, db };
}

function tableExists(db: RawDb, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function maxSchemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version);
}

function projectId(db: RawDb): string {
  return String(db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.project_id);
}

function seedHierarchy(db: RawDb): void {
  db.exec(`
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES
      ('M-CLOSEOUT', 'Closeout foundation', 'active', ''),
      ('M-OTHER', 'Other scope', 'active', '');
  `);
}

function insertOperation(
  db: RawDb,
  revision: number,
  operationType = "attempt.settle",
  epoch = 0,
  requestHash = operationType === "import.apply" ? previewHash(revision) : `hash-op-${revision}`,
): void {
  const operationId = `op-${revision}`;
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, actor_id, source_transport, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', 'developer', 'test', ?, ?)
  `).run(
    operationId,
    projectId(db),
    operationType,
    `key-${operationId}`,
    revision - 1,
    revision,
    epoch,
    epoch,
    requestHash,
    `2026-07-12T00:00:${String(revision).padStart(2, "0")}.000Z`,
  );
}

function insertOperations(db: RawDb, count: number): void {
  for (let revision = 1; revision <= count; revision += 1) insertOperation(db, revision);
}

function insertLifecycle(
  db: RawDb,
  lifecycleId = "life-closeout",
  revision = 1,
  milestoneId = "M-CLOSEOUT",
): void {
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
      created_at, updated_at, last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, 'milestone', ?, 'in_progress', '', '', ?, ?, 0)
  `).run(lifecycleId, projectId(db), milestoneId, `op-${revision}`, revision);
}

function insertSettledAttempt(
  db: RawDb,
  attemptId: string,
  attemptNumber: number,
  claimRevision: number,
  settleRevision: number,
  retryOf: string | null = null,
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
): void {
  db.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state, claimed_at, ended_at, settle_outcome,
      claim_operation_id, claim_project_revision, claim_authority_epoch,
      settle_operation_id, settle_project_revision, settle_authority_epoch
    ) VALUES (?, ?, 'life-closeout', ?, ?, 'settled', '', '', ?, ?, ?, 0, ?, ?, 0)
  `).run(
    attemptId,
    projectId(db),
    attemptNumber,
    retryOf,
    outcome,
    `op-${claimRevision}`,
    claimRevision,
    `op-${settleRevision}`,
    settleRevision,
  );
  db.prepare(`
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome,
      failure_class, summary, output_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, 'life-closeout', ?, ?, 'none',
      'Attempt succeeded', '{}', '2026-07-12T00:00:00.000Z', ?, ?, 0)
  `).run(
    `result-${attemptId}`,
    projectId(db),
    attemptId,
    outcome,
    `op-${settleRevision}`,
    settleRevision,
  );
}

function insertProjection(
  db: RawDb,
  input: {
    id: string;
    revision: number;
    supersedes?: string | null;
    key?: string;
    state?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_projection_work (
      projection_work_id, project_id, projection_key, projection_kind,
      supersedes_projection_work_id, source_project_revision, source_authority_epoch,
      renderer_version, delivery_state, state_version, attempt_count,
      enqueue_operation_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'markdown', ?, ?, 0, 'v1', ?, 0, 0, ?,
      '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')
  `).run(
    input.id,
    projectId(db),
    input.key ?? "status/project",
    input.supersedes ?? null,
    input.revision,
    input.state ?? "pending",
    `op-${input.revision}`,
  );
}

function insertKernelCheckpoint(
  db: RawDb,
  input: {
    id: string;
    sequence: number;
    stage: string;
    revision: number;
    attemptId: string;
    previous?: string | null;
    operationId?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_kernel_checkpoints (
      kernel_checkpoint_id, project_id, lifecycle_id, attempt_id,
      next_stage, sequence, previous_kernel_checkpoint_id,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, 'life-closeout', ?, ?, ?, ?,
      '2026-07-12T00:00:00.000Z', ?, ?, 0)
  `).run(
    input.id,
    projectId(db),
    input.attemptId,
    input.stage,
    input.sequence,
    input.previous ?? null,
    input.operationId ?? `op-${input.revision}`,
    input.revision,
  );
}

function insertCloseoutPlan(
  db: RawDb,
  input: {
    id: string;
    attemptId: string;
    revision: number;
    supersedes?: string | null;
    sourceHash?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_closeout_plans (
      closeout_plan_id, project_id, lifecycle_id, attempt_id,
      tested_source_set_hash, readiness_basis_hash, supersedes_closeout_plan_id,
      prepared_at, operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, 'life-closeout', ?, ?, ?, ?,
      '2026-07-12T00:00:00.000Z', ?, ?, 0)
  `).run(
    input.id,
    projectId(db),
    input.attemptId,
    input.sourceHash ?? sha256(input.id === "plan-1" ? "a" : "b"),
    sha256(input.id === "plan-1" ? "c" : "d"),
    input.supersedes ?? null,
    `op-${input.revision}`,
    input.revision,
  );
}

function insertEffect(
  db: RawDb,
  input: {
    id: string;
    planId: string;
    ordinal: number;
    key: string;
    revision: number;
    specJson?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_closeout_effects (
      closeout_effect_id, closeout_plan_id, project_id, lifecycle_id,
      ordinal, effect_kind, idempotency_key, effect_spec_json, effect_spec_hash,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, 'life-closeout', ?, 'source_commit', ?, ?, ?,
      '2026-07-12T00:00:00.000Z', ?, ?, 0)
  `).run(
    input.id,
    input.planId,
    projectId(db),
    input.ordinal,
    input.key,
    input.specJson ?? '{"kind":"source_commit"}',
    sha256(input.id === "effect-1" ? "1" : "2"),
    `op-${input.revision}`,
    input.revision,
  );
}

function insertReceipt(
  db: RawDb,
  input: {
    id: string;
    effectId: string;
    outcome: string;
    revision: number;
    lifecycleId?: string;
    proofJson?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_settlement_receipts (
      settlement_receipt_id, closeout_effect_id, project_id, lifecycle_id,
      outcome, external_ref, proof_json, proof_hash, settled_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, '2026-07-12T00:00:00.000Z', ?, ?, 0
    )
  `).run(
    input.id,
    input.effectId,
    projectId(db),
    input.lifecycleId ?? "life-closeout",
    input.outcome,
    `external-${input.id}`,
    input.proofJson ?? '{"verified":true}',
    sha256(input.id === "receipt-1" ? "3" : "4"),
    `op-${input.revision}`,
    input.revision,
  );
}

function insertImportApplication(
  db: RawDb,
  input: {
    revision: number;
    previewId: string;
    previewHash?: string;
    previewJson?: string;
  },
): void {
  const baseRevision = input.revision - 1;
  const sourceSetHash = sha256("b");
  const changeSetHash = sha256("c");
  const previewJson = input.previewJson ?? JSON.stringify({
    preview_schema_version: 1,
    preview_id: input.previewId,
    import_kind: "markdown",
    importer_version: "v1",
    base_project_revision: baseRevision,
    base_authority_epoch: 0,
    base_database_schema_version: 35,
    source_set_hash: sourceSetHash,
    change_set_hash: changeSetHash,
    counts: {
      create: 1,
      update: 0,
      delete: 0,
      preserve: 0,
      unparsed: 0,
      unresolved: 0,
    },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
  db.prepare(`
    INSERT INTO workflow_import_applications (
      operation_id, project_id, import_kind, importer_version, preview_schema_version,
      preview_id, preview_hash, base_project_revision, base_authority_epoch,
      base_database_schema_version, source_set_hash, change_set_hash,
      create_count, update_count, delete_count, preserve_count, unparsed_count, unresolved_count,
      preview_json, backup_ref, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch, backup_quick_check, backup_verified_at,
      applied_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      ?, ?, 'markdown', 'v1', 1, ?, ?, ?, 0, 35, ?, ?,
      1, 0, 0, 0, 0, 0, ?, 'backup.db', ?, 42, 35, ?, 0, 'ok',
      '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:01.000Z', ?, 0
    )
  `).run(
    `op-${input.revision}`,
    projectId(db),
    input.previewId,
    input.previewHash ?? previewHash(input.revision),
    baseRevision,
    sourceSetHash,
    changeSetHash,
    previewJson,
    sha256("d"),
    baseRevision,
    input.revision,
  );
}

function reopenRaw(dbPath: string, db: RawDb): RawDb {
  if (db.isOpen) db.close();
  return openRawDatabase(dbPath);
}

function rewindToV34(t: TestContext, dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    seedHierarchy(db);
    for (const table of [...V35_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(`
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at)
      VALUES (34, '2026-07-12T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
  t.after(() => {
    closeDatabase();
    _setMigrationFaultForTest(false);
  });
}

test("fresh databases expose exactly the six v35 projection and closeout tables and vocabularies", (t) => {
  assert.ok(SCHEMA_VERSION >= 35);
  const { db } = openFreshFixture(t);
  for (const table of V35_TABLES) assert.equal(tableExists(db, table), true, `${table} should exist`);

  insertOperations(db, 5);
  insertLifecycle(db);
  insertSettledAttempt(db, "attempt-1", 1, 2, 3);
  insertProjection(db, { id: "projection-1", revision: 4 });
  insertKernelCheckpoint(db, {
    id: "kernel-1", sequence: 1, stage: "execute", revision: 2, attemptId: "attempt-1",
  });
  assert.throws(() => insertCloseoutPlan(db, {
    id: "bad-plan-hash", attemptId: "attempt-1", revision: 4, sourceHash: "not-a-digest",
  }));
  insertCloseoutPlan(db, { id: "plan-1", attemptId: "attempt-1", revision: 4 });
  assert.throws(() => insertEffect(db, {
    id: "bad-effect-json", planId: "plan-1", ordinal: 1,
    key: "bad-spec", revision: 4, specJson: "[]",
  }));
  insertEffect(db, { id: "effect-1", planId: "plan-1", ordinal: 1, key: "commit", revision: 4 });
  assert.throws(() => insertReceipt(db, {
    id: "bad-proof-json", effectId: "effect-1", outcome: "performed",
    revision: 5, proofJson: "{}",
  }));

  for (const state of ["failed", "superseded", "complete"]) {
    assert.throws(() => insertProjection(db, { id: `bad-projection-${state}`, revision: 4, state }));
  }
  for (const stage of ["advance", "done", "failed"]) {
    assert.throws(() => insertKernelCheckpoint(db, {
      id: `bad-kernel-${stage}`, sequence: 2, stage, revision: 4,
      attemptId: "attempt-1", previous: "kernel-1",
    }));
  }
  for (const outcome of ["failed", "pending", "skipped"]) {
    assert.throws(() => insertReceipt(db, {
      id: `bad-receipt-${outcome}`, effectId: "effect-1", outcome, revision: 4,
    }));
  }
});

test("projection lineage and fenced delivery survive reopen without changing project revision", (t) => {
  const { dbPath, db } = openFreshFixture(t);
  insertOperations(db, 5);
  const revisionBefore = db.prepare(
    "SELECT revision FROM project_authority WHERE singleton = 1",
  ).get()?.revision;
  insertProjection(db, { id: "projection-1", revision: 1 });
  db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'worker-1', claim_fencing_token = 1,
        claimed_at = '2026-07-12T00:01:00.000Z', claim_expires_at = '2026-07-12T00:02:00.000Z',
        state_version = 1, updated_at = '2026-07-12T00:01:00.000Z'
    WHERE projection_work_id = 'projection-1';
    UPDATE workflow_projection_work
    SET delivery_state = 'pending', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 2, attempt_count = 1,
        next_attempt_at = '2026-07-12T00:03:00.000Z', last_error = 'disk full',
        updated_at = '2026-07-12T00:02:00.000Z'
    WHERE projection_work_id = 'projection-1';
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'worker-2', claim_fencing_token = 2,
        claimed_at = '2026-07-12T00:04:00.000Z', claim_expires_at = '2026-07-12T00:05:00.000Z',
        state_version = 3, updated_at = '2026-07-12T00:04:00.000Z'
    WHERE projection_work_id = 'projection-1';
    UPDATE workflow_projection_work
    SET delivery_state = 'dead_letter', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 4, attempt_count = 2, next_attempt_at = '',
        last_error = 'permission denied', updated_at = '2026-07-12T00:05:00.000Z'
    WHERE projection_work_id = 'projection-1';
  `);
  insertProjection(db, { id: "projection-2", revision: 2, supersedes: "projection-1" });
  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'invalid-worker', claim_fencing_token = 1,
        claimed_at = '', claim_expires_at = '9999', state_version = 1,
        updated_at = '2026-07-12T00:01:00.000Z'
    WHERE projection_work_id = 'projection-2'
  `));
  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'stale-worker', claim_fencing_token = 3,
        claimed_at = '', claim_expires_at = '9999', state_version = 5
    WHERE projection_work_id = 'projection-1'
  `));
  assert.throws(() => insertProjection(db, {
    id: "projection-fork", revision: 3, supersedes: "projection-1",
  }));
  db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'worker-3', claim_fencing_token = 1,
        claimed_at = '2026-07-12T00:06:00.000Z', claim_expires_at = '2026-07-12T00:07:00.000Z',
        state_version = 1, updated_at = '2026-07-12T00:06:00.000Z'
    WHERE projection_work_id = 'projection-2';
  `);
  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'rendered', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 2, attempt_count = 1,
        rendered_content_hash = 'not-a-digest',
        rendered_at = '2026-07-12T00:06:30.000Z',
        updated_at = '2026-07-12T00:06:30.000Z'
    WHERE projection_work_id = 'projection-2';
  `));
  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET claim_owner = 'different-worker', claim_expires_at = '2026-07-12T00:08:00.000Z',
        state_version = 2, updated_at = '2026-07-12T00:06:30.000Z'
    WHERE projection_work_id = 'projection-2';
  `));
  db.exec(`
    UPDATE workflow_projection_work
    SET claim_expires_at = '2026-07-12T00:08:00.000Z',
        state_version = 2, updated_at = '2026-07-12T00:06:30.000Z'
    WHERE projection_work_id = 'projection-2';
    UPDATE workflow_projection_work
    SET delivery_state = 'rendered', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 3, attempt_count = 1,
        rendered_content_hash = '${sha256("e")}',
        rendered_at = '2026-07-12T00:07:00.000Z',
        updated_at = '2026-07-12T00:07:00.000Z'
    WHERE projection_work_id = 'projection-2';
  `);
  insertProjection(db, { id: "unrelated", revision: 5, key: "status/other" });

  const reopened = reopenRaw(dbPath, db);
  t.after(() => { if (reopened.isOpen) reopened.close(); });
  assert.deepEqual(
    { ...reopened.prepare(`
      SELECT projection_work_id, supersedes_projection_work_id, delivery_state,
             state_version, attempt_count, claim_fencing_token, last_error
      FROM workflow_projection_work WHERE projection_work_id = 'projection-1'
    `).get() },
    {
      projection_work_id: "projection-1",
      supersedes_projection_work_id: null,
      delivery_state: "dead_letter",
      state_version: 4,
      attempt_count: 2,
      claim_fencing_token: 2,
      last_error: "permission denied",
    },
  );
  assert.equal(reopened.prepare(
    "SELECT revision FROM project_authority WHERE singleton = 1",
  ).get()?.revision, revisionBefore);
});

test("projection state rejects nullable claim and render fields", (t) => {
  const { db } = openFreshFixture(t);
  insertOperation(db, 1);
  insertProjection(db, { id: "projection-null-state", revision: 1 });

  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_fencing_token = 1,
        claimed_at = '2026-07-12T00:01:00.000Z',
        claim_expires_at = '2026-07-12T00:02:00.000Z',
        state_version = 1, updated_at = '2026-07-12T00:01:00.000Z'
    WHERE projection_work_id = 'projection-null-state'
  `));

  db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'worker-1', claim_fencing_token = 1,
        claimed_at = '2026-07-12T00:01:00.000Z',
        claim_expires_at = '2026-07-12T00:02:00.000Z',
        state_version = 1, updated_at = '2026-07-12T00:01:00.000Z'
    WHERE projection_work_id = 'projection-null-state'
  `);
  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'rendered', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 2, attempt_count = 1,
        rendered_at = '2026-07-12T00:02:00.000Z',
        updated_at = '2026-07-12T00:02:00.000Z'
    WHERE projection_work_id = 'projection-null-state'
  `));
});

test("projection retry requires diagnostic backoff and preserves it on claim", (t) => {
  const { db } = openFreshFixture(t);
  insertOperation(db, 1);
  insertProjection(db, { id: "projection-retry", revision: 1 });
  db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'worker-1', claim_fencing_token = 1,
        claimed_at = '2026-07-12T00:01:00.000Z',
        claim_expires_at = '2026-07-12T00:02:00.000Z',
        state_version = 1, updated_at = '2026-07-12T00:01:00.000Z'
    WHERE projection_work_id = 'projection-retry'
  `);

  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'pending', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 2, attempt_count = 1,
        updated_at = '2026-07-12T00:02:00.000Z'
    WHERE projection_work_id = 'projection-retry'
  `));

  db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'pending', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 2, attempt_count = 1,
        next_attempt_at = '2026-07-12T00:03:00.000Z', last_error = 'disk full',
        updated_at = '2026-07-12T00:02:00.000Z'
    WHERE projection_work_id = 'projection-retry'
  `);
  assert.throws(() => db.exec(`
    UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'worker-2', claim_fencing_token = 2,
        claimed_at = '2026-07-12T00:03:00.000Z',
        claim_expires_at = '2026-07-12T00:04:00.000Z',
        state_version = 3, next_attempt_at = '', last_error = '',
        updated_at = '2026-07-12T00:03:00.000Z'
    WHERE projection_work_id = 'projection-retry'
  `));
});

test("import application receipt binds asserted operation and backup metadata and is immutable", (t) => {
  const { db } = openFreshFixture(t);
  insertOperation(db, 1, "import.apply");
  insertImportApplication(db, { revision: 1, previewId: "preview-1" });
  assert.throws(() => db.exec(
    "UPDATE workflow_import_applications SET importer_version = 'v2' WHERE operation_id = 'op-1'",
  ));
  assert.throws(() => db.exec(
    "DELETE FROM workflow_import_applications WHERE operation_id = 'op-1'",
  ));
  assert.throws(() => db.exec(
    "UPDATE workflow_operations SET request_hash = 'changed' WHERE operation_id = 'op-1'",
  ));

  insertOperation(db, 2, "test");
  assert.throws(() => insertImportApplication(db, { revision: 2, previewId: "preview-2" }));

  insertOperation(db, 3, "import.apply");
  assert.throws(() => insertImportApplication(db, {
    revision: 3, previewId: "preview-bad-hash", previewHash: "not-a-digest",
  }));
  insertOperation(db, 4, "import.apply");
  assert.throws(() => insertImportApplication(db, {
    revision: 4, previewId: "preview-bad-json", previewJson: "[]",
  }));

  insertOperation(db, 5, "import.apply");
  assert.throws(() => insertImportApplication(db, {
    revision: 5,
    previewId: "preview-mismatched-envelope",
    previewJson: JSON.stringify({
      preview_schema_version: 1,
      preview_id: "preview-mismatched-envelope",
      import_kind: "markdown",
      importer_version: "v1",
      base_project_revision: 4,
      base_authority_epoch: 0,
      base_database_schema_version: 35,
      source_set_hash: sha256("f"),
      change_set_hash: sha256("c"),
      counts: {
        create: 99,
        update: 0,
        delete: 0,
        preserve: 0,
        unparsed: 0,
        unresolved: 0,
      },
      sources: [],
      changes: [],
      diagnoses: [],
      resolutions: [],
    }),
  }));

  insertOperation(db, 6, "import.apply", 0, sha256("f"));
  assert.throws(() => insertImportApplication(db, {
    revision: 6, previewId: "preview-unsealed", previewHash: previewHash(6),
  }));
});

test("kernel checkpoint chain has one root and head and admits only v32 retry or reopen attempts", (t) => {
  const { dbPath, db } = openFreshFixture(t);
  insertOperations(db, 16);
  insertLifecycle(db);
  insertSettledAttempt(db, "attempt-1", 1, 2, 3);
  insertSettledAttempt(db, "attempt-2", 2, 6, 7, "attempt-1", "failed");
  insertSettledAttempt(db, "attempt-3", 3, 11, 12, "attempt-2");
  insertSettledAttempt(db, "attempt-4", 4, 13, 14, "attempt-3");
  insertKernelCheckpoint(db, {
    id: "kernel-1", sequence: 1, stage: "execute", revision: 2, attemptId: "attempt-1",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-2", sequence: 2, stage: "verify", revision: 3,
    attemptId: "attempt-1", previous: "kernel-1",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-3", sequence: 3, stage: "execute", revision: 6,
    attemptId: "attempt-2", previous: "kernel-2",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-4", sequence: 4, stage: "route", revision: 7,
    attemptId: "attempt-2", previous: "kernel-3",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-5", sequence: 5, stage: "execute", revision: 11,
    attemptId: "attempt-3", previous: "kernel-4",
  });
  assert.throws(() => insertKernelCheckpoint(db, {
    id: "wrong-claim-operation", sequence: 6, stage: "execute", revision: 15,
    attemptId: "attempt-4", previous: "kernel-5",
  }));
  assert.throws(() => insertKernelCheckpoint(db, {
    id: "second-root", sequence: 1, stage: "execute", revision: 14, attemptId: "attempt-3",
  }));
  assert.throws(() => insertKernelCheckpoint(db, {
    id: "fork", sequence: 3, stage: "route", revision: 10,
    attemptId: "attempt-1", previous: "kernel-2",
  }));

  const reopened = reopenRaw(dbPath, db);
  t.after(() => { if (reopened.isOpen) reopened.close(); });
  assert.deepEqual({ ...reopened.prepare(`
    SELECT kernel_checkpoint_id, sequence, next_stage, attempt_id
    FROM workflow_kernel_checkpoints
    WHERE lifecycle_id = 'life-closeout'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = workflow_kernel_checkpoints.kernel_checkpoint_id
      )
  `).get() }, {
    kernel_checkpoint_id: "kernel-5", sequence: 5, next_stage: "execute", attempt_id: "attempt-3",
  });
  assert.throws(() => reopened.exec(
    "UPDATE workflow_kernel_checkpoints SET next_stage = 'verify' WHERE kernel_checkpoint_id = 'kernel-5'",
  ));
  assert.throws(() => reopened.exec(
    "DELETE FROM workflow_kernel_checkpoints WHERE kernel_checkpoint_id = 'kernel-5'",
  ));
});

test("one Domain Operation may append ordered Kernel stages without admitting equal-revision foreign operations", (t) => {
  const { db } = openFreshFixture(t);
  insertOperations(db, 3);
  insertLifecycle(db);
  insertSettledAttempt(db, "attempt-1", 1, 2, 3);
  insertKernelCheckpoint(db, {
    id: "kernel-1", sequence: 1, stage: "execute", revision: 2, attemptId: "attempt-1",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-2", sequence: 2, stage: "verify", revision: 3,
    attemptId: "attempt-1", previous: "kernel-1",
  });

  assert.throws(() => insertKernelCheckpoint(db, {
    id: "foreign-operation", sequence: 3, stage: "route", revision: 3,
    operationId: "different-operation", attemptId: "attempt-1", previous: "kernel-2",
  }), /kernel checkpoint must extend/i);

  insertKernelCheckpoint(db, {
    id: "kernel-3", sequence: 3, stage: "route", revision: 3,
    attemptId: "attempt-1", previous: "kernel-2",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-4", sequence: 4, stage: "closeout", revision: 3,
    attemptId: "attempt-1", previous: "kernel-3",
  });
  insertKernelCheckpoint(db, {
    id: "kernel-5", sequence: 5, stage: "settled", revision: 3,
    attemptId: "attempt-1", previous: "kernel-4",
  });

  assert.deepEqual(db.prepare(`
    SELECT sequence, next_stage, operation_id, project_revision
    FROM workflow_kernel_checkpoints ORDER BY sequence
  `).all().map((checkpoint) => ({ ...checkpoint })), [
    { sequence: 1, next_stage: "execute", operation_id: "op-2", project_revision: 2 },
    { sequence: 2, next_stage: "verify", operation_id: "op-3", project_revision: 3 },
    { sequence: 3, next_stage: "route", operation_id: "op-3", project_revision: 3 },
    { sequence: 4, next_stage: "closeout", operation_id: "op-3", project_revision: 3 },
    { sequence: 5, next_stage: "settled", operation_id: "op-3", project_revision: 3 },
  ]);
});

test("closeout effects share plan provenance and idempotency is scoped per plan", (t) => {
  const { db } = openFreshFixture(t);
  insertOperations(db, 10);
  insertLifecycle(db);
  insertLifecycle(db, "life-other", 1, "M-OTHER");
  insertSettledAttempt(db, "attempt-1", 1, 2, 3);
  insertSettledAttempt(db, "attempt-2", 2, 6, 7, "attempt-1");
  insertCloseoutPlan(db, { id: "plan-1", attemptId: "attempt-1", revision: 4 });
  insertEffect(db, { id: "effect-1", planId: "plan-1", ordinal: 1, key: "commit", revision: 4 });
  assert.throws(() => db.prepare(`
    INSERT INTO workflow_closeout_effects (
      closeout_effect_id, closeout_plan_id, project_id, lifecycle_id,
      ordinal, effect_kind, idempotency_key, effect_spec_json, effect_spec_hash,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('wrong-scope', 'plan-1', ?, 'life-other', 2, 'merge', 'merge', '{}',
      'spec-wrong-scope', '', 'op-4', 4, 0)
  `).run(projectId(db)));
  assert.throws(() => insertEffect(db, {
    id: "wrong-operation", planId: "plan-1", ordinal: 2, key: "merge", revision: 5,
  }));
  assert.throws(() => insertEffect(db, {
    id: "duplicate-key", planId: "plan-1", ordinal: 2, key: "commit", revision: 4,
  }));
  insertReceipt(db, {
    id: "receipt-before-late-effect", effectId: "effect-1", outcome: "performed", revision: 5,
  });
  assert.throws(() => insertEffect(db, {
    id: "late-after-receipt", planId: "plan-1", ordinal: 2, key: "merge", revision: 4,
  }));
  insertCloseoutPlan(db, {
    id: "plan-2", attemptId: "attempt-2", revision: 8, supersedes: "plan-1",
  });
  insertEffect(db, { id: "effect-2", planId: "plan-2", ordinal: 1, key: "commit", revision: 8 });
  assert.throws(() => insertEffect(db, {
    id: "late-old-effect", planId: "plan-1", ordinal: 2, key: "publish", revision: 4,
  }));
  assert.throws(() => db.exec(
    "UPDATE workflow_closeout_plans SET readiness_basis_hash = 'changed' WHERE closeout_plan_id = 'plan-2'",
  ));
  assert.throws(() => db.exec(
    "DELETE FROM workflow_closeout_effects WHERE closeout_effect_id = 'effect-2'",
  ));
});

test("settlement receipts are ordered, immutable, and reject superseded plans", (t) => {
  const { dbPath, db } = openFreshFixture(t);
  insertOperations(db, 12);
  insertLifecycle(db);
  insertLifecycle(db, "life-other", 1, "M-OTHER");
  insertSettledAttempt(db, "attempt-1", 1, 2, 3);
  insertSettledAttempt(db, "attempt-2", 2, 9, 10, "attempt-1");
  insertCloseoutPlan(db, { id: "plan-1", attemptId: "attempt-1", revision: 4 });
  insertEffect(db, { id: "effect-1", planId: "plan-1", ordinal: 1, key: "commit", revision: 4 });
  insertEffect(db, { id: "effect-2", planId: "plan-1", ordinal: 2, key: "merge", revision: 4 });
  insertEffect(db, { id: "effect-3", planId: "plan-1", ordinal: 3, key: "publish", revision: 4 });
  assert.throws(() => insertReceipt(db, {
    id: "wrong-scope", effectId: "effect-1", outcome: "performed", revision: 5,
    lifecycleId: "life-other",
  }));
  assert.throws(() => insertReceipt(db, {
    id: "receipt-2-early", effectId: "effect-2", outcome: "performed", revision: 5,
  }));
  insertReceipt(db, { id: "receipt-1", effectId: "effect-1", outcome: "performed", revision: 5 });
  insertReceipt(db, { id: "receipt-2", effectId: "effect-2", outcome: "recognized", revision: 6 });
  assert.throws(() => db.exec(
    "UPDATE workflow_settlement_receipts SET proof_hash = 'changed' WHERE settlement_receipt_id = 'receipt-1'",
  ));
  assert.throws(() => db.exec(
    "DELETE FROM workflow_settlement_receipts WHERE settlement_receipt_id = 'receipt-1'",
  ));

  insertCloseoutPlan(db, {
    id: "plan-2", attemptId: "attempt-2", revision: 11, supersedes: "plan-1",
  });
  insertEffect(db, { id: "effect-4", planId: "plan-2", ordinal: 1, key: "publish", revision: 11 });
  assert.throws(() => insertReceipt(db, {
    id: "late-old-receipt", effectId: "effect-3", outcome: "recognized", revision: 12,
  }));

  const reopened = reopenRaw(dbPath, db);
  t.after(() => { if (reopened.isOpen) reopened.close(); });
  assert.equal(reopened.prepare(`
    SELECT MIN(effect.ordinal) AS ordinal
    FROM workflow_closeout_effects effect
    LEFT JOIN workflow_settlement_receipts receipt
      ON receipt.closeout_effect_id = effect.closeout_effect_id
    WHERE effect.closeout_plan_id = 'plan-2' AND receipt.settlement_receipt_id IS NULL
  `).get()?.ordinal, 1);
});

test("v34 upgrade backs up, rolls back a fault, and retries without losing legacy rows", (t) => {
  assert.ok(SCHEMA_VERSION >= 35);
  const dbPath = createDatabasePath(t);
  rewindToV34(t, dbPath);
  const before = openRawDatabase(dbPath);
  before.exec(`
    INSERT OR IGNORE INTO decisions (
      id, when_context, scope, decision, choice, rationale, revisable, made_by, source
    ) VALUES ('D-V34', 'upgrade', 'project', 'Preserve me', 'yes', 'legacy row', 'yes', 'user', 'discussion')
  `);
  before.close();

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault/i);
  closeDatabase();
  _setMigrationFaultForTest(false);

  const backupPath = `${dbPath}.backup-v34`;
  const faultBackup = openRawDatabase(backupPath);
  assert.equal(maxSchemaVersion(faultBackup), 34);
  for (const table of V35_TABLES) assert.equal(tableExists(faultBackup, table), false);
  assert.equal(faultBackup.prepare("SELECT choice FROM decisions WHERE id = 'D-V34'").get()?.choice, "yes");
  assert.equal(faultBackup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  faultBackup.close();

  const rolledBack = openRawDatabase(dbPath);
  assert.equal(maxSchemaVersion(rolledBack), 34);
  for (const table of V35_TABLES) assert.equal(tableExists(rolledBack, table), false);
  assert.equal(rolledBack.prepare("SELECT choice FROM decisions WHERE id = 'D-V34'").get()?.choice, "yes");
  assert.equal(rolledBack.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  rolledBack.close();

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const upgraded = openRawDatabase(dbPath);
  t.after(() => { if (upgraded.isOpen) upgraded.close(); });
  assert.equal(maxSchemaVersion(upgraded), SCHEMA_VERSION);
  for (const table of V35_TABLES) {
    assert.equal(tableExists(upgraded, table), true);
    assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
  }
  assert.equal(upgraded.prepare("SELECT choice FROM decisions WHERE id = 'D-V34'").get()?.choice, "yes");
  assert.equal(upgraded.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  upgraded.close();

  const restoredPath = join(dirname(dbPath), "restored-backup.db");
  copyFileSync(backupPath, restoredPath);
  assert.equal(openDatabase(restoredPath), true);
  closeDatabase();
  const restored = openRawDatabase(restoredPath);
  t.after(() => { if (restored.isOpen) restored.close(); });
  assert.equal(maxSchemaVersion(restored), SCHEMA_VERSION);
  for (const table of V35_TABLES) {
    assert.equal(tableExists(restored, table), true);
    assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
  }
  assert.equal(restored.prepare("SELECT choice FROM decisions WHERE id = 'D-V34'").get()?.choice, "yes");
  assert.equal(restored.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
});
