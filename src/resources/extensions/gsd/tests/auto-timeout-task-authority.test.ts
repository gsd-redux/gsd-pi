// Project/App: gsd-pi
// File Purpose: Timeout recovery must recognize only canonical succeeded Task Attempts.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { recoverTimedOutUnit } from "../auto-timeout-recovery.js";
import { _getAdapter, closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.js";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.js";

test("timeout recovery finalizes only a canonically succeeded Task Attempt", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-timeout-task-authority-"));
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01\n\n## Tasks\n\n- [ ] **T01: Task** `est:10m`\n",
  );
  writeFileSync(join(basePath, ".gsd", "STATE.md"), "## Next Action\nExecute T01 for S01: Task\n");
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "in_progress" });
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
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
      'trace-1', 'turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const dispatch = adapter.prepare("SELECT id FROM unit_dispatches").get();
  const invocation = (idempotencyKey: string) => ({
    idempotencyKey,
    sourceTransport: "internal" as const,
    actorType: "agent" as const,
    actorId: "timeout-test",
  });
  const claim = claimTaskAttempt({
    invocation: invocation("timeout/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch?.["id"]),
  });
  settleTaskAttempt({
    invocation: invocation("timeout/settle"),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Executor produced a candidate Result",
    output: { changedFiles: ["tracked.ts"] },
  });
  const messages: unknown[] = [];

  const result = await recoverTimedOutUnit(
    { ui: { notify() {} } } as never,
    { sendMessage(message: unknown) { messages.push(message); } } as never,
    "execute-task",
    "M001/S01/T01",
    "idle",
    {
      basePath,
      verbose: false,
      currentUnitStartedAt: Date.now(),
      unitRecoveryCount: new Map(),
    },
  );

  assert.equal(result, "recovered");
  assert.equal(messages.length, 0);
  const runtime = JSON.parse(readFileSync(
    join(basePath, ".gsd", "runtime", "units", "execute-task-M001-S01-T01.json"),
    "utf-8",
  ));
  assert.equal(runtime.phase, "finalized");
});
