import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ClaudeCodeMcpConfig } from "./preferences-types.js";
import { isGsdBrowserMcpServerConfig } from "../shared/gsd-browser-cli.js";
import { toMcpWildcardToolName } from "./mcp-tool-name.js";
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

interface JsonFileSignature {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

interface ProjectMcpDiscoveryCacheEntry {
  signatures: JsonFileSignature[];
  servers: DiscoveredMcpServer[];
}

const projectMcpDiscoveryCache = new Map<string, ProjectMcpDiscoveryCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getJsonFileSignature(path: string, ignoreAccessErrors = false): JsonFileSignature {
  try {
    const stats = statSync(path);
    return { exists: true, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (err) {
    const code = isRecord(err) ? err.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR" || ignoreAccessErrors) return { exists: false };
    throw err;
  }
}

function jsonFileSignaturesEqual(a: JsonFileSignature[], b: JsonFileSignature[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((signature, index) => {
    const other = b[index];
    return signature.exists === other.exists
      && signature.mtimeMs === other.mtimeMs
      && signature.size === other.size;
  });
}

function readJsonFile(
  path: string,
  ignoreParseErrors = false,
  signature = getJsonFileSignature(path, ignoreParseErrors),
): unknown | undefined {
  if (!signature.exists) return undefined;
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
  const resolvedProjectDir = resolve(projectDir);
  const mcpJsonPath = resolve(resolvedProjectDir, ".mcp.json");
  const settingsPath = resolve(resolvedProjectDir, ".claude", "settings.json");
  const localSettingsPath = resolve(resolvedProjectDir, ".claude", "settings.local.json");
  const signatures = [
    getJsonFileSignature(mcpJsonPath, true),
    getJsonFileSignature(settingsPath, true),
    getJsonFileSignature(localSettingsPath, true),
  ];
  const cached = projectMcpDiscoveryCache.get(resolvedProjectDir);
  if (cached && jsonFileSignaturesEqual(cached.signatures, signatures)) {
    return [...cached.servers];
  }

  const mcpJson = readJsonFile(mcpJsonPath, false, signatures[0]) as McpJsonFile | undefined;
  const settings = readJsonFile(settingsPath, true, signatures[1]) as ClaudeSettingsFile | undefined;
  const localSettings = readJsonFile(localSettingsPath, true, signatures[2]) as ClaudeSettingsFile | undefined;

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
  projectMcpDiscoveryCache.set(resolvedProjectDir, { signatures, servers: discovered });
  return [...discovered];
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

export function discoverWorkflowMcpServerName(projectDir: string): string | undefined {
  return discoverMcpServers(projectDir).find((server) => isWorkflowMcpServerConfig(server.config))?.name;
}

export function discoverBrowserMcpServerName(projectDir: string): string | undefined {
  return discoverMcpServers(projectDir).find((server) => isGsdBrowserMcpServerConfig(server.config))?.name;
}

export function discoverMcpServerNames(projectDir: string): string[] {
  return discoverMcpServers(projectDir).map((server) => server.name);
}

export function discoverUserMcpServerNames(): string[] {
  const userSettingsPath = resolve(homedir(), ".claude", "settings.json");
  const userSettings = readJsonFile(userSettingsPath, true) as ClaudeSettingsFile | undefined;
  return collectServerEntries(userSettings?.mcpServers).map((s) => s.name);
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

  return [...blocked].map(toMcpWildcardToolName);
}
