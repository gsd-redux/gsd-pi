// Project/App: gsd-pi
// File Purpose: Auto Orchestration module public contract types.
//
// Phase 2 of #442 collapsed the nine single-implementation adapter interfaces
// (DispatchAdapter, RecoveryAdapter, StateReconciliationAdapter,
// ToolContractAdapter, WorktreeAdapter, HealthAdapter, UokGateAdapter,
// RuntimePersistenceAdapter, NotificationAdapter) and AutoOrchestratorDeps
// into AutoOrchestrator itself (auto/orchestrator.ts). Only the public result
// and lifecycle-interface types remain here.

import type { GSDState } from "../types.js";

export interface AutoSessionContext {
  basePath: string;
  trigger: "guided-flow" | "resume" | "auto-loop" | "manual";
}

export interface UnitRef {
  unitType: string;
  unitId: string;
}

export type AutoSkipCode =
  | "unit-already-active"
  | "completed-no-advance"
  | "already-closed"
  | "no-dispatch";

export const UNIT_ALREADY_ACTIVE_SKIP_CODE = "unit-already-active" as const;
export const UNIT_ALREADY_ACTIVE_SKIP_REASON = "idempotent advance: unit already active";

export function isUnitAlreadyActiveSkip(result: {
  kind: string;
  code?: string;
  reason?: string;
}): boolean {
  return result.kind === "skipped" && result.code === UNIT_ALREADY_ACTIVE_SKIP_CODE;
}

export interface AutoStatus {
  phase: "idle" | "running" | "paused" | "stopped" | "error";
  activeUnit?: UnitRef;
  lastTransitionAt?: number;
  transitionCount: number;
}

export type AutoTerminalOutcome =
  | {
      code: "all-complete";
      displayReason: string;
      allMilestonesComplete: true;
    }
  | {
      code: "no-remaining-units";
      displayReason: string;
      allMilestonesComplete: false;
    }
  | {
      code: "settlement-blocked";
      displayReason: string;
      nextAction: string;
      milestoneId: string;
      allMilestonesComplete: false;
    };

export type AutoAdvanceResult =
  | { kind: "started" }
  | { kind: "resumed" }
  | { kind: "advanced"; unit: UnitRef; stateSnapshot: GSDState; dispatchId: number }
  | { kind: "skipped"; reason: string; code: AutoSkipCode; stateSnapshot?: GSDState }
  | {
      kind: "blocked";
      reason: string;
      action: "pause" | "stop";
      stateSnapshot?: GSDState;
      terminalOutcome?: AutoTerminalOutcome;
    }
  | {
      kind: "stopped";
      reason: string;
      stateSnapshot?: GSDState;
      terminalOutcome?: AutoTerminalOutcome;
    }
  | { kind: "paused"; reason: string; backoffMs?: readonly number[] }
  | { kind: "error"; reason: string };

export interface AutoOrchestrationModule {
  start(sessionContext: AutoSessionContext): Promise<AutoAdvanceResult>;
  advance(): Promise<AutoAdvanceResult>;
  settle(
    dispatchId: number,
    outcome: "completed" | "failed" | "retry" | "canceled",
    reason: string,
  ): Promise<void>;
  completeActiveUnit(unit: UnitRef): Promise<void>;
  retryActiveUnit(unit: UnitRef): Promise<void>;
  abandonActiveUnit(unit: UnitRef, reason: string): Promise<void>;
  resume(): Promise<AutoAdvanceResult>;
  stop(reason: string): Promise<AutoAdvanceResult>;
  getStatus(): AutoStatus;
}
