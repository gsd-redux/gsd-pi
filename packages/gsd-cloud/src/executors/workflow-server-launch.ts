// Project/App: Open GSD
// File Purpose: Resolve how to launch the GSD workflow MCP server for a project.
//
// The cloud daemon's per-project child must be the workflow MCP server
// (@opengsd/mcp-server, bin `gsd-mcp-server`) — that process owns the workflow
// adapter surface (gsd_status, gsd_roadmap, gsd_progress, …). Spawning
// `gsd --mode mcp` instead yields a session registry without those tools, so
// every workflow call fails with "Unknown tool" (issue #1513).
//
// Resolution order mirrors detectWorkflowMcpLaunchConfig in the gsd extension:
//  1. GSD_WORKFLOW_MCP_COMMAND (+ optional GSD_WORKFLOW_MCP_ARGS JSON array)
//  2. packages/mcp-server/dist/cli.js walking up from the resolved gsd binary
//  3. `gsd-mcp-server` on PATH
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface WorkflowServerLaunch {
  command: string;
  args: string[];
  gsdCliPath?: string;
}

export interface ResolveWorkflowServerLaunchOptions {
  /** Path (or bare name) of the gsd binary used as the discovery anchor. */
  gsdBinary?: string;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** PATH lookup, injectable for tests. Defaults to which/where. */
  lookup?: (command: string) => string | null;
  platform?: NodeJS.Platform;
}

function parseArgsEnv(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("GSD_WORKFLOW_MCP_ARGS must be a JSON array of strings");
  }
  return parsed as string[];
}

function defaultLookup(command: string): string | null {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(tool, [command], {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function selectLookupPath(output: string | null, platform: NodeJS.Platform): string | null {
  const paths = output
    ?.split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean) ?? [];
  if (platform === "win32") {
    return paths.find((path) => /\.cmd$/i.test(path)) ?? paths[0] ?? null;
  }
  return paths[0] ?? null;
}

function resolveGsdBinary(
  gsdBinary: string | undefined,
  lookup: (command: string) => string | null,
): string | undefined {
  const candidate = gsdBinary?.trim();
  if (!candidate) return undefined;
  const resolved = candidate.includes("/") || candidate.includes("\\")
    ? candidate
    : lookup(candidate);
  if (!resolved) return undefined;
  try {
    const cliPath = realpathSync(resolve(resolved));
    const npmLoader = resolve(
      dirname(cliPath),
      "node_modules",
      "@opengsd",
      "gsd-pi",
      "dist",
      "loader.js",
    );
    if (existsSync(npmLoader)) return realpathSync(npmLoader);
    if (/\.(?:cmd|ps1)$/i.test(cliPath)) return undefined;
    return cliPath;
  } catch {
    return undefined;
  }
}

function findWorkflowCliFromBinary(gsdCliPath: string): string | null {
  let current = dirname(gsdCliPath);
  while (true) {
    const candidates = [
      resolve(current, "packages", "mcp-server", "dist", "cli.js"),
      resolve(
        current,
        "node_modules",
        "@opengsd",
        "gsd-pi",
        "packages",
        "mcp-server",
        "dist",
        "cli.js",
      ),
    ];
    const candidate = candidates.find((path) => existsSync(path));
    if (candidate) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorkflowServerCommand(commandPath: string): WorkflowServerLaunch | null {
  let resolvedCommand: string;
  try {
    resolvedCommand = realpathSync(resolve(commandPath));
  } catch {
    if (/\.(?:cmd|ps1)$/i.test(commandPath)) return null;
    return { command: commandPath, args: [] };
  }

  const commandDir = dirname(resolvedCommand);
  const entrypoint = [
    resolve(
      commandDir,
      "node_modules",
      "@opengsd",
      "mcp-server",
      "bin",
      "gsd-mcp-server.js",
    ),
    resolve(
      commandDir,
      "..",
      "@opengsd",
      "mcp-server",
      "bin",
      "gsd-mcp-server.js",
    ),
  ].find((path) => existsSync(path));
  if (entrypoint) {
    return { command: process.execPath, args: [realpathSync(entrypoint)] };
  }
  if (/\.(?:cmd|ps1)$/i.test(resolvedCommand)) return null;
  return { command: resolvedCommand, args: [] };
}

export function resolveWorkflowServerLaunch(
  options: ResolveWorkflowServerLaunchOptions = {},
): WorkflowServerLaunch | null {
  const env = options.env ?? process.env;
  const rawLookup = options.lookup ?? defaultLookup;
  const platform = options.platform ?? process.platform;
  const lookup = (command: string): string | null =>
    selectLookupPath(rawLookup(command), platform);
  const gsdCliPath = resolveGsdBinary(options.gsdBinary, lookup);

  const explicitCommand = env.GSD_WORKFLOW_MCP_COMMAND?.trim();
  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: parseArgsEnv(env.GSD_WORKFLOW_MCP_ARGS),
      ...(gsdCliPath ? { gsdCliPath } : {}),
    };
  }

  if (gsdCliPath) {
    const cli = findWorkflowCliFromBinary(gsdCliPath);
    if (cli) return { command: process.execPath, args: [cli], gsdCliPath };
  }

  const onPath = lookup("gsd-mcp-server");
  if (onPath) {
    const launch = resolveWorkflowServerCommand(onPath);
    if (launch) return { ...launch, ...(gsdCliPath ? { gsdCliPath } : {}) };
  }

  return null;
}
