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
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

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
