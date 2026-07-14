// Project/App: gsd-pi
// File Purpose: Executable contract for Task verification recovery trigger migrations.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DbAdapter } from "../db-adapter.ts";
import { createRecoveryEvidenceFoundationSchemaV34 } from "../db-recovery-evidence-foundation-schema.ts";
import { createTaskVerificationRecoverySchemaV38 } from "../db-task-verification-recovery-schema.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "gsd-verification-recovery-"));
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
  insertOperation(db, 6, "verification.supersede");
  insertOperation(db, 7, "recovery.observe.current-head");

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

function insertEvidence(
  db: RawDb,
  verdictId = "verdict-1",
  sourceRevision = "sha256:tested-source",
  operationRevision = 4,
  observation: "failed" | "inconclusive" | "passed" = "failed",
): void {
  db.prepare(`
    INSERT INTO workflow_verification_evidence (
      evidence_id, project_id, verdict_id, criterion_id, lifecycle_id, attempt_id,
      evidence_class, command_or_tool, working_directory, started_at, ended_at,
      exit_code, observation, source_revision, observed_project_revision,
      content_hash, durable_output_ref, environment_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, 'criterion-1', 'life-task', 'attempt-1',
      'command', 'npm test', '/tmp/project',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:01.000Z',
      ?, ?, ?, 3,
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'db://verification-evidence', '{"runner":"node-test"}', '', ?, ?, 0)
  `).run(
    `evidence-${verdictId}`,
    projectId(db),
    verdictId,
    observation === "passed" ? 0 : 1,
    observation,
    sourceRevision,
    `op-${operationRevision}`,
    operationRevision,
  );
}

function insertVerifyFailure(db: RawDb, operationRevision = 5): void {
  db.prepare(`
    INSERT INTO workflow_failure_observations (
      failure_observation_id, project_id, lifecycle_id, attempt_id, result_id,
      recovery_owner, boundary_stage, failure_kind, failure_fingerprint,
      summary, evidence_json, observed_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('failure-1', ?, 'life-task', 'attempt-1', 'result-1',
      'agent', 'verify', 'verification-failed', 'verification-failed:host',
      'Host verification did not pass', '{}', '', ?, ?, 0)
  `).run(projectId(db), `op-${operationRevision}`, operationRevision);
}

function insertVerificationRecoveryRoute(db: RawDb): void {
  db.prepare(`
    INSERT INTO workflow_kernel_checkpoints (
      kernel_checkpoint_id, project_id, lifecycle_id, attempt_id,
      next_stage, sequence, previous_kernel_checkpoint_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES
      ('kernel-execute-1', ?, 'life-task', 'attempt-1',
       'execute', 1, NULL, '2026-07-13T00:00:00.000Z', 'op-1', 1, 0),
      ('kernel-verify-1', ?, 'life-task', 'attempt-1',
       'verify', 2, 'kernel-execute-1', '2026-07-13T00:00:01.000Z', 'op-2', 2, 0),
      ('kernel-route-1', ?, 'life-task', 'attempt-1',
       'route', 3, 'kernel-verify-1', '2026-07-13T00:00:02.000Z', 'op-4', 4, 0)
  `).run(projectId(db), projectId(db), projectId(db));
  insertVerifyFailure(db);
  db.prepare(`
    INSERT INTO workflow_recovery_budgets (
      recovery_budget_id, project_id, lifecycle_id,
      failure_kind, failure_fingerprint, policy_class,
      max_uses, policy_version, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('budget-1', ?, 'life-task',
      'verification-failed', 'verification-failed:host', 'remediation',
      2, '1', '', 'op-5', 5, 0)
  `).run(projectId(db));
  db.prepare(`
    INSERT INTO workflow_recovery_actions (
      recovery_action_id, project_id, lifecycle_id,
      failure_observation_id, action, recovery_budget_id,
      target_lifecycle_id, rationale, policy_version, selected_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('recovery-1', ?, 'life-task',
      'failure-1', 'remediate', 'budget-1',
      'life-task', 'Repair the failed verification', '1', '',
      'op-5', 5, 0)
  `).run(projectId(db));
}

function insertSuccessorAttempt(db: RawDb): void {
  insertOperation(db, 8, "attempt.claim");
  db.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number,
      retry_of_attempt_id, attempt_state, claimed_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch
    ) VALUES ('attempt-2', ?, 'life-task', 2,
      'attempt-1', 'claimed', '', 'op-8', 8, 0)
  `).run(projectId(db));
}

function supersedeVerdictWithPass(db: RawDb): void {
  db.prepare(`
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      supersedes_verdict_id, created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('verdict-2', ?, 'criterion-1', 'life-task', 'attempt-1',
      'sha256:tested-source', 'pass', 'host-verification', '1', 'Human review passed',
      'verdict-1', '', 'op-6', 6, 0)
  `).run(projectId(db));
  insertEvidence(db, "verdict-2", "sha256:tested-source", 6, "passed");
}

function recordNewerSourcePass(db: RawDb): void {
  db.prepare(`
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('verdict-2', ?, 'criterion-1', 'life-task', 'attempt-1',
      'sha256:newer-source', 'pass', 'host-verification', '1', 'New source passed',
      '', 'op-6', 6, 0)
  `).run(projectId(db));
  insertEvidence(db, "verdict-2", "sha256:newer-source", 6, "passed");
}

function supersedeCriterion(db: RawDb): void {
  db.prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id,
      criterion_kind, evidence_class, required, description,
      supersedes_criterion_id, created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('criterion-2', 'task-host-verification', ?, 'life-task',
      'technical', 'command', 1, 'Updated host verification must pass',
      'criterion-1', '', 'op-6', 6, 0)
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

function rewindToV38(db: RawDb): void {
  db.exec("DROP TRIGGER IF EXISTS trg_workflow_attempt_route_authority_v39");
  createTaskVerificationRecoverySchemaV38(db as unknown as DbAdapter);
  db.exec(`
    DELETE FROM schema_version;
    INSERT INTO schema_version (version, applied_at) VALUES (38, '');
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
  test(`current schema accepts a succeeded Result with ${article} ${verdict} Technical Verdict at verify`, (t) => {
    const { db } = createCurrentFixture();
    t.after(() => db.close());
    insertVerdict(db, verdict);
    insertEvidence(
      db,
      "verdict-1",
      "sha256:tested-source",
      4,
      verdict === "fail" ? "failed" : "inconclusive",
    );
    assert.doesNotThrow(() => insertVerifyFailure(db));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
      1,
    );
  });
}

for (const verdict of ["fail", "inconclusive"] as const) {
  test(`current schema rejects verify recovery with an evidence-less ${verdict} verdict`, (t) => {
    const { db } = createCurrentFixture();
    t.after(() => db.close());
    insertVerdict(db, verdict);
    assert.throws(
      () => insertVerifyFailure(db),
      /failed or interrupted result.*current Technical Verdict/i,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
      0,
    );
  });
}

test("current schema ignores an evidence-less newer verdict when selecting the current head", (t) => {
  const { db } = createCurrentFixture();
  t.after(() => db.close());
  insertVerdict(db, "fail");
  insertEvidence(db);
  db.prepare(`
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES ('verdict-2', ?, 'criterion-1', 'life-task', 'attempt-1',
      'sha256:newer-source', 'pass', 'host-verification', '1', 'Orphan newer verdict',
      '', 'op-6', 6, 0)
  `).run(projectId(db));

  assert.doesNotThrow(() => insertVerifyFailure(db, 7));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
    1,
  );
});

for (const verdict of [null, "pass"] as const) {
  const label = verdict ?? "no";
  test(`current schema rejects verify recovery with ${label} Technical Verdict`, (t) => {
    const { db } = createCurrentFixture();
    t.after(() => db.close());
    if (verdict) insertVerdict(db, verdict);
    assert.throws(
      () => insertVerifyFailure(db),
      /failed or interrupted result.*causal Task boundary/i,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
      0,
    );
  });
}

const staleHeadCases = [
  { label: "a superseded failing verdict", prepare: supersedeVerdictWithPass },
  { label: "a verdict on a superseded criterion", prepare: supersedeCriterion },
  { label: "an older failing verdict for a different source revision", prepare: recordNewerSourcePass },
] as const;

for (const staleHead of staleHeadCases) {
  test(`current schema rejects verify recovery authorized only by ${staleHead.label}`, (t) => {
    const { db } = createCurrentFixture();
    t.after(() => db.close());
    insertVerdict(db, "fail");
    insertEvidence(db);
    staleHead.prepare(db);
    assert.throws(
      () => insertVerifyFailure(db, 7),
      /failed or interrupted result.*current Technical Verdict/i,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
      0,
    );
  });
}

test("v38 evidence-less verification route cannot authorize a successor after v39 upgrade", (t) => {
  const { dbPath, db } = createCurrentFixture();
  let fixtureDb: RawDb | undefined = db;
  t.after(() => fixtureDb?.close());
  rewindToV38(db);
  insertVerdict(db, "fail");
  insertVerificationRecoveryRoute(db);
  db.close();
  fixtureDb = undefined;

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const upgraded = openRawDatabase(dbPath);
  t.after(() => upgraded.close());

  assert.throws(
    () => insertSuccessorAttempt(upgraded),
    /current causal recovery authority/i,
  );
  assert.equal(
    upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.["count"],
    1,
  );
  assert.equal(
    upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_recovery_actions").get()?.["count"],
    1,
  );
});

for (const staleHead of staleHeadCases) {
  test(`v38 retained route authorized only by ${staleHead.label} cannot claim after v39 upgrade`, (t) => {
    const { dbPath, db } = createCurrentFixture();
    let fixtureDb: RawDb | undefined = db;
    t.after(() => fixtureDb?.close());
    rewindToV38(db);
    insertVerdict(db, "fail");
    insertEvidence(db);
    insertVerificationRecoveryRoute(db);
    staleHead.prepare(db);
    db.close();
    fixtureDb = undefined;

    assert.equal(openDatabase(dbPath), true);
    closeDatabase();
    const upgraded = openRawDatabase(dbPath);
    t.after(() => upgraded.close());

    assert.throws(
      () => insertSuccessorAttempt(upgraded),
      /current causal recovery authority/i,
    );
    assert.equal(
      upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.["count"],
      1,
    );
    assert.equal(
      upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
      1,
    );
    assert.equal(
      upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_recovery_actions").get()?.["count"],
      1,
    );
  });
}

test("v38 current evidence-backed verification route still authorizes one v39 successor", (t) => {
  const { dbPath, db } = createCurrentFixture();
  let fixtureDb: RawDb | undefined = db;
  t.after(() => fixtureDb?.close());
  rewindToV38(db);
  insertVerdict(db, "fail");
  insertEvidence(db);
  insertVerificationRecoveryRoute(db);
  db.close();
  fixtureDb = undefined;

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const upgraded = openRawDatabase(dbPath);
  t.after(() => upgraded.close());

  assert.doesNotThrow(() => insertSuccessorAttempt(upgraded));
  assert.equal(
    upgraded.prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.["count"],
    2,
  );
});

for (const staleHead of staleHeadCases) {
  test(`v38 database upgrades to reject verify recovery authorized only by ${staleHead.label}`, (t) => {
    const { dbPath, db } = createCurrentFixture();
    let fixtureDb: RawDb | undefined = db;
    t.after(() => fixtureDb?.close());
    insertVerdict(db, "fail");
    insertEvidence(db);
    staleHead.prepare(db);
    rewindToV38(db);
    db.close();
    fixtureDb = undefined;

    assert.equal(openDatabase(dbPath), true);
    closeDatabase();
    const upgraded = openRawDatabase(dbPath);
    t.after(() => upgraded.close());
    assert.equal(schemaVersion(upgraded), SCHEMA_VERSION);
    assert.throws(
      () => insertVerifyFailure(upgraded, 7),
      /failed or interrupted result.*current Technical Verdict/i,
    );
  });
}

test("faulted verification recovery migration chain rolls back and retries cleanly", (t) => {
  const { dbPath, db } = createCurrentFixture();
  let fixtureDb: RawDb | undefined = db;
  t.after(() => fixtureDb?.close());
  insertVerdict(db, "fail");
  insertEvidence(db);
  rewindToV37(db);
  db.close();
  fixtureDb = undefined;

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  let rolledBackOpen = true;
  t.after(() => {
    if (rolledBackOpen) rolledBack.close();
  });
  assert.equal(schemaVersion(rolledBack), 37);
  assert.throws(() => insertVerifyFailure(rolledBack), /matching failed or interrupted result/i);
  rolledBack.close();
  rolledBackOpen = false;

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  t.after(() => retried.close());
  assert.equal(schemaVersion(retried), SCHEMA_VERSION);
  assert.doesNotThrow(() => insertVerifyFailure(retried));
  assert.equal(
    retried.prepare("SELECT COUNT(*) AS count FROM workflow_failure_observations").get()?.["count"],
    1,
  );
});
