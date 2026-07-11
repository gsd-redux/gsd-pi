// Project/App: Open GSD
// File Purpose: Detached cloud runtime process lifecycle and status persistence.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS } from "./cloud-runtime.js";
import { canonicalConfigPath, runtimeArtifactPath } from "./runtime-artifacts.js";

interface RuntimeProcessState {
  pid: number;
  projects: string[];
  process_start_identity?: string;
}

interface LocatedRuntimeProcessState {
  path: string;
  state: RuntimeProcessState;
}

export interface RuntimeProcessStatus {
  running: boolean;
  pid: number | null;
  projects: string[];
  log_file: string;
}

interface StartRuntimeOptions {
  binaryPath: string;
  configPath: string;
  projectDirs: string[];
  readyTimeoutMs?: number;
  verbose?: boolean;
  processIdentityReader?: (pid: number) => string | null;
}

const PROCESS_STARTUP_GRACE_MS = 5_000;
const FORCED_STOP_TIMEOUT_MS = 5_000;
const STOP_GRACE_PERIOD_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 50;

export const BACKGROUND_RUNTIME_READY_TIMEOUT_MS =
  CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS + PROCESS_STARTUP_GRACE_MS;

export async function startBackgroundRuntime(opts: StartRuntimeOptions): Promise<RuntimeProcessStatus> {
  await acquireRuntimeStartLock(opts.configPath);
  try {
    await stopBackgroundRuntime(opts.configPath);

    const logFile = runtimeLogPath(opts.configPath);
    mkdirSync(dirname(runtimeStatePath(opts.configPath)), { recursive: true });
    const logFd = openSync(logFile, "a", 0o600);
    chmodSync(logFile, 0o600);
    const runArgs = [opts.binaryPath, "_run", "--config", opts.configPath];
    if (opts.verbose) runArgs.push("--verbose");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, runArgs, {
        cwd: opts.projectDirs[0] ?? process.cwd(),
        detached: true,
        env: process.env,
        stdio: ["ignore", logFd, logFd, "ipc"],
      });
    } finally {
      closeSync(logFd);
    }

    if (child.pid == null) {
      child.kill();
      throw new Error(`could not start the background runtime; see ${logFile}`);
    }
    const pid = child.pid;

    let processStartIdentity: string | null = null;
    try {
      processStartIdentity = (opts.processIdentityReader ?? readProcessStartIdentity)(pid);
      if (!processStartIdentity) {
        throw new Error(`could not determine process identity for PID ${pid}`);
      }
      writeRuntimeStateWithIdentity(
        opts.configPath,
        pid,
        opts.projectDirs,
        processStartIdentity,
      );
    } catch (error) {
      if (child.connected) child.disconnect();
      if (processStartIdentity) {
        await terminateProcess(pid, processStartIdentity);
      } else {
        await terminateKnownChild(child);
      }
      throw error;
    }

    try {
      await waitUntilReady(child, opts.readyTimeoutMs ?? BACKGROUND_RUNTIME_READY_TIMEOUT_MS);
    } catch (error) {
      if (child.connected) child.disconnect();
      await terminateProcess(pid, processStartIdentity);
      removeRuntimeState(opts.configPath);
      throw error;
    }

    if (child.connected) child.disconnect();
    child.unref();

    return {
      running: true,
      pid,
      projects: opts.projectDirs,
      log_file: logFile,
    };
  } finally {
    releaseRuntimeStartLock(opts.configPath);
  }
}

/**
 * Record a running runtime so a later launch can find and stop it. Used both by
 * the detached launcher (child PID) and by a `--foreground` session (its own
 * PID), so the two modes share one source of truth and never coexist on the
 * same device token.
 */
export function writeRuntimeState(configPath: string, pid: number, projects: string[]): void {
  const processStartIdentity = readProcessStartIdentity(pid);
  if (!processStartIdentity) {
    throw new Error(`could not determine process identity for PID ${pid}`);
  }
  writeRuntimeStateWithIdentity(configPath, pid, projects, processStartIdentity);
}

function writeRuntimeStateWithIdentity(
  configPath: string,
  pid: number,
  projects: string[],
  processStartIdentity: string,
): void {
  const statePath = runtimeStatePath(configPath);
  mkdirSync(dirname(statePath), { recursive: true });
  writePrivateJson(statePath, {
    pid,
    projects,
    process_start_identity: processStartIdentity,
  } satisfies RuntimeProcessState);
}

export function clearRuntimeState(configPath: string): void {
  removeRuntimeState(configPath);
}

export async function stopBackgroundRuntime(configPath: string): Promise<boolean> {
  const located = readRuntimeState(configPath);
  if (!located) return false;
  const processStartIdentity = located.state.process_start_identity;
  if (!processStartIdentity || !runtimeProcessMatches(located.state)) {
    removeRuntimeStateFile(located.path);
    return false;
  }
  await terminateProcess(located.state.pid, processStartIdentity);
  removeRuntimeStateFile(located.path);
  return true;
}

export function backgroundRuntimeStatus(configPath: string): RuntimeProcessStatus {
  const located = readRuntimeState(configPath);
  if (!located) {
    return { running: false, pid: null, projects: [], log_file: runtimeLogPath(configPath) };
  }
  if (!runtimeProcessMatches(located.state)) {
    removeRuntimeStateFile(located.path);
    return {
      running: false,
      pid: null,
      projects: located.state.projects,
      log_file: runtimeLogPath(configPath),
    };
  }
  return {
    running: true,
    pid: located.state.pid,
    projects: located.state.projects,
    log_file: runtimeLogPath(configPath),
  };
}

function waitUntilReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("message", onMessage);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`background runtime exited before connecting (exit ${code ?? "unknown"})`));
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "ready") return;
      cleanup();
      resolve();
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`background runtime did not connect within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

export function runtimeStatePath(configPath: string): string {
  return runtimeArtifactPath(configPath, "state");
}

export function runtimeLogPath(configPath: string): string {
  return runtimeArtifactPath(configPath, "log");
}

function runtimeStartLockPath(configPath: string): string {
  return runtimeArtifactPath(configPath, "start.lock");
}

async function acquireRuntimeStartLock(configPath: string): Promise<void> {
  const lockPath = runtimeStartLockPath(configPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  // Match worst-case `startBackgroundRuntime` hold time: stop prior runtime, wait for
  // ready, and tear down the child if ready fails, plus one poll interval.
  const deadline = Date.now()
    + BACKGROUND_RUNTIME_READY_TIMEOUT_MS
    + 2 * (STOP_GRACE_PERIOD_MS + FORCED_STOP_TIMEOUT_MS)
    + STOP_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const ownerPid = readRuntimeStartLockOwner(lockPath);
        const incompleteLockIsStale = ownerPid === null
          && Date.now() - statSync(lockPath).mtimeMs > 1_000;
        if ((ownerPid !== null && !processIsRunning(ownerPid)) || incompleteLockIsStale) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Another process may have released the lock; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
    }
  }
  throw new Error("timed out waiting for the background runtime start lock");
}

function releaseRuntimeStartLock(configPath: string): void {
  const lockPath = runtimeStartLockPath(configPath);
  if (readRuntimeStartLockOwner(lockPath) !== process.pid) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readRuntimeStartLockOwner(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readRuntimeState(configPath: string): LocatedRuntimeProcessState | null {
  const statePath = runtimeStatePath(configPath);
  const current = readRuntimeStateFile(statePath);
  if (current) {
    return migrateLegacyRuntimeState(configPath, statePath, current) ?? { path: statePath, state: current };
  }
  const legacyPath = legacyRuntimeStatePath(configPath);
  if (legacyPath === statePath) return null;
  const legacy = readRuntimeStateFile(legacyPath);
  if (!legacy || !processCommandMatchesConfig(legacy.pid, configPath)) return null;
  return migrateLegacyRuntimeState(configPath, legacyPath, legacy);
}

function readRuntimeStateFile(path: string): RuntimeProcessState | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeProcessState>;
    const pid = value.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0
      || !Array.isArray(value.projects)) return null;
    return {
      pid,
      projects: value.projects.filter((project): project is string => typeof project === "string"),
      process_start_identity: value.process_start_identity,
    };
  } catch {
    return null;
  }
}

function migrateLegacyRuntimeState(
  configPath: string,
  sourcePath: string,
  state: RuntimeProcessState,
): LocatedRuntimeProcessState | null {
  const destinationPath = runtimeStatePath(configPath);
  if (typeof state.process_start_identity === "string") {
    if (sourcePath !== destinationPath) {
      writeRuntimeStateWithIdentity(
        configPath,
        state.pid,
        state.projects,
        state.process_start_identity,
      );
      removeRuntimeStateFile(sourcePath);
    }
    return { path: destinationPath, state };
  }
  if (!processCommandMatchesConfig(state.pid, configPath)) return null;
  const processStartIdentity = readProcessStartIdentity(state.pid);
  if (!processStartIdentity) return null;
  writeRuntimeStateWithIdentity(configPath, state.pid, state.projects, processStartIdentity);
  if (sourcePath !== destinationPath) removeRuntimeStateFile(sourcePath);
  return {
    path: destinationPath,
    state: { ...state, process_start_identity: processStartIdentity },
  };
}

function legacyRuntimeStatePath(configPath: string): string {
  return runtimeArtifactPath(`${dirname(canonicalConfigPath(configPath))}/daemon.yaml`, "state");
}

function runtimeProcessMatches(state: RuntimeProcessState): boolean {
  return typeof state.process_start_identity === "string"
    && processIsRunning(state.pid)
    && readProcessStartIdentity(state.pid) === state.process_start_identity;
}

function readProcessStartIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? null;
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim() || null;
    }
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf8" }).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

function processCommandMatchesConfig(pid: number, configPath: string): boolean {
  const expectedConfigPath = canonicalConfigPath(configPath);
  try {
    if (process.platform === "linux") {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return commandArgsMatchConfig(args, expectedConfigPath);
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      const command = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      return commandStringMatchesConfig(command, expectedConfigPath);
    }
    if (process.platform === "win32") {
      const command = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ], { encoding: "utf8" }).trim();
      return commandStringMatchesConfig(command, expectedConfigPath);
    }
  } catch {
    return false;
  }
  return false;
}

function commandStringMatchesConfig(command: string, configPath: string): boolean {
  if (!commandStringRunsCloudRuntime(command)) return false;
  const match = command.match(
    /(?:^|\s)--config(?:=|\s+)(.*?)(?=\s+--(?:gateway|code|runtime-name|verbose|foreground|help)(?:=|\s|$)|$)/,
  );
  const configuredPath = match?.[1]?.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  return configuredPath !== undefined && canonicalConfigPath(configuredPath) === configPath;
}

function commandArgsMatchConfig(args: string[], configPath: string): boolean {
  if (!commandArgsRunCloudRuntime(args)) return false;
  const configIndex = args.indexOf("--config");
  const configuredPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  const equalsArgument = args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
  return [configuredPath, equalsArgument].some(
    (value) => value !== undefined && canonicalConfigPath(value) === configPath,
  );
}

function commandStringRunsCloudRuntime(command: string): boolean {
  return /(?:^|\s)_run(?:\s|$)/.test(command)
    || /(?:^|\s)connect(?:\s|$)/.test(command)
    || (/(?:^|\s)login(?:\s|$)/.test(command) && /(?:^|\s)--foreground(?:\s|$)/.test(command));
}

function commandArgsRunCloudRuntime(args: string[]): boolean {
  return args.includes("_run")
    || args.includes("connect")
    || (args.includes("login") && args.includes("--foreground"));
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(
  pid: number,
  expectedIdentity: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processMatchesIdentity(pid, expectedIdentity)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
  return true;
}

async function terminateProcess(pid: number, expectedIdentity: string): Promise<void> {
  if (!signalProcess(pid, expectedIdentity, "SIGTERM")) return;
  if (await waitForProcessExit(pid, expectedIdentity, STOP_GRACE_PERIOD_MS)) return;
  if (!signalProcess(pid, expectedIdentity, "SIGKILL")) return;
  if (!await waitForProcessExit(pid, expectedIdentity, FORCED_STOP_TIMEOUT_MS)) {
    throw new Error(`background runtime PID ${pid} did not stop`);
  }
}

async function terminateKnownChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, STOP_GRACE_PERIOD_MS)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, FORCED_STOP_TIMEOUT_MS)) {
    throw new Error(`background runtime PID ${child.pid ?? "unknown"} did not stop`);
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function signalProcess(pid: number, expectedIdentity: string, signal: NodeJS.Signals): boolean {
  if (!processMatchesIdentity(pid, expectedIdentity)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processMatchesIdentity(pid: number, expectedIdentity: string): boolean {
  return processIsRunning(pid) && readProcessStartIdentity(pid) === expectedIdentity;
}

function removeRuntimeState(configPath: string): void {
  removeRuntimeStateFile(runtimeStatePath(configPath));
}

function removeRuntimeStateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
