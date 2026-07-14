// Project/App: gsd-pi
// File Purpose: Executable contracts for atomic Slice lifecycle Domain Operations.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  type CanonicalLifecycleStatus,
} from "../db/writers/lifecycle-commands.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { cancelSlice } from "../slice-lifecycle-domain-operation.ts";
import { handleSkipSlice } from "../tools/skip-slice.ts";

const tempDirs = new Set<string>();

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

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "slice-lifecycle-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "slice",
        entityId: "M001/S01",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function adoptFixtureLifecycle(
  context: Readonly<DomainOperationContext>,
  itemKind: "slice" | "task",
  lifecycleStatus: CanonicalLifecycleStatus,
  taskId?: string,
): void {
  adoptOrTransitionLifecycle(context, {
    itemKind,
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
    lifecycleStatus,
  }).lifecycleId;
}

function insertClaimedDispatch(taskId: string): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', 1, '2026-07-14T00:00:00.000Z'
    )
  `).run({
    ":trace_id": `trace/${taskId}`,
    ":turn_id": `turn/${taskId}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

function completeTaskWithHistory(taskId: string, dispatchId: number): void {
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/settle`),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Completed before the Slice was cancelled",
    output: { artifact: "immutable-completed-history" },
  });
  executeAtFence("test.task.complete", `fixture/${taskId}/complete`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId,
      lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE tasks
      SET status = 'complete', completed_at = '2026-07-14T00:01:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = :task_id
    `).run({ ":task_id": taskId });
  });
}

function seedMixedSlice(): { runningAttemptId: string; runningDispatchId: number } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-slice-lifecycle-domain-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Slice lifecycle', 'active', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Cancellation', 'active', '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Pending child', 'pending', 1),
      ('M001', 'S01', 'T02', 'Ready child', 'pending', 2),
      ('M001', 'S01', 'T03', 'Running child', 'in_progress', 3),
      ('M001', 'S01', 'T04', 'Completed child', 'in_progress', 4);
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-14T00:00:00.000Z', 'test',
      '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-14T00:00:00.000Z',
      '2099-07-14T00:00:00.000Z', 'held'
    );
  `);

  executeAtFence("test.slice.fixture", "fixture/slice/adopt", (context) => {
    adoptFixtureLifecycle(context, "slice", "in_progress");
    adoptFixtureLifecycle(context, "task", "pending", "T01");
    adoptFixtureLifecycle(context, "task", "ready", "T02");
    adoptFixtureLifecycle(context, "task", "ready", "T03");
    adoptFixtureLifecycle(context, "task", "ready", "T04");
  });

  const runningDispatchId = insertClaimedDispatch("T03");
  const running = claimTaskAttempt({
    invocation: invocation("fixture/T03/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T03" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: runningDispatchId,
  });
  completeTaskWithHistory("T04", insertClaimedDispatch("T04"));
  return { runningAttemptId: running.attemptId, runningDispatchId };
}

function completedHistorySnapshot(): Record<string, unknown> {
  const lifecycleId = String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T04'
  `).lifecycle_id);
  return {
    legacy: row("SELECT * FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T04'"),
    lifecycle: row(`SELECT * FROM workflow_item_lifecycles WHERE lifecycle_id = '${lifecycleId}'`),
    attempts: rows(`SELECT * FROM workflow_execution_attempts WHERE lifecycle_id = '${lifecycleId}' ORDER BY attempt_number`),
    results: rows(`SELECT * FROM workflow_attempt_results WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    checkpoints: rows(`SELECT * FROM workflow_kernel_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY sequence`),
    dispatches: rows("SELECT * FROM unit_dispatches WHERE task_id = 'T04' ORDER BY id"),
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    checkpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY lifecycle_id, sequence"),
    workCheckpoints: rows("SELECT * FROM workflow_work_checkpoints ORDER BY project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("public skip commits one Slice cancellation operation and selectively settles unfinished children", () => {
  const { runningAttemptId, runningDispatchId } = seedMixedSlice();
  const completedBefore = completedHistorySnapshot();
  const beforeRevision = Number(row("SELECT revision FROM project_authority").revision);
  const beforeOperationCount = Number(row("SELECT COUNT(*) AS count FROM workflow_operations").count);

  const result = handleSkipSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "The remaining Slice work is no longer required.",
  });

  assert.equal(result.error, undefined, result.error);
  assert.equal(Number(row("SELECT revision FROM project_authority").revision), beforeRevision + 1);
  assert.equal(Number(row("SELECT COUNT(*) AS count FROM workflow_operations").count), beforeOperationCount + 1);
  const operation = row(`
    SELECT operation_id, operation_type, resulting_revision
    FROM workflow_operations WHERE resulting_revision = ${beforeRevision + 1}
  `);
  assert.equal(operation.operation_type, "slice.cancel");
  assert.equal(operation.resulting_revision, beforeRevision + 1);
  assert.deepEqual(row(`
    SELECT event_type, entity_type, entity_id
    FROM workflow_domain_events WHERE operation_id = '${String(operation.operation_id)}'
  `), {
    event_type: "slice.cancelled",
    entity_type: "slice",
    entity_id: "M001/S01",
  });
  assert.deepEqual(row(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_status AS canonical_status
    FROM slices slice
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
    WHERE slice.milestone_id = 'M001' AND slice.id = 'S01'
  `), { legacy_status: "skipped", canonical_status: "cancelled" });
  assert.deepEqual(rows(`
    SELECT task.id, task.status AS legacy_status,
           lifecycle.lifecycle_status AS canonical_status
    FROM tasks task
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = 'M001' AND task.slice_id = 'S01'
    ORDER BY task.id
  `), [
    { id: "T01", legacy_status: "skipped", canonical_status: "cancelled" },
    { id: "T02", legacy_status: "skipped", canonical_status: "cancelled" },
    { id: "T03", legacy_status: "skipped", canonical_status: "cancelled" },
    { id: "T04", legacy_status: "complete", canonical_status: "completed" },
  ]);
  assert.deepEqual(row(`
    SELECT attempt_state, settle_outcome
    FROM workflow_execution_attempts WHERE attempt_id = '${runningAttemptId}'
  `), { attempt_state: "settled", settle_outcome: "interrupted" });
  assert.deepEqual(row(`
    SELECT attempt_id, outcome, failure_class
    FROM workflow_attempt_results WHERE attempt_id = '${runningAttemptId}'
  `), {
    attempt_id: runningAttemptId,
    outcome: "interrupted",
    failure_class: "slice-cancelled",
  });
  assert.equal(
    row(`SELECT status FROM unit_dispatches WHERE id = ${runningDispatchId}`).status,
    "canceled",
  );
  assert.deepEqual(completedHistorySnapshot(), completedBefore);
});

test("direct Slice cancellation replays its durable receipt and rejects changed idempotency reuse without residue", () => {
  seedMixedSlice();
  const input = {
    invocation: invocation("slice-cancel/replay"),
    slice: { milestoneId: "M001", sliceId: "S01" },
    reason: "The remaining Slice work is no longer required.",
  };

  const committed = cancelSlice(input);
  const afterCommit = durableSnapshot();
  const replayed = cancelSlice(input);

  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.deepEqual(
    { ...replayed, status: "committed" },
    committed,
    "exact retry must return the original durable receipt identity",
  );
  assert.deepEqual(
    durableSnapshot(),
    afterCommit,
    "exact retry must not advance authority or duplicate durable lineage",
  );

  assert.throws(() => cancelSlice({
    ...input,
    reason: "A conflicting reason under the same invocation identity.",
  }), /idempotency conflict/i);
  assert.deepEqual(
    durableSnapshot(),
    afterCommit,
    "changed idempotency reuse must leave exact zero residue",
  );
});

test("public skip rejects a deep canonical and legacy mismatch with exact zero residue", () => {
  seedMixedSlice();
  db().prepare(`
    UPDATE tasks SET status = 'pending', completed_at = NULL
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T04'
  `).run();
  const before = durableSnapshot();

  const result = handleSkipSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "This must not repair contradictory authority by guessing.",
  });

  assert.match(result.error ?? "", /canonical|legacy|shadow|mismatch/i);
  assert.deepEqual(durableSnapshot(), before, "mismatch rejection must leave exact zero residue");
});
