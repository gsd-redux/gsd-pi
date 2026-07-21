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
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

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

/**
 * True when `candidate` is a runnable executable, matching `which`/`where`
 * semantics. On POSIX this requires the execute bit (X_OK); on Windows X_OK is
 * a no-op so this degrades to an existence check, and executability is instead
 * governed by the PATHEXT filtering in searchPath.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Node-side PATH scan, used when `which`/`where` is unavailable (minimal
 * container images often ship neither) or returns nothing. Splits the supplied
 * env's PATH on the OS delimiter and, on Windows, tries each PATHEXT extension.
 * Only returns an executable file, mirroring `which`/`where`.
 */
function searchPath(command: string, env: NodeJS.ProcessEnv): string | null {
  // An explicit path is not a PATH lookup — just confirm it is executable.
  if (command.includes("/") || command.includes("\\")) {
    const abs = resolve(command);
    return isExecutableFile(abs) ? abs : null;
  }
  // Windows commonly exposes PATH as `Path` (or `path`); injected env objects
  // are case-sensitive, unlike the process.env proxy, so check all casings.
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathValue) return null;
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultLookup(command: string, env: NodeJS.ProcessEnv): string | null {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(tool, [command], {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Honor the caller-supplied env so `which`/`where` searches the same PATH
      // as the Node-side fallback below.
      env,
    });
    const resolved = out.trim().split(/\r?\n/)[0] || null;
    // `which`/`where` can report a stale hit; confirm the target still exists.
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // `which`/`where` missing (minimal image) or errored — fall through to the
    // Node-side PATH scan below.
  }
  return searchPath(command, env);
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
  const lookup = options.lookup ?? ((command: string) => defaultLookup(command, env));

  const explicitCommand = env.GSD_WORKFLOW_MCP_COMMAND?.trim();
  if (explicitCommand) {
    return { command: explicitCommand, args: parseArgsEnv(env.GSD_WORKFLOW_MCP_ARGS) };
  }

  let anchor = options.gsdBinary?.trim();
  if (anchor && !anchor.includes("/") && !anchor.includes("\\")) {
    // A bare command name is only a valid discovery anchor once resolved to an
    // on-disk path. If PATH lookup fails, drop it rather than keeping the bare
    // name: resolve("gsd") would otherwise anchor discovery off the daemon's
    // cwd. Callers wanting a relative anchor can pass "./gsd" explicitly.
    anchor = lookup(anchor) ?? undefined;
  }
  if (anchor) {
    const cli = findWorkflowCliFromBinary(anchor);
    if (cli) return { command: process.execPath, args: [cli] };
  }

  const onPath = lookup("gsd-mcp-server");
  if (onPath) return { command: onPath, args: [] };

  return null;
}
