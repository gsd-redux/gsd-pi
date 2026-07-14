import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendEvent, readEvents } from "../workflow-events.ts";
import { listConflicts, reconcileWorktreeLogs, resolveConflict } from "../workflow-reconcile.ts";
import {
  _getAdapter,
  closeDatabase,
  getSlice,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";

const tmpDirs: string[] = [];

function makeTmpRepo(): { main: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "workflow-reconcile-"));
  const main = join(root, "main");
  const worktree = join(root, "worktree");
  mkdirSync(main, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  tmpDirs.push(root);
  return { main, worktree };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on platforms that keep files open briefly.
    }
  }
  tmpDirs.length = 0;
});

test("resolveConflict(pick=main) rewrites the worktree log durably", () => {
  const { main, worktree } = makeTmpRepo();

  appendEvent(main, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Base Milestone" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });
  appendEvent(worktree, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Base Milestone" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });

  appendEvent(main, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Main Choice" },
    ts: "2026-01-01T00:01:00.000Z",
    actor: "agent",
  });

  appendEvent(worktree, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Worktree Choice" },
    ts: "2026-01-01T00:01:00.000Z",
    actor: "agent",
  });

  const initial = reconcileWorktreeLogs(main, worktree);
  assert.equal(initial.conflicts.length, 1, "expected one conflict before resolution");
  assert.ok(listConflicts(main).length === 1, "CONFLICTS.md should exist after detection");

  resolveConflict(main, worktree, "milestone:M001", "main");

  assert.equal(listConflicts(main).length, 0, "conflict file should be cleared after resolving main");
  const conflictsPath = join(main, ".gsd", "CONFLICTS.md");
  assert.equal(
    existsSync(conflictsPath),
    false,
    "CONFLICTS.md should be removed after the last conflict is resolved",
  );

  const wtEvents = readEvents(join(worktree, ".gsd", "event-log.jsonl"));
  assert.ok(
    wtEvents.some((e) => e.cmd === "plan_milestone" && e.params.title === "Main Choice"),
    "worktree log should be rewritten to the main-side resolution",
  );
  assert.ok(
    !wtEvents.some((e) => e.cmd === "plan_milestone" && e.params.title === "Worktree Choice"),
    "worktree log should no longer contain the discarded conflict event",
  );

  const second = reconcileWorktreeLogs(main, worktree);
  assert.equal(second.conflicts.length, 0, "reconcile should stay clean after choosing main");
});

test("reconcileWorktreeLogs treats canonical worktree project-ledger appends as already durable", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-reconcile-canonical-"));
  const main = join(root, "main");
  const worktree = join(main, ".gsd-worktrees", "M001");
  mkdirSync(worktree, { recursive: true });
  tmpDirs.push(root);

  appendEvent(worktree, {
    cmd: "complete-task",
    params: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });

  const result = reconcileWorktreeLogs(main, worktree);

  assert.equal(result.autoMerged, 0, "project-ledger append should not replay the root log");
  assert.equal(result.conflicts.length, 0, "missing worktree shard is not a conflict");
});

test("legacy Task events cannot overwrite adopted canonical lifecycle history", () => {
  const { main, worktree } = makeTmpRepo();
  mkdirSync(join(main, ".gsd"), { recursive: true });
  openDatabase(join(main, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "pending" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "test:workflow-reconcile:task-ready",
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
      adoptedFromStatus: "pending",
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
        projectionKey: "test/task/ready",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  closeDatabase();

  appendEvent(worktree, {
    cmd: "complete-task",
    params: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });

  reconcileWorktreeLogs(main, worktree);

  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  assert.equal(
    _getAdapter()?.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE task_id = 'T01'").get()?.lifecycle_status,
    "ready",
  );
});

test("legacy Slice completion cannot overwrite adopted canonical lifecycle history", () => {
  const { main, worktree } = makeTmpRepo();
  mkdirSync(join(main, ".gsd"), { recursive: true });
  openDatabase(join(main, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.slice.ready",
    idempotencyKey: "test:workflow-reconcile:slice-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { sliceId: "S01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "ready",
      adoptedFromStatus: "pending",
    });
    return {
      events: [{
        eventType: "test.slice.ready",
        entityType: "slice",
        entityId: "M001/S01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/slice/ready",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  closeDatabase();

  appendEvent(worktree, {
    cmd: "complete-slice",
    params: { milestoneId: "M001", sliceId: "S01" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });

  reconcileWorktreeLogs(main, worktree);

  assert.equal(getSlice("M001", "S01")?.status, "pending");
  assert.equal(
    _getAdapter()?.prepare(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'
    `).get()?.lifecycle_status,
    "ready",
  );
});
