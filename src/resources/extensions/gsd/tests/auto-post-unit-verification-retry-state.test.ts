// Project/App: gsd-pi
// File Purpose: Verification retry state lifecycle regression tests for DB-backed Tasks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postUnitPreVerification } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { verificationRetryKey } from "../auto/verification-retry-policy.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim } from "../db/unit-dispatches.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { normalizeRealPath } from "../paths.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";

function createTaskFixture(t: { after(fn: () => void): void }): {
  base: string;
  session: AutoSession;
  retryKey: string;
} {
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-state-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* database may already be closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nversion: 1\n---\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Milestone\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), "# Slice\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md"), "# Task\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "pending" });

  const session = new AutoSession();
  session.active = true;
  session.basePath = base;
  session.originalBasePath = base;
  // canonicalProjectRoot is a derived getter — with basePath/originalBasePath
  // set above it already resolves to normalizeRealPath(base).
  session.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
  const retryKey = verificationRetryKey("execute-task", "M001/S01/T01");
  session.verificationRetryCount.set(retryKey, 1);
  session.verificationRetryFailureHashes.set(retryKey, "same-host-gate-failure");
  return { base, session, retryKey };
}

async function runPreVerification(session: AutoSession): Promise<string> {
  return postUnitPreVerification(
    {
      s: session,
      ctx: { ui: { notify() {} } } as any,
      pi: {} as any,
      buildSnapshotOpts: () => ({}) as any,
      lockBase: () => session.basePath,
      stopAuto: async () => {},
      pauseAuto: async () => {},
      updateProgressWidget: () => {},
    },
    { skipSettleDelay: true, skipWorktreeSync: true },
  );
}

test("DB-backed Task artifact readiness preserves host verification retry state", async (t) => {
  const { base, session, retryKey } = createTaskFixture(t);
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const dispatch = recordDispatchClaim({
    traceId: "post-unit-retry-state",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
  });
  assert.equal(dispatch.ok, true);
  if (!dispatch.ok) return;
  const attempt = claimTaskAttempt({
    invocation: internalExecutionInvocation("test:post-unit-retry-state:claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId,
    milestoneLeaseToken: lease.token,
    coordinationDispatchId: dispatch.dispatchId,
  });
  settleTaskAttempt({
    invocation: internalExecutionInvocation("test:post-unit-retry-state:settle"),
    attemptId: attempt.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "candidate awaits host verification",
    output: {},
  });

  assert.equal(await runPreVerification(session), "continue");
  assert.equal(session.verificationRetryCount.get(retryKey), 1);
  assert.equal(session.verificationRetryFailureHashes.get(retryKey), "same-host-gate-failure");
});

test("DB-backed Task artifact deferral preserves host verification retry state", async (t) => {
  const { session, retryKey } = createTaskFixture(t);

  assert.equal(await runPreVerification(session), "continue");
  assert.equal(session.verificationRetryCount.get(retryKey), 1);
  assert.equal(session.verificationRetryFailureHashes.get(retryKey), "same-host-gate-failure");
});
