// Project/App: Open GSD
// File Purpose: Detached cloud runtime process lifecycle and status persistence.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
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

interface RuntimeStartLockOwner {
  pid: number;
  process_start_identity?: string;
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
const MALFORMED_START_LOCK_GRACE_MS = 5_000;

export const BACKGROUND_RUNTIME_READY_TIMEOUT_MS =
  CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS + PROCESS_STARTUP_GRACE_MS;
const START_LOCK_TIMEOUT_MS = BACKGROUND_RUNTIME_READY_TIMEOUT_MS
  + 2 * (STOP_GRACE_PERIOD_MS + FORCED_STOP_TIMEOUT_MS)
  + STOP_POLL_INTERVAL_MS;

export async function startBackgroundRuntime(opts: StartRuntimeOptions): Promise<RuntimeProcessStatus> {
  const releaseStartLock = await acquireRuntimeStartLock(opts.configPath);
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
    releaseStartLock();
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

export async function acquireRuntimeStartLock(
  configPath: string,
  onRecoveryClaimed?: () => void,
): Promise<() => void> {
  const lockPath = runtimeStartLockPath(configPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const processStartIdentity = readProcessStartIdentity(process.pid);
  if (!processStartIdentity) {
    throw new Error(`could not determine process identity for PID ${process.pid}`);
  }
  const owner: RuntimeStartLockOwner = {
    pid: process.pid,
    process_start_identity: processStartIdentity,
  };
  // Match worst-case `startBackgroundRuntime` hold time: stop prior runtime, wait for
  // ready, and tear down the child if ready fails, plus one poll interval.
  const deadline = Date.now() + START_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      createRuntimeStartLock(lockPath, owner);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseRuntimeStartLock(lockPath, owner);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (recoverRuntimeStartLock(lockPath, configPath, onRecoveryClaimed)) {
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

function createRuntimeStartLock(lockPath: string, owner: RuntimeStartLockOwner): void {
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writePrivateJson(temporaryPath, owner);
    linkSync(temporaryPath, lockPath);
  } finally {
    removeRuntimeStateFile(temporaryPath);
  }
}

function releaseRuntimeStartLock(lockPath: string, owner: RuntimeStartLockOwner): void {
  if (!runtimeStartLockOwnersEqual(readRuntimeStartLockOwner(lockPath), owner)) return;
  removeRuntimeStateFile(lockPath);
}

function readRuntimeStartLockOwner(lockPath: string): RuntimeStartLockOwner | null {
  try {
    const text = readFileSync(lockPath, "utf8").trim();
    if (/^\d+$/.test(text)) {
      const pid = Number.parseInt(text, 10);
      return pid > 0 ? { pid } : null;
    }
    const value = JSON.parse(text) as Partial<RuntimeStartLockOwner>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0) return null;
    if (typeof value.process_start_identity !== "string") return null;
    return { pid: value.pid!, process_start_identity: value.process_start_identity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function runtimeStartLockOwnerIsRunning(owner: RuntimeStartLockOwner): boolean {
  if (!owner.process_start_identity) return processIsRunning(owner.pid);
  return processMatchesIdentity(owner.pid, owner.process_start_identity);
}

function runtimeStartLockCanBeRecovered(lockPath: string, configPath: string): boolean {
  const owner = readRuntimeStartLockOwner(lockPath);
  if (owner?.process_start_identity) return !runtimeStartLockOwnerIsRunning(owner);
  const age = Date.now() - statSync(lockPath).mtimeMs;
  if (owner) {
    if (!runtimeStartLockOwnerIsRunning(owner)) return true;
    return age > START_LOCK_TIMEOUT_MS
      && inspectProcessCommandConfig(owner.pid, configPath) === false;
  }
  return age > MALFORMED_START_LOCK_GRACE_MS;
}

function recoverRuntimeStartLock(
  lockPath: string,
  configPath: string,
  onRecoveryClaimed?: () => void,
): boolean {
  const recoveryPath = `${lockPath}.recovery.${process.pid}.${randomUUID()}`;
  try {
    linkSync(lockPath, recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    if (!runtimeStartLockCanBeRecovered(recoveryPath, configPath)) return false;
    onRecoveryClaimed?.();
    if (!pathsReferenceSameFile(lockPath, recoveryPath)) return false;
    unlinkSync(lockPath);
    return true;
  } finally {
    removeRuntimeStateFile(recoveryPath);
  }
}

function pathsReferenceSameFile(firstPath: string, secondPath: string): boolean {
  try {
    const first = statSync(firstPath, { bigint: true });
    const second = statSync(secondPath, { bigint: true });
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

function runtimeStartLockOwnersEqual(
  first: RuntimeStartLockOwner | null,
  second: RuntimeStartLockOwner,
): boolean {
  return first?.pid === second.pid
    && first.process_start_identity === second.process_start_identity;
}

function readRuntimeState(configPath: string): LocatedRuntimeProcessState | null {
  const statePath = runtimeStatePath(configPath);
  const current = readRuntimeStateFile(statePath);
  if (current) {
    if (typeof current.process_start_identity === "string"
      && statePath !== legacyRuntimeStatePath(configPath)) {
      return { path: statePath, state: current };
    }
    return migrateLegacyRuntimeState(configPath, statePath, current);
  }
  const legacyPath = legacyRuntimeStatePath(configPath);
  if (legacyPath === statePath) return null;
  const legacy = readRuntimeStateFile(legacyPath);
  if (!legacy) return null;
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
  if (sourcePath === legacyRuntimeStatePath(configPath)
    && !processCommandMatchesConfig(state.pid, configPath)) return null;
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
  return inspectProcessCommandConfig(pid, configPath) === true;
}

function inspectProcessCommandConfig(pid: number, configPath: string): boolean | null {
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
      return commandLineMatchesRuntimeConfig(command, expectedConfigPath, process.platform);
    }
    if (process.platform === "win32") {
      const command = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ], { encoding: "utf8" }).trim();
      return commandLineMatchesRuntimeConfig(command, expectedConfigPath, process.platform);
    }
  } catch {
    return null;
  }
  return null;
}

export function commandLineMatchesRuntimeConfig(
  command: string,
  configPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") {
    return commandArgsMatchConfig(splitWindowsCommandLine(command), canonicalConfigPath(configPath));
  }
  return commandStringMatchesConfig(command, canonicalConfigPath(configPath));
}

function splitWindowsCommandLine(command: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? "")) index += 1;
    if (index >= command.length) break;
    let argument = "";
    let inQuotes = false;
    while (index < command.length) {
      if (!inQuotes && /\s/.test(command[index] ?? "")) break;
      let backslashes = 0;
      while (command[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (command[index] === '"') {
        argument += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 0) {
          inQuotes = !inQuotes;
        } else {
          argument += '"';
        }
        index += 1;
        continue;
      }
      argument += "\\".repeat(backslashes);
      if (index < command.length) {
        argument += command[index];
        index += 1;
      }
    }
    args.push(argument);
  }
  return args;
}

function commandStringMatchesConfig(command: string, configPath: string): boolean {
  const runtimeCommand = findRuntimeCommand(command);
  if (!runtimeCommand) return false;
  const executablePrefix = command.slice(0, runtimeCommand.index);
  if (!commandPrefixHasCloudRuntimeLauncher(executablePrefix)) return false;
  if (runtimeCommand.command === "login"
    && !/(?:^|\s)--foreground(?:\s|$)/.test(command.slice(runtimeCommand.index))) return false;
  const match = command.slice(runtimeCommand.index).match(
    /(?:^|\s)(?:--config|-c)(?:=|\s+)(.*?)(?=\s+-{1,2}[A-Za-z](?:[\w-]*)(?:=|\s|$)|$)/,
  );
  const configuredPath = match?.[1]?.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  return configuredPath !== undefined && canonicalConfigPath(configuredPath) === configPath;
}

function commandArgsMatchConfig(args: string[], configPath: string): boolean {
  const runtimeCommand = findRuntimeCommandInArgs(args);
  if (!runtimeCommand) return false;
  if (!argsHaveCloudRuntimeLauncher(args.slice(0, runtimeCommand.index))) return false;
  const runtimeArgs = args.slice(runtimeCommand.index + 1);
  if (runtimeCommand.command === "login" && !runtimeArgs.includes("--foreground")) return false;
  const configIndex = runtimeArgs.findIndex((arg) => arg === "--config" || arg === "-c");
  const configuredPath = configIndex >= 0 ? runtimeArgs[configIndex + 1] : undefined;
  const equalsArgument = runtimeArgs.find((arg) => arg.startsWith("--config=") || arg.startsWith("-c="))
    ?.replace(/^(?:--config|-c)=/, "");
  return [configuredPath, equalsArgument].some(
    (value) => value !== undefined && canonicalConfigPath(value) === configPath,
  );
}

function argsHaveCloudRuntimeLauncher(args: string[]): boolean {
  if (args.length === 1) return isCloudRuntimeExecutable(args[0]!);
  return args.length === 2
    && isNodeExecutable(args[0]!)
    && isCloudRuntimeExecutable(args[1]!);
}

function commandPrefixHasCloudRuntimeLauncher(prefix: string): boolean {
  const args = splitFlattenedCommandPrefix(prefix);
  return args !== null && argsHaveCloudRuntimeLauncher(args);
}

function splitFlattenedCommandPrefix(prefix: string): string[] | null {
  const args: string[] = [];
  const token = /\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gy;
  while (token.lastIndex < prefix.length) {
    const match = token.exec(prefix);
    if (!match) return null;
    args.push(match[1] ?? match[2] ?? match[3]!);
  }
  return args;
}

function findRuntimeCommand(command: string): { command: string; index: number } | null {
  const match = /(?:^|\s)(_run|connect|login)(?=\s|$)/.exec(command);
  return match ? { command: match[1]!, index: match.index } : null;
}

function findRuntimeCommandInArgs(args: string[]): { command: string; index: number } | null {
  const index = args.findIndex((arg) => arg === "_run" || arg === "connect" || arg === "login");
  return index < 0 ? null : { command: args[index]!, index };
}

function isCloudRuntimeExecutable(argument: string): boolean {
  return /(?:^|[\\/])gsd-cloud(?:\.[cm]?js)?$/.test(argument);
}

function isNodeExecutable(argument: string): boolean {
  return /(?:^|[\\/])node(?:\.exe)?$/i.test(argument);
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
