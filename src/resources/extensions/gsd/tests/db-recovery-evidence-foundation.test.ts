// Project/App: gsd-pi
// File Purpose: Executable contract for the additive v34 recovery and verification foundation.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  _setMigrationFaultForTest,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";

const require = createRequire(import.meta.url);
const tempDirs = new Set<string>();
const V34_TABLES = [
  "workflow_failure_observations",
  "workflow_recovery_budgets",
  "workflow_recovery_actions",
  "workflow_acceptance_criteria",
  "workflow_verification_evidence",
  "workflow_technical_verdicts",
  "workflow_human_acceptances",
  "workflow_remediation_links",
] as const;
const V35_TABLES = [
  "workflow_projection_work",
  "workflow_import_applications",
  "workflow_kernel_checkpoints",
  "workflow_closeout_plans",
  "workflow_closeout_effects",
  "workflow_settlement_receipts",
] as const;
const V34_PARENT_INDEXES = [
  "idx_workflow_attempt_scope_v34",
  "idx_workflow_result_scope_v34",
  "idx_workflow_blocker_scope_v34",
] as const;

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

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-recovery-evidence-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function tableExists(db: RawDb, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function indexExists(db: RawDb, index: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(index));
}

function maxSchemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version);
}

function projectId(db: RawDb): string {
  return String(db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.project_id);
}

function seedLegacyRows(db: RawDb): void {
  db.exec(`
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES
      ('M-RECOVERY', 'Recovery foundation', 'active', '2026-07-12T00:00:00.000Z'),
      ('M-OTHER', 'Other scope', 'active', '2026-07-12T00:00:00.000Z');
    INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M-OTHER', 'S01', 'Remediation slice', 'pending', '');
    INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M-OTHER', 'S01', 'T01', 'Repair the finding', 'pending');
    INSERT OR IGNORE INTO decisions (
      id, when_context, scope, decision, choice, rationale, revisable,
      made_by, source, superseded_by
    ) VALUES (
      'D-LEGACY', 'legacy', 'project', 'Preserve legacy meaning', 'yes',
      'No additive migration may reinterpret this row', 'yes',
      'user', 'discussion', NULL
    );
  `);
}

function insertOperation(db: RawDb, revision: number): string {
  const operationId = `op-${revision}`;
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, actor_id, source_transport, request_hash, created_at
    ) VALUES (?, ?, 'attempt.settle', ?, ?, ?, 0, 0, 'user', 'developer', 'test', ?, ?)
  `).run(
    operationId,
    projectId(db),
    `key-${operationId}`,
    revision - 1,
    revision,
    `hash-${operationId}`,
    `2026-07-12T00:00:${String(revision).padStart(2, "0")}.000Z`,
  );
  return operationId;
}

function insertOperations(db: RawDb, count: number): void {
  for (let revision = 1; revision <= count; revision += 1) insertOperation(db, revision);
}

function insertLifecycle(db: RawDb, lifecycleId: string, milestoneId: string, revision: number): void {
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
      created_at, updated_at, last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, 'milestone', ?, 'in_progress', '', '', ?, ?, 0)
  `).run(lifecycleId, projectId(db), milestoneId, `op-${revision}`, revision);
}

function insertTaskLifecycle(db: RawDb, lifecycleId: string, revision: number): void {
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, 'task', 'M-OTHER', 'S01', 'T01', 'in_progress', '', '', ?, ?, 0)
  `).run(lifecycleId, projectId(db), `op-${revision}`, revision);
}

function insertSettledAttempt(
  db: RawDb,
  input: { attemptId: string; lifecycleId: string; claimRevision: number; settleRevision: number; outcome: string },
): string {
  db.prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
      claimed_at, claim_operation_id, claim_project_revision, claim_authority_epoch
    ) VALUES (?, ?, ?, 1, 'claimed', '', ?, ?, 0)
  `).run(input.attemptId, projectId(db), input.lifecycleId, `op-${input.claimRevision}`, input.claimRevision);
  db.prepare(`
    UPDATE workflow_execution_attempts
    SET attempt_state = 'settled', ended_at = '2026-07-12T00:01:00.000Z',
        settle_outcome = ?,
        settle_operation_id = ?, settle_project_revision = ?, settle_authority_epoch = 0
    WHERE attempt_id = ?
  `).run(input.outcome, `op-${input.settleRevision}`, input.settleRevision, input.attemptId);
  const resultId = `result-${input.attemptId}`;
  db.prepare(`
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome,
      failure_class, summary, output_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, 'settled result', '{}', '', ?, ?, 0)
  `).run(
    resultId,
    projectId(db),
    input.lifecycleId,
    input.attemptId,
    input.outcome,
    input.outcome === "succeeded" ? "none" : "test",
    `op-${input.settleRevision}`,
    input.settleRevision,
  );
  return resultId;
}

function insertFailure(
  db: RawDb,
  input: {
    id: string;
    lifecycleId: string;
    attemptId: string;
    resultId: string;
    revision: number;
    kind?: string;
    blockerId?: string;
    recoveryOwner?: string;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_failure_observations (
      failure_observation_id, project_id, lifecycle_id, attempt_id, result_id,
      blocker_id, recovery_owner, boundary_stage, failure_kind, failure_fingerprint, summary,
      evidence_json, observed_at, operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'execute', ?, 'provider-network:timeout',
      'Provider request timed out', '{}', '', ?, ?, 0)
  `).run(
    input.id,
    projectId(db),
    input.lifecycleId,
    input.attemptId,
    input.resultId,
    input.blockerId ?? null,
    input.recoveryOwner ?? "agent",
    input.kind ?? "provider-network",
    `op-${input.revision}`,
    input.revision,
  );
}

function insertBudget(db: RawDb, lifecycleId: string, revision: number): void {
  db.prepare(`
    INSERT INTO workflow_recovery_budgets (
      recovery_budget_id, project_id, lifecycle_id, failure_kind, failure_fingerprint,
      policy_class, max_uses, policy_version, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('budget-retry', ?, ?, 'provider-network', 'provider-network:timeout',
      'transient-execution', 2, 'recovery-v1', '', ?, ?, 0)
  `).run(projectId(db), lifecycleId, `op-${revision}`, revision);
}

function insertCriterion(
  db: RawDb,
  input: {
    id: string;
    lifecycleId: string;
    revision: number;
    criterionKey?: string;
    kind?: string;
    evidenceClass?: string;
    requirementId?: string | null;
    supersedesCriterionId?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
      criterion_kind, evidence_class,
      required, description, supersedes_criterion_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'Requested outcome is proven', ?, '', ?, ?, 0)
  `).run(
    input.id,
    input.criterionKey ?? input.id,
    projectId(db),
    input.lifecycleId,
    input.requirementId ?? null,
    input.kind ?? "technical",
    input.evidenceClass ?? "command",
    input.supersedesCriterionId ?? null,
    `op-${input.revision}`,
    input.revision,
  );
}

function insertEvidence(
  db: RawDb,
  input: {
    id: string;
    verdictId: string;
    criterionId: string;
    lifecycleId: string;
    attemptId: string;
    revision: number;
    sourceRevision?: string;
    observation?: string;
    exitCode?: number;
    contentHash?: string;
    environmentJson?: string;
    startedAt?: string;
    endedAt?: string;
    observedProjectRevision?: number;
  },
): void {
  db.prepare(`
    INSERT INTO workflow_verification_evidence (
      evidence_id, project_id, verdict_id, criterion_id, lifecycle_id, attempt_id, evidence_class,
      command_or_tool, working_directory, started_at, ended_at, exit_code,
      observation, source_revision, observed_project_revision, content_hash,
      durable_output_ref, environment_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, 'command', 'pnpm test', '/workspace', ?, ?, ?,
      ?, ?, ?, ?, 'artifact://test-output', ?, '', ?, ?, 0)
  `).run(
    input.id,
    projectId(db),
    input.verdictId,
    input.criterionId,
    input.lifecycleId,
    input.attemptId,
    input.startedAt ?? "2026-07-12T00:01:00.000Z",
    input.endedAt ?? "2026-07-12T00:02:00.000Z",
    input.exitCode ?? 0,
    input.observation ?? "passed",
    input.sourceRevision ?? "commit-current",
    input.observedProjectRevision ?? input.revision - 1,
    input.contentHash ?? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    input.environmentJson ?? '{"node":"26","platform":"test"}',
    `op-${input.revision}`,
    input.revision,
  );
}

function openFreshFixture(): { dbPath: string; db: RawDb } {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  seedLegacyRows(db);
  return { dbPath, db };
}

function rewindToV33(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    seedLegacyRows(db);
    for (const table of [...V35_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const table of [...V34_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const index of V34_PARENT_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec(`
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at)
      VALUES (33, '2026-07-12T00:00:00.000Z');
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

test("fresh v34 databases expose exactly the recovery and evidence tables and vocabularies", (t) => {
  assert.ok(SCHEMA_VERSION >= 34);
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    for (const table of V34_TABLES) assert.equal(tableExists(db, table), true, `${table} should exist`);
    for (const removedTable of [
      "workflow_technical_verdict_evidence",
      "workflow_verification_findings",
      "workflow_finding_work_links",
    ]) assert.equal(tableExists(db, removedTable), false, `${removedTable} should not exist`);
    insertOperations(db, 8);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    insertTaskLifecycle(db, "life-remediation", 1);
    const resultId = insertSettledAttempt(db, {
      attemptId: "attempt-1", lifecycleId: "life-recovery", claimRevision: 2,
      settleRevision: 3, outcome: "failed",
    });

    for (const [index, stage] of ["advance", "execute", "verify", "route", "closeout"].entries()) {
      db.exec("SAVEPOINT stage");
      db.prepare(`
        INSERT INTO workflow_failure_observations (
          failure_observation_id, project_id, lifecycle_id, attempt_id, result_id,
          recovery_owner, boundary_stage,
          failure_kind, failure_fingerprint, summary, evidence_json, observed_at,
          operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'life-recovery', ?, ?, 'agent', ?, 'runtime-unknown', ?,
          'Boundary failed', '{}', '', 'op-4', 4, 0)
      `).run(
        `failure-stage-${index}`,
        projectId(db),
        stage === "execute" ? "attempt-1" : null,
        stage === "execute" ? resultId : null,
        stage,
        `runtime-unknown:${index}`,
      );
      db.exec("ROLLBACK TO stage");
      db.exec("RELEASE stage");
    }
    for (const [index, kind] of [
      "tool-schema", "tool-contract", "tool-unavailable", "deterministic-policy",
      "lifecycle-progression", "stale-worker", "worktree-invalid", "verification-failed",
      "verification-drift", "reconciliation-drift", "illegal-transition", "provider-network",
      "provider-rate-limit", "provider-server", "provider-stream", "provider-connection",
      "provider-model-error", "provider-unsupported-model", "provider-permanent", "timeout",
      "interrupted", "closeout-effect", "projection", "runtime-unknown", "vendor-new-transient",
    ].entries()) {
      db.exec("SAVEPOINT kind");
      db.prepare(`
        INSERT INTO workflow_failure_observations (
          failure_observation_id, project_id, lifecycle_id, recovery_owner, boundary_stage,
          failure_kind, failure_fingerprint, summary, evidence_json, observed_at,
          operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'life-recovery', 'agent', 'verify', ?, ?,
          'Verification failed', '{}', '', 'op-4', 4, 0)
      `).run(`failure-kind-${index}`, projectId(db), kind, `${kind}:fingerprint`);
      db.exec("ROLLBACK TO kind");
      db.exec("RELEASE kind");
    }
    insertFailure(db, {
      id: "failure-route", lifecycleId: "life-recovery", attemptId: "attempt-1",
      resultId, revision: 4,
    });
    insertBudget(db, "life-recovery", 5);
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_recovery_actions (
        recovery_action_id, project_id, lifecycle_id, failure_observation_id,
        action, recovery_budget_id, rationale, policy_version, selected_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('retry-without-target', ?, 'life-recovery', 'failure-route',
        'retry', 'budget-retry', 'Retry requires an explicit target',
        'recovery-v1', '', 'op-6', 6, 0)
    `).run(projectId(db)), /CHECK constraint failed/);
    db.prepare(`
      INSERT INTO workflow_blockers (
        blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
        blocker_status, description, opened_at,
        opened_operation_id, opened_project_revision, opened_authority_epoch
      ) VALUES ('blocker-vocabulary', ?, 'life-recovery', 'missing_access', 'user',
        'open', 'Credential required', '', 'op-5', 5, 0)
    `).run(projectId(db));
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_failure_observations (
        failure_observation_id, project_id, lifecycle_id, recovery_owner,
        boundary_stage, failure_kind, failure_fingerprint, summary, evidence_json,
        observed_at, operation_id, project_revision, authority_epoch
      ) VALUES ('failure-user-without-blocker', ?, 'life-recovery', 'user',
        'route', 'tool-unavailable', 'tool-unavailable:no-blocker',
        'User route lacks a blocker', '{}', '', 'op-6', 6, 0)
    `).run(projectId(db)), /recovery owner|blocker|CHECK constraint failed/);
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_failure_observations (
        failure_observation_id, project_id, lifecycle_id, blocker_id, recovery_owner,
        boundary_stage, failure_kind, failure_fingerprint, summary, evidence_json,
        observed_at, operation_id, project_revision, authority_epoch
      ) VALUES ('failure-owner-mismatch', ?, 'life-recovery', 'blocker-vocabulary', 'external',
        'route', 'tool-unavailable', 'tool-unavailable:owner-mismatch',
        'Owner does not match blocker', '{}', '', 'op-6', 6, 0)
    `).run(projectId(db)), /recovery owner|matching open blocker/);
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_failure_observations (
        failure_observation_id, project_id, lifecycle_id, blocker_id, recovery_owner,
        boundary_stage, failure_kind, failure_fingerprint, summary, evidence_json,
        observed_at, operation_id, project_revision, authority_epoch
      ) VALUES ('failure-agent-with-blocker', ?, 'life-recovery', 'blocker-vocabulary', 'agent',
        'route', 'tool-unavailable', 'tool-unavailable:local-install',
        'Agent can repair the local tool', '{}', '', 'op-6', 6, 0)
    `).run(projectId(db)), /recovery owner|blocker|CHECK constraint failed/);
    for (const [index, action] of [
      "retry", "repair", "replan", "remediate", "clarify", "pause", "abort",
    ].entries()) {
      db.exec("SAVEPOINT action_kind");
      const observationId = action === "retry" ? "failure-route" : `failure-action-${index}`;
      const blockerId = ["clarify", "pause"].includes(action) ? "blocker-vocabulary" : null;
      if (action !== "retry") {
        db.prepare(`
          INSERT INTO workflow_failure_observations (
            failure_observation_id, project_id, lifecycle_id, blocker_id, recovery_owner,
            boundary_stage,
            failure_kind, failure_fingerprint, summary, evidence_json, observed_at,
            operation_id, project_revision, authority_epoch
          ) VALUES (?, ?, 'life-recovery', ?, ?, 'route', 'tool-unavailable', ?,
            'Routing failed', '{}', '', 'op-6', 6, 0)
        `).run(
          observationId,
          projectId(db),
          blockerId,
          blockerId === null ? "agent" : "user",
          `tool-unavailable:action-${index}`,
        );
      }
      let boundedPolicyClass: string | null = null;
      if (action === "repair") boundedPolicyClass = "deterministic-repair";
      if (action === "remediate") boundedPolicyClass = "remediation";
      const boundedBudgetId = boundedPolicyClass ? `budget-${action}` : null;
      if (boundedPolicyClass) {
        db.prepare(`
          INSERT INTO workflow_recovery_budgets (
            recovery_budget_id, project_id, lifecycle_id, failure_kind,
            failure_fingerprint, policy_class, max_uses, policy_version, created_at,
            operation_id, project_revision, authority_epoch
          ) VALUES (?, ?, 'life-recovery', 'tool-unavailable', ?, ?, 1,
            'recovery-v1', '', 'op-6', 6, 0)
        `).run(
          boundedBudgetId,
          projectId(db),
          `tool-unavailable:action-${index}`,
          boundedPolicyClass,
        );
      }
      let targetLifecycleId: string | null = null;
      if (["retry", "repair", "replan"].includes(action)) targetLifecycleId = "life-recovery";
      if (action === "remediate") targetLifecycleId = "life-remediation";
      db.prepare(`
        INSERT INTO workflow_recovery_actions (
          recovery_action_id, project_id, lifecycle_id, failure_observation_id,
          action, recovery_budget_id, target_lifecycle_id, blocker_id,
          rationale, policy_version, selected_at,
          operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'life-recovery', ?, ?, ?, ?, ?, 'Vocabulary proof',
          'recovery-v1', '', 'op-7', 7, 0)
      `).run(
        `action-${index}`, projectId(db), observationId, action,
        action === "retry" ? "budget-retry" : boundedBudgetId,
        targetLifecycleId,
        blockerId,
      );
      db.exec("ROLLBACK TO action_kind");
      db.exec("RELEASE action_kind");
    }
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_recovery_actions (
        recovery_action_id, project_id, lifecycle_id, failure_observation_id,
        action, rationale, policy_version, selected_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('action-invalid', ?, 'life-recovery', 'failure-route', 'escalate',
        'Not canonical', 'recovery-v1', '', 'op-8', 8, 0)
    `).run(projectId(db)), /CHECK constraint failed/);
    assert.throws(
      () => db.prepare(`UPDATE workflow_failure_observations SET failure_kind = 'unknown'
        WHERE failure_observation_id = 'failure-route'`).run(),
      /immutable|CHECK constraint failed/,
    );
  }
});

test("Failure Observations require matching failed Results and immutable normalized fingerprints", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 9);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    insertLifecycle(db, "life-other", "M-OTHER", 2);
    const failedResult = insertSettledAttempt(db, {
      attemptId: "attempt-failed", lifecycleId: "life-recovery", claimRevision: 3,
      settleRevision: 4, outcome: "failed",
    });
    const succeededResult = insertSettledAttempt(db, {
      attemptId: "attempt-success", lifecycleId: "life-other", claimRevision: 5,
      settleRevision: 6, outcome: "succeeded",
    });
    insertFailure(db, {
      id: "failure-valid", lifecycleId: "life-recovery", attemptId: "attempt-failed",
      resultId: failedResult, revision: 7,
    });
    assert.throws(() => insertFailure(db, {
      id: "failure-success", lifecycleId: "life-other", attemptId: "attempt-success",
      resultId: succeededResult, revision: 8,
    }), /failed|interrupted/);
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_failure_observations (
        failure_observation_id, project_id, lifecycle_id, recovery_owner, boundary_stage,
        failure_kind, failure_fingerprint, summary, evidence_json, observed_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('failure-bad-fingerprint', ?, 'life-recovery', 'agent', 'verify',
        'verification-failed', ' Not-Normalized ', '', '{}', '', 'op-8', 8, 0)
    `).run(projectId(db)), /fingerprint|CHECK constraint failed/);
    assert.throws(
      () => db.prepare("DELETE FROM workflow_failure_observations WHERE failure_observation_id = 'failure-valid'").run(),
      /immutable|durable/,
    );
  }
});

test("immutable recovery budgets survive restart and derive bounded use from Recovery Actions", (t) => {
  const { dbPath, db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  const pid = projectId(db);
  {
    insertOperations(db, 8);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    const resultId = insertSettledAttempt(db, {
      attemptId: "attempt-1", lifecycleId: "life-recovery", claimRevision: 2,
      settleRevision: 3, outcome: "failed",
    });
    insertFailure(db, {
      id: "failure-1", lifecycleId: "life-recovery", attemptId: "attempt-1",
      resultId, revision: 4,
    });
    insertBudget(db, "life-recovery", 5);
  }
  db.close();

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const reopened = openRawDatabase(dbPath);
  t.after(() => {
    if (reopened.isOpen) reopened.close();
  });
  {
    assert.equal(reopened.prepare(
      "SELECT max_uses FROM workflow_recovery_budgets WHERE recovery_budget_id = 'budget-retry'",
    ).get()?.max_uses, 2);
    assert.throws(
      () => reopened.prepare("UPDATE workflow_recovery_budgets SET max_uses = 99 WHERE recovery_budget_id = 'budget-retry'").run(),
      /immutable/,
    );
    assert.throws(() => reopened.prepare(`
      INSERT INTO workflow_recovery_budgets (
        recovery_budget_id, project_id, lifecycle_id, failure_kind, failure_fingerprint,
        policy_class, max_uses, policy_version, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('budget-reset', ?, 'life-recovery', 'provider-network',
        'provider-network:timeout', 'transient-execution', 2, 'recovery-v2', '',
        'op-6', 6, 0)
    `).run(pid), /UNIQUE constraint failed|budget/);
    for (let index = 1; index <= 3; index += 1) {
      if (index > 1) {
        reopened.prepare(`
          INSERT INTO workflow_failure_observations (
            failure_observation_id, project_id, lifecycle_id, recovery_owner, boundary_stage,
            failure_kind, failure_fingerprint, summary, evidence_json, observed_at,
            operation_id, project_revision, authority_epoch
          ) VALUES (?, ?, 'life-recovery', 'agent', 'route', 'provider-network',
            'provider-network:timeout', 'Provider request timed out', '{}', '', ?, ?, 0)
        `).run(`failure-${index}`, pid, `op-${index + 4}`, index + 4);
      }
      const insertAction = (): unknown => reopened.prepare(`
        INSERT INTO workflow_recovery_actions (
          recovery_action_id, project_id, lifecycle_id, failure_observation_id,
          action, recovery_budget_id, target_lifecycle_id, rationale, policy_version,
          selected_at, operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'life-recovery', ?, 'retry', 'budget-retry', 'life-recovery',
          'Transient provider failure', 'recovery-v1', '', ?, ?, 0)
      `).run(`action-${index}`, pid, `failure-${index}`, `op-${index + 4}`, index + 4);
      if (index <= 2) insertAction();
      else assert.throws(insertAction, /budget|exhausted|max_uses/);
    }
    assert.equal(reopened.prepare(`
      SELECT COUNT(*) AS count FROM workflow_recovery_actions
      WHERE recovery_budget_id = 'budget-retry'
    `).get()?.count, 2);
    assert.throws(() => reopened.prepare(`
      INSERT INTO workflow_recovery_actions (
        recovery_action_id, project_id, lifecycle_id, failure_observation_id,
        action, recovery_budget_id, target_lifecycle_id, rationale, policy_version,
        selected_at, operation_id, project_revision, authority_epoch
      ) VALUES ('action-duplicate', ?, 'life-recovery', 'failure-1', 'retry',
        'budget-retry', 'life-recovery', 'Second route', 'recovery-v1', '', 'op-8', 8, 0)
    `).run(pid), /UNIQUE constraint failed|one recovery action/);
  }
});

test("recovery budget allocations cannot exceed their policy-class action caps", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 2);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    const policyCaps = [
      ["transient-execution", 2],
      ["deterministic-repair", 1],
      ["schema-correction", 2],
      ["remediation", 2],
      ["objective-uat", 2],
    ] as const;
    for (const [policyClass, cap] of policyCaps) {
      assert.throws(() => db.prepare(`
        INSERT INTO workflow_recovery_budgets (
          recovery_budget_id, project_id, lifecycle_id, failure_kind,
          failure_fingerprint, policy_class, max_uses, policy_version, created_at,
          operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'life-recovery', 'verification-failed', ?, ?, ?,
          'recovery-v1', '', 'op-2', 2, 0)
      `).run(
        `budget-${policyClass}`,
        projectId(db),
        `verification-failed:${policyClass}`,
        policyClass,
        cap + 1,
      ), /max_uses|CHECK constraint failed/);
    }
  }
});

test("clarify and pause require a genuine open human Blocker", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 8);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    const resultId = insertSettledAttempt(db, {
      attemptId: "attempt-1", lifecycleId: "life-recovery", claimRevision: 2,
      settleRevision: 3, outcome: "failed",
    });
    insertFailure(db, {
      id: "failure-machine", lifecycleId: "life-recovery", attemptId: "attempt-1",
      resultId, revision: 4, kind: "verification-failed",
    });
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_recovery_actions (
        recovery_action_id, project_id, lifecycle_id, failure_observation_id,
        action, rationale, policy_version, selected_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('action-pause', ?, 'life-recovery', 'failure-machine', 'pause',
        'Ask a person to fix a failed test', 'recovery-v1', '', 'op-5', 5, 0)
    `).run(projectId(db)), /blocker|machine-owned/);
    db.prepare(`
      INSERT INTO workflow_blockers (
        blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
        blocker_status, description, requested_action, resolution, opened_at,
        opened_operation_id, opened_project_revision, opened_authority_epoch
      ) VALUES ('blocker-access', ?, 'life-recovery', 'missing_access', 'user',
        'open', 'Credential is unavailable', 'Provide access', '', '', 'op-6', 6, 0)
    `).run(projectId(db));
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_recovery_actions (
        recovery_action_id, project_id, lifecycle_id, failure_observation_id,
        action, blocker_id, rationale, policy_version, selected_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('action-unrelated-blocker', ?, 'life-recovery', 'failure-machine', 'pause',
        'blocker-access', 'Pause for unrelated access', 'recovery-v1', '', 'op-7', 7, 0)
    `).run(projectId(db)), /causal blocker|human blocker/);
    db.prepare(`
      INSERT INTO workflow_failure_observations (
        failure_observation_id, project_id, lifecycle_id, blocker_id, recovery_owner,
        boundary_stage,
        failure_kind, failure_fingerprint, summary, evidence_json, observed_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('failure-access', ?, 'life-recovery', 'blocker-access', 'user',
        'route', 'tool-unavailable',
        'tool-unavailable:credential', 'Access required', '{}', '', 'op-6', 6, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_recovery_actions (
        recovery_action_id, project_id, lifecycle_id, failure_observation_id,
        action, blocker_id, rationale, policy_version, selected_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('action-clarify', ?, 'life-recovery', 'failure-access', 'clarify',
        'blocker-access', 'Only the user can supply access', 'recovery-v1', '', 'op-7', 7, 0)
    `).run(projectId(db));
  }
});

test("acceptance criterion lineages preserve optional requirement scope", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 6);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    db.exec(`
      INSERT INTO requirements (id, class, status, description)
      VALUES ('R001', 'functional', 'active', 'First requirement'),
        ('R002', 'functional', 'active', 'Second requirement');
    `);
    insertCriterion(db, {
      id: "criterion-r1", criterionKey: "outcome", lifecycleId: "life-recovery",
      requirementId: "R001", revision: 2,
    });
    insertCriterion(db, {
      id: "criterion-r2", criterionKey: "outcome", lifecycleId: "life-recovery",
      requirementId: "R002", revision: 2,
    });
    insertCriterion(db, {
      id: "criterion-lifecycle", criterionKey: "outcome", lifecycleId: "life-recovery",
      revision: 2,
    });
    assert.throws(() => insertCriterion(db, {
      id: "criterion-lifecycle-duplicate", criterionKey: "outcome",
      lifecycleId: "life-recovery", revision: 3,
    }), /current head|same scope/);
    assert.throws(() => insertCriterion(db, {
      id: "criterion-r1-duplicate", criterionKey: "outcome", lifecycleId: "life-recovery",
      requirementId: "R001", revision: 3,
    }), /current head|same scope/);
    insertCriterion(db, {
      id: "criterion-r1-v2", criterionKey: "outcome", lifecycleId: "life-recovery",
      requirementId: "R001", revision: 3, supersedesCriterionId: "criterion-r1",
    });
    assert.throws(() => insertCriterion(db, {
      id: "criterion-cross-requirement", criterionKey: "outcome", lifecycleId: "life-recovery",
      requirementId: "R002", revision: 4, supersedesCriterionId: "criterion-r1-v2",
    }), /current head|same scope/);
    assert.throws(() => insertCriterion(db, {
      id: "criterion-missing-requirement", lifecycleId: "life-recovery",
      requirementId: "R404", revision: 5,
    }), /FOREIGN KEY constraint failed/);
  }
});

test("technical PASS is criterion, Attempt, and source-revision scoped to fresh immutable evidence", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 11);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    insertLifecycle(db, "life-other", "M-OTHER", 2);
    insertSettledAttempt(db, {
      attemptId: "attempt-pass", lifecycleId: "life-recovery", claimRevision: 3,
      settleRevision: 4, outcome: "succeeded",
    });
    insertSettledAttempt(db, {
      attemptId: "attempt-other", lifecycleId: "life-other", claimRevision: 5,
      settleRevision: 6, outcome: "succeeded",
    });
    insertCriterion(db, {
      id: "criterion-1", criterionKey: "outcome", lifecycleId: "life-recovery", revision: 7,
    });
    insertCriterion(db, {
      id: "criterion-2", criterionKey: "performance", lifecycleId: "life-recovery", revision: 7,
    });
    insertCriterion(db, { id: "criterion-other", lifecycleId: "life-other", revision: 7 });
    assert.throws(() => insertCriterion(db, {
      id: "criterion-human-technical", lifecycleId: "life-recovery", revision: 7,
      kind: "technical", evidenceClass: "human",
    }), /criterion|evidence|CHECK constraint failed/);
    assert.throws(() => insertCriterion(db, {
      id: "criterion-command-subjective", lifecycleId: "life-recovery", revision: 7,
      kind: "subjective_uat", evidenceClass: "command",
    }), /criterion|evidence|CHECK constraint failed/);
    insertCriterion(db, {
      id: "criterion-1-v2", criterionKey: "outcome", lifecycleId: "life-recovery",
      revision: 8, supersedesCriterionId: "criterion-1",
    });
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('verdict-stale-criterion', ?, 'criterion-1', 'life-recovery', 'attempt-pass',
        'commit-current', 'pass', 'technical-verification', 'v1', 'Fresh proof passed',
        '', 'op-9', 9, 0)
    `).run(projectId(db)), /current criterion|current head/);
    db.prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('verdict-pass', ?, 'criterion-1-v2', 'life-recovery', 'attempt-pass',
        'commit-current', 'pass', 'technical-verification', 'v1', 'Fresh proof passed',
        '', 'op-9', 9, 0)
    `).run(projectId(db));
    insertEvidence(db, {
      id: "evidence-1", verdictId: "verdict-pass", criterionId: "criterion-1-v2", lifecycleId: "life-recovery",
      attemptId: "attempt-pass", revision: 9,
    });
    const evidenceScope = {
      verdictId: "verdict-pass",
      criterionId: "criterion-1-v2",
      lifecycleId: "life-recovery",
      attemptId: "attempt-pass",
      revision: 9,
    } as const;
    assert.throws(() => insertEvidence(db, {
      ...evidenceScope,
      id: "evidence-before-criterion",
      observedProjectRevision: 7,
    }), /criterion|observed revision|verdict scope/);
    assert.throws(() => insertEvidence(db, {
      ...evidenceScope,
      id: "evidence-nonhex",
      contentHash: `sha256:${"z".repeat(64)}`,
    }), /content_hash|CHECK constraint failed/);
    assert.throws(() => insertEvidence(db, {
      ...evidenceScope,
      id: "evidence-empty-environment",
      environmentJson: "{ }",
    }), /environment_json|CHECK constraint failed/);
    assert.throws(() => insertEvidence(db, {
      ...evidenceScope,
      id: "evidence-reversed-instants",
      startedAt: "2026-07-12T00:30:00-01:00",
      endedAt: "2026-07-12T01:00:00+01:00",
    }), /started_at|ended_at|CHECK constraint failed/);
    assert.throws(() => insertEvidence(db, {
      id: "evidence-wrong", verdictId: "verdict-pass", criterionId: "criterion-1-v2", lifecycleId: "life-recovery",
      attemptId: "attempt-other", revision: 9,
    }), /scope|lifecycle|criterion/);
    assert.throws(
      () => db.prepare("UPDATE workflow_verification_evidence SET observation = 'failed' WHERE evidence_id = 'evidence-1'").run(),
      /immutable/,
    );
    db.prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        supersedes_verdict_id, created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('verdict-corrected', ?, 'criterion-1-v2', 'life-recovery', 'attempt-pass',
        'commit-current', 'inconclusive', 'technical-verification', 'v1', 'Corrected verdict',
        'verdict-pass', '', 'op-10', 10, 0)
    `).run(projectId(db));
    insertEvidence(db, {
      id: "evidence-corrected", verdictId: "verdict-corrected", criterionId: "criterion-1-v2",
      lifecycleId: "life-recovery", attemptId: "attempt-pass", revision: 10,
      observation: "inconclusive",
    });
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        supersedes_verdict_id, created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('verdict-fork', ?, 'criterion-1-v2', 'life-recovery', 'attempt-pass',
        'commit-current', 'pass', 'technical-verification', 'v1', 'Fork old head',
        'verdict-pass', '', 'op-11', 11, 0)
    `).run(projectId(db)), /current head|UNIQUE constraint failed/);
  }
});

test("subjective UAT acceptance requires the current accepted v33 subjective-UAT Answer", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 9);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    insertTaskLifecycle(db, "life-uat-remediation", 1);
    insertCriterion(db, {
      id: "criterion-subjective", lifecycleId: "life-recovery", revision: 2,
      kind: "subjective_uat", evidenceClass: "human",
    });
    db.prepare(`
      INSERT INTO workflow_open_questions (
        question_id, project_id, lifecycle_id, question_text, question_status,
        state_version, created_at, updated_at,
        created_operation_id, created_project_revision, created_authority_epoch,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES ('question-uat', ?, 'life-recovery', 'Does this experience feel right?',
        'open', 0, '', '', 'op-3', 3, 0, 'op-3', 3, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_interactions (
        interaction_id, project_id, question_id, sequence, interaction_kind,
        presentation_state, focused_prompt, requires_answer, option_count,
        recommendation_text, recommendation_rationale, recommendation_evidence,
        recommendation_confidence, recommendation_uncertainty, revisit_condition,
        presented_at, operation_id, project_revision, authority_epoch
      ) VALUES ('interaction-uat', ?, 'question-uat', 1, 'subjective-uat',
        'prepared', 'Does this feel acceptable?', 1, 0,
        'Accept if the guided flow feels natural', 'The objective checks already passed',
        'technical verdict', 0.8, '', '', '', 'op-4', 4, 0)
    `).run(projectId(db));
    db.prepare("UPDATE workflow_interactions SET presentation_state = 'presented' WHERE interaction_id = 'interaction-uat'").run();
    db.prepare(`
      INSERT INTO workflow_answers (
        answer_id, project_id, question_id, interaction_id, response_kind,
        verbatim_response, normalized_interpretation, interpretation_confidence,
        answer_disposition, observed_project_revision, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('answer-uat', ?, 'question-uat', 'interaction-uat', 'answer',
        'Yes, this feels natural.', 'accepted_subjective_experience', 0.9,
        'accepted', 4, '', 'op-5', 5, 0)
    `).run(projectId(db));
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_human_acceptances (
        human_acceptance_id, project_id, criterion_id, lifecycle_id,
        answer_id, question_id, interaction_id, disposition, actor_id, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('acceptance-preclose', ?, 'criterion-subjective', 'life-recovery',
        'answer-uat', 'question-uat', 'interaction-uat', 'accepted', 'developer',
        'Question is not closed yet', '', 'op-5', 5, 0)
    `).run(projectId(db)), /current accepted subjective-UAT answer/);
    db.prepare(`
      UPDATE workflow_open_questions
      SET question_status = 'answered', accepted_answer_id = 'answer-uat',
          state_version = 1, updated_at = '2026-07-12T00:05:00.000Z',
          last_operation_id = 'op-5', last_project_revision = 5
      WHERE question_id = 'question-uat'
    `).run();
    db.prepare(`
      INSERT INTO workflow_human_acceptances (
        human_acceptance_id, project_id, criterion_id, lifecycle_id,
        answer_id, question_id, interaction_id, disposition, actor_id, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('acceptance-1', ?, 'criterion-subjective', 'life-recovery',
        'answer-uat', 'question-uat', 'interaction-uat', 'accepted', 'developer',
        'The experience meets the subjective criterion', '', 'op-5', 5, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_open_questions (
        question_id, project_id, lifecycle_id, question_text, question_status,
        state_version, created_at, updated_at,
        created_operation_id, created_project_revision, created_authority_epoch,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES ('question-uat-2', ?, 'life-recovery', 'Does this still feel right?',
        'open', 0, '', '', 'op-6', 6, 0, 'op-6', 6, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_interactions (
        interaction_id, project_id, question_id, sequence, interaction_kind,
        presentation_state, focused_prompt, requires_answer, option_count,
        recommendation_text, recommendation_rationale, recommendation_evidence,
        recommendation_confidence, recommendation_uncertainty, revisit_condition,
        presented_at, operation_id, project_revision, authority_epoch
      ) VALUES ('interaction-uat-2', ?, 'question-uat-2', 1, 'subjective-uat',
        'prepared', 'Does this still feel acceptable?', 1, 0,
        'Reject if the guided flow no longer feels natural', 'The experience changed',
        'updated product experience', 0.8, '', '', '', 'op-7', 7, 0)
    `).run(projectId(db));
    db.prepare("UPDATE workflow_interactions SET presentation_state = 'presented' WHERE interaction_id = 'interaction-uat-2'").run();
    db.prepare(`
      INSERT INTO workflow_answers (
        answer_id, project_id, question_id, interaction_id, response_kind,
        verbatim_response, normalized_interpretation, interpretation_confidence,
        answer_disposition, observed_project_revision, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('answer-uat-2', ?, 'question-uat-2', 'interaction-uat-2', 'correction',
        'No, the revised experience is confusing.', 'rejected_subjective_experience', 0.9,
        'accepted', 7, '', 'op-8', 8, 0)
    `).run(projectId(db));
    db.prepare(`
      UPDATE workflow_open_questions
      SET question_status = 'answered', accepted_answer_id = 'answer-uat-2',
          state_version = 1, updated_at = '2026-07-12T00:08:00.000Z',
          last_operation_id = 'op-8', last_project_revision = 8
      WHERE question_id = 'question-uat-2'
    `).run();
    db.prepare(`
      INSERT INTO workflow_human_acceptances (
        human_acceptance_id, project_id, criterion_id, lifecycle_id,
        answer_id, question_id, interaction_id, disposition, actor_id, rationale,
        supersedes_human_acceptance_id, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('acceptance-2', ?, 'criterion-subjective', 'life-recovery',
        'answer-uat-2', 'question-uat-2', 'interaction-uat-2', 'rejected', 'developer',
        'Later review found a subjective problem', 'acceptance-1', '', 'op-8', 8, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_remediation_links (
        remediation_link_id, project_id, source_lifecycle_id, human_acceptance_id,
        route_kind, remediation_fingerprint, required_outcome, target_lifecycle_id,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('remediation-acceptance', ?, 'life-recovery', 'acceptance-2', 'remediation',
        'criterion-subjective:rejected', 'Resolve the subjective problem',
        'life-uat-remediation', '', 'op-8', 8, 0)
    `).run(projectId(db));
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_human_acceptances (
        human_acceptance_id, project_id, criterion_id, lifecycle_id,
        answer_id, question_id, interaction_id, disposition, actor_id, rationale,
        supersedes_human_acceptance_id, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('acceptance-fork', ?, 'criterion-subjective', 'life-recovery',
        'answer-uat', 'question-uat', 'interaction-uat', 'accepted', 'developer',
        'Fork old head', 'acceptance-1', '', 'op-9', 9, 0)
    `).run(projectId(db)), /current head|UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_human_acceptances (
        human_acceptance_id, project_id, criterion_id, lifecycle_id,
        answer_id, question_id, interaction_id, disposition, actor_id, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('acceptance-fake', ?, 'criterion-subjective', 'life-recovery',
        'missing', 'question-uat', 'interaction-uat', 'accepted', 'developer', 'Fake answer', '',
        'op-9', 9, 0)
    `).run(projectId(db)), /answer|FOREIGN KEY constraint failed/);
  }
});

test("Remediation Links immutably route one failed verdict or rejected Human Acceptance", (t) => {
  const { db } = openFreshFixture();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  {
    insertOperations(db, 9);
    insertLifecycle(db, "life-recovery", "M-RECOVERY", 1);
    insertLifecycle(db, "life-other", "M-OTHER", 2);
    insertTaskLifecycle(db, "life-remediation", 2);
    insertSettledAttempt(db, {
      attemptId: "attempt-1", lifecycleId: "life-recovery", claimRevision: 3,
      settleRevision: 4, outcome: "failed",
    });
    insertSettledAttempt(db, {
      attemptId: "attempt-pass", lifecycleId: "life-other", claimRevision: 5,
      settleRevision: 6, outcome: "succeeded",
    });
    insertCriterion(db, { id: "criterion-1", lifecycleId: "life-recovery", revision: 5 });
    insertCriterion(db, { id: "criterion-pass", lifecycleId: "life-other", revision: 5 });
    db.prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('verdict-fail', ?, 'criterion-1', 'life-recovery', 'attempt-1',
        'commit-bad', 'fail', 'technical-verification', 'v1', 'Test failed', '', 'op-6', 6, 0)
    `).run(projectId(db));
    insertEvidence(db, {
      id: "evidence-failed", verdictId: "verdict-fail", criterionId: "criterion-1",
      lifecycleId: "life-recovery", attemptId: "attempt-1", revision: 6,
      sourceRevision: "commit-bad", observation: "failed", exitCode: 1,
    });
    insertEvidence(db, {
      id: "evidence-passed-companion", verdictId: "verdict-fail", criterionId: "criterion-1",
      lifecycleId: "life-recovery", attemptId: "attempt-1", revision: 6,
      sourceRevision: "commit-bad", observation: "passed", exitCode: 0,
    });
    db.prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('verdict-pass-unroutable', ?, 'criterion-pass', 'life-other', 'attempt-pass',
        'commit-good', 'pass', 'technical-verification', 'v1', 'Test passed', '', 'op-7', 7, 0)
    `).run(projectId(db));
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_remediation_links (
        remediation_link_id, project_id, source_lifecycle_id, technical_verdict_id,
        route_kind, remediation_fingerprint, required_outcome, target_lifecycle_id,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('remediation-pass', ?, 'life-other', 'verdict-pass-unroutable', 'remediation',
        'criterion-pass:no-gap', 'No remediation is valid', 'life-remediation', '', 'op-8', 8, 0)
    `).run(projectId(db)), /failed verdict|failed verdict or rejected acceptance/);
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_remediation_links (
        remediation_link_id, project_id, source_lifecycle_id, technical_verdict_id,
        route_kind, remediation_fingerprint, required_outcome, target_lifecycle_id,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('remediation-milestone', ?, 'life-recovery', 'verdict-fail', 'remediation',
        'criterion-1:wrong-target', 'Make the test pass', 'life-other', '', 'op-7', 7, 0)
    `).run(projectId(db)), /actionable task work/);
    db.prepare(`
      INSERT INTO workflow_remediation_links (
        remediation_link_id, project_id, source_lifecycle_id, technical_verdict_id,
        route_kind, remediation_fingerprint, required_outcome, target_lifecycle_id,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('remediation-1', ?, 'life-recovery', 'verdict-fail', 'remediation',
        'criterion-1:test-failed', 'Make the test pass', 'life-remediation', '', 'op-6', 6, 0)
    `).run(projectId(db));
    assert.throws(() => db.prepare(`
      INSERT INTO workflow_remediation_links (
        remediation_link_id, project_id, source_lifecycle_id, technical_verdict_id,
        human_acceptance_id, route_kind, remediation_fingerprint, required_outcome,
        target_lifecycle_id, created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('remediation-xor', ?, 'life-recovery', 'verdict-fail', 'missing-acceptance',
        'rework', 'criterion-1:ambiguous', 'Fix it', 'life-recovery', '', 'op-8', 8, 0)
    `).run(projectId(db)), /exactly one|CHECK constraint failed|FOREIGN KEY constraint failed/);
    assert.throws(
      () => db.prepare("UPDATE workflow_remediation_links SET required_outcome = 'Ignore it' WHERE remediation_link_id = 'remediation-1'").run(),
      /immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM workflow_remediation_links WHERE remediation_link_id = 'remediation-1'").run(),
      /immutable|durable/,
    );
  }
});

test("v33 upgrade is additive, backed up, and leaves v34 tables empty", (t) => {
  const dbPath = createDatabasePath();
  rewindToV33(dbPath);
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  const upgraded = openRawDatabase(dbPath);
  t.after(() => {
    if (upgraded.isOpen) upgraded.close();
  });
  {
    assert.equal(maxSchemaVersion(upgraded), SCHEMA_VERSION);
    assert.equal(upgraded.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Preserve legacy meaning");
    for (const table of V34_TABLES) {
      assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    for (const index of V34_PARENT_INDEXES) assert.equal(indexExists(upgraded, index), true);
    assert.equal(upgraded.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  }
  upgraded.close();

  const backup = openRawDatabase(`${dbPath}.backup-v33`);
  t.after(() => {
    if (backup.isOpen) backup.close();
  });
  {
    assert.equal(maxSchemaVersion(backup), 33);
    for (const table of V34_TABLES) assert.equal(tableExists(backup, table), false);
    for (const index of V34_PARENT_INDEXES) assert.equal(indexExists(backup, index), false);
    assert.equal(backup.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Preserve legacy meaning");
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  }
  backup.close();

  const restoredPath = join(dirname(dbPath), "restored.db");
  copyFileSync(`${dbPath}.backup-v33`, restoredPath);
  assert.equal(openDatabase(restoredPath), true);
  closeDatabase();
  const restored = openRawDatabase(restoredPath);
  t.after(() => {
    if (restored.isOpen) restored.close();
  });
  {
    assert.equal(maxSchemaVersion(restored), SCHEMA_VERSION);
    for (const table of V34_TABLES) {
      assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
  }
});

test("faulted v33 migration rolls back every v34 table and retries cleanly", (t) => {
  const dbPath = createDatabasePath();
  rewindToV33(dbPath);
  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  t.after(() => {
    if (rolledBack.isOpen) rolledBack.close();
  });
  {
    assert.equal(maxSchemaVersion(rolledBack), 33);
    for (const table of V34_TABLES) assert.equal(tableExists(rolledBack, table), false, `${table} should roll back`);
    for (const index of V34_PARENT_INDEXES) assert.equal(indexExists(rolledBack, index), false);
    assert.equal(rolledBack.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Preserve legacy meaning");
  }
  rolledBack.close();
  const backup = openRawDatabase(`${dbPath}.backup-v33`);
  t.after(() => {
    if (backup.isOpen) backup.close();
  });
  {
    assert.equal(maxSchemaVersion(backup), 33);
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  }
  backup.close();

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  t.after(() => {
    if (retried.isOpen) retried.close();
  });
  {
    assert.equal(maxSchemaVersion(retried), SCHEMA_VERSION);
    for (const table of V34_TABLES) assert.equal(tableExists(retried, table), true);
    for (const index of V34_PARENT_INDEXES) assert.equal(indexExists(retried, index), true);
  }
});
