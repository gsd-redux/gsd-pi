// Project/App: gsd-pi
// File Purpose: Hard tests for auto-mode iteration-run closeout.

import assert from "node:assert/strict";
import test from "node:test";

import { settleIterationRun } from "../auto/iteration-run.ts";

function makeDeps() {
  const ledger: Array<{ kind: string; dispatchId: number; reason?: string }> = [];
  const orch: Array<{ method: string; unitType: string; unitId: string; reason?: string }> = [];
  return {
    ledger,
    orch,
    deps: {
      markFailed(dispatchId: number, details: { errorSummary: string }) {
        ledger.push({ kind: "failed", dispatchId, reason: details.errorSummary });
        return true;
      },
      markCompleted(dispatchId: number) {
        ledger.push({ kind: "completed", dispatchId });
        return true;
      },
      logWriteFailure() {
        throw new Error("ledger write should not throw in this test");
      },
      async completeActiveUnit(unit: { unitType: string; unitId: string }) {
        orch.push({ method: "complete", ...unit });
      },
      async retryActiveUnit(unit: { unitType: string; unitId: string }) {
        orch.push({ method: "retry", ...unit });
      },
      async abandonActiveUnit(unit: { unitType: string; unitId: string }, reason: string) {
        orch.push({ method: "abandon", ...unit, reason });
      },
    },
  };
}

test("settleIterationRun completes the dispatch row and the active unit", async () => {
  const { deps, ledger, orch } = makeDeps();
  const settled = await settleIterationRun(
    { dispatchId: 9, unitType: "execute-task", unitId: "M001/S01/T01" },
    "completed",
    "ok",
    false,
    deps,
  );
  assert.equal(settled, true);
  assert.deepEqual(ledger, [{ kind: "completed", dispatchId: 9 }]);
  assert.deepEqual(orch, [{ method: "complete", unitType: "execute-task", unitId: "M001/S01/T01" }]);
});

test("settleIterationRun fails the dispatch and abandons the active unit", async () => {
  const { deps, ledger, orch } = makeDeps();
  const settled = await settleIterationRun(
    { dispatchId: 4, unitType: "plan-slice", unitId: "M001/S01" },
    "failed",
    "unit execution crashed",
    false,
    deps,
  );
  assert.equal(settled, true);
  assert.deepEqual(ledger, [{ kind: "failed", dispatchId: 4, reason: "unit execution crashed" }]);
  assert.deepEqual(orch, [{
    method: "abandon",
    unitType: "plan-slice",
    unitId: "M001/S01",
    reason: "unit execution crashed",
  }]);
});

test("settleIterationRun skips a second ledger write when already settled", async () => {
  const { deps, ledger, orch } = makeDeps();
  const settled = await settleIterationRun(
    { dispatchId: 4, unitType: "plan-slice", unitId: "M001/S01" },
    "failed",
    "late abandon",
    true,
    deps,
  );
  assert.equal(settled, true);
  assert.deepEqual(ledger, []);
  assert.deepEqual(orch, [{
    method: "abandon",
    unitType: "plan-slice",
    unitId: "M001/S01",
    reason: "late abandon",
  }]);
});

test("settleIterationRun does not write a ledger row when dispatchId is null", async () => {
  const { deps, ledger, orch } = makeDeps();
  const settled = await settleIterationRun(
    { dispatchId: null, unitType: "execute-task", unitId: "M001/S01/T01" },
    "canceled",
    "claim never opened",
    false,
    deps,
  );
  assert.equal(settled, false);
  assert.deepEqual(ledger, []);
  assert.deepEqual(orch, [{
    method: "abandon",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    reason: "claim never opened",
  }]);
});
