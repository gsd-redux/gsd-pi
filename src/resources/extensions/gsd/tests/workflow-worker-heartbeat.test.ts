// Project/App: gsd-pi
// File Purpose: Unit tests for auto-mode worker heartbeat adapter.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  maintainWorkerHeartbeat,
  runWithWorkerHeartbeat,
  type MaintainWorkerHeartbeatDeps,
  type WorkerHeartbeatSession,
} from "../auto/workflow-worker-heartbeat.ts";

function makeDeps(overrides?: Partial<MaintainWorkerHeartbeatDeps>): {
  deps: MaintainWorkerHeartbeatDeps;
  calls: unknown[];
  errors: unknown[];
  misses: unknown[];
} {
  const calls: unknown[] = [];
  const errors: unknown[] = [];
  const misses: unknown[] = [];
  const deps: MaintainWorkerHeartbeatDeps = {
    heartbeatAutoWorker: workerId => calls.push(["heartbeat", workerId]),
    refreshMilestoneLease: (workerId, milestoneId, token) => {
      calls.push(["refresh", workerId, milestoneId, token]);
      return true;
    },
    logHeartbeatFailure: err => errors.push(err),
    logLeaseRefreshMiss: details => misses.push(details),
    ...overrides,
  };
  return { deps, calls, errors, misses };
}

test("maintainWorkerHeartbeat no-ops without a worker id", () => {
  const { deps, calls, errors } = makeDeps();

  maintainWorkerHeartbeat({}, deps);

  assert.deepEqual(calls, []);
  assert.deepEqual(errors, []);
});

test("maintainWorkerHeartbeat refreshes worker heartbeat without active lease", () => {
  const { deps, calls, errors } = makeDeps();

  maintainWorkerHeartbeat({ workerId: "worker-1" }, deps);

  assert.deepEqual(calls, [["heartbeat", "worker-1"]]);
  assert.deepEqual(errors, []);
});

test("maintainWorkerHeartbeat refreshes active milestone lease when token exists", () => {
  const { deps, calls, errors } = makeDeps();
  const session: WorkerHeartbeatSession = {
    workerId: "worker-1",
    currentMilestoneId: "M001",
    milestoneLeaseToken: 7,
  };

  maintainWorkerHeartbeat(session, deps);

  assert.deepEqual(calls, [
    ["heartbeat", "worker-1"],
    ["refresh", "worker-1", "M001", 7],
  ]);
  assert.deepEqual(errors, []);
});

test("maintainWorkerHeartbeat skips lease refresh when token is null", () => {
  const { deps, calls, errors } = makeDeps();

  maintainWorkerHeartbeat({
    workerId: "worker-1",
    currentMilestoneId: "M001",
    milestoneLeaseToken: null,
  }, deps);

  assert.deepEqual(calls, [["heartbeat", "worker-1"]]);
  assert.deepEqual(errors, []);
});

test("maintainWorkerHeartbeat logs and suppresses heartbeat failures", () => {
  const failure = new Error("db unavailable");
  const { deps, calls, errors } = makeDeps({
    heartbeatAutoWorker: workerId => {
      calls.push(["heartbeat", workerId]);
      throw failure;
    },
  });

  assert.doesNotThrow(() => {
    maintainWorkerHeartbeat({
      workerId: "worker-1",
      currentMilestoneId: "M001",
      milestoneLeaseToken: 7,
    }, deps);
  });

  assert.deepEqual(calls, [["heartbeat", "worker-1"]]);
  assert.deepEqual(errors, [failure]);
});

test("maintainWorkerHeartbeat logs and suppresses lease refresh failures", () => {
  const failure = new Error("lease stale");
  const { deps, calls, errors } = makeDeps({
    refreshMilestoneLease: (workerId, milestoneId, token) => {
      calls.push(["refresh", workerId, milestoneId, token]);
      throw failure;
    },
  });

  assert.doesNotThrow(() => {
    maintainWorkerHeartbeat({
      workerId: "worker-1",
      currentMilestoneId: "M001",
      milestoneLeaseToken: 7,
    }, deps);
  });

  assert.deepEqual(calls, [
    ["heartbeat", "worker-1"],
    ["refresh", "worker-1", "M001", 7],
  ]);
  assert.deepEqual(errors, [failure]);
});

test("maintainWorkerHeartbeat clears stale lease tokens when refresh misses", () => {
  const { deps, calls, errors, misses } = makeDeps({
    refreshMilestoneLease: (workerId, milestoneId, token) => {
      calls.push(["refresh", workerId, milestoneId, token]);
      return false;
    },
  });
  const session: WorkerHeartbeatSession = {
    workerId: "worker-1",
    currentMilestoneId: "M001",
    milestoneLeaseToken: 7,
  };

  maintainWorkerHeartbeat(session, deps);

  assert.deepEqual(calls, [
    ["heartbeat", "worker-1"],
    ["refresh", "worker-1", "M001", 7],
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(misses, [{
    workerId: "worker-1",
    milestoneId: "M001",
    fencingToken: 7,
  }]);
  assert.equal(session.milestoneLeaseToken, null);
});

test("runWithWorkerHeartbeat clears its interval when unit execution rejects", async () => {
  mock.timers.enable({ apis: ["setInterval"] });

  try {
    const failure = new Error("unit execution failed");
    const { deps, calls } = makeDeps();
    const session: WorkerHeartbeatSession = {
      workerId: "worker-1",
      currentMilestoneId: "M001",
      milestoneLeaseToken: 7,
    };

    await assert.rejects(
      runWithWorkerHeartbeat(session, deps, 1_000, async () => {
        throw failure;
      }),
      failure,
    );
    const callsAfterRejection = calls.length;

    mock.timers.tick(1_000);

    assert.equal(calls.length, callsAfterRejection);
  } finally {
    mock.timers.reset();
  }
});
