// Project/App: gsd-pi
// File Purpose: Fault-injection contract for atomic planning authority and replay convergence.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import {
  _setDomainOperationFaultForTest,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import { handlePlanTask, type PlanTaskParams, type PlanTaskResult } from "../tools/plan-task.ts";
import { handleReplanTask, type ReplanTaskParams } from "../tools/replan-task.ts";
import type { PlanningInvocation } from "../planning-invocation.ts";

const precommitFaults: DomainOperationFaultPoint[] = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
];

const tempDirs = new Set<string>();

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeFixture(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-planning-fault-")));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "input.ts"), "export const input = true;\n");
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Fault matrix", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Atomic task", status: "pending", demo: "Task is planned." });
  return base;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function count(table: string, where = ""): number {
  return Number(db().prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get()?.["count"] ?? 0);
}

function params(): PlanTaskParams {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    title: "Persist one atomic plan",
    description: "Every planning authority row commits together.",
    estimate: "30m",
    files: ["src/output.ts"],
    verify: "node --test planning.test.ts",
    inputs: ["src/input.ts"],
    expectedOutput: ["src/output.ts"],
  };
}

function invocation(idempotencyKey = "fault-matrix/plan-task"): PlanningInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "fault-matrix",
    traceId: "trace-fault-matrix",
    turnId: "turn-fault-matrix",
  };
}

function authorityResidue() {
  return {
    revision: db().prepare("SELECT revision FROM project_authority").get()?.["revision"],
    tasks: count("tasks", "WHERE milestone_id = 'M001' AND slice_id = 'S01'"),
    gates: count("quality_gates"),
    history: count("replan_history"),
    operations: count("workflow_operations"),
    lifecycles: count("workflow_item_lifecycles"),
    events: count("workflow_domain_events"),
    outbox: count("workflow_outbox"),
    projections: count("workflow_projection_work"),
  };
}

for (const fault of precommitFaults) {
  test(`plan-task ${fault} fault rolls back every authority surface`, async () => {
    const base = makeFixture();
    _setDomainOperationFaultForTest(fault);

    const result = await handlePlanTask(params(), base, invocation());

    assert.ok("error" in result);
    assert.match(result.error, new RegExp(fault));
    assert.deepEqual(authorityResidue(), {
      revision: 0,
      tasks: 0,
      gates: 0,
      history: 0,
      operations: 0,
      lifecycles: 0,
      events: 0,
      outbox: 0,
      projections: 0,
    });
    assert.equal(existsSync(join(base, ".gsd", "phases", "01-test", "01-01-PLAN.md")), false);
    assert.equal(existsSync(join(base, ".gsd", "event-log.jsonl")), false);
  });
}

test("plan-task after-commit fault converges on exact retry without duplicate authority or JSONL", async () => {
  const base = makeFixture();
  const planPath = join(base, ".gsd", "phases", "01-test", "01-01-PLAN.md");
  const eventLogPath = join(base, ".gsd", "event-log.jsonl");
  const committedResidue = {
    revision: 1,
    tasks: 1,
    gates: 3,
    history: 0,
    operations: 1,
    lifecycles: 2,
    events: 1,
    outbox: 1,
    projections: 1,
  };
  _setDomainOperationFaultForTest("after-commit");

  const lostResponse = await handlePlanTask(params(), base, invocation());
  assert.ok("error" in lostResponse);
  assert.match(lostResponse.error, /after-commit/);
  assert.deepEqual(authorityResidue(), committedResidue);
  assert.equal(existsSync(planPath), false, "projection rendering must not be mistaken for the canonical commit");
  assert.equal(existsSync(eventLogPath), false, "the legacy JSONL hook did not run before the simulated process loss");

  _setDomainOperationFaultForTest(null);
  const replay = await handlePlanTask(params(), base, invocation());
  const expected: PlanTaskResult = {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    taskPlanPath: planPath,
  };
  assert.deepEqual(replay, expected);
  assert.match(readFileSync(planPath, "utf8"), /Persist one atomic plan/);
  assert.deepEqual(authorityResidue(), committedResidue);
  assert.equal(existsSync(eventLogPath), false, "a replay must not invent or duplicate the committed-only legacy JSONL event");

  const repeatedReplay = await handlePlanTask(params(), base, invocation());
  assert.deepEqual(repeatedReplay, expected);
  assert.deepEqual(authorityResidue(), committedResidue);
  assert.equal(existsSync(eventLogPath), false);
});

test("replan-task after-mutation fault restores prior planning, lifecycle, history, and operation state", async () => {
  const base = makeFixture();
  const planned = await handlePlanTask(params(), base, invocation());
  assert.ok(!("error" in planned));
  const before = {
    authority: authorityResidue(),
    task: db().prepare(`
      SELECT title, description, estimate, files, verify, inputs, expected_output
      FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).get(),
    lifecycles: db().prepare(`
      SELECT item_kind, lifecycle_status, state_version, last_operation_id, last_project_revision
      FROM workflow_item_lifecycles ORDER BY item_kind, task_id
    `).all(),
    eventLog: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
  };
  const replan: ReplanTaskParams = {
    ...params(),
    title: "This update must roll back",
    description: "The injected fault occurs after planning and history writes.",
    reworkBriefRef: "RB-FAULT",
  };
  _setDomainOperationFaultForTest("after-mutation");

  const failed = await handleReplanTask(replan, base, invocation("fault-matrix/replan-task"));

  assert.ok("error" in failed);
  assert.match(failed.error, /after-mutation/);
  assert.deepEqual({
    authority: authorityResidue(),
    task: db().prepare(`
      SELECT title, description, estimate, files, verify, inputs, expected_output
      FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).get(),
    lifecycles: db().prepare(`
      SELECT item_kind, lifecycle_status, state_version, last_operation_id, last_project_revision
      FROM workflow_item_lifecycles ORDER BY item_kind, task_id
    `).all(),
    eventLog: readFileSync(join(base, ".gsd", "event-log.jsonl"), "utf8"),
  }, before);
});
