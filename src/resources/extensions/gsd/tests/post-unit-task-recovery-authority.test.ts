import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { postUnitPreVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function createTaskContext(basePath: string, pauseCalls: string[]): PostUnitContext {
  const session = new AutoSession();
  session.active = true;
  session.basePath = basePath;
  session.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  return {
    s: session,
    ctx: { ui: { notify: () => {} } } as unknown as PostUnitContext["ctx"],
    pi: {} as PostUnitContext["pi"],
    buildSnapshotOpts: () => ({}),
    lockBase: () => basePath,
    stopAuto: async () => {},
    pauseAuto: async () => {
      pauseCalls.push("pause");
    },
    updateProgressWidget: () => {},
  };
}

function scaffoldDbBackedTask(): string {
  closeDatabase();
  const basePath = makeTempRepo("gsd-post-unit-task-authority-");
  mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Task",
    status: "pending",
  });
  return basePath;
}

test("DB-backed execute-task missing an Attempt Result bypasses generic artifact retries", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  const pauseCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls);
  pctx.s.pendingVerificationRetry = {
    unitId: "M001/S01/T01",
    failureContext: "Legacy artifact retry",
    attempt: 3,
  };
  pctx.s.verificationRetryCount.set("execute-task:M001/S01/T01", 3);

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  assert.equal(result, "continue");
  assert.equal(pctx.s.pendingVerificationRetry, null);
  assert.equal(pctx.s.verificationRetryCount.size, 0);
  assert.deepEqual(pauseCalls, []);
});

test("DB-backed execute-task deterministic errors cannot write an artifact placeholder", async (t) => {
  const basePath = scaffoldDbBackedTask();
  t.after(() => {
    closeDatabase();
    cleanup(basePath);
  });
  const pauseCalls: string[] = [];
  const pctx = createTaskContext(basePath, pauseCalls);
  pctx.s.lastToolInvocationError =
    "gsd_task_complete: Error saving artifact: context write blocked";

  const result = await postUnitPreVerification(pctx, {
    skipSettleDelay: true,
    skipWorktreeSync: true,
  });

  assert.equal(result, "continue");
  assert.equal(
    existsSync(
      join(
        basePath,
        ".gsd",
        "milestones",
        "M001",
        "slices",
        "S01",
        "tasks",
        "T01-SUMMARY.md",
      ),
    ),
    false,
  );
  assert.equal(pctx.s.pendingVerificationRetry, null);
  assert.equal(pctx.s.lastToolInvocationError, null);
  assert.deepEqual(pauseCalls, []);
});
