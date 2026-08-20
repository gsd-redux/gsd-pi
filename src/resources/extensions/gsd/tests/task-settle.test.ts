// Project/App: gsd-pi
// File Purpose: Operator contract for gsd_task_settle — dry-run-first,
// idempotent, never-guessing Task Attempt settlement (#1749).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { claimTaskAttempt, readTaskAttempt } from "../task-execution-domain-operation.ts";
import { applyTaskSettle, planTaskSettle } from "../task-settle.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType: "user",
    traceId: `trace:${key}`,
  };
}

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };

function seedRunningAttempt(): { attemptId: string; dispatchId: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-settle-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Settle', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Settle operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Settle atomically', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'dispatch-trace-1', 'dispatch-turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
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
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  return { attemptId: claim.attemptId, dispatchId, dir };
}

function orphanClaimedAttempt(dispatchId: number): void {
  // The executor died: its dispatch left ('claimed','running') but the
  // Attempt it claimed is still running (#1749's manual-repair state).
  db().prepare(`
    UPDATE unit_dispatches SET status = 'stuck', ended_at = '2026-07-13T00:10:00.000Z'
    WHERE id = :id
  `).run({ ":id": dispatchId });
}

test("dry-run prints the exact row and mutates nothing", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  const plan = planTaskSettle(TASK, "operator repair after manual investigation");

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].attemptId, attemptId);
  assert.equal(plan.rows[0].currentStatus, "running");
  assert.equal(plan.rows[0].targetStatus, "interrupted");
  assert.match(plan.rows[0].rationale, /operator repair/);
  assert.equal(plan.rows[0].leaseHeld, true);
  assert.equal(
    row("SELECT attempt_state AS state FROM workflow_execution_attempts").state,
    "running",
    "dry-run must not settle the Attempt",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "dry-run must not write a Result",
  );
});

test("apply settles the orphaned Attempt and a second apply is a no-op", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);

  const applied = applyTaskSettle({
    invocation: invocation("settle/apply/1"),
    task: TASK,
    reason: "operator repair after manual investigation",
  });
  assert.equal(applied.settled, true);
  assert.equal(applied.reconciled, false);
  assert.equal(applied.rows[0].attemptId, attemptId);
  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.outcome, "interrupted");
  assert.equal(settled?.resultFailureClass, "operator-settle");
  assert.equal(
    row(`
      SELECT lifecycle_status AS status
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND task_id = 'T01'
    `).status,
    "in_progress",
    "settle without reconcileLifecycle must not adopt canonical status",
  );

  const again = applyTaskSettle({
    invocation: invocation("settle/apply/2"),
    task: TASK,
    reason: "operator repair after manual investigation",
  });
  assert.equal(again.settled, false);
  assert.equal(again.rows.length, 0, "a second apply reports nothing to do");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    1,
    "the idempotent re-apply writes no second Result",
  );
});

test("a typo'd task id errors without writes", () => {
  seedRunningAttempt();
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  assert.throws(
    () => planTaskSettle({ milestoneId: "M001", sliceId: "S01", taskId: "T99" }, "typo"),
    /unknown Task M001\/S01\/T99/,
  );
  assert.throws(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/typo"),
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T99" },
      reason: "typo",
    }),
    /unknown Task M001\/S01\/T99/,
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "a typo'd identifier must not write",
  );
  assert.equal(
    row("SELECT attempt_state AS state FROM workflow_execution_attempts").state,
    "running",
  );
});

test("apply refuses when the Attempt's lease is no longer held", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /no longer held/);

  assert.throws(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/released"),
      task: TASK,
      reason: "operator repair",
    }),
    /no longer held.*not authorized|replacement-lease/s,
  );
  assert.equal(
    readTaskAttempt(attemptId)?.state,
    "running",
    "the refused apply leaves the Attempt untouched",
  );
});

function taskLifecycleStatus(): string {
  return String(row(`
    SELECT lifecycle_status AS status
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T01'
  `).status);
}

function restoreSummary(dir: string, body: string, status: "pending" | "complete"): string {
  const summaryPath = join(dir, "T01-SUMMARY.md");
  writeFileSync(summaryPath, body);
  db().prepare(`
    UPDATE tasks SET status = :status, full_summary_md = :body
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({ ":status": status, ":body": body });
  return summaryPath;
}

test("reconcileLifecycle adopts ready for pending after interrupt without deleting SUMMARYs", () => {
  const { dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);

  const dryRun = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(dryRun.rows.length, 1);
  assert.deepEqual(
    dryRun.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->paused", "paused->ready"],
  );
  assert.equal(taskLifecycleStatus(), "in_progress", "dry-run must not adopt lifecycle");

  const settled = applyTaskSettle({
    invocation: invocation("settle/reconcile/pending/settle"),
    task: TASK,
    reason: "operator repair",
  });
  assert.equal(settled.settled, true);
  const summaryPath = restoreSummary(dir, "# Pending repair SUMMARY", "pending");

  const planned = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(planned.rows.length, 0);
  assert.deepEqual(
    planned.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->paused", "paused->ready"],
  );

  const applied = applyTaskSettle({
    invocation: invocation("settle/reconcile/pending"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, false);
  assert.equal(applied.reconciled, true);
  assert.equal(taskLifecycleStatus(), "ready");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "pending");
  assert.equal(row("SELECT full_summary_md AS body FROM tasks WHERE id = 'T01'").body, "# Pending repair SUMMARY");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Pending repair SUMMARY");

  const again = applyTaskSettle({
    invocation: invocation("settle/reconcile/pending/2"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(again.settled, false);
  assert.equal(again.reconciled, false);
  assert.equal(taskLifecycleStatus(), "ready");
});

test("reconcileLifecycle adopts completed for complete after interrupt without deleting SUMMARYs", () => {
  const { dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  const summaryPath = restoreSummary(dir, "# Completed repair SUMMARY", "complete");

  const applied = applyTaskSettle({
    invocation: invocation("settle/reconcile/complete"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, true);
  assert.equal(applied.reconciled, true);
  assert.deepEqual(
    applied.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->completed"],
  );
  assert.equal(taskLifecycleStatus(), "completed");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "complete");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Completed repair SUMMARY");
  assert.equal(applied.proof?.attemptId ?? null, null);
  assert.match(
    applied.proof?.note ?? "",
    /no current passing Technical Verdict/,
  );
});

test("reconcileLifecycle reports when completed repair still lacks passing proof (#1749)", () => {
  const { dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().prepare(`
    UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  const plan = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(plan.proof?.attemptId ?? null, null);
  assert.match(
    plan.proof?.note ?? "",
    /gsd_slice_complete will still refuse/,
  );
});
