// Project/App: Open GSD
// File Purpose: Resolve how to launch the GSD workflow MCP server for a project.
//
// The cloud daemon's per-project child must be the workflow MCP server
// (@opengsd/mcp-server, bin `gsd-mcp-server`) — that process owns the workflow
// adapter surface (gsd_status, gsd_roadmap, gsd_progress, …). Spawning
// `gsd --mode mcp` instead yields a session registry without those tools, so
// every workflow call fails with "Unknown tool" (issue #1513).
//
// Resolution order (daemon-specific; it does not mirror the extension's
// detectWorkflowMcpLaunchConfig, which probes the project root for hints):
//  1. GSD_WORKFLOW_MCP_COMMAND (+ optional GSD_WORKFLOW_MCP_ARGS JSON array)
//  2. packages/mcp-server/dist/cli.js walking up from the resolved gsd binary
//  3. `gsd-mcp-server` on PATH
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface WorkflowServerLaunch {
  command: string;
  args: string[];
}

export interface ResolveWorkflowServerLaunchOptions {
  /** Path (or bare name) of the gsd binary used as the discovery anchor. */
  gsdBinary?: string;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** PATH lookup, injectable for tests. Defaults to which/where. */
  lookup?: (command: string) => string | null;
}

function parseArgsEnv(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`GSD_WORKFLOW_MCP_ARGS must be valid JSON: ${detail}`);
  }
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
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** Walk up from the resolved gsd binary looking for packages/mcp-server/dist/cli.js. */
function findWorkflowCliFromBinary(gsdBinary: string): string | null {
  let current: string;
  try {
    // realpath resolves symlinked launchers (e.g. /opt/homebrew/bin/gsd) to the
    // installed package, whose root holds packages/mcp-server.
    current = dirname(realpathSync(resolve(gsdBinary)));
  } catch {
    return null;
  }
  while (true) {
    const candidate = resolve(current, "packages", "mcp-server", "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveWorkflowServerLaunch(
  options: ResolveWorkflowServerLaunchOptions = {},
): WorkflowServerLaunch | null {
  const env = options.env ?? process.env;
  const lookup = options.lookup ?? defaultLookup;

  const explicitCommand = env.GSD_WORKFLOW_MCP_COMMAND?.trim();
  if (explicitCommand) {
    return { command: explicitCommand, args: parseArgsEnv(env.GSD_WORKFLOW_MCP_ARGS) };
  }

  let anchor = options.gsdBinary?.trim();
  if (anchor && !anchor.includes("/") && !anchor.includes("\\")) {
    anchor = lookup(anchor) ?? anchor;
  }
  if (anchor) {
    const cli = findWorkflowCliFromBinary(anchor);
    if (cli) return { command: process.execPath, args: [cli] };
  }

  const onPath = lookup("gsd-mcp-server");
  if (onPath) return { command: onPath, args: [] };

  return null;
}
