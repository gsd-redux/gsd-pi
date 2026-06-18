// Project/App: gsd-pi
// File Purpose: Share recent workflow MCP probe results across guided-flow and Claude Code SDK preflight.

import { testMcpServerConnection } from "../mcp-client/manager.js";
import { mcpToolMatchesBaseName } from "./mcp-tool-name.js";
import {
  detectWorkflowMcpLaunchConfig,
  resolveWorkflowMcpProjectRoot,
} from "./workflow-mcp.js";
import { isWorkflowToolSurfaceName } from "./workflow-tool-surface.js";

/** Reuse a recent successful probe instead of spawning another stdio server. */
export const WORKFLOW_MCP_PROBE_CACHE_TTL_MS = 120_000;
/** Per-probe connect + tools/list budget (server typically ready in ~1–2s). */
export const WORKFLOW_MCP_PROBE_TIMEOUT_MS = 5_000;

export interface WorkflowMcpProbeCacheEntry {
  serverName: string;
  tools: readonly string[];
  probedAt: number;
}

type WorkflowMcpProbeResult = {
  ok: boolean;
  tools: readonly string[];
  serverName?: string;
  error?: string;
};

const cacheByProject = new Map<string, WorkflowMcpProbeCacheEntry>();
const probeInFlightByProject = new Map<string, Promise<WorkflowMcpProbeResult>>();
let activeWorkflowMcpSdkSessions = 0;

function cacheKey(projectRoot: string): string {
  return resolveWorkflowMcpProjectRoot(projectRoot);
}

export function beginWorkflowMcpSdkSession(): void {
  activeWorkflowMcpSdkSessions++;
}

export function endWorkflowMcpSdkSession(): void {
  activeWorkflowMcpSdkSessions = Math.max(0, activeWorkflowMcpSdkSessions - 1);
}

export function getCachedWorkflowMcpProbe(projectRoot: string): WorkflowMcpProbeCacheEntry | null {
  const entry = cacheByProject.get(cacheKey(projectRoot));
  if (!entry) return null;
  if (Date.now() - entry.probedAt > WORKFLOW_MCP_PROBE_CACHE_TTL_MS) {
    cacheByProject.delete(cacheKey(projectRoot));
    return null;
  }
  return entry;
}

export function recordWorkflowMcpProbe(
  projectRoot: string,
  serverName: string,
  tools: readonly string[],
): void {
  cacheByProject.set(cacheKey(projectRoot), {
    serverName,
    tools: [...tools],
    probedAt: Date.now(),
  });
}

export function clearWorkflowMcpProbeCache(projectRoot?: string): void {
  if (projectRoot === undefined) {
    cacheByProject.clear();
    probeInFlightByProject.clear();
    activeWorkflowMcpSdkSessions = 0;
    return;
  }
  const key = cacheKey(projectRoot);
  cacheByProject.delete(key);
  probeInFlightByProject.delete(key);
}

export function workflowMcpProbeAdvertisesSurface(tools: readonly string[]): boolean {
  return tools.some((tool) => isWorkflowToolSurfaceName(tool));
}

export function cachedWorkflowMcpCoversRequired(
  projectRoot: string,
  serverName: string,
  required: readonly string[],
): boolean {
  const entry = getCachedWorkflowMcpProbe(projectRoot);
  if (!entry || entry.serverName !== serverName) return false;
  return required.every((tool) =>
    entry.tools.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
  );
}

async function runProbeAndCacheWorkflowMcp(
  projectRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<WorkflowMcpProbeResult> {
  const root = cacheKey(projectRoot);
  const launch = detectWorkflowMcpLaunchConfig(root);
  const serverName = launch?.name ?? "gsd-workflow";

  const cached = getCachedWorkflowMcpProbe(projectRoot);
  if (cached && workflowMcpProbeAdvertisesSurface(cached.tools)) {
    return { ok: true, tools: cached.tools, serverName: cached.serverName };
  }

  const result = await testMcpServerConnection(serverName, {
    projectDir: root,
    timeoutMs: options.timeoutMs ?? WORKFLOW_MCP_PROBE_TIMEOUT_MS,
  });
  if (result.ok && workflowMcpProbeAdvertisesSurface(result.tools)) {
    recordWorkflowMcpProbe(projectRoot, serverName, result.tools);
  }
  return {
    ok: result.ok,
    tools: result.tools,
    serverName,
    error: result.error,
  };
}

export async function probeAndCacheWorkflowMcp(
  projectRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<WorkflowMcpProbeResult> {
  const key = cacheKey(projectRoot);
  const inFlight = probeInFlightByProject.get(key);
  if (inFlight) return inFlight;

  const promise = runProbeAndCacheWorkflowMcp(projectRoot, options).finally(() => {
    probeInFlightByProject.delete(key);
  });
  probeInFlightByProject.set(key, promise);
  return promise;
}

/** Fire-and-forget probe so /gsd dispatch often hits a warm cache. */
export function warmWorkflowMcpProbeInBackground(projectRoot: string): void {
  if (activeWorkflowMcpSdkSessions > 0) return;

  const key = cacheKey(projectRoot);
  if (getCachedWorkflowMcpProbe(projectRoot)) return;
  if (probeInFlightByProject.has(key)) return;

  void probeAndCacheWorkflowMcp(projectRoot).catch(() => {
    // Background warm is best-effort.
  });
}
