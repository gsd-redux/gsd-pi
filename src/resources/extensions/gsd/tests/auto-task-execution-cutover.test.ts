// Project/App: gsd-pi
// File Purpose: Executable contract for fail-closed canonical Task execution in auto-mode.

import assert from "node:assert/strict";
import test from "node:test";

type UnitPhaseResult =
  | { action: "break"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "next"; data: { requestDispatchedAt?: number } };

interface TaskIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface AttemptSnapshot {
  attemptId: string;
  attemptNumber: number;
  state: "running" | "settled";
  outcome?: "succeeded" | "failed" | "interrupted";
  nextStage: "execute" | "verify" | "route";
}

interface CutoverInput {
  unitType: string;
  unitId: string;
  dispatchId: number | null;
  workerId: string | null;
  milestoneLeaseToken: number | null;
  traceId: string;
  turnId: string;
  markCanonicalDispatchSettled(): void;
}

interface CutoverDeps {
  readLatestTaskAttempt(task: TaskIdentity): AttemptSnapshot | null;
  readTaskAttempt(attemptId: string): AttemptSnapshot | null;
  claimTaskAttempt(input: {
    invocation: {
      idempotencyKey: string;
      sourceTransport: "internal";
      actorType: string;
      actorId?: string;
      traceId?: string;
      turnId?: string;
    };
    task: TaskIdentity;
    workerId: string;
    milestoneLeaseToken: number;
    coordinationDispatchId: number;
    retryOfAttemptId?: string;
  }): {
    status: "committed" | "replayed";
    operationId: string;
    resultingRevision: number;
    attemptId: string;
    attemptNumber: number;
  };
  settleTaskAttempt(input: {
    invocation: { idempotencyKey: string; sourceTransport: "internal"; actorType: string };
    attemptId: string;
    outcome: "failed";
    failureClass: string;
    summary: string;
    output: Record<string, unknown>;
  }): {
    status: "committed" | "replayed";
    operationId: string;
    resultingRevision: number;
    resultId: string;
    nextStage: "route";
  };
}

interface CutoverSubject {
  runWithTaskExecutionAttempt<T extends UnitPhaseResult>(
    input: CutoverInput,
    run: () => Promise<T>,
    deps: CutoverDeps,
  ): Promise<T>;
}

async function subject(): Promise<CutoverSubject> {
  return import("../auto/task-execution-cutover.js") as Promise<CutoverSubject>;
}

function input(overrides: Partial<CutoverInput> = {}): CutoverInput {
  return {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    dispatchId: 41,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    traceId: "trace-1",
    turnId: "turn-1",
    markCanonicalDispatchSettled() {},
    ...overrides,
  };
}

function fakeDomain() {
  const calls: Array<{ name: string; value?: unknown }> = [];
  const attempts: AttemptSnapshot[] = [];
  const claims: Array<Parameters<CutoverDeps["claimTaskAttempt"]>[0]> = [];
  const settlements: Array<Parameters<CutoverDeps["settleTaskAttempt"]>[0]> = [];

  const deps: CutoverDeps = {
    readLatestTaskAttempt(task) {
      calls.push({ name: "read-latest", value: task });
      return attempts.at(-1) ?? null;
    },
    readTaskAttempt(attemptId) {
      calls.push({ name: "read-attempt", value: attemptId });
      return attempts.find((attempt) => attempt.attemptId === attemptId) ?? null;
    },
    claimTaskAttempt(claim) {
      calls.push({ name: "claim", value: claim });
      claims.push(claim);
      const attempt: AttemptSnapshot = {
        attemptId: `attempt-${attempts.length + 1}`,
        attemptNumber: attempts.length + 1,
        state: "running",
        nextStage: "execute",
      };
      attempts.push(attempt);
      return {
        status: "committed",
        operationId: `claim-operation-${attempt.attemptNumber}`,
        resultingRevision: attempt.attemptNumber,
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
      };
    },
    settleTaskAttempt(settlement) {
      calls.push({ name: "settle", value: settlement });
      settlements.push(settlement);
      const attempt = attempts.find((candidate) => candidate.attemptId === settlement.attemptId);
      assert.ok(attempt);
      attempt.state = "settled";
      attempt.outcome = "failed";
      attempt.nextStage = "route";
      return {
        status: "committed",
        operationId: `settle-operation-${attempt.attemptNumber}`,
        resultingRevision: attempt.attemptNumber + 1,
        resultId: `result-${attempt.attemptNumber}`,
        nextStage: "route",
      };
    },
  };

  return {
    calls,
    claims,
    settlements,
    attempts,
    deps,
    completeSucceeded(attemptId: string) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      assert.ok(attempt);
      attempt.state = "settled";
      attempt.outcome = "succeeded";
      attempt.nextStage = "verify";
    },
  };
}

test("non-task units pass through without reading or mutating Task execution authority", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  let runs = 0;
  const expected = { action: "next", data: { requestDispatchedAt: 123 } } as const;

  const result = await runWithTaskExecutionAttempt(input({
    unitType: "plan-slice",
    unitId: "M001/S01",
    dispatchId: null,
    workerId: null,
    milestoneLeaseToken: null,
  }), async () => {
    runs += 1;
    return expected;
  }, domain.deps);

  assert.equal(result, expected);
  assert.equal(runs, 1);
  assert.deepEqual(domain.calls, []);
});

for (const missing of [
  { field: "dispatch", overrides: { dispatchId: null } },
  { field: "worker", overrides: { workerId: null } },
  { field: "lease", overrides: { milestoneLeaseToken: null } },
] as const) {
  test(`execute-task fails closed without ${missing.field} identity before running the unit`, async () => {
    const { runWithTaskExecutionAttempt } = await subject();
    const domain = fakeDomain();
    let ran = false;

    await assert.rejects(
      runWithTaskExecutionAttempt(input(missing.overrides), async () => {
        ran = true;
        return { action: "next", data: {} };
      }, domain.deps),
      new RegExp(missing.field, "i"),
    );

    assert.equal(ran, false);
    assert.deepEqual(domain.calls, []);
  });
}

test("execute-task commits its canonical claim before running and accepts only succeeded verify-stage completion", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  const order: string[] = [];
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      order.push("marked");
      dispatchSettled = true;
    },
  }), async () => {
    order.push("run");
    assert.equal(domain.attempts.length, 1, "Attempt must exist before provider execution");
    domain.completeSucceeded(domain.attempts[0].attemptId);
    return { action: "next", data: { requestDispatchedAt: 456 } };
  }, {
    ...domain.deps,
    claimTaskAttempt(claim) {
      order.push("claim");
      return domain.deps.claimTaskAttempt(claim);
    },
  });

  assert.deepEqual(order, ["claim", "run", "marked"]);
  assert.deepEqual(result, { action: "next", data: { requestDispatchedAt: 456 } });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 0);
  assert.deepEqual(domain.claims[0], {
    invocation: {
      idempotencyKey: "internal:auto:attempt.claim:41",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "worker-1",
      traceId: "trace-1",
      turnId: "turn-1",
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: 41,
  });
});

test("execute-task next without a succeeded Result settles failed and becomes a retry", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      dispatchSettled = true;
    },
  }), async () => ({ action: "next", data: {} }), domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "missing-executor-result" });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 1);
  assert.equal(domain.settlements[0].attemptId, "attempt-1");
  assert.equal(domain.settlements[0].outcome, "failed");
  assert.match(domain.settlements[0].failureClass, /missing|executor/i);
  assert.equal(
    domain.settlements[0].invocation.idempotencyKey,
    "internal:auto:attempt.settle:attempt-1",
  );
});

test("execute-task next does not advance a failed canonical Result into verification", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  let dispatchSettled = false;

  const result = await runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      dispatchSettled = true;
    },
  }), async () => {
    const attempt = domain.attempts[0];
    attempt.state = "settled";
    attempt.outcome = "failed";
    attempt.nextStage = "route";
    return { action: "next", data: {} };
  }, domain.deps);

  assert.deepEqual(result, { action: "retry", reason: "executor-result-failed" });
  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 0, "an immutable failed Result must not be settled twice");
});

for (const phaseResult of [
  { action: "retry", reason: "zero-tool-calls" },
  { action: "break", reason: "provider-pause" },
] as const) {
  test(`execute-task ${phaseResult.action} settles failed and marks its canonical dispatch settled`, async () => {
    const { runWithTaskExecutionAttempt } = await subject();
    const domain = fakeDomain();
    let dispatchSettled = false;

    const result = await runWithTaskExecutionAttempt(input({
      markCanonicalDispatchSettled() {
        dispatchSettled = true;
      },
    }), async () => phaseResult, domain.deps);

    assert.equal(result, phaseResult);
    assert.equal(dispatchSettled, true);
    assert.equal(domain.settlements.length, 1);
    assert.equal(domain.settlements[0].outcome, "failed");
    assert.match(domain.settlements[0].summary, new RegExp(phaseResult.reason, "i"));
  });
}

test("execute-task exceptions settle failed and mark the canonical dispatch before rethrowing", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();
  const failure = new Error("provider exploded");
  let dispatchSettled = false;

  await assert.rejects(runWithTaskExecutionAttempt(input({
    markCanonicalDispatchSettled() {
      dispatchSettled = true;
    },
  }), async () => {
    throw failure;
  }, domain.deps), failure);

  assert.equal(dispatchSettled, true);
  assert.equal(domain.settlements.length, 1);
  assert.equal(domain.settlements[0].outcome, "failed");
  assert.match(domain.settlements[0].summary, /provider exploded/i);
});

test("a retry claim links the immediately preceding settled Attempt", async () => {
  const { runWithTaskExecutionAttempt } = await subject();
  const domain = fakeDomain();

  await runWithTaskExecutionAttempt(input(), async () => ({
    action: "retry",
    reason: "executor asked to retry",
  }), domain.deps);

  await runWithTaskExecutionAttempt(input({ dispatchId: 42 }), async () => {
    domain.completeSucceeded("attempt-2");
    return { action: "next", data: {} };
  }, domain.deps);

  assert.equal(domain.claims.length, 2);
  assert.equal(domain.claims[0].retryOfAttemptId, undefined);
  assert.equal(domain.claims[1].retryOfAttemptId, "attempt-1");
  assert.equal(domain.claims[1].invocation.idempotencyKey, "internal:auto:attempt.claim:42");
});
