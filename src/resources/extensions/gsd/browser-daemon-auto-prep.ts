import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveAmbientBrowserEngineResolution,
  resolveBrowserEngineResolution,
  type BrowserEngineMode,
} from "../browser-tools/engine/selection.js";
import {
  resolveGsdBrowserCliAvailability,
  resolveGsdBrowserDaemonStartInvocation,
  resolveGsdBrowserDaemonStopInvocation,
  type GsdBrowserMcpLaunchConfig,
} from "../shared/gsd-browser-cli.js";
import { uatTypeIncludesBrowser, type UatType } from "./uat-policy.js";

const DEFAULT_DAEMON_START_TIMEOUT_MS = 30_000;
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 15_000;

/** Maximum bytes of daemon stderr folded into an error message (4 KB). */
const MAX_DAEMON_STDERR_BYTES = 4 * 1024;

/**
 * Project roots whose gsd-browser daemon this process warmed via
 * {@link prepareBrowserDaemonForUat}. Teardown only stops daemons we actually
 * started, so non-browser auto-mode sessions never spawn a stray `daemon stop`.
 */
const warmedDaemonProjectRoots = new Set<string>();

function isEnvDisabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function isWarmUpDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GSD_BROWSER_WARMUP?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

export interface BrowserDaemonWarmContext {
  uatType: UatType;
  sessionProvider?: string;
  sessionAuthMode?: "apiKey" | "oauth" | "externalCli" | "none";
  sessionBaseUrl?: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

/** Active engine for warm-up: explicit env override, else session-committed ambient resolution. */
function resolveActiveBrowserEngine(projectRoot: string, env: NodeJS.ProcessEnv): BrowserEngineMode {
  if (env.GSD_BROWSER_ENGINE?.trim()) {
    return resolveBrowserEngineResolution(env, projectRoot).engine;
  }
  return resolveAmbientBrowserEngineResolution(projectRoot).engine;
}

export function shouldWarmBrowserDaemonForUat(ctx: BrowserDaemonWarmContext): boolean {
  if (!uatTypeIncludesBrowser(ctx.uatType)) return false;

  const env = ctx.env ?? process.env;
  if (isWarmUpDisabled(env)) return false;
  if (isEnvDisabled(env.GSD_BROWSER_MCP_ENABLED)) return false;

  const availability = resolveGsdBrowserCliAvailability(env);
  if (!availability.available) return false;

  const projectRoot = resolve(ctx.projectRoot);
  return resolveActiveBrowserEngine(projectRoot, env) === "gsd-browser";
}

/**
 * Read at most {@link MAX_DAEMON_STDERR_BYTES} from the capture file, keeping the head and
 * the tail around a marker. Mirrors readBoundedCommandOutput in verification-gate.ts, so a
 * daemon that floods stderr cannot pull an unbounded file into memory here.
 */
function readDaemonStderr(stderrPath: string): string {
  let fd: number;
  try {
    fd = openSync(stderrPath, "r");
  } catch {
    // Diagnostics are best-effort — never let stderr recovery mask the real failure.
    return "";
  }

  try {
    const size = fstatSync(fd).size;
    if (size <= MAX_DAEMON_STDERR_BYTES) return readFileSync(stderrPath, "utf-8").trim();

    const marker = Buffer.from("\n…[truncated]\n", "utf-8");
    const retainedBytes = MAX_DAEMON_STDERR_BYTES - marker.byteLength;
    const headBytes = Math.floor(retainedBytes / 2);
    const tailBytes = retainedBytes - headBytes;
    const head = Buffer.allocUnsafe(headBytes);
    const tail = Buffer.allocUnsafe(tailBytes);
    readSync(fd, head, 0, headBytes, 0);
    readSync(fd, tail, 0, tailBytes, size - tailBytes);
    return Buffer.concat([head, marker, tail]).toString("utf-8").trim();
  } catch {
    return "";
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Run a `gsd-browser daemon <action>` invocation without ever handing the child an
 * stdio *pipe* (#2103).
 *
 * `daemon start` exits 0 but leaves a detached daemon (and Chrome) behind that inherits
 * the pipe's write handle. execFileSync unblocks on stdio EOF, not on child exit, so the
 * surviving grandchild held the pipe open and warm-up burned its full timeout — reporting
 * ETIMEDOUT even though the daemon had started cleanly.
 *
 * stderr is captured to a file descriptor instead, mirroring verification-gate.ts: a file
 * is not a pipe, so spawnSync never waits on it. Capturing rather than discarding keeps the
 * daemon's own failure text inside the user-facing "daemon failed to start (...)" message,
 * which stdio "ignore" would reduce to a bare "Command failed: <cmd>".
 */
function runDaemonCommand(
  invocation: Pick<GsdBrowserMcpLaunchConfig, "command" | "args" | "cwd" | "env">,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): { ok: true } | { ok: false; error: string } {
  // Capture setup is best-effort: this module must stay incapable of throwing, because the
  // dispatch-rule loop that reaches it does not guard rule.match(). If the temp file cannot
  // be created we discard stderr rather than fail the warm-up.
  // The directory is tracked separately from the descriptor so that a partial setup —
  // mkdtempSync succeeds, openSync then fails — still gets cleaned up below.
  let captureDir: string | null = null;
  let capture: { path: string; fd: number } | null = null;
  try {
    captureDir = mkdtempSync(join(tmpdir(), "gsd-browser-daemon-"));
    const path = join(captureDir, "stderr");
    capture = { path, fd: openSync(path, "w") };
  } catch {
    capture = null;
  }

  try {
    execFileSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...env, ...(invocation.env ?? {}) },
      stdio: ["ignore", "ignore", capture ? capture.fd : "ignore"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderrText = capture ? readDaemonStderr(capture.path) : "";
    return { ok: false, error: stderrText ? `${detail}: ${stderrText}` : detail };
  } finally {
    if (capture) {
      try {
        closeSync(capture.fd);
      } catch {
        /* already closed */
      }
    }
    if (captureDir) {
      try {
        rmSync(captureDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

export function ensureBrowserDaemonStarted(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: true } | { ok: false; error: string } {
  const env = options.env ?? process.env;
  const availability = resolveGsdBrowserCliAvailability(env);
  if (!availability.available) {
    return { ok: false, error: availability.detail };
  }

  let invocation: ReturnType<typeof resolveGsdBrowserDaemonStartInvocation>;
  try {
    invocation = resolveGsdBrowserDaemonStartInvocation(projectRoot, env);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return runDaemonCommand(invocation, env, options.timeoutMs ?? DEFAULT_DAEMON_START_TIMEOUT_MS);
}

/**
 * Best-effort pre-warm of the gsd-browser session daemon before browser-backed
 * run-uat dispatch. Returns an actionable stop reason when warm-up is required
 * but fails; returns null when warm-up is skipped or succeeds.
 */
export function prepareBrowserDaemonForUat(ctx: BrowserDaemonWarmContext): string | null {
  if (!shouldWarmBrowserDaemonForUat(ctx)) return null;

  const result = ensureBrowserDaemonStarted(ctx.projectRoot, { env: ctx.env });
  if (result.ok) {
    warmedDaemonProjectRoots.add(resolve(ctx.projectRoot));
    return null;
  }

  return `Cannot dispatch browser-backed run-uat: gsd-browser daemon failed to start (${result.error}). Ensure Chrome/Chromium is installed, run \`gsd-browser daemon health\` with the project session flags from .mcp.json, or set GSD_BROWSER_PATH to a Chromium binary.`;
}

/**
 * Best-effort stop of a gsd-browser session daemon warmed for browser UAT.
 * Mirrors {@link ensureBrowserDaemonStarted}; returns the failure detail rather
 * than throwing so teardown can stay non-fatal.
 */
export function stopBrowserDaemon(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: true } | { ok: false; error: string } {
  const env = options.env ?? process.env;
  const availability = resolveGsdBrowserCliAvailability(env);
  if (!availability.available) {
    return { ok: false, error: availability.detail };
  }

  let invocation: ReturnType<typeof resolveGsdBrowserDaemonStopInvocation>;
  try {
    invocation = resolveGsdBrowserDaemonStopInvocation(projectRoot, env);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return runDaemonCommand(invocation, env, options.timeoutMs ?? DEFAULT_DAEMON_STOP_TIMEOUT_MS);
}

/**
 * Tear down every gsd-browser daemon this process warmed for browser UAT,
 * clearing the tracked set. Called on auto-mode loop exit so the Chrome process
 * does not survive session/task completion (mirrors the warm-up preflight).
 * Best-effort: returns the project roots whose stop failed for logging.
 */
export function teardownWarmedBrowserDaemons(
  options: { env?: NodeJS.ProcessEnv } = {},
): { projectRoot: string; error: string }[] {
  if (warmedDaemonProjectRoots.size === 0) return [];

  const failures: { projectRoot: string; error: string }[] = [];
  for (const projectRoot of warmedDaemonProjectRoots) {
    const result = stopBrowserDaemon(projectRoot, { env: options.env });
    if (!result.ok) {
      failures.push({ projectRoot, error: result.error });
    }
  }
  warmedDaemonProjectRoots.clear();
  return failures;
}
