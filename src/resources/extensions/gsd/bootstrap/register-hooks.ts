// Project/App: gsd-pi
// File Purpose: Registers GSD extension runtime hooks and token-saving tool policies.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";
import { ALWAYS_PRESERVED_SHIM_TOOL_NAMES } from "@gsd/pi-ai";

import type { GSDEcosystemBeforeAgentStartHandler } from "../ecosystem/gsd-extension-api.js";
import { updateSnapshot } from "../ecosystem/gsd-extension-api.js";

import { buildMilestoneFileName, clearPathCache, milestonesDir, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "../paths.js";
import { applyAskUserQuestionsGateResult, canonicalToolName, clearDiscussionFlowState, formatPendingAskUserQuestionsGateMessage, isApprovalGateVerifiedInSnapshot, isMilestoneDepthVerified, isMilestoneDepthVerifiedInSnapshot, isQueuePhaseActive, loadWriteGateSnapshot, markApprovalGateVerified, markDepthVerified, refreshWriteGateStateFromDisk, resetWriteGateState, shouldBlockContextWrite, shouldBlockPlanningUnit, shouldBlockQueueExecution, shouldBlockWorktreeWrite, isGateQuestionId, setPendingGate, clearPendingGate, getPendingGate, shouldBlockPendingGate, shouldBlockPendingGateBash, extractDepthVerificationMilestoneId } from "./write-gate.js";
import { resolveManifest } from "../unit-context-manifest.js";
import { isBlockedStateFile, isBashWriteToStateFile, BLOCKED_WRITE_ERROR } from "../write-intercept.js";
import { loadFile, saveFile, formatContinue } from "../files.js";
import {
  clearAutoCompletionStopInProgress,
  clearToolInvocationError,
  getAutoRuntimeSnapshot,
  getSourceObservationStore,
  isAutoActive,
  isAutoCompletionStopInProgress,
  isAutoPaused,
  isInteractiveElicitationInFlight,
  markToolEnd,
  markToolStart,
  recordAutoToolSurfaceSnapshot,
  recordToolInvocationError,
} from "../auto-runtime-state.js";
import { applyProviderPayloadPolicy } from "../provider-payload-policy.js";

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
import { notifyPreferenceDiagnostics } from "../preferences-diagnostics.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { extractSubagentAgentClasses } from "./subagent-input.js";
import {
  approvalGateIdForUnit,
  isExplicitApprovalResponse,
  messageHasPendingAskUserQuestionsTool,
  shouldPauseForUserApprovalQuestion,
} from "../user-input-boundary.js";
import { resolveSkillManifest } from "../skill-manifest.js";
import { applyUnitSkillVisibility, unitHasSkillManifest } from "../skill-scope.js";
import { getGuidedUnitContext } from "../guided-unit-context.js";
import { registerPlanMilestoneSchemaRecovery } from "./plan-milestone-schema-recovery.js";
import { AUTO_UNIT_SCOPED_TOOLS, RUN_UAT_BROWSER_TOOL_NAMES, canonicalWorkflowToolName, isWorkflowAliasTool } from "../auto-unit-tool-scope.js";
import { filterToolsForProvider } from "../model-router.js";
import { mcpToolMatchesBaseName } from "../mcp-tool-name.js";
import { RUN_UAT_READ_ONLY_TOOL_NAMES, RUN_UAT_WORKFLOW_TOOL_NAMES } from "../tool-presentation-plan.js";
import { supportsSourceObservationsForUnit } from "../source-observations.js";
import { clearPendingAutoStart } from "../pending-auto-start.js";

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
  "gsd_plan_milestone",
  "memory_query",
  "gsd_memory_query",
  "capture_thought",
  "gsd_capture_thought",
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
    const aliasFallbacks: string[] = [];

    for (const activeName of activeToolNames) {
      if (mcpToolMatchesBaseName(activeName, requested)) {
        scopedMatches.push(activeName);
      } else if (isWorkflowAliasTool(activeName) && canonicalWorkflowToolName(activeName) === requested) {
        aliasFallbacks.push(activeName);
      }
    }

    // Only use alias as fallback when canonical is absent — not directly and not via MCP scoping.
    // Prevents the alias from resurfacing alongside the canonical when both are in the active set.
    if (!exact.has(requested) && scopedMatches.length === 0) {
      scopedMatches.push(...aliasFallbacks);
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
  if (unitType === "run-uat") {
    return buildRunUatGsdToolSet(activeToolNames, registeredToolNames);
  }
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

export function buildRunUatGsdToolSet(
  activeToolNames: readonly string[],
  registeredToolNames: readonly string[] = activeToolNames,
): string[] {
  const scoped = resolveScopedToolNames(
    [...activeToolNames, ...registeredToolNames],
    [
      ...RUN_UAT_WORKFLOW_TOOL_NAMES,
      ...RUN_UAT_READ_ONLY_TOOL_NAMES,
      "subagent",
      ...RUN_UAT_BROWSER_TOOL_NAMES,
    ],
  );
  const resolved = [...new Set(scoped)];

  const unresolved = RUN_UAT_WORKFLOW_TOOL_NAMES.filter(
    (tool) => !resolved.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
  );
  if (unresolved.length > 0) {
    safetyLogWarning(
      "bootstrap",
      `buildRunUatGsdToolSet: required run-uat workflow tool(s) not found in active/registered surface: ${unresolved.join(", ")}. Session may lack gsd-workflow MCP connection.`,
    );
  }

  return resolved;
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
    const currentToolNames = pi.getActiveTools();
    const registeredToolNames = resolveRegisteredToolNames(pi, currentToolNames);
    const scopedToolNames = buildMinimalAutoGsdToolSet(
      currentToolNames,
      dash.currentUnit.type,
      registeredToolNames,
    );
    recordAutoToolSurfaceSnapshot({
      source: "runtime-scope",
      unitType: dash.currentUnit.type,
      modelFacingToolNames: scopedToolNames,
      registeredToolNames,
      scopedToolNames,
    });
    pi.setActiveTools(scopedToolNames);
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
  recordAutoToolSurfaceSnapshot({
    source: "dispatch-scope",
    unitType,
    modelFacingToolNames: scoped,
    registeredToolNames,
    scopedToolNames: scoped,
  });
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

function beginSourceObservationStoreForCurrentUnit(
  ctx?: { cwd?: string },
): ReturnType<typeof getSourceObservationStore> | null {
  if (!isAutoActive()) return null;
  const dash = getAutoRuntimeSnapshot();
  if (!dash.currentUnit) return null;
  if (!supportsSourceObservationsForUnit(dash.currentUnit.type)) return null;

  const store = getSourceObservationStore();
  store.beginUnit({
    unitType: dash.currentUnit.type,
    unitId: dash.currentUnit.id,
    startedAt: dash.currentUnit.startedAt,
    basePath: dash.currentUnit.workspaceRoot ?? (dash.basePath || contextBasePath(ctx)),
  });
  return store;
}

function refreshSourceObservationAfterMutation(
  canonicalName: string,
  input: unknown,
  ctx?: { cwd?: string },
): void {
  if (canonicalName !== "edit" && canonicalName !== "write") return;
  if (!input || typeof input !== "object") return;

  const store = beginSourceObservationStoreForCurrentUnit(ctx);
  if (!store) return;
  store.observeMutation(input as { path?: unknown; file_path?: unknown });
}

function clearSourceObservationsAfterShell(
  canonicalName: string,
): void {
  if (!isAutoActive()) return;
  if (!isShellExecutionTool(canonicalName)) return;
  const dash = getAutoRuntimeSnapshot();
  if (!dash.currentUnit || !supportsSourceObservationsForUnit(dash.currentUnit.type)) return;
  getSourceObservationStore().clear();
}

function isShellExecutionTool(canonicalName: string): boolean {
  return canonicalName === "bash" ||
    canonicalName === "bg_shell" ||
    canonicalName === "async_bash" ||
    canonicalName === "shell" ||
    canonicalName === "powershell";
}

function activateDeferredApprovalGate(basePath: string): void {
  if (deferredApprovalGate?.basePath !== basePath) return;
  const gateId = deferredApprovalGate.gateId;
  deferredApprovalGate = null;
  refreshWriteGateStateFromDisk(basePath);
  const snapshot = loadWriteGateSnapshot(basePath);
  const milestoneId = extractDepthVerificationMilestoneId(gateId);
  if (isApprovalGateVerifiedInSnapshot(snapshot, gateId)) return;
  if (milestoneId && isMilestoneDepthVerifiedInSnapshot(snapshot, milestoneId)) return;
  setPendingGate(gateId, basePath);
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

type StructuredQuestion = {
  id?: string;
  header?: string;
  question?: string;
  options?: Array<{ label?: string; description?: string }>;
};

type StructuredAnswer = {
  selected?: unknown;
  notes?: unknown;
};

function selectedAnswerLabel(selected: unknown): string {
  if (Array.isArray(selected)) return selected.map(String).join(", ");
  if (selected == null) return "";
  return String(selected);
}

function formatQuestionExchange(
  questions: StructuredQuestion[],
  answers: Record<string, StructuredAnswer> | undefined,
): string {
  const lines: string[] = [];
  for (const question of questions) {
    lines.push(`### ${question.header ?? "Question"}`, "", question.question ?? "");
    if (Array.isArray(question.options)) {
      lines.push("");
      for (const opt of question.options) {
        lines.push(`- **${opt.label ?? ""}** — ${opt.description ?? ""}`);
      }
    }

    const answer = question.id ? answers?.[question.id] : undefined;
    if (answer) {
      lines.push("");
      const selected = selectedAnswerLabel(answer.selected);
      if (selected) lines.push(`**Selected:** ${selected}`);
      if (answer.notes) lines.push(`**Notes:** ${String(answer.notes)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function ensureMilestoneShell(basePath: string, milestoneId: string): Promise<string> {
  const milestoneDir = resolveMilestonePath(basePath, milestoneId)
    ?? join(milestonesDir(basePath), milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  clearPathCache();

  try {
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    if (await ensureDbOpen(basePath)) {
      const { getMilestone, insertMilestone } = await import("../gsd-db.js");
      if (!getMilestone(milestoneId)) {
        insertMilestone({
          id: milestoneId,
          title: `New milestone ${milestoneId}`,
          status: "queued",
        });
      }
    }
  } catch (err) {
    safetyLogWarning("guided", `failed to persist milestone shell for ${milestoneId}: ${(err as Error).message}`);
  }

  return milestoneDir;
}

async function saveDiscussionQuestionRound(
  basePath: string,
  milestoneId: string,
  questions: StructuredQuestion[],
  details: any,
): Promise<void> {
  const milestoneDir = await ensureMilestoneShell(basePath, milestoneId);
  const answers = details?.response?.answers;
  const timestamp = new Date().toISOString();
  const exchange = formatQuestionExchange(questions, answers);

  const discussionPath = join(milestoneDir, buildMilestoneFileName(milestoneId, "DISCUSSION"));
  const existingDiscussion = await loadFile(discussionPath) ?? `# ${milestoneId} Discussion Log\n\n`;
  await saveFile(
    discussionPath,
    `${existingDiscussion}## Exchange — ${timestamp}\n\n${exchange}---\n\n`,
  );

  const draftPath = join(milestoneDir, buildMilestoneFileName(milestoneId, "CONTEXT-DRAFT"));
  const existingDraft = await loadFile(draftPath);
  const draftHeader = existingDraft
    ?? [
      `# ${milestoneId}: New milestone ${milestoneId}`,
      "",
      "This draft was captured automatically from structured question responses.",
      "Use it so `/gsd` can resume the in-flight milestone discussion.",
      "",
    ].join("\n");
  await saveFile(
    draftPath,
    `${draftHeader.trimEnd()}\n\n## Captured Question Round — ${timestamp}\n\n${exchange}`,
  );
}

function withDepthGateDisplayReason<T extends { block: boolean; reason?: string }>(
  result: T,
  displayReason = "Depth confirmation is waiting for your answer.",
): T & { displayReason?: string } {
  if (!result.block) return result;
  return { ...result, displayReason };
}

function shouldBlockDeferredApprovalTool(
  toolName: string,
  input: unknown,
  basePath: string,
): { block: boolean; reason?: string; displayReason?: string } {
  if (deferredApprovalGate?.basePath !== basePath) return { block: false };
  if (toolName === "ask_user_questions") return { block: false };
  if (isContextDraftSummarySave(toolName, input)) return { block: false };
  return withDepthGateDisplayReason({
    block: true,
    reason: [
      `HARD BLOCK: Approval question "${deferredApprovalGate.gateId}" has been shown to the user.`,
      `Only CONTEXT-DRAFT persistence may finish in this same assistant turn.`,
      `Wait for the user's answer before calling additional tools.`,
    ].join(" "),
  });
}

export function resolveNotificationStoreBasePath(basePath: string): string {
  return resolveWorktreeProjectRoot(basePath);
}

function initSessionNotifications(ctx: ExtensionContext): void {
  initNotificationStore(resolveNotificationStoreBasePath(contextBasePath(ctx)));
  installNotifyInterceptor(ctx);
  initNotificationWidget(ctx);
  notifyPreferenceDiagnostics(ctx, contextBasePath(ctx), { surface: "session-start" });
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
    const preserveCloseoutSurface = isAutoCompletionStopInProgress();
    initSessionNotifications(ctx);
    if (!isAutoActive() && !preserveCloseoutSurface) {
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
    if (!preserveCloseoutSurface) {
      await installWelcomeHeader(ctx);
    }
    await loadToolApiKeysForSession();
    if (isAutoActive() || preserveCloseoutSurface) {
      ctx.ui.setWidget("gsd-health", undefined);
    }
    // Cold start after /quit relaunches with cwd at the project root. When
    // auto-mode is neither active nor paused (its own resume path re-enters the
    // worktree with a lease check — auto.ts:3032), proactively chdir back into
    // the active milestone's worktree so subsequent work isn't stranded at the
    // root. Best-effort and a no-op when already inside a worktree.
    if (!isAutoActive() && !isAutoPaused() && !preserveCloseoutSurface) {
      try {
        const { reenterActiveWorktreeIfNeeded } = await import("../worktree-reentry.js");
        await reenterActiveWorktreeIfNeeded(basePath);
      } catch { /* non-fatal */ }
    }
  });

  pi.on("session_switch", async (event, ctx) => {
    const basePath = contextBasePath(ctx);
    const preserveCloseoutSurface = isAutoCompletionStopInProgress();
    initSessionNotifications(ctx);
    resetWriteGateState(basePath);
    resetToolCallLoopGuard();
    clearDeferredApprovalGate();
    await resetAskUserQuestionsTurnCache();
    clearDiscussionFlowState(basePath);
    // /clear or /new destroys the conversation holding a discuss interview, so
    // its pending discuss→auto handoff can never be answered — clear it. Resume
    // restores the interview transcript, so the entry survives. Auto-mode's own
    // newSession() calls are safe: the handoff consumes the entry on agent_end.
    if (event.reason === "new") {
      clearPendingAutoStart(basePath);
    }
    await syncServiceTierStatus(ctx);
    await applyDisabledModelProviderPolicy(ctx);
    await applyCompactionThresholdOverride(ctx);
    await prepareWorkflowMcpForHookContext(ctx, basePath);
    await loadToolApiKeysForSession();
    if (!isAutoActive() && !preserveCloseoutSurface) {
      ctx.ui.setWidget("gsd-progress", undefined);
      ctx.ui.setWidget("gsd-outcome", undefined);
      const { initHealthWidget } = await import("../health-widget.js");
      initHealthWidget(ctx);
    } else {
      ctx.ui.setWidget("gsd-health", undefined);
    }
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    clearAutoCompletionStopInProgress();
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
    // If the model asked via ask_user_questions, that in-flight elicitation IS
    // the human boundary. Arming the pause/gate here (and emitting the "waiting
    // for your approval - pausing" notice) would tear it down and trigger the
    // foreground self-cancel/re-ask loop. The marker is set only by the
    // claude-code-cli SDK elicitation handler and is ungated, so it is true in
    // foreground; under the native-TUI provider it is always false and this path
    // runs unchanged (#cc-elicitation-self-cancel).
    if (isInteractiveElicitationInFlight()) return;
    // Prose with "?" can stream before the MCP tool/elicitation starts. When the
    // structured ask_user_questions call is already in the partial message, the
    // tool IS the human boundary — do not arm the text-based approval pause.
    if (messageHasPendingAskUserQuestionsTool(event.message)) return;

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
          return withDepthGateDisplayReason(bashGuard);
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
          return withDepthGateDisplayReason(gateGuard);
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
    if (result.block) {
      return withDepthGateDisplayReason(result, "Depth check required before writing milestone context.");
    }
  });

  // ── Safety harness: evidence collection + destructive command blocking ──
  pi.on("tool_call", async (event, ctx) => {
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

    // Destructive command classification + hard gate in all modes.
    if (isToolCallEventType("bash", event)) {
      const classification = classifyCommand(event.input.command);
      if (classification.destructive) {
        const reason = [
          "HARD BLOCK: destructive Bash command requires explicit human confirmation.",
          `Detected: ${classification.labels.join(", ")}`,
          "Run this via ask_user_questions, wait for the user's response,",
          "then issue the command only when confirmed in the current turn.",
        ].join(" ");
        safetyLogWarning("safety", `destructive command: ${classification.labels.join(", ")}`, {
          command: String(event.input.command).slice(0, 200),
        });
        if (ctx) {
          await maybePauseAutoForApprovalGate(
            ctx,
            pi,
            isAutoActive(),
            "Depth confirmation is waiting for your answer — pausing auto-mode.",
          );
        }
        return { block: true, reason };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (isAutoActive() && typeof event.toolCallId === "string") {
      markToolEnd(event.toolCallId);
    }
    const toolName = canonicalToolName(event.toolName);
    if (isAutoActive() && toolName === "read" && !event.isError) {
      const store = beginSourceObservationStoreForCurrentUnit(ctx);
      if (store) {
        store.observeRead(event.input);
      }
    }
    if (!event.isError) {
      refreshSourceObservationAfterMutation(toolName, event.input, ctx);
      clearSourceObservationsAfterShell(toolName);
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
    if (toolName !== "ask_user_questions") return;
    const basePath = contextBasePath(ctx);
    const milestoneId = await getDiscussionMilestoneIdFor(basePath);

    const details = event.details as any;

    const questions: any[] = (event.input as any)?.questions ?? [];
    const gateResult = applyAskUserQuestionsGateResult({
      basePath,
      questions,
      details,
      fallbackMilestoneId: milestoneId,
    });
    if (gateResult.status === "waiting") {
      resetToolCallLoopGuard();
      if (ctx) {
        await maybePauseAutoForApprovalGate(
          ctx,
          pi,
          true,
          gateResult.interrupted
            ? "Depth confirmation was interrupted — pausing auto-mode until you respond."
            : "Depth confirmation is waiting for your answer — pausing auto-mode.",
        );
      }
      return {
        content: [{
          type: "text" as const,
          text: formatPendingAskUserQuestionsGateMessage(gateResult.pendingGateId, gateResult.interrupted),
        }],
      };
    }
    if (gateResult.status === "verified") {
      clearDeferredApprovalGate(basePath);
    }

    if (details?.cancelled || !details?.response) return;
    if (!milestoneId) return;
    await saveDiscussionQuestionRound(basePath, milestoneId, questions, details);
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

    return applyProviderPayloadPolicy({
      payload,
      modelId: event.model?.id,
    });
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
    const aliasFilteredCompatible = compatible.filter(
      (name) => !(dropAliases && isWorkflowAliasTool(name)),
    );
    const providerCompatible = aliasFilteredCompatible.filter(
      (name) => !(dropBrowser && isBrowserTool(name)),
    );
    const surfaceReduced = providerCompatible.length !== compatible.length;
    if (fullToolsRequested) {
      return surfaceReduced ? { toolNames: providerCompatible } : undefined;
    }
    const registeredToolNames = resolveRegisteredToolNames(pi, event.activeToolNames);
    const compatibleRegisteredToolNames = filterToolsForProvider(
      registeredToolNames,
      event.selectedModelApi,
      event.selectedModelProvider,
    ).compatible.filter((name) => !(dropAliases && isWorkflowAliasTool(name)));
    const guidedUnit = getGuidedUnitContext();
    const requestRegisteredToolNames = guidedUnit?.unitType === "run-uat"
      ? compatibleRegisteredToolNames
      : registeredToolNames;
    const requestScoped = buildRequestScopedGsdToolSet(
      guidedUnit?.unitType === "run-uat" ? aliasFilteredCompatible : providerCompatible,
      event.requestCustomMessages,
      requestRegisteredToolNames,
      guidedUnit?.unitType,
    );
    if (requestScoped) {
      recordAutoToolSurfaceSnapshot({
        source: "provider-adjustment",
        unitType: guidedUnit?.unitType,
        modelFacingToolNames: requestScoped,
        registeredToolNames: requestRegisteredToolNames,
        scopedToolNames: requestScoped,
      });
      return { toolNames: requestScoped };
    }
    const dash = getAutoRuntimeSnapshot();
    if (dash.active && dash.currentUnit) {
      const registeredForUnit = dash.currentUnit.type === "run-uat"
        ? compatibleRegisteredToolNames
        : resolveRegisteredToolNames(pi, event.activeToolNames);
      const scopedToolNames = buildMinimalAutoGsdToolSet(
        dash.currentUnit.type === "run-uat" ? aliasFilteredCompatible : providerCompatible,
        dash.currentUnit.type,
        registeredForUnit,
      );
      recordAutoToolSurfaceSnapshot({
        source: "provider-adjustment",
        unitType: dash.currentUnit.type,
        modelFacingToolNames: scopedToolNames,
        registeredToolNames: registeredForUnit,
        scopedToolNames,
      });
      return {
        toolNames: scopedToolNames,
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
