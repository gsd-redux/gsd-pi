// Project/App: GSD-2
// File Purpose: Regression tests for milestone-scoped metrics aggregation.

import test from "node:test";
import assert from "node:assert/strict";

import {
  filterUnitsForMilestone,
  getProjectTotals,
  type UnitMetrics,
} from "../metrics.js";

function makeUnit(id: string, tokens: number, cost: number): UnitMetrics {
  return {
    type: id.includes("/") ? "execute-task" : "complete-milestone",
    id,
    model: "test-model",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens,
    },
    cost,
    toolCalls: 0,
    assistantMessages: 1,
    userMessages: 1,
  };
}

test("filterUnitsForMilestone keeps completion totals scoped to the active milestone", () => {
  const units = [
    makeUnit("M014/S01/T01", 100, 1),
    makeUnit("M015", 10, 0.1),
    makeUnit("M015/S01", 20, 0.2),
    makeUnit("M015/S01/T01", 30, 0.3),
    makeUnit("M0150/S01/T01", 400, 4),
  ];

  const scoped = filterUnitsForMilestone(units, "M015");
  const totals = getProjectTotals(scoped);

  assert.deepEqual(
    scoped.map((unit) => unit.id),
    ["M015", "M015/S01", "M015/S01/T01"],
    "completion roll-up must include milestone and child units without pulling similarly prefixed milestones",
  );
  assert.equal(totals.units, 3);
  assert.equal(totals.tokens.total, 60);
  assert.ok(Math.abs(totals.cost - 0.6) < Number.EPSILON);
});

test("filterUnitsForMilestone returns all units when no milestone id is available", () => {
  const units = [
    makeUnit("M014/S01/T01", 100, 1),
    makeUnit("M015/S01/T01", 200, 2),
  ];

  assert.equal(filterUnitsForMilestone(units, null).length, 2);
  assert.equal(filterUnitsForMilestone(units, undefined).length, 2);
});
