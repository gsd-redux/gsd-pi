// Project/App: gsd-pi
// File Purpose: Executable v45 receipt contract for authority cutover and import recovery.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  SCHEMA_VERSION,
  _setMigrationFaultForTest,
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";

const tempDirs = new Set<string>();
const HASH = `sha256:${"1".repeat(64)}`;
const OTHER_HASH = `sha256:${"2".repeat(64)}`;

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "gsd-authority-recovery-schema-"));
  tempDirs.add(directory);
  return join(directory, "gsd.db");
}

function tableColumns(table: string): string[] {
  const database = _getAdapter();
  assert.ok(database);
  return database.prepare(`PRAGMA table_info(${table})`).all()
    .map((column) => String(column["name"]));
}

function database(): NonNullable<ReturnType<typeof _getAdapter>> {
  const value = _getAdapter();
  assert.ok(value);
  return value;
}

function projectId(): string {
  return String(database().prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.["project_id"]);
}

function insertOperation(input: {
  id: string;
  type: string;
  expectedRevision: number;
  expectedEpoch: number;
  advanceEpoch?: boolean;
  createdAt: string;
  requestHash?: string;
}): void {
  database().prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 'test', ?, ?)
  `).run(
    input.id,
    projectId(),
    input.type,
    `key/${input.id}`,
    input.expectedRevision,
    input.expectedRevision + 1,
    input.expectedEpoch,
    input.expectedEpoch + (input.advanceEpoch ? 1 : 0),
    input.requestHash ?? HASH,
    input.createdAt,
  );
}

function insertCutover(operationType = "authority.cutover"): void {
  insertOperation({
    id: "cutover-op",
    type: operationType,
    expectedRevision: 0,
    expectedEpoch: 0,
    advanceEpoch: true,
    createdAt: "2026-07-17T01:00:00.000Z",
  });
  database().prepare(`
    INSERT INTO workflow_authority_cutovers (
      operation_id, project_id, authority_contract_version,
      evidence_hash, consent_hash, cutover_at,
      resulting_project_revision, resulting_authority_epoch
    ) VALUES ('cutover-op', ?, 1, ?, ?, '2026-07-17T01:00:00.000Z', 1, 1)
  `).run(projectId(), HASH, OTHER_HASH);
}

function restoreLineage(): string {
  return JSON.stringify({
    schemaVersion: 1,
    applicationOperationId: "erased-application-op",
    applicationIdentityHash: HASH,
    applicationResultingProjectRevision: 1,
    applicationResultingAuthorityEpoch: 0,
  });
}

function insertRestore(operationType = "import.restore"): void {
  insertOperation({
    id: "restore-op",
    type: operationType,
    expectedRevision: 0,
    expectedEpoch: 0,
    createdAt: "2026-07-17T02:00:00.000Z",
  });
  database().prepare(`
    INSERT INTO workflow_import_restores (
      operation_id, project_id,
      application_operation_id, application_identity_hash,
      application_resulting_project_revision, application_resulting_authority_epoch,
      erased_lineage_hash, erased_lineage_json,
      preview_id, preview_hash,
      backup_id, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch,
      difference_hash, consent_hash, verification_hash,
      restored_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      'restore-op', ?, 'erased-application-op', ?, 1, 0, ?, ?,
      'preview-1', ?, ?, ?, 4096, 45, 0, 0, ?, ?, ?,
      '2026-07-17T02:00:00.000Z', 1, 0
    )
  `).run(
    projectId(),
    HASH,
    OTHER_HASH,
    restoreLineage(),
    HASH,
    OTHER_HASH,
    HASH,
    OTHER_HASH,
    HASH,
    OTHER_HASH,
  );
}

function seedApplication(): void {
  const preview = {
    preview_schema_version: 1,
    preview_id: "preview-1",
    import_kind: "legacy-markdown",
    importer_version: "1",
    base_project_revision: 0,
    base_authority_epoch: 0,
    base_database_schema_version: 45,
    source_set_hash: OTHER_HASH,
    change_set_hash: HASH,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  };
  insertOperation({
    id: "application-op",
    type: "import.apply",
    expectedRevision: 0,
    expectedEpoch: 0,
    createdAt: "2026-07-17T03:00:00.000Z",
    requestHash: HASH,
  });
  database().prepare(`
    INSERT INTO workflow_import_applications (
      operation_id, project_id, import_kind, importer_version,
      preview_schema_version, preview_id, preview_hash,
      base_project_revision, base_authority_epoch, base_database_schema_version,
      source_set_hash, change_set_hash,
      create_count, update_count, delete_count, preserve_count, unparsed_count, unresolved_count,
      preview_json,
      backup_ref, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch, backup_quick_check, backup_verified_at,
      applied_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      'application-op', ?, 'legacy-markdown', '1',
      1, 'preview-1', ?, 0, 0, 45, ?, ?,
      0, 0, 0, 0, 0, 0, ?,
      'backup.sqlite', ?, 4096, 45, 0, 0, 'ok', '2026-07-17T02:59:00.000Z',
      '2026-07-17T03:00:00.000Z', 1, 0
    )
  `).run(projectId(), HASH, OTHER_HASH, HASH, JSON.stringify(preview), OTHER_HASH);
  database().prepare(`
    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
    ) VALUES (
      'application-event', 'application-op', 0, ?, 1, 0,
      'legacy-import.applied', 'legacy-import', 'preview-1', ?,
      '2026-07-17T03:00:00.000Z'
    )
  `).run(projectId(), JSON.stringify({ applicationIdentityHash: HASH, backupId: OTHER_HASH }));
}

function repairPlan(applicationIdentityHash = HASH): string {
  return JSON.stringify({
    planSchemaVersion: 1,
    applicationOperationId: "application-op",
    applicationIdentityHash,
    previewId: "preview-1",
    previewHash: HASH,
    backupId: OTHER_HASH,
    differenceHash: HASH,
    targetCount: 3,
    mutationCount: 1,
    preservedCount: 1,
    rejectedCount: 1,
    unresolvedCount: 0,
  });
}

function insertForwardRepair(applicationIdentityHash = HASH): void {
  insertOperation({
    id: "repair-op",
    type: "import.forward_repair",
    expectedRevision: 1,
    expectedEpoch: 0,
    createdAt: "2026-07-17T04:00:00.000Z",
  });
  database().prepare(`
    INSERT INTO workflow_import_forward_repairs (
      operation_id, project_id, application_operation_id, application_identity_hash,
      preview_id, preview_hash, backup_id, difference_hash,
      plan_schema_version, plan_hash, plan_json,
      target_count, mutation_count, preserved_count, rejected_count, unresolved_count,
      repaired_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      'repair-op', ?, 'application-op', ?, 'preview-1', ?, ?, ?,
      1, ?, ?, 3, 1, 1, 1, 0, '2026-07-17T04:00:00.000Z', 2, 0
    )
  `).run(
    projectId(),
    applicationIdentityHash,
    HASH,
    OTHER_HASH,
    HASH,
    OTHER_HASH,
    repairPlan(applicationIdentityHash),
  );
}

afterEach(() => {
  _setMigrationFaultForTest(false);
  closeDatabase();
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

test("a fresh current-schema database exposes the minimum authority recovery receipts", () => {
  assert.equal(openDatabase(databasePath()), true);
  assert.deepEqual(tableColumns("workflow_authority_cutovers"), [
    "operation_id",
    "project_id",
    "authority_contract_version",
    "evidence_hash",
    "consent_hash",
    "cutover_at",
    "resulting_project_revision",
    "resulting_authority_epoch",
  ]);
  assert.deepEqual(tableColumns("workflow_import_restores"), [
    "operation_id",
    "project_id",
    "application_operation_id",
    "application_identity_hash",
    "application_resulting_project_revision",
    "application_resulting_authority_epoch",
    "erased_lineage_hash",
    "erased_lineage_json",
    "preview_id",
    "preview_hash",
    "backup_id",
    "backup_sha256",
    "backup_byte_size",
    "backup_schema_version",
    "backup_project_revision",
    "backup_authority_epoch",
    "difference_hash",
    "consent_hash",
    "verification_hash",
    "restored_at",
    "resulting_project_revision",
    "resulting_authority_epoch",
  ]);
  assert.deepEqual(tableColumns("workflow_import_forward_repairs"), [
    "operation_id",
    "project_id",
    "application_operation_id",
    "application_identity_hash",
    "preview_id",
    "preview_hash",
    "backup_id",
    "difference_hash",
    "plan_schema_version",
    "plan_hash",
    "plan_json",
    "target_count",
    "mutation_count",
    "preserved_count",
    "rejected_count",
    "unresolved_count",
    "repaired_at",
    "resulting_project_revision",
    "resulting_authority_epoch",
  ]);
});

test("cutover receipts require one exact epoch-advancing operation and are immutable", () => {
  assert.equal(openDatabase(databasePath()), true);
  database().exec("BEGIN");
  assert.throws(() => insertCutover("milestone.describe"), /cutover.*operation/i);
  database().exec("ROLLBACK");

  insertCutover();
  assert.deepEqual(database().prepare(`
    SELECT authority_contract_version, resulting_project_revision, resulting_authority_epoch
    FROM workflow_authority_cutovers
  `).get(), {
    authority_contract_version: 1,
    resulting_project_revision: 1,
    resulting_authority_epoch: 1,
  });
  assert.throws(
    () => database().prepare("UPDATE workflow_authority_cutovers SET authority_contract_version = 2").run(),
    /cutovers are immutable/i,
  );
  assert.throws(
    () => database().prepare("DELETE FROM workflow_authority_cutovers").run(),
    /cutovers are immutable/i,
  );
  assert.throws(
    () => database().prepare("UPDATE workflow_operations SET request_hash = ? WHERE operation_id = 'cutover-op'").run(OTHER_HASH),
    /recovery operations are immutable/i,
  );
});

test("restore receipts retain erased Application lineage without a live Application foreign key", () => {
  assert.equal(openDatabase(databasePath()), true);
  database().exec("BEGIN");
  assert.throws(() => insertRestore("fixture.wrong"), /restore.*Application lineage/i);
  database().exec("ROLLBACK");

  insertRestore();
  assert.deepEqual(database().prepare(`
    SELECT application_operation_id, application_resulting_project_revision,
           backup_project_revision, resulting_project_revision, resulting_authority_epoch
    FROM workflow_import_restores
  `).get(), {
    application_operation_id: "erased-application-op",
    application_resulting_project_revision: 1,
    backup_project_revision: 0,
    resulting_project_revision: 1,
    resulting_authority_epoch: 0,
  });
  assert.equal(database().prepare(`
    SELECT count(*) AS count FROM workflow_operations
    WHERE operation_id = 'erased-application-op'
  `).get()?.["count"], 0);
  assert.throws(
    () => database().prepare("UPDATE workflow_import_restores SET backup_byte_size = 8192").run(),
    /restores are immutable/i,
  );
  assert.throws(
    () => database().prepare("DELETE FROM workflow_import_restores").run(),
    /restores are immutable/i,
  );
});

test("Forward Repair receipts require the retained exact Application and complete accounting", () => {
  assert.equal(openDatabase(databasePath()), true);
  seedApplication();
  database().exec("BEGIN");
  assert.throws(() => insertForwardRepair(OTHER_HASH), /Forward Repair.*Application/i);
  database().exec("ROLLBACK");

  database().prepare(`
    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
    ) VALUES (
      'forged-application-event', 'application-op', 1, ?, 1, 0,
      'legacy-import.applied', 'legacy-import', 'preview-1', ?,
      '2026-07-17T03:00:01.000Z'
    )
  `).run(projectId(), JSON.stringify({ applicationIdentityHash: OTHER_HASH, backupId: OTHER_HASH }));
  database().exec("BEGIN");
  assert.throws(() => insertForwardRepair(OTHER_HASH), /Forward Repair.*Application/i);
  database().exec("ROLLBACK");

  insertForwardRepair();
  assert.deepEqual(database().prepare(`
    SELECT target_count, mutation_count, preserved_count, rejected_count, unresolved_count,
           resulting_project_revision, resulting_authority_epoch
    FROM workflow_import_forward_repairs
  `).get(), {
    target_count: 3,
    mutation_count: 1,
    preserved_count: 1,
    rejected_count: 1,
    unresolved_count: 0,
    resulting_project_revision: 2,
    resulting_authority_epoch: 0,
  });
  assert.throws(
    () => database().prepare("UPDATE workflow_import_forward_repairs SET rejected_count = 0").run(),
    /Forward Repairs are immutable/i,
  );
  assert.throws(
    () => database().prepare("DELETE FROM workflow_import_forward_repairs").run(),
    /Forward Repairs are immutable/i,
  );
});

function createGenuineV44Database(path: string): void {
  assert.equal(openDatabase(path), true);
  database().prepare(
    "INSERT INTO milestones (id, title, status, created_at) VALUES ('M045', 'Preserved', 'active', 'created')",
  ).run();
  closeDatabase();
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`
      DROP TRIGGER IF EXISTS trg_workflow_authority_recovery_operation_update;
      DROP TABLE workflow_import_forward_repairs;
      DROP TABLE workflow_import_restores;
      DROP TABLE workflow_authority_cutovers;
      DELETE FROM schema_version WHERE version >= 45;
      INSERT OR IGNORE INTO schema_version (version, applied_at)
      VALUES (44, '2026-07-17T00:00:00.000Z');
    `);
  } finally {
    raw.close();
  }
}

function rawSchemaVersion(path: string): number {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(raw.prepare("SELECT max(version) AS version FROM schema_version").get()?.version);
  } finally {
    raw.close();
  }
}

function rawAuthorityRecoveryObjects(path: string): string[] {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN (
        'workflow_authority_cutovers',
        'workflow_import_restores',
        'workflow_import_forward_repairs'
      ) OR name LIKE 'trg_workflow_authority_%'
        OR name LIKE 'trg_workflow_import_restore_%'
        OR name LIKE 'trg_workflow_import_forward_repair_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
  } finally {
    raw.close();
  }
}

test("a genuine v44 migration backs up, rolls back on fault, and retries without data loss", () => {
  const path = databasePath();
  createGenuineV44Database(path);
  assert.equal(rawSchemaVersion(path), 44);

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(path), /migration fault injected/i);
  _setMigrationFaultForTest(false);
  assert.equal(rawSchemaVersion(path), 44);
  assert.deepEqual(rawAuthorityRecoveryObjects(path), []);
  assert.equal(existsSync(`${path}.backup-v44`), true);
  assert.equal(rawSchemaVersion(`${path}.backup-v44`), 44);

  assert.equal(openDatabase(path), true);
  assert.equal(tableColumns("workflow_import_restores").length > 0, true);
  assert.equal(database().prepare(
    "SELECT title FROM milestones WHERE id = 'M045'",
  ).get()?.["title"], "Preserved");
  insertCutover();
  assert.throws(
    () => database().prepare(
      "UPDATE workflow_authority_cutovers SET authority_contract_version = 2",
    ).run(),
    /cutovers are immutable/i,
  );
  closeDatabase();
  assert.equal(rawSchemaVersion(path), SCHEMA_VERSION);

  const restoredPath = join(path.slice(0, path.lastIndexOf("/")), "restored-v44.db");
  copyFileSync(`${path}.backup-v44`, restoredPath);
  assert.equal(openDatabase(restoredPath), true);
  assert.equal(tableColumns("workflow_authority_cutovers").length > 0, true);
});
