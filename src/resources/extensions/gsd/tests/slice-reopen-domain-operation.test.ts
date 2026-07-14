// Project/App: gsd-pi
// File Purpose: Executable contracts for atomic full-redo Slice reopen Domain Operations.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import * as sliceLifecycle from "../slice-lifecycle-domain-operation.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import { handleReopenSlice } from "../tools/reopen-slice.ts";
import { handleResetSlice } from "../undo.ts";

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
    actorId: "slice-reopen-test",
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

function completeTaskWithEvidence(taskId: string): void {
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertClaimedDispatch(taskId),
  });
  settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/settle`),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Completed before the Slice was reopened",
    output: { artifact: "immutable-completed-history" },
  });
  recordTaskTechnicalVerdict({
    invocation: invocation(`fixture/${taskId}/verify`),
    attemptId: claim.attemptId,
    testedSourceRevision: "git:fixture-source-revision",
    verdict: "pass",
    rationale: "Fixture verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test fixture",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-14T00:01:00.000Z",
      endedAt: "2026-07-14T00:01:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: `db://fixture/${taskId}/verification`,
      environment: { runner: "node-test", fixture: "slice-reopen" },
    },
  });
}

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-reopen-domain-"));
  tempDirs.add(base);
  const phaseDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(
    join(phaseDir, "01-01-PLAN.md"),
    "# S01\n\n- [x] **T01**: Completed\n- [x] **T02**: Cancelled\n",
  );
  writeFileSync(
    join(phaseDir, "M001-ROADMAP.md"),
    "# Roadmap\n\n- [x] **S01: Full redo** `risk:low` `depends:[]`\n",
  );
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function seedTerminalSlice(
  sliceStatus: "complete" | "skipped" = "complete",
  options: { runningChild?: boolean } = {},
): string {
  const base = makeBase();
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Slice lifecycle', 'active', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Full redo', 'in_progress', '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Completed child', 'pending', 1),
      ('M001', 'S01', 'T02', 'Cancelled child', 'pending', 2);
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
  if (options.runningChild) {
    db().prepare(`
      INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
      VALUES ('M001', 'S01', 'T03', 'Running child', 'pending', 3)
    `).run();
  }

  executeAtFence("test.slice-reopen.ready", "fixture/slice-reopen/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "in_progress",
    });
    for (const taskId of options.runningChild ? ["T01", "T02", "T03"] : ["T01", "T02"]) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId,
        lifecycleStatus: "ready",
      });
    }
  });

  completeTaskWithEvidence("T01");
  if (options.runningChild) {
    const runningClaim = claimTaskAttempt({
      invocation: invocation("fixture/T03/claim"),
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T03" },
      workerId: "worker-1",
      milestoneLeaseToken: 7,
      coordinationDispatchId: insertClaimedDispatch("T03"),
    });
    assert.ok(runningClaim.attemptId);
  }

  const canonicalSliceStatus = sliceStatus === "complete" ? "completed" : "cancelled";
  executeAtFence("test.slice-reopen.terminal", "fixture/slice-reopen/terminal", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: canonicalSliceStatus,
    });
    db().prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-14T00:02:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    db().prepare(`
      UPDATE tasks SET status = 'skipped', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'
    `).run();
    db().prepare(`
      UPDATE slices SET status = :status, completed_at = :completed_at
      WHERE milestone_id = 'M001' AND id = 'S01'
    `).run({
      ":status": sliceStatus,
      ":completed_at": sliceStatus === "complete" ? "2026-07-14T00:02:00.000Z" : null,
    });
  });
  return base;
}

function taskEvidenceSnapshot(taskId = "T01"): Record<string, unknown> {
  const lifecycleId = String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001'
      AND slice_id = 'S01' AND task_id = '${taskId}'
  `).lifecycle_id);
  return {
    attempts: rows(`SELECT * FROM workflow_execution_attempts WHERE lifecycle_id = '${lifecycleId}' ORDER BY attempt_number`),
    results: rows(`SELECT * FROM workflow_attempt_results WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    verdicts: rows(`SELECT * FROM workflow_technical_verdicts WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    evidence: rows(`SELECT * FROM workflow_verification_evidence WHERE lifecycle_id = '${lifecycleId}' ORDER BY created_at`),
    kernelCheckpoints: rows(`SELECT * FROM workflow_kernel_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY sequence`),
    workCheckpoints: rows(`SELECT * FROM workflow_work_checkpoints WHERE lifecycle_id = '${lifecycleId}' ORDER BY project_revision`),
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    kernelCheckpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY lifecycle_id, sequence"),
    workCheckpoints: rows("SELECT * FROM workflow_work_checkpoints ORDER BY project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
  };
}

function assertFullRedoState(): void {
  assert.deepEqual(row(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_status AS canonical_status
    FROM slices slice
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
    WHERE slice.milestone_id = 'M001' AND slice.id = 'S01'
  `), { legacy_status: "in_progress", canonical_status: "ready" });
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
    { id: "T01", legacy_status: "pending", canonical_status: "ready" },
    { id: "T02", legacy_status: "pending", canonical_status: "ready" },
  ]);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("public reopen performs one full-redo Slice Domain Operation and preserves prior execution evidence", async () => {
  const base = seedTerminalSlice("complete");
  const historyBefore = taskEvidenceSnapshot();
  const revisionBefore = Number(row("SELECT revision FROM project_authority").revision);
  const reopenOperationsBefore = Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count);

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Requirements changed, so the entire Slice must be redone.",
    invocation: invocation("slice-reopen/public/full-redo"),
  } as Parameters<typeof handleReopenSlice>[0] & { invocation: ExecutionInvocation }, base);

  assert.equal("error" in result, false, "public reopen must accept canonical terminal history");
  assert.equal(Number(row("SELECT revision FROM project_authority").revision), revisionBefore + 1);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), reopenOperationsBefore + 1);
  assert.deepEqual(row(`
    SELECT event_type, entity_type, entity_id
    FROM workflow_domain_events
    WHERE operation_id = (
      SELECT operation_id FROM workflow_operations WHERE operation_type = 'slice.reopen'
      ORDER BY resulting_revision DESC LIMIT 1
    )
  `), {
    event_type: "slice.reopened",
    entity_type: "slice",
    entity_id: "M001/S01",
  });
  assertFullRedoState();
  assert.deepEqual(taskEvidenceSnapshot(), historyBefore, "reopen must not rewrite prior evidence history");
});

test("public reset is a compatibility adapter to the same atomic Slice reopen operation", async () => {
  const base = seedTerminalSlice("skipped");
  const historyBefore = taskEvidenceSnapshot();
  const revisionBefore = Number(row("SELECT revision FROM project_authority").revision);
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await handleResetSlice("M001/S01 --force", ctx as never, {} as never, base);

  assert.equal(notifications.at(-1)?.level, "success", notifications.at(-1)?.message);
  assert.equal(Number(row("SELECT revision FROM project_authority").revision), revisionBefore + 1);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
  `).count), 1);
  assertFullRedoState();
  assert.deepEqual(taskEvidenceSnapshot(), historyBefore, "reset must preserve immutable execution evidence");
});

test("public reopen rejects a running descendant and leaves exact zero durable residue", async () => {
  const base = seedTerminalSlice("complete", { runningChild: true });
  const before = durableSnapshot();

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "A running child makes full redo unsafe.",
    invocation: invocation("slice-reopen/public/running-reject"),
  } as Parameters<typeof handleReopenSlice>[0] & { invocation: ExecutionInvocation }, base);

  assert.equal("error" in result, true);
  assert.match("error" in result ? result.error : "", /running attempt|running descendant/i);
  assert.deepEqual(durableSnapshot(), before, "running-descendant rejection must leave zero residue");
});

test("public reopen rejects a deep legacy/canonical mismatch with exact zero durable residue", async () => {
  const base = seedTerminalSlice("complete");
  db().prepare(`
    UPDATE tasks SET status = 'pending', completed_at = NULL
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'
  `).run();
  const before = durableSnapshot();

  const result = await handleReopenSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Contradictory authority must not be repaired by guessing.",
    invocation: invocation("slice-reopen/public/mismatch-reject"),
  } as Parameters<typeof handleReopenSlice>[0] & { invocation: ExecutionInvocation }, base);

  assert.equal("error" in result, true);
  assert.match("error" in result ? result.error : "", /canonical|legacy|shadow|mismatch/i);
  assert.deepEqual(durableSnapshot(), before, "deep mismatch rejection must leave zero residue");
});

test("direct Slice reopen replays its durable receipt and rejects changed idempotency reuse", () => {
  seedTerminalSlice("complete");
  const reopen = (sliceLifecycle as unknown as {
    reopenSlice?: (input: {
      invocation: ExecutionInvocation;
      slice: { milestoneId: string; sliceId: string };
      reason: string;
    }) => Record<string, unknown>;
  }).reopenSlice;
  assert.equal(typeof reopen, "function", "Slice lifecycle module must expose the reopen Domain Operation");
  const input = {
    invocation: invocation("slice-reopen/direct/replay"),
    slice: { milestoneId: "M001", sliceId: "S01" },
    reason: "Repeat this exact full-redo request safely.",
  };

  const committed = reopen!(input);
  const afterCommit = durableSnapshot();
  const replayed = reopen!(input);

  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(durableSnapshot(), afterCommit, "exact replay must not duplicate durable lineage");

  assert.throws(() => reopen!({
    ...input,
    reason: "A changed reason under the same invocation identity.",
  }), /idempotency conflict/i);
  assert.deepEqual(durableSnapshot(), afterCommit, "changed idempotency reuse must leave zero residue");
});
