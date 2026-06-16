// Project/App: gsd-pi
// File Purpose: Pure budget and context guard decisions for GSD auto-mode.
/**
 * Budget alert level tracking and enforcement for auto-mode.
 * Pure functions — no module state or side effects.
 */

import type { BudgetEnforcementMode, TokenProfile } from "./types.js";

export type BudgetAlertLevel = 0 | 75 | 80 | 90 | 100;

export function getBudgetAlertLevel(budgetPct: number): BudgetAlertLevel {
  if (budgetPct >= 1.0) return 100;
  if (budgetPct >= 0.90) return 90;
  if (budgetPct >= 0.80) return 80;
  if (budgetPct >= 0.75) return 75;
  return 0;
}

export function getNewBudgetAlertLevel(previousLevel: BudgetAlertLevel, budgetPct: number): BudgetAlertLevel | null {
  const currentLevel = getBudgetAlertLevel(budgetPct);
  if (currentLevel === 0 || currentLevel <= previousLevel) return null;
  return currentLevel;
}

export function getBudgetEnforcementAction(
  enforcement: BudgetEnforcementMode,
  budgetPct: number,
): "none" | "warn" | "pause" | "halt" {
  if (budgetPct < 1.0) return "none";
  if (enforcement === "halt") return "halt";
  if (enforcement === "pause") return "pause";
  return "warn";
}

export function getUnitCostSpikeAction(
  unitCostUsd: number,
  rollingAvgUsd: number,
  multiplier = 3.0,
): "none" | "pause" {
  if (!Number.isFinite(unitCostUsd) || unitCostUsd < 0) return "none";
  if (!Number.isFinite(rollingAvgUsd) || rollingAvgUsd <= 0) return "none";
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "none";
  return unitCostUsd >= (rollingAvgUsd * multiplier) ? "pause" : "none";
}

/**
 * Resolve the rolling-average cost-spike multiplier for `getUnitCostSpikeAction`
 * from preferences. The `burn-max` token profile opts out of the spike pause
 * entirely (returns Infinity, which `getUnitCostSpikeAction` treats as "none").
 * An explicit finite, positive `unit_cost_spike_multiplier` overrides the
 * default; otherwise the default of 3.0 applies.
 */
export function resolveUnitCostSpikeMultiplier(
  prefs: { token_profile?: TokenProfile; unit_cost_spike_multiplier?: number } | null | undefined,
): number {
  if (prefs?.token_profile === "burn-max") return Infinity;
  const override = prefs?.unit_cost_spike_multiplier;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  return 3.0;
}

export function getContextPauseAction(
  contextPercent: number | null | undefined,
  thresholdPercent: number,
): "none" | "pause" {
  if (!Number.isFinite(contextPercent) || !Number.isFinite(thresholdPercent)) return "none";
  if (contextPercent === null || contextPercent === undefined || thresholdPercent <= 0) return "none";

  const usage = contextPercent <= 1 ? contextPercent * 100 : contextPercent;
  const threshold = thresholdPercent <= 1 ? thresholdPercent * 100 : thresholdPercent;
  return usage >= threshold ? "pause" : "none";
}

/** Normalize compaction_threshold_percent pref (0.5–0.95 ratio) to a 0–100 scale. */
export function resolveCompactionThresholdPercent(raw: number | undefined): number {
  const value =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0.5 && raw <= 0.95 ? raw : 0.6;
  return value <= 1 ? value * 100 : value;
}

export function shouldRerootStepSessionForContext(
  contextPercent: number | null | undefined,
  compactionThresholdPercent?: number,
): boolean {
  return getContextPauseAction(
    contextPercent,
    resolveCompactionThresholdPercent(compactionThresholdPercent),
  ) === "pause";
}
