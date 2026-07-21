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
import { dirname, isAbsolute, resolve, win32 } from "node:path";

export interface WorkflowServerLaunch {
  command: string;
  args: string[];
  gsdCliPath?: string;
  windowsVerbatimArguments?: boolean;
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

function isWindowsShim(commandPath: string): boolean {
  return /\.(?:cmd|ps1)$/i.test(commandPath);
}

function isWorkflowServerShim(commandPath: string): boolean {
  return /^gsd-mcp-server(?:\.(?:cmd|ps1))?$/i.test(commandPath.split(/[\\/]/).pop() ?? "");
}

function isAbsoluteCommand(commandPath: string, platform: NodeJS.Platform): boolean {
  return isAbsolute(commandPath) || (platform === "win32" && win32.isAbsolute(commandPath));
}

const WINDOWS_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCommand(command: string): string {
  return command.replace(WINDOWS_META_CHARS, "^$1");
}

function escapeWindowsArgument(argument: string, doubleEscapeMetaChars: boolean): string {
  let escaped = `"${argument
    .replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  escaped = escaped.replace(WINDOWS_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) escaped = escaped.replace(WINDOWS_META_CHARS, "^$1");
  return escaped;
}

function wrapWindowsServerShim(
  commandPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): WorkflowServerLaunch {
  if (/\.ps1$/i.test(commandPath)) {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        commandPath,
        ...args,
      ],
    };
  }
  const doubleEscapeMetaChars = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(commandPath);
  const shellCommand = [
    escapeWindowsCommand(commandPath),
    ...args.map((argument) => escapeWindowsArgument(argument, doubleEscapeMetaChars)),
  ].join(" ");
  return {
    command: env.COMSPEC?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveWorkflowServerCommand(
  commandPath: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  inferEntrypoint: boolean,
): WorkflowServerLaunch {
  let resolvedCommand: string;
  try {
    resolvedCommand = realpathSync(resolve(commandPath));
  } catch {
    if (platform === "win32" && isWindowsShim(commandPath)) {
      return wrapWindowsServerShim(commandPath, args, env);
    }
    return { command: commandPath, args };
  }

  if (inferEntrypoint) {
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
      return { command: process.execPath, args: [realpathSync(entrypoint), ...args] };
    }
  }
  if (platform === "win32" && isWindowsShim(resolvedCommand)) {
    return wrapWindowsServerShim(resolvedCommand, args, env);
  }
  return { command: resolvedCommand, args };
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
    const args = parseArgsEnv(env.GSD_WORKFLOW_MCP_ARGS);
    const hasPath = explicitCommand.includes("/") || explicitCommand.includes("\\");
    const commandPath = hasPath ? explicitCommand : lookup(explicitCommand) ?? explicitCommand;
    let launch: WorkflowServerLaunch;
    if (hasPath && !isAbsoluteCommand(explicitCommand, platform)) {
      launch = platform === "win32" && isWindowsShim(explicitCommand)
        ? wrapWindowsServerShim(explicitCommand, args, env)
        : { command: explicitCommand, args };
    } else {
      launch = resolveWorkflowServerCommand(
        commandPath,
        args,
        platform,
        env,
        isWorkflowServerShim(commandPath),
      );
    }
    return {
      ...launch,
      ...(gsdCliPath ? { gsdCliPath } : {}),
    };
  }

  if (gsdCliPath) {
    const cli = findWorkflowCliFromBinary(gsdCliPath);
    if (cli) return { command: process.execPath, args: [cli], gsdCliPath };
  }

  const onPath = lookup("gsd-mcp-server");
  if (onPath) {
    const launch = resolveWorkflowServerCommand(onPath, [], platform, env, true);
    return { ...launch, ...(gsdCliPath ? { gsdCliPath } : {}) };
  }

  return null;
}
