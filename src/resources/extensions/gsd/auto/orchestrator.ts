// Project/App: gsd-pi
// File Purpose: Auto Orchestration module implementation and ADR-015 invariant pipeline owner.
//
// Phase 2 of #442 collapsed the nine single-implementation adapter seams
// (DispatchAdapter, RecoveryAdapter, StateReconciliationAdapter,
// ToolContractAdapter, WorktreeAdapter, HealthAdapter, UokGateAdapter,
// RuntimePersistenceAdapter, NotificationAdapter) into this class. The
// orchestrator now constructs from the concrete extension context and calls
// the real collaborators (state-reconciliation, doctor-proactive,
// auto-dispatch, recovery-classification, tool-contract, worktree-safety,
// uok/gate-runner, journal, session-lock, ctx.ui.notify) directly.

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoAdvanceResult, AutoOrchestrationModule, AutoSessionContext, AutoStatus, AutoTerminalOutcome } from "./contracts.js";
import type { AutoSession, PendingOrchestrationDispatch } from "./session.js";
import type { GSDState, Phase } from "../types.js";
import type { MinimalModelRegistry } from "../context-budget.js";

type BlockedAdvanceResult = Extract<AutoAdvanceResult, { kind: "blocked" }>;

import { debugCount, debugLog, debugTime } from "../debug-logger.js";
import { reconcileBeforeDispatch } from "../state-reconciliation.js";
import { isLegalEdge, IllegalPhaseTransitionError } from "../state-transition-matrix.js";
import { hasPendingDeepStage, resolveDispatch } from "../auto-dispatch.js";
import { classifyFailure } from "../recovery-classification.js";
import { verifyExpectedArtifact, refreshRecoveryDbForArtifact } from "../auto-recovery.js";
import { invalidateAllCaches } from "../cache.js";
import { compileUnitToolContract } from "../tool-contract.js";
import { createWorktreeSafetyModule } from "../worktree-safety.js";
import { repairAutoWorktreeSafetyFailure } from "../auto-worktree-repair.js";
import { resolveManifest } from "../unit-context-manifest.js";
import {
  preDispatchHealthGate,
  recordHealthSnapshot,
} from "../doctor-proactive.js";
import { autoWorktreeBranch } from "../auto-worktree-branch-lifecycle.js";
import { checkResourcesStale } from "../auto-worktree-resource-version.js";
import { getSessionLockStatus } from "../session-lock.js";
import { resolveUokFlags } from "../uok/flags.js";
import { emitJournalEvent as _emitJournalEvent } from "../journal.js";
import { loadEffectiveGSDPreferences, loadEffectiveGSDPreferencesWithRegistry, getIsolationMode, resolveEffectiveUnitIsolationMode, resolveProfileAnchorProvider } from "../preferences.js";
import {
  detectWorktreeName,
  getMainBranch,
  resolveProjectRoot,
  resolveWorktreeProjectRoot,
} from "../worktree.js";
import { getDispatchAuthorityBlocker, getPriorSliceCompletionBlocker } from "../dispatch-guard.js";
import { GitServiceImpl } from "../git-service.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { WorktreeLifecycle } from "../worktree-lifecycle.js";
import { createDefaultMilestoneMergeTransaction } from "../milestone-merge-transaction.js";
import { createWorkspace, scopeMilestone } from "../workspace.js";
import { supportsStructuredQuestions } from "../workflow-mcp.js";
import { getRegisteredToolSnapshot, getToolBaselineSnapshot } from "../auto-model-selection.js";
import { deriveState } from "../state.js";
import { parseUnitId } from "../unit-id.js";
import { isClosedStatus } from "../status-guards.js";
import {
  isDbAvailable,
  getSlice,
  getTask,
} from "../gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "../db-workspace.js";
import { getErrorMessage } from "../error-utils.js";
import { logWarning } from "../workflow-logger.js";
import { normalizeRealPath } from "../paths.js";
import {
  buildDispatchKey,
  createDispatchHistory,
  STUCK_WINDOW_SIZE,
  type DispatchHistory,
} from "./dispatch-history.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAllCompleteSettlement } from "../milestone-settlement.js";
import { hasHeldMilestoneLease, reclaimMissingMilestoneLease } from "./milestone-lease-reclaim.js";

type UokFlags = ReturnType<typeof resolveUokFlags>;

function now(): number {
  return Date.now();
}

/**
 * Optional override for the post-settlement markdown projection rebuild
 * (mergePendingCompleteMilestone). Production leaves this null so the real
 * rebuild runs; tests inject a throwing function to deterministically exercise
 * the best-effort failure path (orchestrator.ts:637), which is otherwise only
 * reachable by driving advance() through a full merge-pending milestone
 * settlement and then contriving a projection-rebuild fault.
 * @internal
 */
let _projectionRebuildFn: ((projectRoot: string) => Promise<void>) | null = null;

function noRemainingUnitsOutcome(stateSnapshot: GSDState): AutoTerminalOutcome {
  if (stateSnapshot.phase === "complete") {
    return {
      code: "all-complete",
      displayReason: "All milestones complete",
      allMilestonesComplete: true,
    };
  }
  return {
    code: "no-remaining-units",
    displayReason: "No remaining units",
    allMilestonesComplete: false,
  };
}

/**
 * Concrete construction context for the Auto Orchestrator.
 *
 * Phase 2 of #442 replaced the nine adapter interfaces with this bundle of the
 * real values the wiring factory used to close over: the extension context and
 * API, the dispatch/runtime base paths, and the shared {@link AutoSession}
 * singleton.
 */
export interface OrchestratorContext {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  dispatchBasePath: string;
  runtimeBasePath: string;
  session: AutoSession;
}

/** Result type of a single dispatch decision. */
export type DispatchDecision =
  | { kind: "blocked"; reason: string; action: "pause" | "stop" }
  | { kind: "skipped"; reason: string }
  | { unitType: string; unitId: string; reason: string; preconditions: string[] }
  | null;

/** Inputs to a dispatch decision. Caller-supplied fields override ctx-derived ones. */
export interface DispatchDecisionInput {
  stateSnapshot: GSDState;
  /** Optional live session context, forwarded to dispatch rules that need session-derived state. */
  session?: AutoSession;
  /** Mirrors `DispatchContext.structuredQuestionsAvailable` — "true"/"false" string per the dispatch contract. */
  structuredQuestionsAvailable?: "true" | "false";
  /** Session model context window in tokens, forwarded to the budget engine. */
  sessionContextWindow?: number;
  /** Session model provider, used for provider-specific effective context windows. */
  sessionProvider?: string;
  /** Model registry for executor-model lookups inside the budget engine. */
  modelRegistry?: MinimalModelRegistry;
}

function getAlreadyClosedDispatchReason(unitType: string, unitId: string): string | null {
  if (!isDbAvailable()) return null;
  refreshWorkflowDatabaseFromDisk();
  const { milestone, slice, task } = parseUnitId(unitId);
  if (unitType === "execute-task" && milestone && slice && task) {
    const row = getTask(milestone, slice, task);
    return row && isClosedStatus(row.status)
      ? `execute-task ${unitId} is already ${row.status}`
      : null;
  }
  if (unitType === "complete-slice" && milestone && slice) {
    const row = getSlice(milestone, slice);
    return row && isClosedStatus(row.status)
      ? `complete-slice ${unitId} is already ${row.status}`
      : null;
  }
  return null;
}

function shouldAdoptActiveMilestone(
  state: GSDState,
  activeSession: AutoSession | undefined,
  activeDispatchBasePath: string,
): boolean {
  const activeMilestoneId = state.activeMilestone?.id;
  const currentMilestoneId = activeSession?.currentMilestoneId;
  if (!activeSession || !activeMilestoneId || !currentMilestoneId || activeMilestoneId === currentMilestoneId) {
    return false;
  }

  const scopedWorktreeMilestone =
    (activeSession.basePath ? detectWorktreeName(activeSession.basePath) : null) ??
    detectWorktreeName(activeDispatchBasePath);
  if (scopedWorktreeMilestone && scopedWorktreeMilestone !== activeMilestoneId) {
    return false;
  }

  const currentMilestone = state.registry.find((milestone) => milestone.id === currentMilestoneId);
  return !!currentMilestone && isClosedStatus(currentMilestone.status);
}

/**
 * Pure dispatch-decision function — formerly `createWiredDispatchAdapter`'s
 * `decideNextUnit`. Folded out of the closure so the orchestrator can call it
 * directly and tests can drive the exact dispatch decision logic against real
 * fixtures without re-introducing an adapter seam.
 *
 * Derives session-derived dispatch inputs the same way phases.ts:runDispatch
 * does (#5789): prefers caller-supplied values when present so test harnesses
 * and alternative wirings can inject deterministic snapshots; otherwise pulls
 * from the captured pi/ctx references.
 */
export async function decideOrchestratorDispatch(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  dispatchBasePath: string,
  session: AutoSession | undefined,
  input: DispatchDecisionInput,
): Promise<DispatchDecision> {
  const state = input.stateSnapshot;
  const active = state.activeMilestone;
  const activeSession = input.session ?? session;
  const activeDispatchBasePath = activeSession?.basePath || dispatchBasePath;
  const prefs = loadEffectiveGSDPreferencesWithRegistry(
    ctx.modelRegistry,
    activeDispatchBasePath,
    resolveProfileAnchorProvider(ctx.model?.provider, session?.autoModeStartModel?.provider),
    activeSession?.autoModeStartModel
      ? `${activeSession.autoModeStartModel.provider}/${activeSession.autoModeStartModel.id}`
      : undefined,
  )?.preferences;
  if (!active) {
    if (state.phase !== "pre-planning") return null;
    if (!hasPendingDeepStage(prefs, activeDispatchBasePath)) {
      return {
        kind: "blocked",
        reason: state.nextAction || "No active milestone. Run /gsd unpark <id> or create a new milestone.",
        action: "stop",
      };
    }
  }

  if (active && activeSession && shouldAdoptActiveMilestone(state, activeSession, activeDispatchBasePath)) {
    activeSession.currentMilestoneId = active.id;
    activeSession.milestoneLeaseToken = null;
  }
  const dispatchMid = active?.id ?? "PROJECT";
  const dispatchMidTitle = active?.title ?? "Project setup";

  // Derive session-derived dispatch inputs the same way phases.ts:runDispatch does
  // (#5789). Prefer caller-supplied values when present so test harnesses and
  // alternative wirings can inject deterministic snapshots; otherwise pull from
  // the captured pi/ctx references.
  const sessionProvider = input.sessionProvider ?? ctx.model?.provider;
  const sessionContextWindow = input.sessionContextWindow ?? ctx.model?.contextWindow;
  const modelRegistry = input.modelRegistry ?? (ctx.modelRegistry as MinimalModelRegistry | undefined);
  const authMode =
    sessionProvider && typeof ctx.modelRegistry?.getProviderAuthMode === "function"
      ? ctx.modelRegistry.getProviderAuthMode(sessionProvider)
      : undefined;
  // Use baseline snapshot — same reason as phases.ts:runDispatch: the live
  // active set may be narrowed by the prior unit before selectAndApplyModel
  // restores it, causing false transport-preflight failures (#477 follow-up).
  const activeTools = getToolBaselineSnapshot(pi);
  const registeredTools = getRegisteredToolSnapshot(pi);
  // Mirrors runDispatch: deep-planning keeps approval gates in plain chat
  // because structured questions can be cancelled outside the chat turn on
  // some transports.
  const structuredQuestionsAvailable =
    input.structuredQuestionsAvailable ??
    (prefs?.planning_depth === "deep"
      ? "false"
      : supportsStructuredQuestions(activeTools, {
          authMode,
          baseUrl: ctx.model?.baseUrl,
        })
        ? "true"
        : "false");

  // Only replay a milestone-scoped verification retry when a milestone is
  // active. Pre-PR (#712 fix), `!active` returned null before reaching this
  // block, so the retry was preserved for a future tick. The new
  // pre-planning + deep-pending fall-through must keep that contract:
  // otherwise a stale execute-task / complete-slice / complete-milestone
  // retry whose target milestone has since been parked would preempt
  // project-level deep rules like `discuss-project`.
  const pendingRetry = session?.pendingVerificationRetryDispatch;
  if (session && pendingRetry && active) {
    const authorityBlocker = getDispatchAuthorityBlocker(pendingRetry.unitType, pendingRetry.unitId);
    if (authorityBlocker) {
      return { kind: "blocked", reason: authorityBlocker, action: "stop" };
    }
    const alreadyClosedReason = getAlreadyClosedDispatchReason(
      pendingRetry.unitType,
      pendingRetry.unitId,
    );
    if (alreadyClosedReason) {
      session.pendingOrchestrationDispatch = null;
      session.pendingVerificationRetry = null;
      return { kind: "skipped", reason: alreadyClosedReason };
    }
    session.pendingVerificationRetryDispatch = null;
    session.pendingOrchestrationDispatch = pendingRetry;
    return {
      unitType: pendingRetry.unitType,
      unitId: pendingRetry.unitId,
      reason: "verification-retry",
      preconditions: [],
    };
  }

  const action = await resolveDispatch({
    basePath: activeDispatchBasePath,
    mid: dispatchMid,
    midTitle: dispatchMidTitle,
    state,
    prefs,
    session: activeSession,
    structuredQuestionsAvailable,
    sessionContextWindow,
    sessionProvider,
    modelRegistry,
    activeTools,
    registeredTools,
    sessionAuthMode: authMode,
    sessionBaseUrl: ctx.model?.baseUrl,
  });

  if (action.action === "stop") {
    if (session) session.pendingOrchestrationDispatch = null;
    return {
      kind: "blocked",
      reason: action.reason,
      action: action.level === "warning" ? "pause" : "stop",
    };
  }
  if (action.action !== "dispatch") {
    if (session) session.pendingOrchestrationDispatch = null;
    return {
      kind: "skipped",
      reason: action.matchedRule ?? "dispatch-skip",
    };
  }
  const alreadyClosedReason = getAlreadyClosedDispatchReason(action.unitType, action.unitId);
  if (alreadyClosedReason) {
    if (session) {
      session.pendingOrchestrationDispatch = null;
      session.pendingVerificationRetry = null;
    }
    return { kind: "skipped", reason: alreadyClosedReason };
  }
  if (session) {
    const pending: PendingOrchestrationDispatch = {
      unitType: action.unitType,
      unitId: action.unitId,
      prompt: action.prompt,
      pauseAfterUatDispatch: action.pauseAfterDispatch ?? false,
      state,
      mid: dispatchMid,
      midTitle: dispatchMidTitle,
    };
    session.pendingOrchestrationDispatch = pending;
  }
  return {
    unitType: action.unitType,
    unitId: action.unitId,
    reason: action.matchedRule ?? "dispatch",
    preconditions: [],
  };
}

export class AutoOrchestrator implements AutoOrchestrationModule {
  private status: AutoStatus = {
    phase: "idle",
    transitionCount: 0,
  };
  private readonly ctx: ExtensionContext;
  private readonly pi: ExtensionAPI;
  private readonly dispatchBasePath: string;
  private readonly runtimeBasePath: string;
  private readonly s: AutoSession;
  private readonly flowId: string;
  private seq = 0;
  private lastAdvanceKey: string | null = null;
  private lastFinalizedUnitKey: string | null = null;
  // Dispatch History module (#482): the dispatch-decision window with
  // cross-session DB rehydration and full detect-stuck rules.
  private readonly dispatchHistory: DispatchHistory;
  // ADR-030 Phase Transition Invariant: the prior advance's reconciled Phase,
  // the "from" endpoint of the edge check. In-memory; reset on start/resume/stop
  // so the first advance of a session has no edge to assert.
  private lastDerivedPhase: Phase | null = null;
  // #442: the unit key we last attempted graduated stuck-recovery for. Bounds
  // recovery to one attempt per stuck episode per run (reset on start/resume/
  // stop), mirroring the legacy Level-1-then-Level-2 escalation in phases.ts.
  private lastStuckRecoveryKey: string | null = null;

  public constructor(context: OrchestratorContext) {
    this.ctx = context.ctx;
    this.pi = context.pi;
    this.dispatchBasePath = context.dispatchBasePath;
    this.runtimeBasePath = context.runtimeBasePath;
    this.s = context.session;
    this.flowId = `auto-orchestrator-${Date.now()}`;
    this.dispatchHistory = createDispatchHistory({
      windowSize: STUCK_WINDOW_SIZE,
      // Same stable scope the auto-loop uses for stuck-state persistence so
      // rehydration reads the rows the dispatch ledger wrote for this project.
      resolveScopeId: () =>
        normalizeRealPath(
          this.s.scope?.workspace.projectRoot ??
            (this.s.originalBasePath || this.s.basePath || this.runtimeBasePath),
        ) || null,
    });
  }

  // ── Live base-path resolution (was the wiring factory's getLiveDispatchBasePath) ──

  private getLiveDispatchBasePath(): string {
    return resolveLiveOrchestratorBasePath({
      capturedBasePath: this.dispatchBasePath,
      runtimeBasePath: this.runtimeBasePath,
      sessionBasePath: this.s.basePath,
      originalBasePath: this.s.originalBasePath,
    });
  }

  // ── RuntimePersistenceAdapter (folded) ───────────────────────────────────

  private ensureLockOwnership(): void {
    const status = getSessionLockStatus(this.runtimeBasePath);
    if (!status.valid || status.failureReason === "pid-mismatch") {
      throw new Error("session lock held by another process");
    }
  }

  /**
   * Map an orchestrator lifecycle event name to its journal eventType and emit
   * it. The name→eventType ternary is preserved byte-for-byte from the legacy
   * wired RuntimePersistenceAdapter.journalTransition.
   */
  private journalTransition(event: {
    name: string;
    reason?: string;
    unitType?: string;
    unitId?: string;
  }): void {
    const eventType = event.name === "start"
      ? "orchestrator-iteration-start"
      : event.name === "resume"
        ? "orchestrator-iteration-start"
        : event.name === "advance"
          ? "orchestrator-dispatch-match"
          : event.name === "advance-blocked"
            ? "orchestrator-guard-block"
            : event.name === "advance-stopped"
              ? "orchestrator-dispatch-stop"
              : event.name === "advance-error"
                ? "orchestrator-iteration-end"
                : event.name === "advance-paused" || event.name === "advance-retry"
                  ? "orchestrator-guard-block"
                  : event.name === "stop"
                  ? "orchestrator-terminal"
                  : "orchestrator-iteration-end";

    _emitJournalEvent(this.runtimeBasePath, {
      ts: new Date().toISOString(),
      flowId: this.flowId,
      seq: ++this.seq,
      eventType,
      data: {
        source: "auto-orchestrator",
        name: event.name,
        reason: event.reason,
        unitType: event.unitType,
        unitId: event.unitId,
      },
    });
  }

  // ── NotificationAdapter (folded) ─────────────────────────────────────────

  private notifyLifecycle(event: { name: string; detail?: string }): void {
    if (event.name === "error") {
      this.ctx.ui.notify(event.detail ?? "auto orchestration error", "error");
    }
  }

  // ── HealthAdapter (folded) ───────────────────────────────────────────────

  private checkResourcesStale(): string | null {
    return checkResourcesStale(this.s.resourceVersionOnStart);
  }

  private async preAdvanceGate(): Promise<
    | { kind: "pass"; fixesApplied?: readonly string[] }
    | { kind: "fail"; reason: string; action?: "pause" | "stop" }
    | { kind: "threw"; error: unknown }
  > {
    try {
      const gate = await preDispatchHealthGate(this.getLiveDispatchBasePath());
      if (gate.proceed) {
        return {
          kind: "pass",
          fixesApplied: gate.fixesApplied,
        };
      }
      return {
        kind: "fail",
        reason: gate.reason ?? "Pre-dispatch health check failed — run /gsd doctor for details.",
        action: gate.severity ?? "pause",
      };
    } catch (error) {
      return { kind: "threw", error };
    }
  }

  private postAdvanceRecord(result: AutoAdvanceResult): void {
    if (result.kind === "error") {
      recordHealthSnapshot(1, 0, 0, [{
        code: "orchestration-error",
        message: result.reason ?? "orchestration error",
        severity: "error",
        unitId: "orchestration",
      }], [], "orchestration");
    } else if (result.kind === "blocked") {
      recordHealthSnapshot(0, 1, 0, [{
        code: "orchestration-blocked",
        message: result.reason ?? "orchestration blocked",
        severity: "warning",
        unitId: "orchestration",
      }], [], "orchestration");
    }
  }

  // ── UokGateAdapter (folded) ──────────────────────────────────────────────

  private resolveUokGateContext(): { activeBasePath: string; uokFlags: UokFlags } {
    const activeBasePath = this.getLiveDispatchBasePath();
    const prefs = loadEffectiveGSDPreferencesWithRegistry(
      this.ctx.modelRegistry,
      activeBasePath,
      resolveProfileAnchorProvider(this.ctx.model?.provider, this.s.autoModeStartModel?.provider),
      this.s.autoModeStartModel
        ? `${this.s.autoModeStartModel.provider}/${this.s.autoModeStartModel.id}`
        : undefined,
    )?.preferences;
    return { activeBasePath, uokFlags: resolveUokFlags(prefs) };
  }

  private async emitUokGate(input: {
    gateId: string;
    gateType: "policy" | "execution";
    outcome: "pass" | "fail" | "manual-attention";
    failureClass: "none" | "policy" | "manual-attention";
    rationale: string;
    findings?: string;
    milestoneId?: string;
    activeBasePath: string;
    uokFlags: UokFlags;
  }): Promise<void> {
    if (!input.uokFlags.gates) return;
    const activeBasePath = input.activeBasePath;
    const milestoneId = input.milestoneId ?? this.s.currentMilestoneId ?? undefined;
    try {
      const { UokGateRunner } = await import("../uok/gate-runner.js");
      const runner = new UokGateRunner();
      runner.register({
        id: input.gateId,
        type: input.gateType,
        execute: async () => ({
          outcome: input.outcome,
          failureClass: input.failureClass,
          rationale: input.rationale,
          findings: input.findings ?? "",
        }),
      });
      await runner.run(input.gateId, {
        basePath: activeBasePath,
        traceId: `pre-dispatch:${this.flowId}`,
        turnId: `orch-${this.seq}`,
        milestoneId,
        unitType: "pre-dispatch",
        unitId: `orch-${this.seq}`,
      });
    } catch (err) {
      logWarning("engine", `uok gate emit failed: ${getErrorMessage(err)}`, {
        file: "orchestrator.ts",
        gateId: input.gateId,
        gateType: input.gateType,
        ...(milestoneId ? { milestoneId } : {}),
      });
    }
  }

  // ── StateReconciliationAdapter (folded) ──────────────────────────────────

  private async reconcileBeforeDispatch(): Promise<
    { ok: true; reason: string; stateSnapshot?: GSDState }
    | { ok: false; reason: string; stateSnapshot?: GSDState }
  > {
    const activeBasePath = this.getLiveDispatchBasePath();
    const result = await reconcileBeforeDispatch(activeBasePath);
    // Failure-path summaries written by gsd_summary_save create
    // artifact-db-status-divergence blockers for tasks that are still
    // pending (gsd_task_complete never ran). These tasks can still be
    // dispatched and the drift self-heals once they complete successfully.
    const hardBlockers = result.blockers.filter(
      (b) =>
        !b.includes("has SUMMARY artifact while DB status is") &&
        !b.includes("has SUMMARY on disk while DB status is") &&
        !b.includes("has task SUMMARY artifacts but no DB tasks"),
    );
    if (hardBlockers.length > 0) {
      return {
        ok: false,
        reason: hardBlockers[0],
        stateSnapshot: result.stateSnapshot,
      };
    }
    const repairedKinds = result.repaired.map((d) => d.kind);
    return {
      ok: true,
      reason:
        repairedKinds.length > 0
          ? `repaired: ${repairedKinds.join(", ")}`
          : "clean",
      stateSnapshot: result.stateSnapshot,
    };
  }

  // ── DispatchAdapter (folded) ─────────────────────────────────────────────

  private decideNextUnit(input: DispatchDecisionInput): Promise<DispatchDecision> {
    return decideOrchestratorDispatch(this.ctx, this.pi, this.dispatchBasePath, this.s, input);
  }

  private evaluateNoRemainingUnitsSettlement(stateSnapshot: GSDState): BlockedAdvanceResult | null {
    const settlement = evaluateAllCompleteSettlement({
      milestoneId: this.s.currentMilestoneId ?? stateSnapshot.activeMilestone?.id,
      statePhase: stateSnapshot.phase,
      basePath: this.s.basePath || this.getLiveDispatchBasePath(),
      originalBasePath: this.s.originalBasePath || this.runtimeBasePath,
      milestoneMerged: this.s.milestoneMergedInPhases,
    });
    this.s.milestoneSettlement = settlement;
    if (settlement.ok) return null;
    return {
      kind: "blocked",
      reason: settlement.message,
      action: settlement.action,
      stateSnapshot,
      terminalOutcome: {
        code: "settlement-blocked",
        displayReason: settlement.message,
        nextAction: settlement.nextAction,
        milestoneId: settlement.milestoneId,
        allMilestonesComplete: false,
      },
    };
  }

  private async mergePendingCompleteMilestone(milestoneId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = this.buildLifecycle().exitMilestone(
      milestoneId,
      { merge: true },
      this.ctx.ui,
    );
    if (!result.ok) {
      const detail = result.cause instanceof Error
        ? result.cause.message
        : result.reason;
      return {
        ok: false,
        reason: `Milestone ${milestoneId} is complete, but the system-owned merge failed: ${detail}`,
      };
    }

    this.s.milestoneMergedInPhases = true;
    this.s.milestoneSettlement = { ok: true, reason: "settled" };
    try {
      const projectRoot = this.s.originalBasePath || this.s.canonicalProjectRoot || this.runtimeBasePath;
      // Test seam: when _projectionRebuildFn is injected, route the rebuild
      // through it so the best-effort failure path (:637) is deterministically
      // reachable. Production leaves it null → real rebuildMarkdownProjectionsFromDb.
      if (_projectionRebuildFn) {
        await _projectionRebuildFn(projectRoot);
      } else {
        const { rebuildMarkdownProjectionsFromDb } = await import("../commands-maintenance.js");
        await rebuildMarkdownProjectionsFromDb(projectRoot);
      }
    } catch (err) {
      logWarning(
        "engine",
        `markdown projection rebuild after settlement merge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ok: true };
  }

  private clearPendingDispatch(): void {
    this.s.pendingOrchestrationDispatch = null;
  }

  private findPriorSliceCompletionBlocker(unitType: string, unitId: string): string | null {
    const guardBasePath = resolveWorktreeProjectRoot(
      this.getLiveDispatchBasePath(),
      this.s.originalBasePath,
    );
    let mainBranch = "main";
    try {
      mainBranch = getMainBranch(guardBasePath);
    } catch (err) {
      // Preserve legacy dispatch behavior: fall back to main when branch
      // discovery fails, then let the guard make the progression decision.
      logWarning(
        "engine",
        `branch discovery failed, falling back to main: ${getErrorMessage(err)}`,
        { file: "orchestrator.ts" },
      );
    }
    return getPriorSliceCompletionBlocker(guardBasePath, mainBranch, unitType, unitId);
  }

  // ── ToolContractAdapter (folded) ─────────────────────────────────────────

  private compileUnitToolContract(unitType: string): { ok: true; reason: string } | { ok: false; reason: string } {
    const result = compileUnitToolContract(unitType);
    if (!result.ok) return { ok: false, reason: result.detail };
    return { ok: true, reason: result.contract.validationRules.join(", ") };
  }

  // ── WorktreeAdapter (folded) ─────────────────────────────────────────────

  private getEffectiveUnitIsolationMode(basePath: string): ReturnType<typeof getIsolationMode> {
    return resolveEffectiveUnitIsolationMode(
      getIsolationMode(basePath),
      this.s.isolationDegraded,
      this.s.strandedRecoveryIsolationMode,
    );
  }

  private buildLifecycle(): WorktreeLifecycle {
    return new WorktreeLifecycle(this.s, {
      gitServiceFactory: (basePath: string) => {
        const gitConfig = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
        return new GitServiceImpl(basePath, gitConfig);
      },
      worktreeProjection: new WorktreeStateProjection(),
      mergeMilestone: createDefaultMilestoneMergeTransaction(),
    });
  }

  private rebuildScope(rawPath: string, milestoneId: string | null): void {
    if (!milestoneId) {
      this.s.scope = null;
      return;
    }
    try {
      const workspace = createWorkspace(rawPath);
      this.s.scope = scopeMilestone(workspace, milestoneId);
    } catch {
      // Non-fatal — scope is additive. Existing readers still use basePath.
      this.s.scope = null;
    }
  }

  private async prepareWorktreeForUnit(
    unitType: string,
    unitId: string,
  ): Promise<{ ok: true; reason: string } | { ok: false; reason: string }> {
    const isolationMode = this.getEffectiveUnitIsolationMode(this.runtimeBasePath);
    const manifest = resolveManifest(unitType);
    if (!manifest) {
      return {
        ok: false,
        reason: `No Unit manifest is registered for ${unitType}`,
      };
    }
    const writeScope =
      manifest.tools.mode === "all" || manifest.tools.mode === "docs"
        ? "source-writing"
        : "planning-only";
    const safety = createWorktreeSafetyModule();
    const activeBasePath = this.getLiveDispatchBasePath();
    const snapshot = await deriveState(activeBasePath);
    const milestoneId = snapshot.activeMilestone?.id ?? null;
    const buildExpectedBranch = (mode: ReturnType<typeof getIsolationMode>) =>
      mode !== "none" && milestoneId ? autoWorktreeBranch(milestoneId) : null;
    // The milestone lease coordinates concurrent workers on an isolated
    // milestone worktree/branch. `none` mode has no per-milestone isolation
    // and does not reliably claim a lease, so requiring one there would
    // falsely fail dispatch; enforce it only in isolated modes.
    const buildLease = (mode: ReturnType<typeof getIsolationMode>) =>
      milestoneId && this.s.workerId
        ? {
            required: writeScope === "source-writing" && mode !== "none",
            held: hasHeldMilestoneLease(this.s, milestoneId),
            owner: this.s.workerId,
          }
        : undefined;
    if (writeScope === "source-writing") {
      reclaimMissingMilestoneLease(this.s, milestoneId, isolationMode, "orchestrator");
    }
    let result = safety.validateUnitRoot({
      unitType,
      unitId,
      writeScope,
      projectRoot: this.runtimeBasePath,
      unitRoot: activeBasePath,
      milestoneId,
      isolationMode,
      expectedBranch: buildExpectedBranch(isolationMode),
      lease: buildLease(isolationMode),
    });
    if (!result.ok) {
      const repaired = await repairAutoWorktreeSafetyFailure({
        safetyResult: result,
        projectRoot: this.runtimeBasePath,
        activeRoot: activeBasePath,
        milestoneId,
        enterMilestone: async (id) => {
          this.buildLifecycle().adoptSessionRoot(this.runtimeBasePath, this.s.originalBasePath || this.runtimeBasePath);
          const enterResult = this.buildLifecycle().enterMilestone(id, {
            notify: this.ctx.ui.notify.bind(this.ctx.ui),
          });
          if (!enterResult.ok) return { ok: false, reason: enterResult.reason };
          this.rebuildScope(this.s.basePath, this.s.currentMilestoneId);
          return { ok: true };
        },
        revalidate: () => {
          const revalidatedMode = this.getEffectiveUnitIsolationMode(this.runtimeBasePath);
          return safety.validateUnitRoot({
            unitType,
            unitId,
            writeScope,
            projectRoot: this.runtimeBasePath,
            unitRoot: this.getLiveDispatchBasePath(),
            milestoneId,
            isolationMode: revalidatedMode,
            expectedBranch: buildExpectedBranch(revalidatedMode),
            lease: buildLease(revalidatedMode),
          });
        },
      });
      result = repaired.result;
      if (result.ok) {
        return { ok: true, reason: repaired.repaired ? `repaired-${result.kind}` : result.kind };
      }
      const repairDetail = repaired.repairReason
        ? ` (repair skipped: ${repaired.repairReason})`
        : "";
      return { ok: false, reason: `${result.kind}: ${result.reason}${repairDetail}` };
    }
    return { ok: true, reason: result.kind };
  }

  // ── RecoveryAdapter (folded) ─────────────────────────────────────────────

  private classifyAndRecover(input: {
    error: unknown;
    unitType?: string;
    unitId?: string;
  }): { action: "retry" | "escalate" | "stop"; reason: string } {
    const recovery = classifyFailure(input);
    return { action: recovery.action, reason: recovery.reason };
  }

  /**
   * ADR-030 Phase Transition Invariant (advisory mode). The matrix is an
   * assertion, not a decision-maker — deriveState already chose the phase; we
   * only observe illegal *derived* edges that survived reconciliation. The
   * matrix is still a sparse hardening spec, so this is telemetry-only (no
   * block) until it is expanded into a validated legal-edge graph. To enforce:
   * `throw violation;` instead of logging — recovery-classification maps
   * IllegalPhaseTransitionError to kind "illegal-transition" (escalate).
   */
  private observePhaseTransition(from: Phase, to: Phase): void {
    if (isLegalEdge(from, to)) return;
    const violation = new IllegalPhaseTransitionError(from, to);
    debugLog("phase-transition-advisory", { from, to, message: violation.message });
  }

  // ── Lifecycle verbs ──────────────────────────────────────────────────────

  /**
   * #442: graduated stuck recovery, ported from the legacy
   * auto/phases.ts:runDispatch path that Phase 3 retires. The ring-buffer
   * hard-stops (stuck-loop saturation and finalized-repeat) would otherwise
   * KILL a unit that actually completed on disk but whose DB row is still
   * stale. Before hard-stopping, verify the expected artifact exists; if so,
   * refresh the DB from it, invalidate caches and reset the dispatch ring so
   * the next advance picks the correct next unit. Bounded to one attempt per
   * stuck key per episode (reset on lifecycle + genuine finalize) to avoid an
   * unbounded recover→re-saturate→recover loop — mirrors the legacy
   * Level-1-recover-then-Level-2-hard-stop escalation.
   *
   * Returns true when recovery succeeded; the caller should re-loop (return a
   * skipped result) instead of stopping.
   */
  private tryStuckArtifactRecovery(unitType: string, unitId: string): boolean {
    const key = buildDispatchKey(unitType, unitId);
    if (this.lastStuckRecoveryKey === key) return false; // already tried this episode
    const basePath = this.getLiveDispatchBasePath();
    if (!verifyExpectedArtifact(unitType, unitId, basePath)) return false;
    const refreshed = refreshRecoveryDbForArtifact(unitType, unitId, basePath);
    // Fatal failures cannot be recovered — hard-stop. Non-fatal (e.g. plan-slice
    // DB refresh hiccup) still fall through: invalidating caches and resetting
    // the ring gives the next advance a clean slate to pick up the correct state,
    // mirroring the legacy Level-1 "continue" escalation path.
    if (!refreshed.ok && refreshed.fatal) return false;
    this.lastStuckRecoveryKey = key;
    invalidateAllCaches();
    this.dispatchHistory.clearOnRecovery();
    this.lastAdvanceKey = null;
    this.lastFinalizedUnitKey = null;
    return true;
  }

  private stuckRecovered(
    decision: { unitType: string; unitId: string },
    stateSnapshot: GSDState,
  ): AutoAdvanceResult {
    const recovered: AutoAdvanceResult = {
      kind: "skipped",
      reason: `stuck-recovery: ${decision.unitType} ${decision.unitId} artifact found on disk; DB refreshed`,
      stateSnapshot,
    };
    this.status.phase = "running";
    this.status.activeUnit = undefined;
    this.bumpTransition();
    this.journalTransition({
      name: "advance-skipped",
      reason: recovered.reason,
      unitType: decision.unitType,
      unitId: decision.unitId,
    });
    this.postAdvanceRecord(recovered);
    return recovered;
  }

  public async start(_sessionContext: AutoSessionContext): Promise<AutoAdvanceResult> {
    this.lastAdvanceKey = null;
    this.lastFinalizedUnitKey = null;
    // #852: a fresh user-triggered session must start with a clean stuck window.
    // Cross-session rehydration at start() was removed because it caused false
    // stuck-loop verdicts when prior sessions left consecutive finalize-retry
    // entries in unit_dispatches — the new session would be killed before its
    // first dispatch ran. Within-session stuck detection (accumulated through
    // recordDispatch() calls during advance()) remains fully active and catches
    // genuine stuck patterns after STUCK_WINDOW_SIZE dispatches.
    //
    // resume() retains cross-session rehydration: an interrupted session resuming
    // after a crash should see the dispatch history it had been accumulating.
    this.dispatchHistory.clearOnRecovery();
    this.lastStuckRecoveryKey = null;
    this.lastDerivedPhase = null;
    this.status.phase = "running";
    this.bumpTransition();
    this.journalTransition({ name: "start" });
    this.notifyLifecycle({ name: "start" });
    return { kind: "started" };
  }

  public async advance(): Promise<AutoAdvanceResult> {
    debugCount("dispatches");
    const stopAdvanceTimer = debugTime("orchestrator-advance");
    try {
      this.ensureLockOwnership();
      const uokGateContext = this.resolveUokGateContext();

      const staleMsg = this.checkResourcesStale();
      if (staleMsg) {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "resource-version-guard",
          gateType: "policy",
          outcome: "fail",
          failureClass: "policy",
          rationale: "resource version guard blocked dispatch",
          findings: staleMsg,
        });
        const blocked: AutoAdvanceResult = { kind: "blocked", reason: staleMsg, action: "pause" };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return blocked;
      }
      await this.emitUokGate({
        ...uokGateContext,
        gateId: "resource-version-guard",
        gateType: "policy",
        outcome: "pass",
        failureClass: "none",
        rationale: "resource version guard passed",
      });

      const gate = await this.preAdvanceGate();
      if (gate.kind === "fail") {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "pre-dispatch health gate blocked dispatch",
          findings: gate.reason,
        });
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: gate.reason,
          action: gate.action ?? "pause",
        };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return blocked;
      }
      if (gate.kind === "threw") {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "pre-dispatch health gate threw unexpectedly",
          findings: String(gate.error),
        });
        // intentional fall-through: matches runPreDispatch behaviour
      } else {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "pass",
          failureClass: "none",
          rationale: "pre-dispatch health gate passed",
          findings: gate.fixesApplied?.join(", ") ?? "",
        });
      }

      const reconciliation = await this.reconcileBeforeDispatch();
      if (!reconciliation.ok || !reconciliation.stateSnapshot) {
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: reconciliation.reason ?? "state reconciliation produced no snapshot",
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      const reconciledPhase = reconciliation.stateSnapshot.phase;
      if (this.lastDerivedPhase !== null) {
        this.observePhaseTransition(this.lastDerivedPhase, reconciledPhase);
      }
      this.lastDerivedPhase = reconciledPhase;

      const decision = await this.decideNextUnit({ stateSnapshot: reconciliation.stateSnapshot });
      if (!decision) {
        const settlementBlock = this.evaluateNoRemainingUnitsSettlement(reconciliation.stateSnapshot);
        if (settlementBlock) {
          const settlement = this.s.milestoneSettlement;
          if (settlement && !settlement.ok && settlement.reason === "merge-pending") {
            const merged = await this.mergePendingCompleteMilestone(settlement.milestoneId);
            if (merged.ok) {
              const terminalOutcome = noRemainingUnitsOutcome(reconciliation.stateSnapshot);
              const stopped: AutoAdvanceResult = {
                kind: "stopped",
                reason: terminalOutcome.displayReason,
                stateSnapshot: reconciliation.stateSnapshot,
                terminalOutcome,
              };
              this.status.phase = "stopped";
              this.status.activeUnit = undefined;
              this.lastAdvanceKey = null;
              this.dispatchHistory.clearOnRecovery();
              this.bumpTransition();
              this.journalTransition({ name: "advance-stopped", reason: stopped.reason });
              this.postAdvanceRecord(stopped);
              return stopped;
            }
            settlementBlock.reason = merged.reason;
            settlementBlock.terminalOutcome = {
              code: "settlement-blocked",
              displayReason: merged.reason,
              nextAction: `Fix the merge failure, then retry \`/gsd dispatch complete-milestone ${settlement.milestoneId}\`.`,
              milestoneId: settlement.milestoneId,
              allMilestonesComplete: false,
            };
          }
          this.status.phase = "paused";
          this.status.activeUnit = undefined;
          this.lastAdvanceKey = null;
          this.dispatchHistory.clearOnRecovery();
          this.bumpTransition();
          this.journalTransition({ name: "advance-blocked", reason: settlementBlock.reason });
          this.postAdvanceRecord(settlementBlock);
          return settlementBlock;
        }
        const terminalOutcome = noRemainingUnitsOutcome(reconciliation.stateSnapshot);
        const stopped: AutoAdvanceResult = {
          kind: "stopped",
          reason: terminalOutcome.displayReason,
          stateSnapshot: reconciliation.stateSnapshot,
          terminalOutcome,
        };
        this.status.phase = "stopped";
        this.status.activeUnit = undefined;
        this.lastAdvanceKey = null;
        this.dispatchHistory.clearOnRecovery();
        this.bumpTransition();
        this.journalTransition({ name: "advance-stopped", reason: stopped.reason });
        this.postAdvanceRecord(stopped);
        return stopped;
      }
      if ("kind" in decision && decision.kind === "skipped") {
        const skipped: AutoAdvanceResult = {
          kind: "skipped",
          reason: decision.reason,
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.status.phase = "running";
        this.status.activeUnit = undefined;
        this.bumpTransition();
        this.journalTransition({ name: "advance-skipped", reason: skipped.reason });
        this.postAdvanceRecord(skipped);
        return skipped;
      }
      if (!("unitType" in decision)) {
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: decision.reason,
          action: decision.action,
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      const priorSliceBlocker = this.findPriorSliceCompletionBlocker(decision.unitType, decision.unitId);
      if (priorSliceBlocker) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: priorSliceBlocker,
          action: "stop",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      // Record every dispatch decision in the history window before pre-flight
      // checks so the stuck-loop detector observes the full decision history
      // (including decisions that idempotency would otherwise short-circuit).
      // The window is capped at STUCK_WINDOW_SIZE and evicts oldest-first.
      const nextKey = this.dispatchHistory.recordDispatch(decision.unitType, decision.unitId);

      const matchingCount = this.dispatchHistory.countMatching(nextKey);
      if (this.lastFinalizedUnitKey === nextKey) {
        // #442: the unit re-dispatched immediately after finalizing may have
        // actually completed on disk with a stale DB. Verify + recover before
        // hard-stopping (legacy graduated stuck-recovery parity).
        if (this.tryStuckArtifactRecovery(decision.unitType, decision.unitId)) {
          this.clearPendingDispatch();
          return this.stuckRecovered(decision, reconciliation.stateSnapshot);
        }
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: `state did not advance after finalized ${decision.unitType} ${decision.unitId}`,
          action: "stop",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      // Idempotency: same key as immediately previous successful advance.
      // This is the soft, fast-path block kept from #5786. It only fires when
      // the ring is NOT yet saturated for this key — once the ring is full of
      // `nextKey`, the stuck-loop verdict takes precedence (see below). Both
      // checks coexist: idempotency for the common immediate-repeat case,
      // stuck-loop for the saturated-window case.
      if (this.lastAdvanceKey === nextKey && matchingCount < STUCK_WINDOW_SIZE) {
        // Unit already active — benign no-op. Return skipped so the loop re-polls
        // without cancelling the in-flight unit (blocked+pause would force-cancel it).
        this.clearPendingDispatch();
        const skipped: AutoAdvanceResult = { kind: "skipped", reason: "idempotent advance: unit already active" };
        this.journalTransition({
          name: "advance-skipped",
          reason: skipped.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(skipped);
        return skipped;
      }

      // Stuck-loop detection: consult the Dispatch History module's full
      // detect-stuck rule set once the window is *full* — not only when a
      // single key saturates it. Gating on a single key's saturation count
      // (matchingCount >= STUCK_WINDOW_SIZE) let two-unit oscillations slip
      // through forever: an execute-task ↔ complete-slice loop (a slice gate
      // that keeps reopening the same task, #1225) fills the window with two
      // alternating keys, so neither key ever reaches the saturation count and
      // detect-stuck's oscillation/repeat rules were never even invoked. Firing
      // on window saturation instead covers both shapes. Consecutive same-key
      // re-advances (the benign pause/resume churn the old count gate guarded
      // against) are already short-circuited above by the idempotency skip, and
      // legitimate retry backoff is still suppressed inside detect-stuck via the
      // dispatch ledger — a saturated window with no verdict means we are inside
      // the unit's retry-backoff budget, so let the retry proceed.
      const windowSaturated =
        this.dispatchHistory.getRecentWindow().length >= STUCK_WINDOW_SIZE;
      const stuckVerdict = windowSaturated ? this.dispatchHistory.detectStuck() : null;
      if (stuckVerdict) {
        // #442: before declaring a stuck loop, verify the unit didn't actually
        // complete on disk (stale DB) and recover if so — legacy graduated
        // stuck-recovery parity. Otherwise hard-stop with a diagnosable reason.
        if (this.tryStuckArtifactRecovery(decision.unitType, decision.unitId)) {
          this.clearPendingDispatch();
          return this.stuckRecovered(decision, reconciliation.stateSnapshot);
        }
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: `stuck-loop: ${stuckVerdict.reason}`,
          action: "stop",
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      const contract = this.compileUnitToolContract(decision.unitType);
      if (!contract.ok) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: contract.reason,
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      const worktree = await this.prepareWorktreeForUnit(decision.unitType, decision.unitId);
      if (!worktree.ok) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: worktree.reason,
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return blocked;
      }

      this.status.activeUnit = { unitType: decision.unitType, unitId: decision.unitId };
      this.status.phase = "running";
      this.lastAdvanceKey = nextKey;
      this.bumpTransition();

      this.journalTransition({
        name: "advance",
        reason: decision.reason,
        unitType: decision.unitType,
        unitId: decision.unitId,
      });
      // syncAfterUnit was a no-op in the wired WorktreeAdapter.

      const advanced: AutoAdvanceResult = {
        kind: "advanced",
        unit: { unitType: decision.unitType, unitId: decision.unitId },
        stateSnapshot: reconciliation.stateSnapshot,
      };
      this.postAdvanceRecord(advanced);
      return advanced;
    } catch (error) {
      const recovery = this.classifyAndRecover({
        error,
        unitType: this.status.activeUnit?.unitType,
        unitId: this.status.activeUnit?.unitId,
      });
      const result: AutoAdvanceResult = recovery.action === "retry"
        ? { kind: "paused", reason: recovery.reason }
        : recovery.action === "escalate"
          ? { kind: "error", reason: recovery.reason }
          : { kind: "stopped", reason: recovery.reason };

      if (result.kind === "paused") {
        this.status.phase = "paused";
      } else if (result.kind === "stopped") {
        this.status.phase = "stopped";
      } else {
        this.status.phase = "error";
      }

      if (result.kind === "stopped") {
        this.lastAdvanceKey = null;
        this.lastFinalizedUnitKey = null;
        this.dispatchHistory.clearOnRecovery();
        this.status.activeUnit = undefined;
      }
      this.bumpTransition();

      const journalName = result.kind === "paused"
        ? "advance-paused"
        : result.kind === "stopped"
          ? "advance-stopped"
          : "advance-error";
      this.journalTransition({ name: journalName, reason: recovery.reason });

      if (result.kind === "paused") {
        this.notifyLifecycle({ name: "pause", detail: recovery.reason });
      } else if (result.kind === "stopped") {
        this.notifyLifecycle({ name: "stopped", detail: recovery.reason });
      } else if (result.kind === "error") {
        this.notifyLifecycle({ name: "error", detail: recovery.reason });
      }
      this.postAdvanceRecord(result);
      return result;
    } finally {
      stopAdvanceTimer();
    }
  }

  public async resume(): Promise<AutoAdvanceResult> {
    this.lastAdvanceKey = null;
    this.lastFinalizedUnitKey = null;
    // Preserve the dispatch-history window across an in-process resume so
    // stuck-loop detection accumulates across pause/resume cycles rather than
    // resetting each time (#572 regression). When the window is empty (fresh
    // orchestrator resuming a prior session), rehydrate it from the DB
    // dispatch ledger so cross-session re-dispatch loops are detected (#482).
    if (this.dispatchHistory.getRecentWindow().length === 0) {
      this.dispatchHistory.rehydrate();
    }
    this.lastStuckRecoveryKey = null;
    // ADR-030: drop the prior "from" — the first advance after resume has no
    // edge to assert (avoids a false illegal-edge across the pause boundary).
    this.lastDerivedPhase = null;
    this.status.phase = "running";
    this.bumpTransition();
    this.journalTransition({ name: "resume" });
    this.notifyLifecycle({ name: "resume" });
    return { kind: "resumed" };
  }

  public async stop(reason: string): Promise<AutoAdvanceResult> {
    if (this.status.phase === "stopped") {
      return { kind: "stopped", reason };
    }
    // cleanupOnStop was a no-op in the wired WorktreeAdapter.
    this.status.phase = "stopped";
    this.status.activeUnit = undefined;
    this.lastAdvanceKey = null;
    this.lastFinalizedUnitKey = null;
    this.lastDerivedPhase = null;
    // Preserve the dispatch-history window on pause so stuck-loop detection
    // accumulates across pause/resume cycles. Only clear on a hard stop.
    if (reason !== "pause") {
      this.dispatchHistory.clearOnRecovery();
    }
    this.lastStuckRecoveryKey = null;
    this.bumpTransition();
    this.journalTransition({ name: "stop", reason });
    this.notifyLifecycle({ name: "stop", detail: reason });
    return { kind: "stopped", reason };
  }

  public getStatus(): AutoStatus {
    return { ...this.status, activeUnit: this.status.activeUnit ? { ...this.status.activeUnit } : undefined };
  }

  public async completeActiveUnit(unit: { unitType: string; unitId: string }): Promise<void> {
    const unitKey = buildDispatchKey(unit.unitType, unit.unitId);
    const activeUnitKey = this.status.activeUnit
      ? buildDispatchKey(this.status.activeUnit.unitType, this.status.activeUnit.unitId)
      : null;
    if (activeUnitKey !== unitKey) return;

    this.status.activeUnit = undefined;
    this.lastAdvanceKey = null;
    this.lastFinalizedUnitKey = unitKey;
    // Genuine progress — re-enable graduated stuck recovery for future episodes.
    this.lastStuckRecoveryKey = null;
    this.bumpTransition();
    this.journalTransition({
      name: "unit-finalized",
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
  }

  public async retryActiveUnit(unit: { unitType: string; unitId: string }): Promise<void> {
    const unitKey = buildDispatchKey(unit.unitType, unit.unitId);
    const activeUnitKey = this.status.activeUnit
      ? buildDispatchKey(this.status.activeUnit.unitType, this.status.activeUnit.unitId)
      : null;
    if (activeUnitKey !== unitKey && this.lastFinalizedUnitKey !== unitKey) return;

    if (activeUnitKey === unitKey) {
      this.status.activeUnit = undefined;
    }
    this.lastAdvanceKey = null;
    this.lastFinalizedUnitKey = null;
    this.bumpTransition();
    this.journalTransition({
      name: "unit-retry",
      reason: "finalize-retry",
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
  }

  private bumpTransition(): void {
    this.status.transitionCount += 1;
    this.status.lastTransitionAt = now();
  }
}

function isUsableLiveOrchestratorBasePath(basePath: string): boolean {
  if (!basePath || !existsSync(basePath)) return false;
  if (!detectWorktreeName(basePath)) return true;

  try {
    return readFileSync(join(basePath, ".git"), "utf8").trim().startsWith("gitdir: ");
  } catch {
    return false;
  }
}

/**
 * Resolve the base path the live orchestrator should dispatch from, falling
 * back to the project root when the captured worktree path has been removed
 * (e.g. after milestone-merge cleanup). Exported for the closeout-regression
 * tests and reused by the orchestrator's getLiveDispatchBasePath.
 */
export function resolveLiveOrchestratorBasePath(input: {
  capturedBasePath: string;
  runtimeBasePath: string;
  sessionBasePath?: string | null;
  originalBasePath?: string | null;
}): string {
  const primary = input.sessionBasePath || input.capturedBasePath;
  if (isUsableLiveOrchestratorBasePath(primary)) return primary;

  const fallbacks = [
    input.originalBasePath,
    input.runtimeBasePath,
    resolveProjectRoot(input.capturedBasePath),
  ];

  for (const candidate of fallbacks) {
    if (candidate && isUsableLiveOrchestratorBasePath(candidate)) {
      return candidate;
    }
  }

  return input.runtimeBasePath || input.capturedBasePath;
}

export function createAutoOrchestrator(context: OrchestratorContext): AutoOrchestrationModule {
  return new AutoOrchestrator(context);
}

/**
 * Inject an override for the post-settlement markdown projection rebuild,
 * returning a function that restores the default (real rebuild) behavior. Used
 * by tests to deterministically exercise the best-effort rebuild-failure path
 * (orchestrator.ts:637) — otherwise only reachable by driving advance() through
 * a full merge-pending milestone settlement and then contriving a projection
 * fault. No production caller.
 * @internal
 */
export function _setProjectionRebuildFnForTests(
  fn: ((projectRoot: string) => Promise<void>) | null,
): () => void {
  _projectionRebuildFn = fn;
  return () => { _projectionRebuildFn = null; };
}
