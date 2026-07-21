// Project/App: Open GSD
// File Purpose: Resolve how to launch the GSD workflow MCP server for a project.
//
// The cloud daemon's per-project child must be the workflow MCP server
// (@opengsd/mcp-server, bin `gsd-mcp-server`) — that process owns the workflow
// adapter surface (gsd_status, gsd_roadmap, gsd_progress, …). Spawning
// `gsd --mode mcp` instead yields a session registry without those tools, so
// every workflow call fails with "Unknown tool" (issue #1513).
//
// Resolution mirrors the extension's environment override, installed-layout,
// and PATH stages, but uses host installation anchors instead of the project root:
//  1. GSD_WORKFLOW_MCP_COMMAND (+ optional ARGS, ENV, and CWD overrides)
//  2. packages/mcp-server/dist/cli.js walking up from resolved gsd binaries or
//     GSD_WORKFLOW_PATH
//  3. `gsd-mcp-server` on PATH
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

export interface WorkflowServerLaunch {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`GSD_WORKFLOW_MCP_ARGS must be valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("GSD_WORKFLOW_MCP_ARGS must be a JSON array");
  }
  // Coerce entries with String(...) rather than rejecting non-strings, matching
  // the extension's detectWorkflowMcpLaunchConfig contract (explicitArgs.map(String)),
  // so reasonable values like numbers/booleans don't cause startup failures.
  return parsed.map(String);
}

function parseEnvironmentEnv(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`GSD_WORKFLOW_MCP_ENV must be valid JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GSD_WORKFLOW_MCP_ENV must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );
}

/**
 * True when `candidate` is a runnable executable, matching `which`/`where`
 * semantics. On POSIX this requires the execute bit (X_OK); on Windows X_OK is
 * a no-op so this degrades to an existence check, and executability is instead
 * governed by the PATHEXT filtering in searchPath.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    // Reject directories: on POSIX they usually carry the execute ("searchable")
    // bit, so an X_OK-only check would mistake a same-named directory for the
    // binary. which/where only return regular files.
    if (!statSync(candidate).isFile()) return false;
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
function searchPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  // An explicit path is not a PATH lookup — just confirm it is executable.
  if (command.includes("/") || command.includes("\\")) {
    const abs = resolve(command);
    return isExecutableFile(abs) ? abs : null;
  }
  // Windows commonly exposes PATH as `Path` (or `path`); injected env objects
  // are case-sensitive, unlike the process.env proxy, so check all casings.
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathValue) return null;
  const isWindows = platform === "win32";
  const exts = isWindows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  // Split PATH with the delimiter of the injected platform, not the host's, so
  // Windows-style (`;`) values resolve when tests simulate win32 on POSIX.
  const pathDelimiter = isWindows ? win32.delimiter : posix.delimiter;
  for (const dir of pathValue.split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultLookup(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const tool = platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(tool, [command], {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Honor the caller-supplied env so `which`/`where` searches the same PATH
      // as the Node-side fallback below.
      env,
    });
    // `which`/`where` can report stale hits; drop any line whose target no
    // longer exists before handing candidates to selectLookupPath. If nothing
    // valid remains, fall through to the Node-side PATH scan below.
    const valid = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
    if (valid.length > 0) return valid.join("\n");
  } catch {
    // `which`/`where` missing (minimal image) or errored — fall through to the
    // Node-side PATH scan below.
  }
  return searchPath(command, env, platform);
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
  // A bare command name is only a valid discovery anchor once resolved to an
  // on-disk path. If PATH lookup fails, drop it rather than keeping the bare
  // name: resolve("gsd") would otherwise anchor discovery off the daemon's
  // cwd. Callers wanting a relative anchor can pass "./gsd" explicitly.
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

function findWorkflowCliFromAnchor(anchor: string): string | null {
  let current = dirname(anchor);
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
  const platform = options.platform ?? process.platform;
  const rawLookup = options.lookup ?? ((command: string) => defaultLookup(command, env, platform));
  const lookup = (command: string): string | null =>
    selectLookupPath(rawLookup(command), platform);
  const explicitEnvironment = parseEnvironmentEnv(env.GSD_WORKFLOW_MCP_ENV);
  const explicitCwd = env.GSD_WORKFLOW_MCP_CWD?.trim();
  const configuredCliPath =
    explicitEnvironment?.GSD_CLI_PATH?.trim()
    || explicitEnvironment?.GSD_BIN_PATH?.trim()
    || env.GSD_CLI_PATH?.trim()
    || env.GSD_BIN_PATH?.trim();
  const anchorCandidates = options.gsdBinary !== undefined
    ? [options.gsdBinary, configuredCliPath]
    : [configuredCliPath, "gsd"];
  const resolvedConfiguredCliPath = resolveGsdBinary(configuredCliPath, lookup);
  const resolvedGsdAnchors: string[] = [];
  for (const candidate of anchorCandidates) {
    const resolved = candidate === configuredCliPath
      ? resolvedConfiguredCliPath
      : resolveGsdBinary(candidate, lookup);
    if (resolved && !resolvedGsdAnchors.includes(resolved)) resolvedGsdAnchors.push(resolved);
  }
  const gsdCliPath = options.gsdBinary === undefined && configuredCliPath
    ? resolvedConfiguredCliPath ?? configuredCliPath
    : resolvedGsdAnchors[0];

  const explicitCommand = env.GSD_WORKFLOW_MCP_COMMAND?.trim();
  if (explicitCommand) {
    const args = parseArgsEnv(env.GSD_WORKFLOW_MCP_ARGS);
    // GSD_WORKFLOW_MCP_CWD (explicitCwd) is a working-directory override for the
    // server process only — it is deliberately NOT a project-root fallback.
    // Discovery is memoized host-level, so folding it into GSD_WORKFLOW_PROJECT_ROOT
    // would pin every per-project child to the same root and clobber the
    // executor's per-project path (gsd-pi-executor uses launch.env root ?? path),
    // breaking multi-project routing. It still lands as launch.cwd below.
    const workflowProjectRoot =
      explicitEnvironment?.GSD_WORKFLOW_PROJECT_ROOT?.trim()
      || env.GSD_WORKFLOW_PROJECT_ROOT?.trim()
      || env.GSD_PROJECT_ROOT?.trim();
    const launchEnvironment = {
      ...explicitEnvironment,
      ...(configuredCliPath && gsdCliPath
        ? { GSD_CLI_PATH: gsdCliPath, GSD_BIN_PATH: gsdCliPath }
        : {}),
      ...(workflowProjectRoot ? { GSD_WORKFLOW_PROJECT_ROOT: resolve(workflowProjectRoot) } : {}),
    };
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
      ...(explicitCwd ? { cwd: explicitCwd } : {}),
      ...(Object.keys(launchEnvironment).length > 0 ? { env: launchEnvironment } : {}),
      ...(gsdCliPath ? { gsdCliPath } : {}),
    };
  }

  const workflowPath = env.GSD_WORKFLOW_PATH?.trim();
  const discoveryAnchors = workflowPath
    ? [...resolvedGsdAnchors, workflowPath]
    : resolvedGsdAnchors;
  for (const anchor of discoveryAnchors) {
    const cli = findWorkflowCliFromAnchor(anchor);
    if (cli) {
      return {
        command: process.execPath,
        args: [cli],
        ...(gsdCliPath ? { gsdCliPath } : {}),
      };
    }
  }

  const onPath = lookup("gsd-mcp-server");
  if (onPath) {
    const launch = resolveWorkflowServerCommand(onPath, [], platform, env, true);
    return { ...launch, ...(gsdCliPath ? { gsdCliPath } : {}) };
  }

  return null;
}
