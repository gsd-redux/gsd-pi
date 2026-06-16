import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ClaudeCodeMcpConfig } from "./preferences-types.js";
import { resolveModelMcpConfig } from "./preferences-mcp.js";

interface McpJsonFile {
  mcpServers?: Record<string, unknown>;
  servers?: Record<string, unknown>;
}

interface ClaudeSettingsFile {
  mcpServers?: Record<string, unknown>;
}

interface DiscoveredMcpServer {
  name: string;
  config: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(path: string, ignoreParseErrors = false): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (err) {
    if (!ignoreParseErrors) throw err;
    return undefined;
  }
}

function collectServerEntries(servers: unknown): DiscoveredMcpServer[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, config]) => ({ name, config }));
}

export function discoverMcpServers(projectDir: string): DiscoveredMcpServer[] {
  const mcpJsonPath = resolve(projectDir, ".mcp.json");
  const settingsPath = resolve(projectDir, ".claude", "settings.json");
  const localSettingsPath = resolve(projectDir, ".claude", "settings.local.json");

  const mcpJson = readJsonFile(mcpJsonPath) as McpJsonFile | undefined;
  const settings = readJsonFile(settingsPath, true) as ClaudeSettingsFile | undefined;
  const localSettings = readJsonFile(localSettingsPath, true) as ClaudeSettingsFile | undefined;

  const seen = new Set<string>();
  const discovered: DiscoveredMcpServer[] = [];
  for (const entry of [
    ...collectServerEntries(mcpJson?.mcpServers),
    ...collectServerEntries(mcpJson?.servers),
    ...collectServerEntries(settings?.mcpServers),
    ...collectServerEntries(localSettings?.mcpServers),
  ]) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    discovered.push(entry);
  }
  return discovered;
}

function isWorkflowMcpServerConfig(config: unknown): boolean {
  if (!isRecord(config)) return false;
  const env = config.env;
  if (isRecord(env)) {
    if (
      typeof env.GSD_WORKFLOW_PROJECT_ROOT === "string"
      || typeof env.GSD_WORKFLOW_EXECUTORS_MODULE === "string"
      || typeof env.GSD_WORKFLOW_WRITE_GATE_MODULE === "string"
      || typeof env.GSD_PERSIST_WRITE_GATE_STATE === "string"
    ) {
      return true;
    }
  }

  const command = typeof config.command === "string" ? config.command : "";
  if (command.includes("gsd-mcp-server")) return true;
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
  return args.some((arg) => arg.includes("gsd-mcp-server") || arg.includes("packages/mcp-server"));
}

function isBrowserMcpServerConfig(config: unknown): boolean {
  if (!isRecord(config)) return false;
  const command = typeof config.command === "string" ? config.command : "";
  if (command.includes("gsd-browser") || command.includes("@opengsd/gsd-browser")) {
    return true;
  }

  const env = config.env;
  if (isRecord(env)) {
    if (
      typeof env.GSD_BROWSER_CLI_PATH === "string"
      || typeof env.GSD_BROWSER_BIN_PATH === "string"
      || typeof env.GSD_BROWSER_MCP_COMMAND === "string"
    ) {
      return true;
    }
  }

  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
  return args.some((arg) => arg.includes("gsd-browser") || arg.includes("@opengsd/gsd-browser"));
}

export function discoverWorkflowMcpServerName(projectDir: string): string | undefined {
  return discoverMcpServers(projectDir).find((server) => isWorkflowMcpServerConfig(server.config))?.name;
}

export function discoverBrowserMcpServerName(projectDir: string): string | undefined {
  return discoverMcpServers(projectDir).find((server) => isBrowserMcpServerConfig(server.config))?.name;
}

export function discoverMcpServerNames(projectDir: string): string[] {
  return discoverMcpServers(projectDir).map((server) => server.name);
}

export function computeMcpDisallowedTools(
  modelId: string,
  mcpConfig: ClaudeCodeMcpConfig | undefined,
  discoveredServers: string[],
  workflowServerName: string | undefined,
): string[] {
  if (!mcpConfig) return [];

  const entry = resolveModelMcpConfig(modelId, mcpConfig);
  if (!entry) return [];

  const allServers = [...discoveredServers, ...(workflowServerName ? [workflowServerName] : [])];
  const blocked = new Set<string>();

  // Allowlist phase: block every server NOT in the allowlist (except workflowServerName)
  if (entry.allowed_servers !== undefined) {
    const allowSet = new Set(entry.allowed_servers);
    for (const server of allServers) {
      if (server === workflowServerName) continue;
      if (!allowSet.has(server)) {
        blocked.add(server);
      }
    }
  }

  // Blocklist phase: explicitly blocked servers are added
  if (entry.blocked_servers !== undefined) {
    for (const server of entry.blocked_servers) {
      blocked.add(server);
    }
  }

  // gsd-workflow implicit allow: remove unless explicitly in blocked_servers
  if (workflowServerName && !(entry.blocked_servers ?? []).includes(workflowServerName)) {
    blocked.delete(workflowServerName);
  }

  return [...blocked].map((name) => `mcp__${name}__*`);
}
