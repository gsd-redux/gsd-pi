// GSD auto-mode runtime state
import { AutoSession } from "./auto/session.js";
import type { CurrentUnit } from "./auto/session.js";
import type { SourceObservationStore } from "./source-observations.js";
import {
  markToolEnd as markTrackedToolEnd,
  markToolStart as markTrackedToolStart,
  shouldClearToolInvocationErrorAfterSuccess,
  updateToolInvocationError,
} from "./auto-tool-tracking.js";
// Re-exported as a pure pass-through. Must stay UNGATED (no autoSession.active
// argument, unlike markToolStart at the bottom of this file) so it is true in
// foreground where the foreground approval-gate pause consults it.
export { isInteractiveElicitationInFlight } from "./auto-tool-tracking.js";
import {
  createToolSurfaceSnapshot,
  type ToolSurfaceSnapshot,
  type ToolSurfaceSnapshotInput,
} from "./tool-surface-snapshot.js";

export type {
  ToolSurfaceSnapshot,
  ToolSurfaceSnapshotInput,
} from "./tool-surface-snapshot.js";

export const autoSession = new AutoSession();

export type AutoRuntimeSnapshot = {
  active: boolean;
  paused: boolean;
  currentUnit: CurrentUnit | null;
  basePath: string;
  isolationDegraded: boolean;
  strandedRecoveryIsolationMode: "worktree" | "branch" | null;
  orchestrationPhase?: "idle" | "running" | "paused" | "stopped" | "error";
  orchestrationTransitionCount?: number;
  orchestrationLastTransitionAt?: number;
  toolSurface: ToolSurfaceSnapshot | null;
};

export function getAutoRuntimeSnapshot(): AutoRuntimeSnapshot {
  const orchestrationStatus = autoSession.orchestration?.getStatus();
  return {
    active: autoSession.active,
    paused: autoSession.paused,
    currentUnit: autoSession.currentUnit ? { ...autoSession.currentUnit } : null,
    basePath: autoSession.basePath,
    isolationDegraded: autoSession.isolationDegraded,
    strandedRecoveryIsolationMode: autoSession.strandedRecoveryIsolationMode,
    orchestrationPhase: orchestrationStatus?.phase,
    orchestrationTransitionCount: orchestrationStatus?.transitionCount,
    orchestrationLastTransitionAt: orchestrationStatus?.lastTransitionAt,
    toolSurface: autoSession.active || autoSession.paused ? autoSession.toolSurfaceSnapshot : null,
  };
}

export function recordAutoToolSurfaceSnapshot(input: ToolSurfaceSnapshotInput): ToolSurfaceSnapshot {
  autoSession.toolSurfaceSnapshot = createToolSurfaceSnapshot(input);
  return autoSession.toolSurfaceSnapshot;
}

export function clearAutoToolSurfaceSnapshot(): void {
  autoSession.toolSurfaceSnapshot = null;
}

export function isAutoActive(): boolean {
  return autoSession.active;
}

/**
 * The unit type of the unit auto-mode is currently dispatching, or undefined
 * when auto is inactive or between units. This is the authoritative phase
 * signal for auto-mode (set in auto/unit-phase.ts before each dispatch), so
 * consumers never have to regex-infer the phase from prompt text. Can be a
 * `hook/<name>` pseudo-type during hook dispatch — callers that need a real
 * GSD phase should validate against their known phase set.
 */
export function getActiveAutoUnitType(): string | undefined {
  if (!autoSession.active) return undefined;
  return autoSession.currentUnit?.type ?? undefined;
}

export function isAutoPaused(): boolean {
  return autoSession.paused;
}

export function isAutoCompletionStopInProgress(): boolean {
  return autoSession.completionStopInProgress;
}

export function clearAutoCompletionStopInProgress(): void {
  autoSession.completionStopInProgress = false;
}

export function markToolStart(toolCallId: string, toolName?: string): void {
  markTrackedToolStart(toolCallId, autoSession.active, toolName);
}

export function markToolEnd(toolCallId: string): void {
  markTrackedToolEnd(toolCallId);
}

export function recordToolInvocationError(toolName: string, errorMsg: string): void {
  if (!autoSession.active) return;
  autoSession.lastToolInvocationError = updateToolInvocationError(
    autoSession.lastToolInvocationError,
    toolName,
    errorMsg,
  );
}

export function clearToolInvocationError(successfulToolName?: string): void {
  if (!autoSession.active) return;
  if (!shouldClearToolInvocationErrorAfterSuccess(
    autoSession.lastToolInvocationError,
    successfulToolName,
  )) return;
  autoSession.lastToolInvocationError = null;
}

export function getSourceObservationStore(): SourceObservationStore {
  return autoSession.sourceObservations;
}
