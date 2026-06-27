// Project/App: gsd-pi
// File Purpose: Tool Contract module's runtime face — verify the live SDK tool surface covers a Unit's required workflow tools.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { buildHttpTransportOpts } from "../mcp-client/auth.js";
import {
  buildMcpChildEnv,
  collectMcpEnvWarnings,
  detectTransport,
  getMcpServerConfig,
  GSD_MCP_PROBE_ENV,
  resolveMcpString,
  type ManagedMcpServerConfig,
} from "../mcp-client/manager.js";
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
export const TERMINAL_MCP_SERVER_STATUSES = new Set(["failed", "needs-auth", "disabled"]);

/**
 * Marker embedded in the terminal readiness error message. The readiness layer
 * appends it to the terminal branch so the classifier can distinguish a
 * non-self-healing failure (failed/needs-auth/disabled) from the genuinely
 * transient not-yet-connected branches, which all share the
 * {@link TOOL_SURFACE_NOT_READY} prefix.
 */
export const TOOL_SURFACE_TERMINAL_MARKER = "(terminal)";

/**
 * True when a tool-surface readiness error describes a *terminal* MCP server
 * failure (failed / needs-auth / disabled). These statuses will not self-heal
 * within the session, so they must not be retried as transient — the caller
 * should escalate / pause instead of same-model retrying indefinitely.
 *
 * Detection is driven by the embedded marker string and the terminal status
 * set above (single source of truth), not by re-deriving either independently.
 */
export function isTerminalToolSurfaceError(errorMsg: string | null | undefined): boolean {
  if (!errorMsg || !errorMsg.includes(TOOL_SURFACE_NOT_READY)) return false;
  if (!/\bterminal\b/i.test(errorMsg)) return false;
  // Belt-and-braces: confirm one of the canonical terminal statuses is present
  // so a stray "(terminal)" in unrelated text doesn't trigger this.
  return [...TERMINAL_MCP_SERVER_STATUSES].some(
    (status) => new RegExp(`status is "${escapeRegExp(status)}"`, "i").test(errorMsg),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  error?: string;
}

export type WorkflowMcpInlineServerConfig = Record<string, unknown>;

export type WorkflowMcpToolProbe = (
  serverName: string,
  projectRoot: string,
  workflowServerConfig?: WorkflowMcpInlineServerConfig,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeInlineWorkflowMcpServerConfig(
  serverName: string,
  config: WorkflowMcpInlineServerConfig | undefined,
): ManagedMcpServerConfig | undefined {
  if (!config) return undefined;
  const command = typeof config.command === "string" ? config.command : undefined;
  const url = typeof config.url === "string" ? config.url : undefined;
  const transport = detectTransport(config);
  const args = stringArray(config.args);
  const env = stringRecord(config.env);
  const headers = stringRecord(config.headers);
  return {
    name: serverName,
    transport,
    sourcePath: "[inline workflow MCP config]",
    sourceKind: "project-local",
    disabled: config.disabled === true,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
    ...(headers ? { headers } : {}),
    ...(isRecord(config.oauth) ? { oauth: config.oauth as ManagedMcpServerConfig["oauth"] } : {}),
    envWarnings: collectMcpEnvWarnings([
      ["url", url],
      ...Object.entries(env ?? {}).map(([key, value]) => [`env.${key}`, value] as [string, string | undefined]),
      ...Object.entries(headers ?? {}).map(([key, value]) => [`headers.${key}`, value] as [string, string | undefined]),
    ]),
  };
}

export async function awaitWorkflowMcpToolRegistration(input: {
  unitType: string | undefined;
  workflowServerName: string | undefined;
  projectRoot: string;
  workflowServerConfig?: WorkflowMcpInlineServerConfig;
  timeoutMs?: number;
  pollMs?: number;
  probe?: WorkflowMcpToolProbe;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { unitType, workflowServerName, projectRoot } = input;
  if (!unitType || !workflowServerName) return null;

  const required = getRequiredWorkflowToolsForUnit(unitType).filter(isWorkflowToolSurfaceName);
  if (required.length === 0) return null;

  let reusableClient: Client | undefined;
  let reusableTransport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
  let reusableServerConfig: ManagedMcpServerConfig | undefined;
  let readReusableStderr: (() => string) | undefined;

  const closeReusableConnection = async (): Promise<void> => {
    if (reusableTransport) {
      try {
        await reusableTransport.close();
      } catch {
        // Best-effort cleanup after preflight connection probing.
      }
    }
    if (reusableClient) {
      try {
        await reusableClient.close();
      } catch {
        // Best-effort cleanup after preflight connection probing.
      }
    }
    reusableClient = undefined;
    reusableTransport = undefined;
    readReusableStderr = undefined;
  };

  const formatProbeError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = readReusableStderr?.() ?? "";
    return stderr ? `${message}\nStderr:\n${stderr}` : message;
  };

  const captureReusableStderr = (transport: StdioClientTransport): (() => string) => {
    const maxBytes = 4096;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.byteLength;
      chunks.push(buffer);
      while (chunks.reduce((sum, entry) => sum + entry.byteLength, 0) > maxBytes) {
        chunks.shift();
      }
    });

    return () => {
      const captured = Buffer.concat(chunks).toString("utf-8").trim();
      if (!captured) return "";
      return totalBytes > maxBytes ? `[stderr truncated to last ${maxBytes} bytes]\n${captured}` : captured;
    };
  };

  const probe = input.probe ?? (async (serverName, root, workflowServerConfig) => {
    reusableServerConfig ??=
      normalizeInlineWorkflowMcpServerConfig(serverName, workflowServerConfig) ??
      getMcpServerConfig(serverName, {
        projectDir: resolveWorkflowMcpProjectRoot(root),
        includeDisabled: true,
      });

    const config = reusableServerConfig;
    if (!config) return { ok: false, tools: [], error: "Unknown MCP server." };
    if (config.disabled) return { ok: false, tools: [], error: "MCP server is disabled." };
    if (config.transport === "unsupported") return { ok: false, tools: [], error: "MCP server transport is unsupported." };
    if (config.envWarnings.length > 0) {
      return { ok: false, tools: [], error: "MCP server config references unset environment variables." };
    }

    try {
      if (!reusableClient) {
        reusableClient = new Client({ name: "gsd", version: "1.0.0" });
        let transport: StdioClientTransport | StreamableHTTPClientTransport;
        if (config.transport === "stdio") {
          transport = new StdioClientTransport({
            command: config.command ?? "",
            args: config.args,
            env: {
              ...buildMcpChildEnv(config.env),
              [GSD_MCP_PROBE_ENV]: "1",
            },
            cwd: config.cwd,
            stderr: "pipe",
          });
          readReusableStderr = captureReusableStderr(transport);
        } else {
          const resolvedUrl = resolveMcpString(config.url ?? "");
          transport = new StreamableHTTPClientTransport(
            new URL(resolvedUrl),
            buildHttpTransportOpts({ headers: config.headers, oauth: config.oauth }),
          );
        }
        reusableTransport = transport;
        await reusableClient.connect(transport, {
          signal: input.signal,
          timeout: WORKFLOW_MCP_PROBE_TIMEOUT_MS,
        });
      }

      const result = await reusableClient.listTools(undefined, {
        signal: input.signal,
        timeout: WORKFLOW_MCP_PROBE_TIMEOUT_MS,
      });
      return { ok: true, tools: (result.tools ?? []).map((tool) => tool.name) };
    } catch (error) {
      const formatted = formatProbeError(error);
      await closeReusableConnection();
      return { ok: false, tools: [], error: formatted };
    }
  });

  const deadline = Date.now() + (input.timeoutMs ?? resolveWorkflowMcpPreflightTimeoutMs(unitType));
  const pollMs = input.pollMs ?? DEFAULT_WORKFLOW_MCP_PREFLIGHT_POLL_MS;
  let lastProbeError: string | undefined;

  try {
    while (Date.now() < deadline) {
      throwIfAborted(input.signal);
      const result = await probe(workflowServerName, projectRoot, input.workflowServerConfig).catch((err: unknown) => {
        if (input.signal?.aborted) throw err;
        lastProbeError = err instanceof Error ? err.message : String(err);
        return undefined;
      });
      throwIfAborted(input.signal);
      if (result) lastProbeError = result.error;
      if (result?.ok && probeCoversRequiredWorkflowTools(result.tools, required)) {
        recordWorkflowMcpProbe(projectRoot, workflowServerName, result.tools);
        return null;
      }
      await sleep(pollMs, input.signal);
    }
  } finally {
    await closeReusableConnection();
  }

  const probeError = lastProbeError ? `; last probe error: ${lastProbeError}` : "";
  return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" did not register required tools before session start: ${required.join(", ")}${probeError}`;
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
