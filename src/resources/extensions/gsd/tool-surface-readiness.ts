// Project/App: gsd-pi
// File Purpose: Tool Contract module's runtime face — verify the live SDK tool surface covers a Unit's required workflow tools.

import { testMcpServerConnection } from "../mcp-client/manager.js";
import { mcpToolMatchesBaseName } from "./mcp-tool-name.js";
import { getRequiredWorkflowToolsForUnit } from "./unit-tool-contracts.js";
import {
  recordWorkflowMcpProbe,
  WORKFLOW_MCP_PROBE_TIMEOUT_MS,
} from "./workflow-mcp-readiness-cache.js";
import { resolveWorkflowMcpProjectRoot } from "./workflow-mcp.js";
import { isWorkflowToolSurfaceName } from "./workflow-tool-surface.js";

/**
 * Stable phrase recognized as transient by auto-tool-tracking's
 * isToolUnavailableError and error-classifier's transient buckets,
 * which build their matchers from this constant.
 */
export const TOOL_SURFACE_NOT_READY = "workflow tool surface not ready";

/** MCP server statuses that will not self-heal within the session. */
const TERMINAL_MCP_SERVER_STATUSES = new Set(["failed", "needs-auth", "disabled"]);

export interface LiveToolSurfaceObservation {
  /** Tool names the session reported at init (MCP tools appear as mcp__<server>__<tool>). */
  tools: readonly string[];
  /** MCP server connection statuses the session reported at init. */
  mcpServers: readonly { name: string; status: string }[];
}

/**
 * Verify the live tool surface observed at SDK session init covers the Unit's
 * required workflow tools. Complements the static pre-dispatch gate
 * (getWorkflowTransportSupportError), which only proves the MCP launch config
 * is discoverable — the workflow server connects asynchronously after session
 * start, so the static gate cannot see whether the tools actually registered.
 *
 * Returns a transient, recovery-classifiable error (kind tool-unavailable →
 * retry) when the workflow server failed or has not yet registered a required
 * tool, so dispatch aborts before the first model turn instead of letting the
 * Unit improvise around "No such tool available". Returns null when no
 * workflow server is part of this session (native tool path), when the Unit
 * requires no workflow tools, or when the surface is ready.
 */
export interface WorkflowMcpToolProbeResult {
  ok: boolean;
  tools: readonly string[];
}

export type WorkflowMcpToolProbe = (
  serverName: string,
  projectRoot: string,
) => Promise<WorkflowMcpToolProbeResult>;

export const DEFAULT_WORKFLOW_MCP_PREFLIGHT_TIMEOUT_MS = 30_000;
export const DEFAULT_WORKFLOW_MCP_PREFLIGHT_POLL_MS = 200;
const RUN_UAT_PREFLIGHT_TIMEOUT_MS = 90_000;

function resolveWorkflowMcpPreflightTimeoutMs(unitType: string | undefined): number {
  if (unitType === "run-uat") return RUN_UAT_PREFLIGHT_TIMEOUT_MS;
  return DEFAULT_WORKFLOW_MCP_PREFLIGHT_TIMEOUT_MS;
}

export function probeCoversRequiredWorkflowTools(
  tools: readonly string[],
  required: readonly string[],
): boolean {
  return required.every((tool) =>
    tools.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
  );
}

export async function awaitWorkflowMcpToolRegistration(input: {
  unitType: string | undefined;
  workflowServerName: string | undefined;
  projectRoot: string;
  timeoutMs?: number;
  pollMs?: number;
  probe?: WorkflowMcpToolProbe;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { unitType, workflowServerName, projectRoot } = input;
  if (!unitType || !workflowServerName) return null;

  const required = getRequiredWorkflowToolsForUnit(unitType).filter(isWorkflowToolSurfaceName);
  if (required.length === 0) return null;

  const probe = input.probe ?? (async (serverName, root) => {
    const result = await testMcpServerConnection(serverName, {
      projectDir: resolveWorkflowMcpProjectRoot(root),
      timeoutMs: WORKFLOW_MCP_PROBE_TIMEOUT_MS,
    });
    return { ok: result.ok, tools: result.tools };
  });

  const deadline = Date.now() + (input.timeoutMs ?? resolveWorkflowMcpPreflightTimeoutMs(unitType));
  const pollMs = input.pollMs ?? DEFAULT_WORKFLOW_MCP_PREFLIGHT_POLL_MS;

  while (Date.now() < deadline) {
    throwIfAborted(input.signal);
    const result = await probe(workflowServerName, projectRoot);
    throwIfAborted(input.signal);
    if (result.ok && probeCoversRequiredWorkflowTools(result.tools, required)) {
      recordWorkflowMcpProbe(projectRoot, workflowServerName, result.tools);
      return null;
    }
    await sleep(pollMs, input.signal);
  }

  return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" did not register required tools before session start: ${required.join(", ")}`;
}

function makeAbortError(): Error {
  const error = new Error("AbortError: The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw makeAbortError();
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(makeAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Brief pause after a successful preflight before SDK query (race with MCP attach). */
export const POST_PREFLIGHT_SDK_SETTLE_MS = 750;

export const POST_PREFLIGHT_READINESS_RETRY_DELAYS_MS = [
  1_000, 2_000, 3_000, 5_000, 8_000, 10_000, 15_000, 15_000, 15_000, 15_000,
] as const;

export function getToolSurfaceReadinessError(input: {
  unitType: string | undefined;
  workflowServerName: string | undefined;
  observation: LiveToolSurfaceObservation;
  projectRoot?: string | undefined;
}): string | null {
  const { unitType, workflowServerName, observation } = input;
  if (!unitType || !workflowServerName) return null;

  const required = getRequiredWorkflowToolsForUnit(unitType).filter(isWorkflowToolSurfaceName);
  if (required.length === 0) return null;

  const server = observation.mcpServers.find((entry) => entry.name === workflowServerName);
  if (server && TERMINAL_MCP_SERVER_STATUSES.has(server.status)) {
    const missing = required.filter(
      (tool) => !observation.tools.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
    );
    const tools = missing.length > 0 ? missing : required;
    return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" status is "${server.status}" (terminal) — cannot register: ${tools.join(", ")}`;
  }

  const missing = required.filter(
    (tool) => !observation.tools.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
  );
  if (missing.length === 0) {
    return null;
  }

  if (!server) {
    return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" is absent from the init surface (not yet connected): ${missing.join(", ")}`;
  }

  if (server.status !== "connected") {
    return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" status is "${server.status}" (not yet connected): ${missing.join(", ")}`;
  }

  return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" is connected but has not registered: ${missing.join(", ")}`;
}
