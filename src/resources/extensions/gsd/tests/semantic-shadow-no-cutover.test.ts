// Project/App: gsd-pi
// File Purpose: Behavior-first proof that semantic shadow state has not become read or routing authority.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { resolveDispatch } from "../auto-dispatch.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { markFailed, recordDispatchClaim } from "../db/unit-dispatches.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import {
  _getAdapter,
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { analyzeParallelEligibility } from "../parallel-eligibility.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function makeProject(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function seedLifecycle(
  input: Parameters<typeof adoptOrTransitionLifecycle>[1],
  operationSuffix: string,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "semantic-shadow.no-cutover.seed",
    idempotencyKey: `semantic-shadow/no-cutover/${operationSuffix}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "semantic-shadow-no-cutover",
    sourceTransport: "test",
    payload: {
      itemKind: input.itemKind,
      milestoneId: input.milestoneId,
      sliceId: input.sliceId ?? null,
      taskId: input.taskId ?? null,
      lifecycleStatus: input.lifecycleStatus,
    },
  }, (context) => {
    adoptOrTransitionLifecycle(context, input);
    return {
      events: [{
        eventType: "semantic-shadow.no-cutover.seeded",
        entityType: input.itemKind,
        entityId: [input.milestoneId, input.sliceId, input.taskId].filter(Boolean).join("/"),
        payload: { lifecycleStatus: input.lifecycleStatus },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `semantic-shadow/no-cutover/${operationSuffix.toLowerCase()}`,
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function readLifecycleStatus(itemKind: string): string {
  const db = _getAdapter();
  assert.ok(db);
  const row = db.prepare(
    "SELECT lifecycle_status FROM workflow_item_lifecycles WHERE item_kind = :itemKind",
  ).get({ ":itemKind": itemKind }) as { lifecycle_status: string } | undefined;
  assert.ok(row);
  return row.lifecycle_status;
}

function writeMilestoneContext(base: string, milestoneId: string): void {
  const directory = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "CONTEXT.md"), `# ${milestoneId}\n`);
}


test("legacy milestone status remains public when canonical lifecycle disagrees", async () => {
  const base = makeProject("gsd-no-cutover-status-");
  insertMilestone({
    id: "M001",
    title: "Legacy status wins",
    status: "active",
  });
  _getAdapter()?.prepare(
    "UPDATE milestones SET created_at = '2026-07-15T00:00:00.000Z' WHERE id = 'M001'",
  ).run();
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Legacy slice",
    status: "active",
    depends: [],
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Legacy task",
    status: "pending",
  });
  seedLifecycle({
    itemKind: "milestone",
    milestoneId: "M001",
    lifecycleStatus: "completed",
  }, "status-M001");

  assert.equal(readLifecycleStatus("milestone"), "completed");
  const result = await executeMilestoneStatus({ milestoneId: "M001" }, base);
  const expected = {
    milestoneId: "M001",
    title: "Legacy status wins",
    status: "active",
    createdAt: "2026-07-15T00:00:00.000Z",
    completedAt: null,
    dependsOn: [],
    sliceCount: 1,
    slices: [{
      id: "S01",
      status: "active",
      taskCounts: { total: 1, done: 0, pending: 1 },
    }],
  };
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected, null, 2) }]);
  assert.deepEqual(result.details, { operation: "milestone_status", ...expected });
});

test("legacy dependency and dispatch decisions win in both disagreement directions", async () => {
  const eligibilityBase = makeProject("gsd-no-cutover-eligibility-");
  for (const id of ["M001", "M002", "M003", "M004"]) {
    writeMilestoneContext(eligibilityBase, id);
  }
  insertMilestone({ id: "M001", title: "Legacy complete", status: "complete" });
  insertMilestone({
    id: "M002",
    title: "Allowed dependent",
    status: "active",
    depends_on: ["M001"],
  });
  insertMilestone({ id: "M003", title: "Legacy active", status: "active" });
  insertMilestone({
    id: "M004",
    title: "Blocked dependent",
    status: "active",
    depends_on: ["M003"],
  });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress" },
    "eligibility-complete",
  );
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M003", lifecycleStatus: "completed" },
    "eligibility-active",
  );
  invalidateStateCache();

  const eligibility = await analyzeParallelEligibility(eligibilityBase);
  assert.ok(eligibility.eligible.some((entry) => entry.milestoneId === "M002"));
  assert.ok(eligibility.ineligible.some((entry) => entry.milestoneId === "M004"));
  closeDatabase();

  const dispatchBase = makeProject("gsd-no-cutover-dispatch-");
  writeMilestoneContext(dispatchBase, "M010");
  insertMilestone({ id: "M010", title: "Dispatch", status: "active" });
  insertSlice({
    id: "S01", milestoneId: "M010", title: "Legacy skipped", status: "skipped", depends: [],
  });
  insertSlice({
    id: "S02", milestoneId: "M010", title: "Allowed target", status: "pending", depends: ["S01"],
  });
  insertSlice({
    id: "S03", milestoneId: "M010", title: "Legacy active", status: "active", depends: [],
  });
  insertSlice({
    id: "S04", milestoneId: "M010", title: "Blocked target", status: "pending", depends: ["S03"],
  });
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M010", sliceId: "S01", lifecycleStatus: "in_progress" },
    "dispatch-skipped",
  );
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M010", sliceId: "S03", lifecycleStatus: "completed" },
    "dispatch-active",
  );

  assert.equal(
    getPriorSliceCompletionBlocker(dispatchBase, "main", "execute-task", "M010/S02/T01"),
    null,
  );
  assert.match(
    getPriorSliceCompletionBlocker(dispatchBase, "main", "execute-task", "M010/S04/T01") ?? "",
    /dependency slice M010\/S03 is not complete/,
  );
});

test("resolveDispatch keeps legacy milestone status authoritative when canonical lifecycle disagrees", async () => {
  const base = makeProject("gsd-no-cutover-resolve-dispatch-");
  insertMilestone({ id: "M001", title: "Legacy active", status: "active" });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" },
    "resolve-dispatch-active",
  );

  const active = await resolveDispatch({
    basePath: base,
    mid: "M001",
    midTitle: "Legacy active",
    prefs: undefined,
    state: {
      activeMilestone: { id: "M001", title: "Legacy active" },
      activeSlice: null,
      activeTask: null,
      phase: "needs-discussion",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Legacy active", status: "active" }],
    },
  });
  assert.equal(active.action, "dispatch");
  assert.equal(active.unitType, "discuss-milestone");

  insertMilestone({ id: "M002", title: "Legacy complete", status: "complete" });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "in_progress" },
    "resolve-dispatch-complete",
  );
  const complete = await resolveDispatch({
    basePath: base,
    mid: "M002",
    midTitle: "Legacy complete",
    prefs: undefined,
    state: {
      activeMilestone: { id: "M002", title: "Legacy complete" },
      activeSlice: null,
      activeTask: null,
      phase: "needs-discussion",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M002", title: "Legacy complete", status: "complete" }],
    },
  });
  assert.equal(complete.action, "stop");
  assert.match(complete.reason, /Milestone M002 is closed/);
});

test("legacy validation assessment steers state when canonical lifecycle disagrees", async () => {
  const base = makeProject("gsd-no-cutover-state-");
  insertMilestone({ id: "M001", title: "State authority", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", depends: [] });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Done",
    status: "complete",
  });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" },
    "state-completed",
  );
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" },
    "state-slice",
  );
  seedLifecycle({
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    lifecycleStatus: "completed",
  }, "state-task");

  assert.equal((await deriveStateFromDb(base)).phase, "validating-milestone");

  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  invalidateStateCache();
  assert.equal((await deriveStateFromDb(base)).phase, "completing-milestone");

  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: "needs-remediation",
    scope: "milestone-validation",
    fullContent: "---\nverdict: needs-remediation\n---\n",
  });
  invalidateStateCache();
  const blocked = await deriveStateFromDb(base);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockers[0] ?? "", /needs-remediation/);
});

