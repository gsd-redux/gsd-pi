import test from "node:test";
import assert from "node:assert/strict";

import {
  getBudgetAlertLevel,
  getBudgetEnforcementAction,
  getContextPauseAction,
  getNewBudgetAlertLevel,
  resolveCompactionThresholdPercent,
  shouldRerootStepSessionForContext,
} from "../auto.js";
import {
  getUnitCostSpikeAction,
  resolveUnitCostSpikeMultiplier,
} from "../auto-budget.js";

test("getBudgetAlertLevel returns the expected threshold bucket", () => {
  assert.equal(getBudgetAlertLevel(0.10), 0);
  assert.equal(getBudgetAlertLevel(0.74), 0);
  assert.equal(getBudgetAlertLevel(0.75), 75);
  assert.equal(getBudgetAlertLevel(0.79), 75);
  assert.equal(getBudgetAlertLevel(0.80), 80);
  assert.equal(getBudgetAlertLevel(0.85), 80);
  assert.equal(getBudgetAlertLevel(0.89), 80);
  assert.equal(getBudgetAlertLevel(0.90), 90);
  assert.equal(getBudgetAlertLevel(1.00), 100);
});

test("getNewBudgetAlertLevel only emits once per threshold", () => {
  assert.equal(getNewBudgetAlertLevel(0, 0.74), null);
  assert.equal(getNewBudgetAlertLevel(0, 0.75), 75);
  assert.equal(getNewBudgetAlertLevel(75, 0.79), null);
  assert.equal(getNewBudgetAlertLevel(75, 0.80), 80);
  assert.equal(getNewBudgetAlertLevel(80, 0.85), null);
  assert.equal(getNewBudgetAlertLevel(80, 0.90), 90);
  assert.equal(getNewBudgetAlertLevel(90, 0.95), null);
  assert.equal(getNewBudgetAlertLevel(90, 1.0), 100);
  assert.equal(getNewBudgetAlertLevel(100, 1.2), null);
});

test("80% alert fires exactly once between 75% and 90%", () => {
  // Transition from 75 → 80 emits 80
  assert.equal(getNewBudgetAlertLevel(75, 0.80), 80);
  // Already at 80 — no re-emission
  assert.equal(getNewBudgetAlertLevel(80, 0.82), null);
  assert.equal(getNewBudgetAlertLevel(80, 0.89), null);
  // Transition from 80 → 90 emits 90
  assert.equal(getNewBudgetAlertLevel(80, 0.90), 90);
});

test("getBudgetEnforcementAction maps the configured ceiling behavior", () => {
  assert.equal(getBudgetEnforcementAction("warn", 0.80), "none");
  assert.equal(getBudgetEnforcementAction("warn", 0.99), "none");
  assert.equal(getBudgetEnforcementAction("warn", 1.0), "warn");
  assert.equal(getBudgetEnforcementAction("pause", 1.0), "pause");
  assert.equal(getBudgetEnforcementAction("halt", 1.0), "halt");
});

test("getContextPauseAction pauses at or above a percentage threshold", () => {
  assert.equal(getContextPauseAction(undefined, 90), "none");
  assert.equal(getContextPauseAction(null, 90), "none");
  assert.equal(getContextPauseAction(89.9, 90), "none");
  assert.equal(getContextPauseAction(90, 90), "pause");
  assert.equal(getContextPauseAction(95, 90), "pause");
  assert.equal(getContextPauseAction(95, 0), "none");
  assert.equal(getContextPauseAction(0.75, 75), "pause");
  assert.equal(getContextPauseAction(0.8, 0.75), "pause");
});

test("resolveCompactionThresholdPercent defaults to 60 and accepts ratio prefs", () => {
  assert.equal(resolveCompactionThresholdPercent(undefined), 60);
  assert.equal(resolveCompactionThresholdPercent(0.75), 75);
  assert.equal(resolveCompactionThresholdPercent(0.4), 60);
});

test("shouldRerootStepSessionForContext uses compaction threshold pref", () => {
  assert.equal(shouldRerootStepSessionForContext(59.9, 0.6), false);
  assert.equal(shouldRerootStepSessionForContext(60, 0.6), true);
  assert.equal(shouldRerootStepSessionForContext(273.8, 0.6), true);
  assert.equal(shouldRerootStepSessionForContext(undefined, 0.6), false);
});

test("resolveUnitCostSpikeMultiplier disables the spike pause for burn-max", () => {
  // burn-max -> Infinity, and getUnitCostSpikeAction treats a non-finite
  // multiplier as "none" (no pause) regardless of how large the spike is.
  const m = resolveUnitCostSpikeMultiplier({ token_profile: "burn-max" });
  assert.equal(m, Infinity);
  assert.equal(getUnitCostSpikeAction(40, 1, m), "none");
});

test("resolveUnitCostSpikeMultiplier honors an explicit unit_cost_spike_multiplier", () => {
  const m = resolveUnitCostSpikeMultiplier({ unit_cost_spike_multiplier: 10 });
  assert.equal(m, 10);
  // 4x spike is below the configured 10x threshold -> no pause.
  assert.equal(getUnitCostSpikeAction(4, 1, m), "none");
  // 11x spike is at/above 10x -> pause.
  assert.equal(getUnitCostSpikeAction(11, 1, m), "pause");
});

test("resolveUnitCostSpikeMultiplier defaults to 3.0 and still pauses at >=3x", () => {
  assert.equal(resolveUnitCostSpikeMultiplier(undefined), 3.0);
  assert.equal(resolveUnitCostSpikeMultiplier({}), 3.0);
  // Non-positive / non-finite explicit values fall back to the 3.0 default.
  assert.equal(resolveUnitCostSpikeMultiplier({ unit_cost_spike_multiplier: 0 }), 3.0);
  const m = resolveUnitCostSpikeMultiplier({});
  // Default profile still pauses on a 3x spike.
  assert.equal(getUnitCostSpikeAction(3, 1, m), "pause");
  assert.equal(getUnitCostSpikeAction(2.9, 1, m), "none");
});
