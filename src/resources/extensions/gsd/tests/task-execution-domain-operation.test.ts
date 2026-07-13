// Project/App: gsd-pi
// File Purpose: Executable contract for atomic, replay-safe Task execution Domain Operations.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  executeDomainOperation,
  type DomainJsonValue,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
} from "../task-verification-domain-operation.ts";

interface ExecutionInvocation {
  idempotencyKey: string;
  sourceTransport: "internal" | "pi-tool" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}

interface ClaimTaskAttemptInput {
  invocation: ExecutionInvocation;
  task: { milestoneId: string; sliceId: string; taskId: string };
  workerId: string;
  milestoneLeaseToken: number;
  coordinationDispatchId: number;
  retryOfAttemptId?: string;
}

interface SettleTaskAttemptInput {
  invocation: ExecutionInvocation;
  attemptId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
  recovery?: { workerId: string; milestoneLeaseToken: number };
}

interface ClaimTaskAttemptReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  attemptId: string;
  attemptNumber: number;
}

interface SettleTaskAttemptReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultId: string;
  nextStage: "verify" | "route";
}

interface TaskExecutionDomain {
  claimTaskAttempt(input: ClaimTaskAttemptInput): ClaimTaskAttemptReceipt;
  settleTaskAttempt(input: SettleTaskAttemptInput): SettleTaskAttemptReceipt;
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): AttemptSnapshot | null;
  readTaskAttempt(attemptId: string): AttemptSnapshot | null;
}

interface AttemptSnapshot {
  attemptId: string;
  attemptNumber: number;
  retryOfAttemptId?: string;
  state: "running" | "settled";
  outcome?: "succeeded" | "failed" | "interrupted";
  nextStage: "execute" | "verify" | "route";
  coordinationDispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
}

const tempDirs = new Set<string>();

async function subject(): Promise<TaskExecutionDomain> {
  return import("../task-execution-domain-operation.js") as Promise<TaskExecutionDomain>;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`).count ?? 0);
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "task-execution-test",
    traceId: "trace-task-execution",
    turnId: "turn-task-execution",
  };
}

function seedFixture(): { dispatchId: number } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-execution-domain-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Task execution', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Domain operation', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Execute atomically', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-1', 'turn-dispatch-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { taskId: "T01" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  return { dispatchId: Number(row("SELECT id FROM unit_dispatches").id) };
}

function claimInput(dispatchId: number, key = "task-attempt/claim/1"): ClaimTaskAttemptInput {
  return {
    invocation: invocation(key),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  };
}

function settleInput(
  attemptId: string,
  outcome: SettleTaskAttemptInput["outcome"],
  key = `task-attempt/settle/${outcome}`,
): SettleTaskAttemptInput {
  return {
    invocation: invocation(key),
    attemptId,
    outcome,
    failureClass: outcome === "succeeded" ? "none" : "executor-error",
    summary: outcome === "succeeded" ? "executor produced its result" : "executor stopped without a valid result",
    output: { changedFiles: ["src/task.ts"] },
  };
}

function executionSnapshot(): Record<string, unknown> {
  return {
    authority: row("SELECT revision, authority_epoch FROM project_authority"),
    operations: rows("SELECT operation_id, idempotency_key FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT lifecycle_status, state_version FROM workflow_item_lifecycles"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY created_at"),
    checkpoints: rows("SELECT attempt_id, sequence, next_stage FROM workflow_kernel_checkpoints ORDER BY sequence"),
    events: rows("SELECT operation_id, event_type, entity_type, entity_id FROM workflow_domain_events ORDER BY project_revision"),
    outbox: rows("SELECT event_id, destination FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT enqueue_operation_id, projection_key FROM workflow_projection_work ORDER BY source_project_revision"),
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("claimTaskAttempt atomically records lifecycle, Attempt, execute checkpoint, event, outbox, projection, and one revision", async () => {
  const { claimTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const beforeRevision = Number(row("SELECT revision FROM project_authority").revision);
  const before = {
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    outbox: count("workflow_outbox"),
    projections: count("workflow_projection_work"),
  };

  const receipt = claimTaskAttempt(claimInput(dispatchId));

  assert.equal(receipt.status, "committed");
  assert.equal(receipt.attemptNumber, 1);
  assert.equal(receipt.resultingRevision, beforeRevision + 1);
  assert.deepEqual(row(`
    SELECT lifecycle_status, state_version, last_operation_id, last_project_revision
    FROM workflow_item_lifecycles
  `), {
    lifecycle_status: "in_progress",
    state_version: 1,
    last_operation_id: receipt.operationId,
    last_project_revision: receipt.resultingRevision,
  });
  assert.deepEqual(row(`
    SELECT attempt_id, attempt_number, attempt_state, coordination_dispatch_id,
           worker_id, milestone_lease_token, claim_operation_id
    FROM workflow_execution_attempts
  `), {
    attempt_id: receipt.attemptId,
    attempt_number: 1,
    attempt_state: "running",
    coordination_dispatch_id: dispatchId,
    worker_id: "worker-1",
    milestone_lease_token: 7,
    claim_operation_id: receipt.operationId,
  });
  assert.equal(row("SELECT status FROM unit_dispatches WHERE id = " + dispatchId).status, "running");
  assert.deepEqual(row("SELECT attempt_id, sequence, next_stage, operation_id FROM workflow_kernel_checkpoints"), {
    attempt_id: receipt.attemptId,
    sequence: 1,
    next_stage: "execute",
    operation_id: receipt.operationId,
  });
  assert.deepEqual({
    operations: count("workflow_operations") - before.operations,
    events: count("workflow_domain_events") - before.events,
    outbox: count("workflow_outbox") - before.outbox,
    projections: count("workflow_projection_work") - before.projections,
  }, { operations: 1, events: 1, outbox: 1, projections: 1 });
  assert.deepEqual(row(`
    SELECT entity_type, entity_id FROM workflow_domain_events
    WHERE operation_id = '${receipt.operationId}'
  `), { entity_type: "task", entity_id: "M001/S01/T01" });
});

test("claimTaskAttempt rolls back when the claimed dispatch fence does not match", async () => {
  const { claimTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const before = {
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
  };

  assert.throws(() => claimTaskAttempt({
    ...claimInput(dispatchId, "task-attempt/claim/wrong-fence"),
    milestoneLeaseToken: 8,
  }), /matching coordination dispatch/i);

  assert.deepEqual({
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
  }, before);
  assert.equal(count("workflow_execution_attempts"), 0);
  assert.equal(row("SELECT status FROM unit_dispatches WHERE id = " + dispatchId).status, "claimed");
});

for (const contract of [
  { outcome: "succeeded", nextStage: "verify" },
  { outcome: "failed", nextStage: "route" },
] as const) {
  test(`${contract.outcome} settlement persists one immutable Result, leaves the Task in progress, and advances to ${contract.nextStage}`, async () => {
    const { claimTaskAttempt, settleTaskAttempt, readLatestTaskAttempt, readTaskAttempt } = await subject();
    const { dispatchId } = seedFixture();
    const claim = claimTaskAttempt(claimInput(dispatchId));

    const settled = settleTaskAttempt(settleInput(claim.attemptId, contract.outcome));

    assert.equal(settled.status, "committed");
    assert.equal(settled.nextStage, contract.nextStage);
    assert.deepEqual(row("SELECT attempt_state, settle_operation_id FROM workflow_execution_attempts"), {
      attempt_state: "settled",
      settle_operation_id: settled.operationId,
    });
    assert.deepEqual(row("SELECT result_id, attempt_id, outcome, operation_id FROM workflow_attempt_results"), {
      result_id: settled.resultId,
      attempt_id: claim.attemptId,
      outcome: contract.outcome,
      operation_id: settled.operationId,
    });
    assert.equal(
      row("SELECT status FROM unit_dispatches").status,
      contract.outcome === "succeeded" ? "completed" : "failed",
    );
    assert.equal(row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status, "in_progress");
    assert.deepEqual(rows("SELECT sequence, next_stage FROM workflow_kernel_checkpoints ORDER BY sequence"), [
      { sequence: 1, next_stage: "execute" },
      { sequence: 2, next_stage: contract.nextStage },
    ]);
    const expectedSnapshot = {
      attemptId: claim.attemptId,
      attemptNumber: 1,
      state: "settled",
      outcome: contract.outcome,
      nextStage: contract.nextStage,
      coordinationDispatchId: dispatchId,
      workerId: "worker-1",
      milestoneLeaseToken: 7,
    } as const;
    assert.deepEqual(readTaskAttempt(claim.attemptId), expectedSnapshot);
    assert.deepEqual(
      readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }),
      expectedSnapshot,
    );
    if (contract.outcome === "succeeded") {
      const startedAt = "2026-07-12T00:02:00.000Z";
      const verdict = recordTaskTechnicalVerdict({
        invocation: invocation("task-attempt/verify/pass"),
        attemptId: claim.attemptId,
        testedSourceRevision: "git:test-source-revision",
        verdict: "pass",
        rationale: "Host-owned verification passed.",
        evidence: {
          evidenceClass: "command",
          commandOrTool: "npm test",
          workingDirectory: "/tmp/project",
          startedAt,
          endedAt: "2026-07-12T00:02:01.000Z",
          exitCode: 0,
          observation: "passed",
          durableOutputRef: "db://host-verification/attempt-1",
          environment: { runner: "node-test", platform: "test" },
        },
      });
      assert.equal(verdict.nextStage, "verify");
      assert.equal(count("workflow_technical_verdicts"), 1);
      assert.equal(count("workflow_verification_evidence"), 1);
      assert.throws(() => db().prepare(`
        UPDATE workflow_technical_verdicts SET rationale = 'rewritten'
      `).run(), /immutable/i);
    }
    assert.throws(() => db().prepare(`
      UPDATE workflow_attempt_results SET summary = 'rewritten' WHERE result_id = ?
    `).run(settled.resultId), /immutable/i);
  });
}

test("lost-response replay returns the original claim identity after unrelated revision advance without duplicating facts", async () => {
  const { claimTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const input = claimInput(dispatchId, "task-attempt/lost-response");
  const committed = claimTaskAttempt(input);

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.unrelated",
    idempotencyKey: "test/unrelated-revision",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { unrelated: true },
  }, () => ({
    events: [{
      eventType: "test.unrelated",
      entityType: "test",
      entityId: "unrelated",
      payload: { unrelated: true },
      destinations: ["test"],
    }],
    projections: [{ projectionKey: "test/unrelated", projectionKind: "test", rendererVersion: "1" }],
  }));
  const beforeReplay = executionSnapshot();

  const replayed = claimTaskAttempt(input);

  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  assert.deepEqual(executionSnapshot(), beforeReplay);
});

test("failed host verification records immutable evidence and routes before retry", async () => {
  const { claimTaskAttempt, settleTaskAttempt, readTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const claim = claimTaskAttempt(claimInput(dispatchId));
  settleTaskAttempt(settleInput(claim.attemptId, "succeeded"));

  const verdict = recordTaskTechnicalVerdict({
    invocation: invocation("task-attempt/verify/fail"),
    attemptId: claim.attemptId,
    testedSourceRevision: "git:test-source-revision",
    verdict: "fail",
    rationale: "Host test failed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "npm test",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      exitCode: 1,
      observation: "failed",
      durableOutputRef: "db://host-verification/attempt-1",
      environment: { runner: "node-test", platform: "test" },
    },
  });

  assert.equal(verdict.nextStage, "route");
  assert.equal(readTaskAttempt(claim.attemptId)?.nextStage, "route");
  assert.deepEqual(row("SELECT verdict, rationale FROM workflow_technical_verdicts"), {
    verdict: "fail",
    rationale: "Host test failed.",
  });
});

test("one Attempt cannot record a second host Technical Verdict", async () => {
  const { claimTaskAttempt, settleTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const claim = claimTaskAttempt(claimInput(dispatchId));
  settleTaskAttempt(settleInput(claim.attemptId, "succeeded"));
  const base = {
    attemptId: claim.attemptId,
    rationale: "Host verification completed.",
    evidence: {
      evidenceClass: "command" as const,
      commandOrTool: "npm test",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-12T00:02:00.000Z",
      endedAt: "2026-07-12T00:02:01.000Z",
      durableOutputRef: "db://host-verification/attempt-1",
      environment: { runner: "node-test", platform: "test" },
    },
  };
  recordTaskTechnicalVerdict({
    ...base,
    invocation: invocation("task-attempt/verify/first"),
    testedSourceRevision: "git:first-source-revision",
    verdict: "pass",
    evidence: { ...base.evidence, exitCode: 0, observation: "passed" },
  });

  assert.throws(() => recordTaskTechnicalVerdict({
    ...base,
    invocation: invocation("task-attempt/verify/second"),
    testedSourceRevision: "git:second-source-revision",
    verdict: "fail",
    evidence: { ...base.evidence, exitCode: 1, observation: "failed" },
  }), /already|one|verdict|verified/i);

  assert.equal(count("workflow_technical_verdicts"), 1);
  assert.equal(count("workflow_verification_evidence"), 1);
  assert.equal(row("SELECT verdict FROM workflow_technical_verdicts").verdict, "pass");
  const authoritative = row(`
    SELECT verdict.verdict_id, verdict.operation_id, verdict.project_revision,
           evidence.evidence_id
    FROM workflow_technical_verdicts verdict
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
  `);
  assert.deepEqual(readTaskTechnicalVerdict(claim.attemptId), {
    attemptId: claim.attemptId,
    verdictId: authoritative.verdict_id,
    evidenceId: authoritative.evidence_id,
    verdict: "pass",
    testedSourceRevision: "git:first-source-revision",
    nextStage: "verify",
    operationId: authoritative.operation_id,
    resultingRevision: authoritative.project_revision,
  });
});

test("lost-response replay returns the original settlement identity without duplicating facts", async () => {
  const { claimTaskAttempt, settleTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const claim = claimTaskAttempt(claimInput(dispatchId));
  const input = settleInput(claim.attemptId, "succeeded", "task-attempt/settle/lost-response");
  const committed = settleTaskAttempt(input);
  const beforeReplay = executionSnapshot();

  const replayed = settleTaskAttempt(input);

  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  assert.deepEqual(executionSnapshot(), beforeReplay);
});

test("a replacement lease can interrupt the fenced Attempt and a lineage-linked retry can claim", async () => {
  const { claimTaskAttempt, settleTaskAttempt } = await subject();
  const { dispatchId } = seedFixture();
  const first = claimTaskAttempt(claimInput(dispatchId));
  const beforePrematureRecovery = executionSnapshot();
  assert.throws(() => settleTaskAttempt({
    ...settleInput(first.attemptId, "interrupted", "task-attempt/recover/too-early"),
    failureClass: "stale-worker",
    recovery: { workerId: "worker-1", milestoneLeaseToken: 7 },
  }), /lease|current|valid|stale/i);
  assert.deepEqual(executionSnapshot(), beforePrematureRecovery);
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-2', 'test-host', 2, '2026-07-12T00:01:00.000Z', 'test',
      '2026-07-12T00:01:00.000Z', 'active', '/tmp/project'
    );
    UPDATE milestone_leases
    SET worker_id = 'worker-2', fencing_token = 8,
        acquired_at = '2026-07-12T00:01:00.000Z',
        expires_at = '2099-07-12T00:00:00.000Z', status = 'held'
    WHERE milestone_id = 'M001';
    UPDATE unit_dispatches
    SET status = 'canceled', ended_at = '2026-07-12T00:01:00.000Z',
        exit_reason = 'stale-dispatch-lease-takeover'
    WHERE id = ${dispatchId};
  `);

  const interruptInput = {
    ...settleInput(first.attemptId, "interrupted", "task-attempt/recover/1"),
    failureClass: "stale-worker",
    recovery: { workerId: "worker-2", milestoneLeaseToken: 8 },
  };
  const interrupted = settleTaskAttempt(interruptInput);
  const replayedInterrupt = settleTaskAttempt(interruptInput);
  assert.equal(interrupted.nextStage, "route");
  assert.deepEqual(replayedInterrupt, { ...interrupted, status: "replayed" });
  assert.deepEqual(row("SELECT outcome, failure_class FROM workflow_attempt_results"), {
    outcome: "interrupted",
    failure_class: "stale-worker",
  });
  assert.equal(row("SELECT status FROM unit_dispatches").status, "canceled");
  db().exec(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-dispatch-2', 'turn-dispatch-2', 'worker-2', 8,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 2, '2026-07-12T00:01:00.000Z'
    );
  `);
  const retryDispatchId = Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);

  const retry = claimTaskAttempt({
    ...claimInput(retryDispatchId, "task-attempt/claim/2"),
    workerId: "worker-2",
    milestoneLeaseToken: 8,
    retryOfAttemptId: first.attemptId,
  });

  assert.equal(retry.attemptNumber, 2);
  assert.deepEqual(rows(`
    SELECT attempt_number, retry_of_attempt_id, attempt_state
    FROM workflow_execution_attempts ORDER BY attempt_number
  `), [
    { attempt_number: 1, retry_of_attempt_id: null, attempt_state: "settled" },
    { attempt_number: 2, retry_of_attempt_id: first.attemptId, attempt_state: "running" },
  ]);
});
