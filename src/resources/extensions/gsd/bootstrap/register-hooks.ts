// Project/App: gsd-pi
// File Purpose: Registers GSD extension runtime hooks and token-saving tool policies.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";
import { ALWAYS_PRESERVED_SHIM_TOOL_NAMES } from "@gsd/pi-ai";

import type { GSDEcosystemBeforeAgentStartHandler } from "../ecosystem/gsd-extension-api.js";
import { updateSnapshot } from "../ecosystem/gsd-extension-api.js";

import { buildMilestoneFileName, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "../paths.js";
import { canonicalToolName, clearDiscussionFlowState, isDepthConfirmationAnswer, isMilestoneDepthVerified, isQueuePhaseActive, markApprovalGateVerified, markDepthVerified, resetWriteGateState, shouldBlockContextWrite, shouldBlockPlanningUnit, shouldBlockQueueExecution, shouldBlockWorktreeWrite, isGateQuestionId, setPendingGate, clearPendingGate, getPendingGate, shouldBlockPendingGate, shouldBlockPendingGateBash, extractDepthVerificationMilestoneId } from "./write-gate.js";
import { resolveManifest } from "../unit-context-manifest.js";
import { isBlockedStateFile, isBashWriteToStateFile, BLOCKED_WRITE_ERROR } from "../write-intercept.js";
import { loadFile, saveFile, formatContinue } from "../files.js";
import { clearToolInvocationError, getAutoRuntimeSnapshot, isAutoActive, isAutoPaused, markToolEnd, markToolStart, recordToolInvocationError } from "../auto-runtime-state.js";

import { checkToolCallLoop, resetToolCallLoopGuard } from "./tool-call-loop-guard.js";
import { maybePauseAutoForApprovalGate, resetPendingGatePauseGuard } from "./pending-gate-pause.js";
import { saveActivityLog } from "../activity-log.js";
import { recordToolCall as safetyRecordToolCall, recordToolResult as safetyRecordToolResult, saveEvidenceToDisk } from "../safety/evidence-collector.js";
import { parseUnitId } from "../unit-id.js";
import { classifyCommand } from "../safety/destructive-guard.js";
import { logWarning as safetyLogWarning } from "../workflow-logger.js";
import { installNotifyInterceptor } from "./notify-interceptor.js";
import { initNotificationStore } from "../notification-store.js";
import { initNotificationWidget } from "../notification-widget.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { extractSubagentAgentClasses } from "./subagent-input.js";
import { approvalGateIdForUnit, isExplicitApprovalResponse, shouldPauseForUserApprovalQuestion } from "../user-input-boundary.js";
import { resolveSkillManifest } from "../skill-manifest.js";
import { applyUnitSkillVisibility, unitHasSkillManifest } from "../skill-scope.js";
import { getGuidedUnitContext } from "../guided-unit-context.js";
import { registerPlanMilestoneSchemaRecovery } from "./plan-milestone-schema-recovery.js";
import { AUTO_UNIT_SCOPED_TOOLS, isWorkflowAliasTool } from "../auto-unit-tool-scope.js";

let approvalQuestionAbortInFlight = false;

interface DeferredApprovalGate {
  gateId: string;
  basePath: string;
}

type WelcomeScreenModule = {
  buildWelcomeScreenLines(opts: { version: string; remoteChannel?: string; width?: number }): string[];
};

async function loadWelcomeScreenModule(): Promise<WelcomeScreenModule | undefined> {
  const candidates: string[] = [];
  const gsdBinPath = process.env.GSD_BIN_PATH;
  if (gsdBinPath) {
    candidates.push(join(dirname(gsdBinPath), "welcome-screen.js"));
  }

  const packageRoot = process.env.GSD_PKG_ROOT;
  if (packageRoot) {
    candidates.push(join(packageRoot, "dist", "welcome-screen.js"));
    candidates.push(join(packageRoot, "src", "welcome-screen.ts"));
  }

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const mod = await import(pathToFileURL(candidate).href) as Partial<WelcomeScreenModule>;
      if (typeof mod.buildWelcomeScreenLines === "function") {
        return mod as WelcomeScreenModule;
      }
    } catch {
      // Try the next package layout.
    }
  }
  return undefined;
}

async function installWelcomeHeader(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui?.setHeader !== "function") return;

  try {
    const welcome = await loadWelcomeScreenModule();
    if (!welcome) return;

    let remoteChannel: string | undefined;
    try {
      const { resolveRemoteConfig } = await import("../../remote-questions/config.js");
      const rc = resolveRemoteConfig();
      if (rc) remoteChannel = rc.channel;
    } catch { /* non-fatal */ }

    ctx.ui.setHeader(() => {
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;
      return {
        render(width: number): string[] {
          if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
          cachedLines = welcome.buildWelcomeScreenLines({
            version: process.env.GSD_VERSION || "0.0.0",
            remoteChannel,
            width,
          });
          cachedWidth = width;
          return cachedLines;
        },
        invalidate(): void {
          cachedLines = undefined;
          cachedWidth = undefined;
        },
      };
    });
  } catch {
    /* non-fatal */
  }
}

let deferredApprovalGate: DeferredApprovalGate | null = null;

export const MINIMAL_GSD_TOOL_NAMES = [
  "gsd_exec",
  "gsd_exec_search",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_checkpoint_db",
  "memory_query",
  "capture_thought",
] as const;

export const MINIMAL_AUTO_BASE_TOOL_NAMES = [
  "ask_user_questions",
  "bash",
  "bg_shell",
  "edit",
  "find",
  "glob",
  "grep",
  "fetch_page",
  "search-the-web",
  "ls",
  "read",
  "subagent",
  "write",
  "ToolSearch",
] as const;

function withPreservedShimTools(toolNames: readonly string[]): string[] {
  return [...new Set([...toolNames, ...ALWAYS_PRESERVED_SHIM_TOOL_NAMES])];
}

/** True for the browser automation tools (browser_navigate, browser_click, ...). */
function isBrowserTool(toolName: string): boolean {
  return canonicalToolName(toolName).startsWith("browser_");
}

/**
 * True when any message in the request is driven by a GSD workflow command
 * (customType starting "gsd-"). Plain interactive chat has none, and is scoped
 * to the minimal GSD tool surface by default.
 */
export function requestHasGsdCustomType(
  requestCustomMessages: readonly { customType?: string }[] | undefined,
): boolean {
  return (requestCustomMessages ?? []).some(
    (message) => typeof message.customType === "string" && message.customType.startsWith("gsd-"),
  );
}

const WORKFLOW_GSD_TOOL_NAMES = [
  ...MINIMAL_GSD_TOOL_NAMES,
  ...Object.values(AUTO_UNIT_SCOPED_TOOLS).flat(),
].filter(isGsdManagedTool);

function isGsdManagedTool(name: string): boolean {
  return name.startsWith("gsd_") || name === "memory_query" || name === "capture_thought" || name === "gsd_graph";
}

/**
 * Resolves requested tool names against active tools using exact and MCP-scoped matches.
 *
 * MCP-scoped names follow `mcp__<namespace>__<toolname>`.
 * Example: if `requestedToolNames` contains `gsd_exec` and `activeToolNames` contains
 * `mcp__custom-workflow__gsd_exec`, the MCP-scoped active name is included in the result.
 *
 * Returns deduplicated active tool names that satisfy the requested base names.
 */
function resolveScopedToolNames(
  activeToolNames: readonly string[],
  requestedToolNames: readonly string[],
): string[] {
  const exact = new Set(activeToolNames);
  const resolved = new Set<string>();

  for (const requested of requestedToolNames) {
    const scopedMatches: string[] = [];

    for (const activeName of activeToolNames) {
      if (!activeName.startsWith("mcp__")) continue;
      const toolSeparator = activeName.indexOf("__", "mcp__".length);
      if (toolSeparator < 0) continue;
      if (activeName.slice(toolSeparator + 2) === requested) {
        scopedMatches.push(activeName);
      }
    }

    if (requested.startsWith("browser_") && scopedMatches.length > 0) {
      for (const match of scopedMatches) resolved.add(match);
      continue;
    }

    if (exact.has(requested)) resolved.add(requested);
    for (const match of scopedMatches) resolved.add(match);
  }

  return [...resolved];
}

export function buildMinimalGsdToolSet(activeToolNames: readonly string[]): string[] {
  const preserved = activeToolNames.filter((name) => !isGsdManagedTool(name));
  const minimal = resolveScopedToolNames(activeToolNames, MINIMAL_GSD_TOOL_NAMES);
  return withPreservedShimTools([...new Set([...preserved, ...minimal])]);
}

export function buildMinimalAutoGsdToolSet(
  activeToolNames: readonly string[],
  unitType: string | undefined,
  registeredToolNames: readonly string[] = activeToolNames,
): string[] {
  const unitTools = unitType ? AUTO_UNIT_SCOPED_TOOLS[unitType] ?? [] : [];
  const autoBaseTools = new Set<string>(MINIMAL_AUTO_BASE_TOOL_NAMES);
  const availableBaseTools = registeredToolNames.filter((name) => autoBaseTools.has(name));
  const preserved = [...new Set([
    ...activeToolNames.filter((name) => autoBaseTools.has(name)),
    ...availableBaseTools,
  ])];
  const scoped = resolveScopedToolNames(
    [...activeToolNames, ...registeredToolNames],
    [...MINIMAL_GSD_TOOL_NAMES, ...unitTools],
  );
  return withPreservedShimTools([...new Set([...preserved, ...scoped])]);
}

export function buildMinimalGsdWorkflowToolSet(
  activeToolNames: readonly string[],
  registeredToolNames: readonly string[] = activeToolNames,
): string[] {
  const autoBaseTools = new Set<string>(MINIMAL_AUTO_BASE_TOOL_NAMES);
  const availableBaseTools = registeredToolNames.filter((name) => autoBaseTools.has(name));
  const preserved = [...new Set([
    ...activeToolNames.filter((name) => autoBaseTools.has(name)),
    ...availableBaseTools,
  ])];
  const scoped = resolveScopedToolNames(
    [...activeToolNames, ...registeredToolNames],
    WORKFLOW_GSD_TOOL_NAMES,
  );
  return withPreservedShimTools([...new Set([...preserved, ...scoped])]);
}

export function buildRequestScopedGsdToolSet(
  activeToolNames: readonly string[],
  requestCustomMessages: readonly { customType?: string }[] | undefined,
  registeredToolNames: readonly string[] = activeToolNames,
  guidedUnitType?: string,
): string[] | undefined {
  for (let index = (requestCustomMessages?.length ?? 0) - 1; index >= 0; index--) {
    const currentCustomType = requestCustomMessages?.[index]?.customType;
    if (
      currentCustomType === "gsd-run" ||
      currentCustomType === "gsd-discuss" ||
      currentCustomType === "gsd-doctor-heal" ||
      currentCustomType === "gsd-triage"
    ) {
      if (guidedUnitType) {
        return buildMinimalAutoGsdToolSet(activeToolNames, guidedUnitType, registeredToolNames);
      }
      return buildMinimalGsdWorkflowToolSet(activeToolNames, registeredToolNames);
    }
  }
  return undefined;
}

export function isFullGsdToolSurfaceRequested(): boolean {
  return process.env.PI_GSD_FULL_TOOLS === "1";
}

function isGeneralGsdToolScopingRequested(): boolean {
  return process.env.PI_GSD_MINIMAL_TOOLS === "1";
}

/**
 * Whether the browser automation surface (~7K tokens) should be
 * advertised in interactive sessions. Off by default — browser tools stay
 * registered/callable (so auto run-uat, which scopes them in explicitly, is
 * unaffected) but are dropped from the model-facing surface until opted in.
 */
function isBrowserToolSurfaceRequested(): boolean {
  return process.env.PI_GSD_BROWSER_TOOLS === "1";
}

export interface ScopedGsdWorkflowState {
  tools: string[] | null;
  visibleSkills: string[] | undefined;
  restoreVisibleSkills: boolean;
}

type GsdWorkflowScopeApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools"> & Partial<Pick<ExtensionAPI, "getAllTools" | "getVisibleSkills" | "setVisibleSkills">>;

function resolveRegisteredToolNames(
  pi: Pick<ExtensionAPI, "getActiveTools"> & Partial<Pick<ExtensionAPI, "getAllTools">>,
  fallback: readonly string[],
): string[] {
  if (typeof pi.getAllTools === "function") {
    return pi.getAllTools().map((tool) => tool.name);
  }
  return [...fallback];
}

function applyMinimalGsdToolSurface(pi: ExtensionAPI): void {
  if (isFullGsdToolSurfaceRequested()) return;
  const dash = getAutoRuntimeSnapshot();
  if (dash.active && dash.currentUnit) {
    pi.setActiveTools(buildMinimalAutoGsdToolSet(
      pi.getActiveTools(),
      dash.currentUnit.type,
      resolveRegisteredToolNames(pi, pi.getActiveTools()),
    ));
    return;
  }
  if (!isGeneralGsdToolScopingRequested()) return;
  pi.setActiveTools(buildMinimalGsdToolSet(pi.getActiveTools()));
}

export function scopeGsdWorkflowToolsForDispatch(
  pi: GsdWorkflowScopeApi,
  unitType?: string,
): ScopedGsdWorkflowState | null {
  if (isFullGsdToolSurfaceRequested()) return null;
  const current = pi.getActiveTools();
  const registeredToolNames = resolveRegisteredToolNames(pi, current);
  const scoped = unitType
    ? buildMinimalAutoGsdToolSet(current, unitType, registeredToolNames)
    : buildMinimalGsdWorkflowToolSet(current, registeredToolNames);
  const toolsChanged = !(scoped.length === current.length && scoped.every((name, index) => name === current[index]));
  const canScopeSkills = unitHasSkillManifest(unitType) && pi.getVisibleSkills && pi.setVisibleSkills;
  if (!toolsChanged && !canScopeSkills) {
    return null;
  }
  if (toolsChanged) {
    pi.setActiveTools(scoped);
  }
  const visibleSkills = canScopeSkills ? pi.getVisibleSkills!() : undefined;
  if (canScopeSkills && pi.setVisibleSkills) {
    applyUnitSkillVisibility({ setVisibleSkills: pi.setVisibleSkills }, unitType);
  }
  return {
    tools: toolsChanged ? current : null,
    visibleSkills,
    restoreVisibleSkills: Boolean(canScopeSkills),
  };
}

export function restoreGsdWorkflowTools(
  pi: Pick<ExtensionAPI, "setActiveTools"> & Partial<Pick<ExtensionAPI, "setVisibleSkills">>,
  savedState: ScopedGsdWorkflowState | null,
): void {
  if (!savedState) return;
  if (savedState.tools) pi.setActiveTools(savedState.tools);
  if (savedState.restoreVisibleSkills && pi.setVisibleSkills) {
    pi.setVisibleSkills(savedState.visibleSkills);
  }
}

async function deriveGsdState(basePath: string) {
  const { deriveState } = await import("../state.js");
  return deriveState(basePath);
}

async function getDiscussionMilestoneIdFor(basePath: string): Promise<string | null> {
  const { getDiscussionMilestoneId } = await import("../guided-flow.js");
  return getDiscussionMilestoneId(basePath);
}

async function loadToolApiKeysForSession(): Promise<void> {
  const { loadToolApiKeys } = await import("../commands-config.js");
  loadToolApiKeys();
}

async function resetAskUserQuestionsTurnCache(): Promise<void> {
  const { resetAskUserQuestionsCache } = await import("../../ask-user-questions.js");
  resetAskUserQuestionsCache();
}

async function syncServiceTierStatus(ctx: ExtensionContext): Promise<void> {
  const { getEffectiveServiceTier, formatServiceTierFooterStatus } = await import("../service-tier.js");
  ctx.ui.setStatus("gsd-fast", formatServiceTierFooterStatus(getEffectiveServiceTier(), ctx.model?.id));
}

async function applyDisabledModelProviderPolicy(ctx: ExtensionContext): Promise<void> {
  try {
    const { resolveDisabledModelProvidersFromPreferences } = await import("../preferences.js");
    ctx.modelRegistry.setDisabledModelProviders(resolveDisabledModelProvidersFromPreferences());
  } catch {
    // Non-fatal: keep default provider visibility if preferences cannot be loaded.
  }
}

/**
 * Bridge `context_management.compaction_threshold_percent` from GSD preferences
 * into the agent's runtime compaction settings (#5475). The preference is
 * validated to [0.5, 0.95] at load time, but defense-in-depth normalization
 * here protects against a stale or hand-edited prefs file. Calling with
 * `undefined` clears any prior override so a removed preference does not leak.
 */
async function applyCompactionThresholdOverride(ctx: ExtensionContext): Promise<void> {
  try {
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");
    const prefs = loadEffectiveGSDPreferences();
    const raw = prefs?.preferences.context_management?.compaction_threshold_percent;
    const value =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 0.5 && raw <= 0.95 ? raw : 0.6;
    ctx.setCompactionThresholdOverride?.(value);
  } catch {
    // Non-fatal: use conservative default when preferences cannot be loaded.
    ctx.setCompactionThresholdOverride?.(0.6);
  }
}

function clearDeferredApprovalGate(basePath?: string): void {
  if (!basePath || deferredApprovalGate?.basePath === basePath) {
    deferredApprovalGate = null;
  }
}

function deferApprovalGate(gateId: string, basePath: string): void {
  deferredApprovalGate = { gateId, basePath };
}

function contextBasePath(ctx?: { cwd?: string }): string {
  return typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
}

function activateDeferredApprovalGate(basePath: string): void {
  if (deferredApprovalGate?.basePath !== basePath) return;
  setPendingGate(deferredApprovalGate.gateId, basePath);
  deferredApprovalGate = null;
}

function extractGateQuestionId(input: unknown): string | undefined {
  const questions: Array<{ id?: unknown }> = (input as { questions?: unknown })?.questions as Array<{ id?: unknown }> ?? [];
  const match = questions.find((question) => typeof question?.id === "string" && isGateQuestionId(question.id));
  return typeof match?.id === "string" ? match.id : undefined;
}

function isApprovalGateBlocking(basePath: string): boolean {
  return Boolean(getPendingGate(basePath))
    || (deferredApprovalGate?.basePath === basePath);
}

function isContextDraftSummarySave(toolName: string, input: unknown): boolean {
  if (toolName !== "gsd_summary_save" && toolName !== "summary_save") return false;
  if (!input || typeof input !== "object") return false;
  return (input as { artifact_type?: unknown }).artifact_type === "CONTEXT-DRAFT";
}

function shouldBlockDeferredApprovalTool(
  toolName: string,
  input: unknown,
  basePath: string,
): { block: boolean; reason?: string } {
  if (deferredApprovalGate?.basePath !== basePath) return { block: false };
  if (toolName === "ask_user_questions") return { block: false };
  if (isContextDraftSummarySave(toolName, input)) return { block: false };
  return {
    block: true,
    reason: [
      `HARD BLOCK: Approval question "${deferredApprovalGate.gateId}" has been shown to the user.`,
      `Only CONTEXT-DRAFT persistence may finish in this same assistant turn.`,
      `Wait for the user's answer before calling additional tools.`,
    ].join(" "),
  };
}

export function resolveNotificationStoreBasePath(basePath: string): string {
  return resolveWorktreeProjectRoot(basePath);
}

function initSessionNotifications(ctx: ExtensionContext): void {
  initNotificationStore(resolveNotificationStoreBasePath(contextBasePath(ctx)));
  installNotifyInterceptor(ctx);
  initNotificationWidget(ctx);
}

async function prepareWorkflowMcpForHookContext(
  ctx: ExtensionContext,
  basePath: string,
): Promise<void> {
  // Skip MCP auto-prep when running inside an auto-worktree. The worktree
  // already has .mcp.json from createAutoWorktree, and re-running the writer
  // post-chdir rewrites the file mid-run (non-idempotent due to cwd-relative
  // CLI path resolution), dirtying the tree and breaking the milestone merge.
  const { isInAutoWorktree } = await import("../auto-worktree.js");
  if (isInAutoWorktree(basePath)) return;

  const { prepareWorkflowMcpForProject } = await import("../workflow-mcp-auto-prep.js");
  prepareWorkflowMcpForProject(ctx, basePath);
}

export function registerHooks(
  pi: ExtensionAPI,
  ecosystemHandlers: GSDEcosystemBeforeAgentStartHandler[],
): void {
  // ADR-005 Phase 3b: surface pi-ai ProviderSwitchReport via audit, notification, and counter.
  // Idempotent — only the first registerHooks call installs.
  void import("../provider-switch-observer.js").then((m) => m.installProviderSwitchObserver());

  registerPlanMilestoneSchemaRecovery(pi);

  pi.on("session_start", async (_event, ctx) => {
    const basePath = contextBasePath(ctx);
    initSessionNotifications(ctx);
    if (!isAutoActive()) {
      const { initHealthWidget } = await import("../health-widget.js");
      initHealthWidget(ctx);
    }
    resetWriteGateState(basePath);
    resetToolCallLoopGuard();
    approvalQuestionAbortInFlight = false;
    clearDeferredApprovalGate();
    await resetAskUserQuestionsTurnCache();
    await syncServiceTierStatus(ctx);
    await applyDisabledModelProviderPolicy(ctx);
    await applyCompactionThresholdOverride(ctx);
    await prepareWorkflowMcpForHookContext(ctx, basePath);

    // Apply show_token_cost preference (#1515)
    try {
      const { loadEffectiveGSDPreferences } = await import("../preferences.js");
      const prefs = loadEffectiveGSDPreferences(basePath);
      process.env.GSD_SHOW_TOKEN_COST = prefs?.preferences.show_token_cost ? "1" : "";
    } catch { /* non-fatal */ }
    await installWelcomeHeader(ctx);
    await loadToolApiKeysForSession();
    if (isAutoActive()) {
      ctx.ui.setWidget("gsd-health", undefined);
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    const basePath = contextBasePath(ctx);
    initSessionNotifications(ctx);
    resetWriteGateState(basePath);
    resetToolCallLoopGuard();
    clearDeferredApprovalGate();
    await resetAskUserQuestionsTurnCache();
    clearDiscussionFlowState(basePath);
    await syncServiceTierStatus(ctx);
    await applyDisabledModelProviderPolicy(ctx);
    await applyCompactionThresholdOverride(ctx);
    await prepareWorkflowMcpForHookContext(ctx, basePath);
    await loadToolApiKeysForSession();
    if (!isAutoActive()) {
      ctx.ui.setWidget("gsd-progress", undefined);
      ctx.ui.setWidget("gsd-outcome", undefined);
      const { initHealthWidget } = await import("../health-widget.js");
      initHealthWidget(ctx);
    } else {
      ctx.ui.setWidget("gsd-health", undefined);
    }
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    resetPendingGatePauseGuard();
    applyMinimalGsdToolSurface(pi);

    // Wait for ecosystem loader to finish (no-op after first turn).
    const { getEcosystemReadyPromise } = await import("../ecosystem/loader.js");
    await getEcosystemReadyPromise();

    const beforeAgentBasePath = contextBasePath(ctx);
    const pendingApprovalGate = getPendingGate(beforeAgentBasePath);
    if (pendingApprovalGate && isExplicitApprovalResponse(event.prompt, pendingApprovalGate)) {
      markApprovalGateVerified(pendingApprovalGate, beforeAgentBasePath);
      const milestoneId = extractDepthVerificationMilestoneId(pendingApprovalGate);
      if (milestoneId) markDepthVerified(milestoneId, beforeAgentBasePath);
      clearPendingGate(beforeAgentBasePath);
      if (isAutoPaused() && !isAutoActive()) {
        const { resumeAutoAfterProviderDelay } = await import("./provider-error-resume.js");
        void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to resume auto-mode after approval: ${message}`, "warning");
        });
      }
    }
    clearDeferredApprovalGate(beforeAgentBasePath);

    // session_start can fire before the active provider has settled. By
    // before_agent_start, Claude Code CLI sessions should get the same
    // project MCP config that /gsd mcp init would write.
    await prepareWorkflowMcpForHookContext(ctx, beforeAgentBasePath);

    let systemPrompt = event.systemPrompt;
    const { appendDiscoveredSkillsFallback, hasSkillSnapshot, refreshCatalogForNewSkills } = await import("../skill-discovery.js");
    if (hasSkillSnapshot()) {
      const loadedSkills = await refreshCatalogForNewSkills({
        reload: () => (ctx as ExtensionContext & { reload: () => Promise<void> }).reload(),
        notify: (message, level) => ctx.ui.notify(message, level),
      });
      if (loadedSkills.length > 0) {
        systemPrompt = appendDiscoveredSkillsFallback(ctx.getSystemPrompt(), loadedSkills);
      }
    }

    // GSD's own context injection (existing behavior — unchanged).
    const { buildBeforeAgentStartResult } = await import("./system-context.js");
    const gsdResult = await buildBeforeAgentStartResult({ ...event, systemPrompt }, ctx);

    // Refresh the snapshot used by ecosystem getPhase()/getActiveUnit().
    // deriveState has its own ~100ms cache so this is cheap on repeat calls.
    try {
      const state = await deriveGsdState(beforeAgentBasePath);
      updateSnapshot(state);
    } catch {
      updateSnapshot(null);
    }

    // Chain ecosystem handlers using pi's runner.ts chaining protocol:
    // each handler sees the systemPrompt mutated by prior handlers.
    let currentSystemPrompt = gsdResult?.systemPrompt ?? systemPrompt;
    // `any` because pi's BeforeAgentStartEventResult.message uses an internal
    // CustomMessage type that's not re-exported (see ecosystem/gsd-extension-api.ts).
    let lastMessage: any = gsdResult?.message;

    for (const handler of ecosystemHandlers) {
      try {
        const r = await handler(
          { ...event, systemPrompt: currentSystemPrompt },
          ctx,
        );
        if (r?.systemPrompt !== undefined) currentSystemPrompt = r.systemPrompt;
        if (r?.message) lastMessage = r.message;
      } catch (err) {
        safetyLogWarning(
          "ecosystem",
          `before_agent_start handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Compose result. Return undefined if nothing changed (preserves runner contract).
    if (currentSystemPrompt === event.systemPrompt && !lastMessage) return undefined;
    return {
      systemPrompt: currentSystemPrompt !== event.systemPrompt ? currentSystemPrompt : undefined,
      message: lastMessage,
    };
  });

  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    approvalQuestionAbortInFlight = false;
    resetToolCallLoopGuard();
    resetPendingGatePauseGuard();
    await resetAskUserQuestionsTurnCache();
    const { handleAgentEnd } = await import("./agent-end-recovery.js");
    const agentEndBasePath = contextBasePath(ctx);
    try {
      await handleAgentEnd(pi, event, ctx);
    } finally {
      activateDeferredApprovalGate(agentEndBasePath);
      await maybePauseAutoForApprovalGate(
        ctx,
        pi,
        isApprovalGateBlocking(agentEndBasePath),
        "Depth confirmation is waiting for your answer — pausing auto-mode.",
      );
    }
  });

  pi.on("message_end", async (event) => {
    const { suppressTerminalDeletedWorktreeMessageEnd } = await import("./agent-end-recovery.js");
    suppressTerminalDeletedWorktreeMessageEnd(event);
  });

  // Squash-merge quick-task branch back to the original branch after the
  // agent turn completes (#2668). cleanupQuickBranch is a no-op when no
  // quick-return state is pending, so this is safe to call on every turn.
  pi.on("turn_end", async () => {
    try {
      const { cleanupQuickBranch } = await import("../quick.js");
      cleanupQuickBranch();
    } catch {
      // Best-effort: don't break the turn lifecycle if cleanup fails.
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const basePath = contextBasePath(ctx);
    // Context Mode is default-on. Write the resumable snapshot before any
    // active-auto cancel return so auto sessions still leave re-entry context.
    const { writeContextModeCompactionSnapshot } = await import("../context-mode-snapshot.js");
    await writeContextModeCompactionSnapshot(basePath);

    const prep = event?.preparation;
    if (prep && prep.messagesToSummarize?.length === 0 && prep.turnPrefixMessages?.length === 0) {
      ctx.ui.notify(
        "Skipped compaction because there was no conversation history to summarize; history preserved.",
        "warning",
      );
      return { cancel: true };
    }

    // Only cancel compaction while auto-mode is actively running and context
    // still has headroom. At ~90%+ the session is at risk of overflow/truncation;
    // allow compaction (with CONTINUE checkpoint below) instead of growing unbounded.
    if (isAutoActive()) {
      const usage = ctx.getContextUsage?.();
      const contextPercent = usage?.percent;
      if (contextPercent == null || contextPercent < 90) {
        return { cancel: true };
      }
      ctx.ui.notify(
        `Context at ${contextPercent.toFixed(1)}% — compacting during auto-mode to recover headroom.`,
        "warning",
      );
    }
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    await ensureDbOpen(basePath);
    const state = await deriveGsdState(basePath);
    if (!state.activeMilestone || !state.activeSlice) return;
    // Write checkpoint for ALL phases, not just "executing" — discuss, research,
    // and planning also carry in-memory state (user answers, gate verification)
    // that would be lost on compaction (#4258).
    // if (state.phase !== "executing") return;

    const sliceDir = resolveSlicePath(basePath, state.activeMilestone.id, state.activeSlice.id);
    if (!sliceDir) return;

    const existingFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "CONTINUE");
    if (existingFile && await loadFile(existingFile)) return;
    const legacyContinue = join(sliceDir, "continue.md");
    if (await loadFile(legacyContinue)) return;

    const continuePath = join(sliceDir, `${state.activeSlice.id}-CONTINUE.md`);
    const taskId = state.activeTask?.id ?? "none";
    const taskTitle = state.activeTask?.title ?? "";
    const phaseLabel = state.phase.replace(/-/g, " ");

    await saveFile(continuePath, formatContinue({
      frontmatter: {
        milestone: state.activeMilestone.id,
        slice: state.activeSlice.id,
        task: taskId,
        step: 0,
        totalSteps: 0,
        status: "compacted" as const,
        savedAt: new Date().toISOString(),
      },
      completedWork: state.activeTask
        ? `Task ${taskId} (${taskTitle}) was in progress when compaction occurred.`
        : `Slice ${state.activeSlice.id} was in ${phaseLabel} phase when compaction occurred.`,
      remainingWork: state.activeTask
        ? "Check the task plan for remaining steps."
        : "Continue this slice from the latest planning/research/discussion artifacts.",
      decisions: "Check task summary files for prior decisions.",
      context: "Session was auto-compacted by Pi. Resume with /gsd.",
      nextAction: state.activeTask
        ? `Resume task ${taskId}: ${taskTitle}.`
        : `Resume ${phaseLabel} work for slice ${state.activeSlice.id}.`,
    }));
  });

  pi.on("message_update", async (event, ctx: ExtensionContext) => {
    if (approvalQuestionAbortInFlight) return;

    const dash = getAutoRuntimeSnapshot();
    if (dash.active) return;
    let unitType = dash.currentUnit?.type;
    let unitId = dash.currentUnit?.id;

    if (!unitType) {
      try {
        const { getPendingDeepProjectSetupUnitForContext } = await import("../guided-flow.js");
        const pending = getPendingDeepProjectSetupUnitForContext(ctx, contextBasePath(ctx));
        unitType = pending?.unitType;
        unitId = pending?.unitId;
      } catch {
        // Best-effort foreground detection only.
      }
    }

    if (!unitType) {
      const milestoneId = await getDiscussionMilestoneIdFor(contextBasePath(ctx));
      if (milestoneId) {
        unitType = "discuss-milestone";
        unitId = milestoneId;
      }
    }

    if (!shouldPauseForUserApprovalQuestion(unitType, [event.message])) return;

    const gateId = approvalGateIdForUnit(unitType, unitId);
    if (gateId) {
      // Skip the gate if this milestone is already depth-verified — the approval
      // pattern matched again on post-verification text (a false-positive re-trigger).
      // Without this guard, the second firing blocks gsd_plan_milestone in the same
      // turn and leaves CONTEXT.md on disk with no DB row (#discuss-milestone-no-db).
      const gateMilestoneId = extractDepthVerificationMilestoneId(gateId);
      if (gateMilestoneId && isMilestoneDepthVerified(gateMilestoneId, contextBasePath(ctx))) return;
      deferApprovalGate(gateId, contextBasePath(ctx));
    }

    approvalQuestionAbortInFlight = true;
    ctx.ui.notify(
      `${unitType}${unitId ? ` ${unitId}` : ""} is waiting for your approval - pausing before more tool calls run.`,
      "info",
    );
    // The durable pending gate is activated at agent_end so same-turn
    // CONTEXT-DRAFT persistence can finish after the text boundary streams.
    // The tool_call hook below still blocks non-draft tools in this turn.
    // Aborting mid-stream eats the model's question text on external CLI
    // providers (Claude Code SDK) because lastTextContent isn't populated
    // from in-flight builder state — the user only ever sees "Claude Code
    // stream aborted by caller" instead of the question.
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    const { isParallelActive, shutdownParallel } = await import("../parallel-orchestrator.js");
    if (isParallelActive()) {
      try {
        await shutdownParallel(contextBasePath(ctx));
      } catch {
        // best-effort
      }
    }
    if (!isAutoActive() && !isAutoPaused()) return;
    const dash = getAutoRuntimeSnapshot();
    if (dash.currentUnit) {
      saveActivityLog(ctx, dash.basePath, dash.currentUnit.type, dash.currentUnit.id);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const discussionBasePath = contextBasePath(ctx);
    const toolName = canonicalToolName(event.toolName);
    // ── Loop guard: block repeated identical tool calls ──
    const loopCheck = checkToolCallLoop(toolName, event.input as Record<string, unknown>);
    if (loopCheck.block) {
      return { block: true, reason: loopCheck.reason };
    }

    const deferredGateGuard = shouldBlockDeferredApprovalTool(
      toolName,
      event.input,
      discussionBasePath,
    );
    if (deferredGateGuard.block) {
      if (ctx) {
        await maybePauseAutoForApprovalGate(
          ctx,
          pi,
          isApprovalGateBlocking(discussionBasePath),
          "Depth confirmation is waiting for your answer — pausing auto-mode.",
        );
      }
      return deferredGateGuard;
    }

    // ── Discussion gate enforcement: defer gate arming until execution ─────
    // Same-turn CONTEXT-DRAFT persistence can finish after the question is shown.
    // The durable pending gate activates at tool_execution_start (or agent_end for
    // streamed text approval questions).
    if (toolName === "ask_user_questions") {
      const questionId = extractGateQuestionId(event.input);
      if (typeof questionId === "string") {
        deferApprovalGate(questionId, discussionBasePath);
      }
    }

    // ── Discussion gate enforcement: block tool calls while gate is pending ──
    // If ask_user_questions was called with a gate ID but hasn't been confirmed,
    // block all non-read-only tool calls to prevent the model from skipping gates.
    if (getPendingGate(discussionBasePath)) {
      const milestoneId = await getDiscussionMilestoneIdFor(discussionBasePath);
      if (isToolCallEventType("bash", event)) {
        const bashGuard = shouldBlockPendingGateBash(
          event.input.command,
          milestoneId,
          isQueuePhaseActive(discussionBasePath),
          discussionBasePath,
        );
        if (bashGuard.block) {
          if (ctx) {
            await maybePauseAutoForApprovalGate(
              ctx,
              pi,
              true,
              "Depth confirmation is waiting for your answer — pausing auto-mode.",
            );
          }
          return bashGuard;
        }
      } else {
        const gateGuard = shouldBlockPendingGate(
          toolName,
          milestoneId,
          isQueuePhaseActive(discussionBasePath),
          discussionBasePath,
        );
        if (gateGuard.block) {
          if (ctx) {
            await maybePauseAutoForApprovalGate(
              ctx,
              pi,
              true,
              "Depth confirmation is waiting for your answer — pausing auto-mode.",
            );
          }
          return gateGuard;
        }
      }
    }

    // ── Queue-mode execution guard (#2545): block source-code mutations ──
    // When /gsd queue is active, the agent should only create milestones,
    // not execute work. Block write/edit to non-.gsd/ paths and bash commands
    // that would modify files.
    if (isQueuePhaseActive(discussionBasePath)) {
      let queueInput = "";
      if (isToolCallEventType("write", event)) {
        queueInput = event.input.path;
      } else if (isToolCallEventType("edit", event)) {
        queueInput = event.input.path;
      } else if (isToolCallEventType("bash", event)) {
        queueInput = event.input.command;
      }
      const queueGuard = shouldBlockQueueExecution(toolName, queueInput, true);
      if (queueGuard.block) return queueGuard;
    }

    // ── Planning-unit tools-policy enforcement (#4934): runtime half ─────
    // The active auto-mode unit's manifest declares a ToolsPolicy. For
    // planning/docs/read-only modes, deny writes outside .gsd/ (or the
    // manifest's allowedPathGlobs), bash that isn't read-only, and
    // subagent dispatch. Closes the b23 bug class where a discuss-milestone
    // turn used the host Edit tool to modify user source files.
    const dash = getAutoRuntimeSnapshot();

    // ScheduleWakeup is registered by the GSD extension so auto-mode can
    // continue the same unit session after long external waits.
    const guidedUnit = getGuidedUnitContext(discussionBasePath);
    const activeUnitType = dash.currentUnit?.type ?? guidedUnit?.unitType;
    if (activeUnitType) {
      const manifest = resolveManifest(activeUnitType);
      let planningInput = "";
      let agentClasses: string[] | undefined;
      if (isToolCallEventType("write", event)) {
        planningInput = event.input.path;
      } else if (isToolCallEventType("edit", event)) {
        planningInput = event.input.path;
      } else if (isToolCallEventType("bash", event)) {
        planningInput = event.input.command;
      } else if (event.toolName === "subagent" || event.toolName === "task") {
        // Subagent inputs use { agent }, { tasks: [{ agent }] }, or { chain: [{ agent }] }.
        agentClasses = extractSubagentAgentClasses((event as { input?: unknown }).input);
      }
      const planningGuard = shouldBlockPlanningUnit(
        event.toolName,
        planningInput,
        dash.basePath || guidedUnit?.basePath || discussionBasePath,
        activeUnitType,
        manifest?.tools,
        agentClasses,
        (event as { input?: unknown }).input,
        dash.currentUnit?.id,
      );
      if (planningGuard.block) return planningGuard;
    }

    // ── Worktree-isolation write gate (#5199) ────────────────────────────
    // Block planning-write tools from landing code at the project root when
    // git.isolation=worktree but auto-mode hasn't created the milestone
    // worktree yet. Without this, writes silently orphan outside git history.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const wtGuard = shouldBlockWorktreeWrite(
        event.toolName,
        event.input.path,
        dash.basePath ?? discussionBasePath,
        isAutoActive(),
        dash.currentUnit?.type,
      );
      if (wtGuard.block) return wtGuard;
    }

    // ── Single-writer engine: block direct writes to STATE.md ──────────
    // Covers write, edit, and bash tools to prevent bypass vectors.
    if (isToolCallEventType("write", event)) {
      if (isBlockedStateFile(event.input.path)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }

    if (isToolCallEventType("edit", event)) {
      if (isBlockedStateFile(event.input.path)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }

    if (isToolCallEventType("bash", event)) {
      if (isBashWriteToStateFile(event.input.command)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }

    if (!isToolCallEventType("write", event)) return;

    const result = shouldBlockContextWrite(
      event.toolName,
      event.input.path,
      await getDiscussionMilestoneIdFor(discussionBasePath),
      isQueuePhaseActive(discussionBasePath),
      discussionBasePath,
    );
    if (result.block) return result;
  });

  // ── Safety harness: evidence collection + destructive command warnings ──
  pi.on("tool_call", async (event, ctx) => {
    if (!isAutoActive()) return;
    markToolStart(event.toolCallId, event.toolName);
    safetyRecordToolCall(event.toolCallId, event.toolName, event.input as Record<string, unknown>);

    // Persist immediately at dispatch so a mid-unit re-dispatch — which calls
    // resetEvidence() + loadEvidenceFromDisk() in runUnitPhase — cannot wipe
    // the entry between tool_call and tool_execution_end. Without this, the
    // race window equals the tool's runtime, producing the "no bash calls"
    // false positive when the LLM clearly ran a verification command.
    const callDash = getAutoRuntimeSnapshot();
    if (callDash.basePath && callDash.currentUnit?.type === "execute-task") {
      const { milestone: cMid, slice: cSid, task: cTid } = parseUnitId(callDash.currentUnit.id);
      if (cMid && cSid && cTid) {
        saveEvidenceToDisk(callDash.basePath, cMid, cSid, cTid);
      }
    }

    // Destructive command classification (warn only, never block)
    if (isToolCallEventType("bash", event)) {
      const classification = classifyCommand(event.input.command);
      if (classification.destructive) {
        safetyLogWarning("safety", `destructive command: ${classification.labels.join(", ")}`, {
          command: String(event.input.command).slice(0, 200),
        });
        ctx.ui.notify(
          `Destructive command detected: ${classification.labels.join(", ")}`,
          "warning",
        );
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (isAutoActive() && typeof event.toolCallId === "string") {
      markToolEnd(event.toolCallId);
    }
    if (isAutoActive() && event.isError) {
      const resultPayload = ("result" in event ? event.result : undefined) as any;
      const errorText = typeof resultPayload === "string"
        ? resultPayload
        : (typeof resultPayload?.content?.[0]?.text === "string"
            ? resultPayload.content[0].text
            : (typeof (event as any).content === "string"
                ? (event as any).content
                : String(resultPayload ?? "")));
      // Let recordToolInvocationError classify the failure so non-gsd_ harness
      // errors and deterministic policy rejections are handled consistently.
      recordToolInvocationError(event.toolName, errorText);
    } else if (isAutoActive()) {
      clearToolInvocationError();
    }
    const toolName = canonicalToolName(event.toolName);
    if (toolName !== "ask_user_questions") return;
    const basePath = contextBasePath(ctx);
    const milestoneId = await getDiscussionMilestoneIdFor(basePath);
    const queueActive = isQueuePhaseActive(basePath);

    const details = event.details as any;

    // ── Discussion gate enforcement: handle gate question responses ──
    // If the result is cancelled or has no response, the pending gate stays active
    // so the model is blocked from non-read-only tools until it re-asks.
    // If the user responded at all (even "needs adjustment"), clear the pending gate
    // because the user engaged — the prompt handles the re-ask-after-adjustment flow.
    const questions: any[] = (event.input as any)?.questions ?? [];
    const currentPendingGate = getPendingGate(basePath);
    if (currentPendingGate) {
      if (details?.cancelled || !details?.response) {
        // Gate stays pending. Direct the agent to the most reliable recovery
        // path — re-calling ask_user_questions with the same gate id — without
        // misrepresenting the plain-text path. The plain-text path also works
        // (isExplicitApprovalResponse on the next before_agent_start clears
        // the gate when the user replies with an approval keyword), but the
        // structured re-ask is more deterministic and gives the user a clear UI.
        resetToolCallLoopGuard();
        const interrupted = details?.interrupted === true;
        if (ctx) {
          await maybePauseAutoForApprovalGate(
            ctx,
            pi,
            true,
            interrupted
              ? "Depth confirmation was interrupted — pausing auto-mode until you respond."
              : "Depth confirmation is waiting for your answer — pausing auto-mode.",
          );
        }
        return {
          content: [{
            type: "text" as const,
            text: [
              `Waiting for depth confirmation on gate "${currentPendingGate}".`,
              interrupted
                ? "The confirmation question was interrupted before a response was recorded."
                : "No user response was received for the confirmation question.",
              "Do not infer approval from earlier or prior messages.",
              "Do not proceed, write files, save artifacts, or call other tools.",
              `Re-call ask_user_questions with the same gate question id ("${currentPendingGate}") and wait for the user's response.`,
            ].join(" "),
          }],
        };
      } else {
        const pendingQuestion = questions.find((question) => question?.id === currentPendingGate);
        if (pendingQuestion) {
          const answer = details.response?.answers?.[currentPendingGate];
          if (isDepthConfirmationAnswer(answer?.selected, pendingQuestion.options)) {
            markApprovalGateVerified(currentPendingGate, basePath);
            const milestoneIdFromGate = extractDepthVerificationMilestoneId(currentPendingGate);
            if (milestoneIdFromGate) markDepthVerified(milestoneIdFromGate, basePath);
            clearPendingGate(basePath);
            clearDeferredApprovalGate(basePath);
          }
        }
      }
    }

    if (details?.cancelled || !details?.response) return;

    for (const question of questions) {
      if (typeof question.id === "string" && question.id.includes("depth_verification")) {
        // Only unlock the gate if the user selected the first option (confirmation).
        // Cross-references against the question's defined options to reject free-form "Other" text.
        const answer = details.response?.answers?.[question.id];
        const inferredMilestoneId = extractDepthVerificationMilestoneId(question.id) ?? milestoneId;
        if (isDepthConfirmationAnswer(answer?.selected, question.options)) {
          if (currentPendingGate && question.id !== currentPendingGate) break;
          markApprovalGateVerified(question.id, basePath);
          markDepthVerified(inferredMilestoneId, basePath);
          clearPendingGate(basePath);
          clearDeferredApprovalGate(basePath);
        }
        break;
      }
    }

    if (!milestoneId && !queueActive) return;
    if (!milestoneId) return;
    const milestoneDir = resolveMilestonePath(basePath, milestoneId);
    if (!milestoneDir) return;

    const discussionPath = join(milestoneDir, buildMilestoneFileName(milestoneId, "DISCUSSION"));
    const timestamp = new Date().toISOString();
    const lines: string[] = [`## Exchange — ${timestamp}`, ""];
    for (const question of questions) {
      lines.push(`### ${question.header ?? "Question"}`, "", question.question ?? "");
      if (Array.isArray(question.options)) {
        lines.push("");
        for (const opt of question.options) {
          lines.push(`- **${opt.label}** — ${opt.description ?? ""}`);
        }
      }
      const answer = details.response?.answers?.[question.id];
      if (answer) {
        lines.push("");
        const selected = Array.isArray(answer.selected) ? answer.selected.join(", ") : answer.selected;
        lines.push(`**Selected:** ${selected}`);
        if (answer.notes) {
          lines.push(`**Notes:** ${answer.notes}`);
        }
      }
      lines.push("");
    }
    lines.push("---", "");
    const existing = await loadFile(discussionPath) ?? `# ${milestoneId} Discussion Log\n\n`;
    await saveFile(discussionPath, existing + lines.join("\n"));
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const basePath = contextBasePath(ctx);
    const toolName = canonicalToolName(event.toolName);
    if (toolName === "ask_user_questions") {
      const questionId = extractGateQuestionId(event.args);
      if (typeof questionId === "string") {
        setPendingGate(questionId, basePath);
        clearDeferredApprovalGate(basePath);
      }
    }
    if (!isAutoActive()) return;
    markToolStart(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", async (event) => {
    markToolEnd(event.toolCallId);
    // #2883/#4974: Capture deterministic invocation/policy errors
    // so postUnitPreVerification can break the retry loop instead of re-dispatching.
    if (event.isError) {
      const errorText = typeof event.result === "string"
        ? event.result
        : (typeof event.result?.content?.[0]?.text === "string" ? event.result.content[0].text : String(event.result));
      // Let recordToolInvocationError classify the failure so non-gsd_ harness
      // errors and deterministic policy rejections are handled consistently.
      recordToolInvocationError(event.toolName, errorText);
    } else if (isAutoActive()) {
      clearToolInvocationError();
    }
    // Safety harness: record tool execution results for evidence cross-referencing
    if (isAutoActive()) {
      safetyRecordToolResult(event.toolCallId, event.toolName, event.result, event.isError);
      // Persist evidence to disk after each tool result so it survives a session
      // restart mid-unit (Bug #4385 — non-persisted evidence false positives).
      const dash = getAutoRuntimeSnapshot();
      if (dash.basePath && dash.currentUnit?.type === "execute-task") {
        const { milestone: pMid, slice: pSid, task: pTid } = parseUnitId(dash.currentUnit.id);
        if (pMid && pSid && pTid) {
          saveEvidenceToDisk(dash.basePath, pMid, pSid, pTid);
        }
      }
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    await syncServiceTierStatus(ctx);
  });

  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return;

    // ── Observation Masking ─────────────────────────────────────────────
    // Replace old tool results with placeholders to reduce context bloat.
    // Only active during auto-mode when context_management.observation_masking is enabled.
    if (isAutoActive()) {
      try {
        const { loadEffectiveGSDPreferences } = await import("../preferences.js");
        const prefs = loadEffectiveGSDPreferences();
        const cmConfig = prefs?.preferences.context_management;

        // Observation masking: replace old tool results with placeholders
        if (cmConfig?.observation_masking !== false) {
          const keepTurns = cmConfig?.observation_mask_turns ?? 8;
          const { createObservationMask } = await import("../context-masker.js");
          const mask = createObservationMask(keepTurns);
          const messages = payload.messages;
          if (Array.isArray(messages)) {
            payload.messages = mask(messages);
          }
        }

        // Tool result truncation: cap individual tool result content length.
        // In pi-ai format, toolResult messages have role: "toolResult" and content: TextContent[].
        // Creates new objects to avoid mutating shared conversation state.
        const maxChars = cmConfig?.tool_result_max_chars ?? 800;
        const msgs = payload.messages;
        if (Array.isArray(msgs)) {
          payload.messages = msgs.map((msg: Record<string, unknown>) => {
            // Match toolResult messages (role: "toolResult", content is array of content blocks)
            if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
              const blocks = msg.content as Array<Record<string, unknown>>;
              const totalLen = blocks.reduce((sum: number, b) => sum + (typeof b.text === "string" ? b.text.length : 0), 0);
              if (totalLen > maxChars) {
                const truncated = blocks.map(b => {
                  if (typeof b.text === "string" && b.text.length > maxChars) {
                    return { ...b, text: b.text.slice(0, maxChars) + "\n…[truncated]" };
                  }
                  return b;
                });
                return { ...msg, content: truncated };
              }
            }
            return msg;
          });
        }
      } catch { /* non-fatal */ }
    }

    // ── Service Tier ────────────────────────────────────────────────────
    const modelId = event.model?.id;
    if (!modelId) return payload;
    const { getEffectiveServiceTier, supportsServiceTier } = await import("../service-tier.js");
    const tier = getEffectiveServiceTier();
    if (!tier || !supportsServiceTier(modelId)) return payload;
    payload.service_tier = tier;
    return payload;
  });

  // Capability-aware model routing hook (ADR-004)
  // Extensions can override model selection by returning { modelId: "..." }
  // Return undefined to let the built-in capability scoring proceed.
  pi.on("before_model_select", async (_event) => {
    // Default: no override — let capability scoring handle selection
    return undefined;
  });

  // Tool set adaptation hook (ADR-005 Phase 4)
  // Extensions can override tool set after model selection by returning { toolNames: [...] }
  // Return undefined to let the built-in provider compatibility filtering proceed.
  pi.on("adjust_tool_set", async (event) => {
    const removed = new Set(event.filteredTools);
    const compatible = event.activeToolNames.filter((name) => !removed.has(name));
    // Always drop backwards-compatibility workflow aliases from the advertised
    // surface; they remain registered/callable but never cost schema tokens.
    // Drop the heavy browser surface too unless explicitly opted in — it stays
    // registered, so auto run-uat (which scopes browser tools in from the full
    // registry) still works. Both filters are skipped under full-tools mode.
    const fullToolsRequested = isFullGsdToolSurfaceRequested();
    const dropAliases = !fullToolsRequested;
    const dropBrowser = !fullToolsRequested && !isBrowserToolSurfaceRequested();
    const providerCompatible = compatible.filter(
      (name) => !(dropAliases && isWorkflowAliasTool(name)) && !(dropBrowser && isBrowserTool(name)),
    );
    const surfaceReduced = providerCompatible.length !== compatible.length;
    if (fullToolsRequested) {
      return surfaceReduced ? { toolNames: providerCompatible } : undefined;
    }
    const registeredToolNames = resolveRegisteredToolNames(pi, event.activeToolNames);
    const guidedUnit = getGuidedUnitContext();
    const requestScoped = buildRequestScopedGsdToolSet(
      providerCompatible,
      event.requestCustomMessages,
      registeredToolNames,
      guidedUnit?.unitType,
    );
    if (requestScoped) {
      return { toolNames: requestScoped };
    }
    const dash = getAutoRuntimeSnapshot();
    if (dash.active && dash.currentUnit) {
      return {
        toolNames: buildMinimalAutoGsdToolSet(
          providerCompatible,
          dash.currentUnit.type,
          resolveRegisteredToolNames(pi, event.activeToolNames),
        ),
      };
    }
    if (isGeneralGsdToolScopingRequested()) {
      return { toolNames: buildMinimalGsdToolSet(providerCompatible) };
    }
    // Plain interactive chat (no GSD workflow command driving this request)
    // never needs the full ~50-tool workflow surface — scope it to the minimal
    // GSD set by default (all non-GSD tools are preserved). Requests carrying a
    // gsd-* customType keep their existing surface, so no command is stranded.
    // Set PI_GSD_FULL_TOOLS=1 (handled above) to restore the full surface.
    if (!requestHasGsdCustomType(event.requestCustomMessages)) {
      return { toolNames: buildMinimalGsdToolSet(providerCompatible) };
    }
    return surfaceReduced ? { toolNames: providerCompatible } : undefined;
  });
}
