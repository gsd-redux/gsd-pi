/**
 * Supervised `gsd headless` runs.
 *
 * One child per project. stdout is a JSONL event stream; interactive
 * `extension_ui_request`s (select/confirm/input/editor) park the run as
 * `blocked` until `/gsd reply` writes an `extension_ui_response` to stdin.
 * stdin stays open for the whole run: closing it makes gsd fall back to
 * auto-answering (src/headless.ts `onStdinClose`).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Route } from "./binding.js";
import { spawnErrorMessage } from "./gsd-cli.js";
import { errorMessage, redactSecrets, tail } from "./redact.js";
import type { PluginLogger } from "./types.js";

export type RunStatus = "starting" | "running" | "blocked" | "cancelling" | "complete" | "failed" | "cancelled";

export interface Blocker {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  allowMultiple?: boolean;
  placeholder?: string;
  prefill?: string;
  secure?: boolean;
}

export interface GsdRun {
  runId: string;
  projectDir: string;
  command: "auto" | "new-milestone" | "quick";
  status: RunStatus;
  startedAt: number;
  pid?: number;
  blocker?: Blocker;
  exitCode?: number | null;
  resultStatus?: string;
  route: Route;
  sessionKey?: string;
  summary?: string;
}

export type SupervisorEvent =
  | { type: "blocked"; run: GsdRun; blocker: Blocker }
  | { type: "notice"; run: GsdRun; text: string }
  | { type: "finished"; run: GsdRun; summary: string };

export interface ChildLike {
  pid?: number;
  stdin: {
    writable: boolean;
    destroyed: boolean;
    write(chunk: string, cb?: (err?: Error | null) => void): boolean;
    on(event: "error", cb: (err: Error) => void): unknown;
  };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "exit" | "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (file: string, args: string[], opts: { cwd: string }) => ChildLike;

const defaultSpawn: SpawnFn = (file, args, opts) =>
  spawn(file, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/** Exit codes from src/headless.ts. */
const EXIT_SUCCESS = 0;
const EXIT_BLOCKED = 10;
const EXIT_CANCELLED = 11;
const RESPONSE_TIMEOUT_MS = 86_400_000;
const STDERR_TAIL_BYTES = 8 * 1024;
const LOCK_FILE = join(".gsd", "runtime", "openclaw-run.json");
const INTERACTIVE_METHODS = new Set<Blocker["method"]>(["select", "confirm", "input", "editor"]);
export const SECRET_PROMPT_NOTICE = "GSD asked for a secret value; run this step in an interactive gsd session.";

interface LockFile {
  pid: number;
  runId: string;
  startedAt: number;
  command: string;
}

interface Active {
  run: GsdRun;
  child: ChildLike;
  stderrTail: string;
  lastNotice?: string;
  stdinError?: string;
  exitSignal?: NodeJS.Signals | null;
  done: boolean;
}

function readLock(projectDir: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, LOCK_FILE), "utf8")) as Partial<LockFile>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid, runId: String(parsed.runId ?? `gsd-${parsed.pid}`), startedAt: Number(parsed.startedAt ?? 0), command: String(parsed.command ?? "") };
    }
  } catch {
    // missing or malformed: caller treats as absent
  }
  return undefined;
}

function removeLock(projectDir: string): void {
  try {
    unlinkSync(join(projectDir, LOCK_FILE));
  } catch {
    // already gone
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but owned by someone else; still counts as running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock written before the current boot names a pid that cannot be ours any
 * more (pids restart at boot), so it is stale whatever `pidAlive` says.
 * ponytail: pid reuse without a reboot is not detected; there is no other
 * restart recovery.
 */
function lockIsCurrent(lock: LockFile): boolean {
  return lock.startedAt > Date.now() - uptime() * 1000;
}

export class Supervisor {
  private readonly active = new Map<string, Active>();
  private readonly finished = new Map<string, GsdRun>();
  private readonly cliPath: string;
  private readonly onEvent: (e: SupervisorEvent) => void;
  private readonly logger: PluginLogger;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;

  constructor(opts: { cliPath: string; onEvent: (e: SupervisorEvent) => void; logger: PluginLogger; spawn?: SpawnFn; now?: () => number }) {
    this.cliPath = opts.cliPath;
    this.onEvent = opts.onEvent;
    this.logger = opts.logger;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.now = opts.now ?? Date.now;
  }

  start(input: { projectDir: string; command: GsdRun["command"]; commandArgs: string[]; extraFlags: string[]; route: Route; sessionKey?: string }): { ok: true; run: GsdRun } | { ok: false; error: string } {
    const { projectDir } = input;
    const current = this.active.get(projectDir);
    if (current) return { ok: false, error: `Run ${current.run.runId} (pid ${current.run.pid ?? "?"}) is already active for ${projectDir}; /gsd cancel first` };
    // ponytail: the lockfile is the only restart recovery. A run orphaned by a
    // Gateway restart keeps running unsupervised; it can only be cancelled.
    const lock = readLock(projectDir);
    if (lock && lockIsCurrent(lock) && pidAlive(lock.pid)) {
      return { ok: false, error: `Run ${lock.runId} (pid ${lock.pid}) is already active for ${projectDir}; /gsd cancel first` };
    }
    removeLock(projectDir); // stale, pre-boot, or malformed

    const args = [
      "headless",
      input.command,
      ...input.commandArgs,
      "--supervised",
      "--output-format",
      "stream-json",
      "--max-restarts",
      "0",
      "--timeout",
      "0",
      "--response-timeout",
      String(RESPONSE_TIMEOUT_MS),
      ...input.extraFlags,
    ];
    let child: ChildLike;
    try {
      child = this.spawnFn(this.cliPath, args, { cwd: projectDir });
    } catch (error) {
      return { ok: false, error: spawnErrorMessage(error, this.cliPath) ?? errorMessage(error) };
    }
    const run: GsdRun = {
      runId: child.pid ? `gsd-${child.pid}` : "gsd-pending",
      projectDir,
      command: input.command,
      status: child.pid ? "running" : "starting",
      startedAt: this.now(),
      pid: child.pid,
      route: input.route,
      sessionKey: input.sessionKey,
    };
    const active: Active = { run, child, stderrTail: "", done: false };
    this.active.set(projectDir, active);
    this.attach(active);
    if (child.pid) this.writeLock(active);
    return { ok: true, run };
  }

  get(projectDir: string): GsdRun | undefined {
    return this.active.get(projectDir)?.run;
  }

  lastFinished(projectDir: string): GsdRun | undefined {
    return this.finished.get(projectDir);
  }

  list(): GsdRun[] {
    return [...this.active.values()].map((a) => a.run);
  }

  reply(projectDir: string, text: string): { ok: true; text: string } | { ok: false; error: string } {
    const active = this.active.get(projectDir);
    if (!active) return { ok: false, error: `No active run for ${projectDir}` };
    const blocker = active.run.blocker;
    if (!blocker) return { ok: false, error: `No pending question for ${projectDir}` };
    const trimmed = text.trim();
    let payload: Record<string, unknown>;
    let echo: string;
    if (trimmed.toLowerCase() === "cancel") {
      payload = { cancelled: true };
      echo = `Cancelled "${blocker.title}"`;
    } else if (blocker.method === "select") {
      const options = blocker.options ?? [];
      const index = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      const choice = index >= 1 && index <= options.length ? options[index - 1] : options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
      if (choice === undefined) {
        return { ok: false, error: `Reply with a number (1-${options.length}) or an option name:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` };
      }
      payload = { value: choice };
      echo = `Chose "${choice}" for "${blocker.title}"`;
    } else if (blocker.method === "confirm") {
      const lower = trimmed.toLowerCase();
      if (["yes", "y", "true"].includes(lower)) payload = { confirmed: true };
      else if (["no", "n", "false"].includes(lower)) payload = { confirmed: false };
      else return { ok: false, error: `Reply yes or no to "${blocker.title}"` };
      echo = `Answered ${payload.confirmed ? "yes" : "no"} to "${blocker.title}"`;
    } else {
      payload = { value: text };
      echo = `Sent your text for "${blocker.title}"`;
    }
    if (!this.writeStdin(active, { type: "extension_ui_response", id: blocker.id, ...payload })) {
      return { ok: false, error: `Run ${active.run.runId} is no longer accepting input` };
    }
    active.run.blocker = undefined;
    active.run.status = "running";
    return { ok: true, text: echo };
  }

  cancel(projectDir: string): { ok: true; runId: string } | { ok: false; error: string } {
    const active = this.active.get(projectDir);
    if (active) {
      active.run.status = "cancelling";
      try {
        active.child.kill("SIGTERM");
      } catch (error) {
        return { ok: false, error: `Could not stop run ${active.run.runId}: ${errorMessage(error)}` };
      }
      return { ok: true, runId: active.run.runId };
    }
    const lock = readLock(projectDir);
    if (lock && lockIsCurrent(lock) && pidAlive(lock.pid)) {
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch (error) {
        return { ok: false, error: `Could not signal orphaned run ${lock.runId} (pid ${lock.pid}): ${errorMessage(error)}` };
      }
      this.logger.info(`sent SIGTERM to orphaned run ${lock.runId} (pid ${lock.pid}) for ${projectDir}`);
      return { ok: true, runId: lock.runId };
    }
    if (lock) removeLock(projectDir);
    return { ok: false, error: `No active run for ${projectDir}` };
  }

  stopAll(): void {
    for (const active of this.active.values()) {
      active.run.status = "cancelling";
      try {
        active.child.kill("SIGTERM");
      } catch (error) {
        this.logger.warn(`could not stop run ${active.run.runId}: ${errorMessage(error)}`);
      }
    }
  }

  private writeLock(active: Active): void {
    const { run } = active;
    // A legacy `.planning/` project has no `.gsd/`; creating it here would make
    // `gsd headless new-milestone` skip its own bootstrap, so the lock is skipped.
    if (!existsSync(join(run.projectDir, ".gsd"))) return;
    try {
      mkdirSync(join(run.projectDir, ".gsd", "runtime"), { recursive: true });
      const lock: LockFile = { pid: run.pid!, runId: run.runId, startedAt: run.startedAt, command: run.command };
      writeFileSync(join(run.projectDir, LOCK_FILE), JSON.stringify(lock));
    } catch (error) {
      this.logger.warn(`could not write ${LOCK_FILE} for ${run.projectDir}: ${errorMessage(error)}`);
    }
  }

  private attach(active: Active): void {
    const { child, run } = active;
    child.stdin.on("error", (error) => this.stdinFailed(active, error));
    child.on("error", (error) => {
      // Only a failed spawn (no pid) is terminal; a failed kill() on a live
      // child also lands here and `close` still finalizes.
      if (run.pid) {
        this.logger.warn(`run ${run.runId}: child error: ${errorMessage(error)}`);
        return;
      }
      run.status = "failed";
      run.summary = spawnErrorMessage(error, this.cliPath) ?? `gsd exited with an error: ${errorMessage(error)}`;
      this.finalize(active);
    });
    child.on("exit", (code, signal) => {
      if (run.exitCode === undefined || run.exitCode === null) run.exitCode = code;
      active.exitSignal = signal;
    });
    child.on("close", () => this.finalize(active));
    // Pipe read errors are not terminal on their own (`close` still follows);
    // without listeners they are uncaught and take the Gateway down.
    child.stderr.on("error", (error) => this.logger.warn(`run ${run.runId}: stderr stream error: ${errorMessage(error)}`));
    child.stderr.on("data", (chunk: Buffer | string) => {
      active.stderrTail = tail(active.stderrTail + String(chunk), STDERR_TAIL_BYTES);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // readline re-emits its input's errors on the Interface, so the listener goes here.
    lines.on("error", (error) => this.logger.warn(`run ${run.runId}: stdout stream error: ${errorMessage(error)}`));
    lines.on("line", (line) => {
      try {
        this.onLine(active, line);
      } catch (error) {
        this.logger.warn(`run ${run.runId}: unhandled stdout line: ${errorMessage(error)}`);
      }
    });
  }

  private onLine(active: Active, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const { run } = active;
    switch (msg.type) {
      case "extension_ui_request":
        this.onRequest(active, msg);
        return;
      case "supervised_timeout": {
        if (run.blocker && run.blocker.id === String(msg.id ?? "")) {
          run.blocker = undefined;
          run.status = "running";
        }
        this.emit({ type: "notice", run, text: `GSD answered ${String(msg.method ?? "the question")} itself after the response timeout.` });
        return;
      }
      case "headless_result":
        if (typeof msg.exitCode === "number") run.exitCode = msg.exitCode;
        if (typeof msg.status === "string") run.resultStatus = msg.status;
        return;
      default:
        return;
    }
  }

  private onRequest(active: Active, msg: Record<string, unknown>): void {
    const { run } = active;
    const method = String(msg.method ?? "");
    if (method === "notify") {
      const text = String(msg.message ?? "").trim();
      if (!text || text === active.lastNotice) return;
      active.lastNotice = text;
      this.emit({ type: "notice", run, text });
      return;
    }
    if (!INTERACTIVE_METHODS.has(method as Blocker["method"])) return; // setStatus & co. are answered by gsd itself
    const id = String(msg.id ?? "");
    if (msg.secure === true) {
      // Secret prompts never reach chat; cancelling makes gsd surface the gap itself.
      this.writeStdin(active, { type: "extension_ui_response", id, cancelled: true });
      this.emit({ type: "notice", run, text: SECRET_PROMPT_NOTICE });
      return;
    }
    const blocker: Blocker = {
      id,
      method: method as Blocker["method"],
      title: String(msg.title ?? method),
      ...(typeof msg.message === "string" ? { message: msg.message } : {}),
      ...(Array.isArray(msg.options) ? { options: msg.options.map(String) } : {}),
      ...(msg.allowMultiple === true ? { allowMultiple: true } : {}),
      ...(typeof msg.placeholder === "string" ? { placeholder: msg.placeholder } : {}),
      ...(typeof msg.prefill === "string" ? { prefill: msg.prefill } : {}),
    };
    run.blocker = blocker;
    run.status = "blocked";
    this.emit({ type: "blocked", run, blocker });
  }

  private writeStdin(active: Active, payload: Record<string, unknown>): boolean {
    const { stdin } = active.child;
    if (!stdin.writable || stdin.destroyed) return false;
    try {
      stdin.write(JSON.stringify(payload) + "\n", (error) => {
        if (error) this.stdinFailed(active, error);
      });
      return true;
    } catch (error) {
      this.stdinFailed(active, error);
      return false;
    }
  }

  private stdinFailed(active: Active, error: unknown): void {
    active.stdinError = errorMessage(error);
    this.logger.error(`run ${active.run.runId}: stdin write failed: ${active.stdinError}`);
    if (!active.done) active.run.status = "failed";
  }

  private finalize(active: Active): void {
    if (active.done) return;
    active.done = true;
    const { run } = active;
    const wasCancelling = run.status === "cancelling";
    const wasSpawnError = run.status === "failed" && run.summary !== undefined;
    let note = "";
    if (wasSpawnError) {
      // summary already set by the spawn error handler
    } else if (wasCancelling || run.exitCode === EXIT_CANCELLED || (run.exitCode === null && active.exitSignal === "SIGTERM")) {
      run.status = "cancelled";
    } else if (run.exitCode === EXIT_SUCCESS) {
      run.status = "complete";
    } else if (run.exitCode === EXIT_BLOCKED) {
      run.status = "complete";
      note = run.resultStatus && run.resultStatus !== "blocked" ? `, blocked: ${run.resultStatus}` : ", blocked";
    } else {
      run.status = "failed";
    }
    if (!wasSpawnError) {
      const exit = run.exitCode === null || run.exitCode === undefined ? `signal ${active.exitSignal ?? "unknown"}` : `exit ${run.exitCode}`;
      let summary = `GSD ${run.command} in \`${run.projectDir}\` (run ${run.runId}) ${run.status} (${exit}${note}).`;
      if (run.status === "failed") {
        const detail = redactSecrets(active.stderrTail).trim();
        if (detail) summary += ` stderr: ${detail}`;
      }
      if (active.stdinError) summary += ` stdin: ${active.stdinError}`;
      run.summary = summary;
    }
    run.blocker = undefined;
    removeLock(run.projectDir);
    this.active.delete(run.projectDir);
    this.finished.set(run.projectDir, run);
    this.emit({ type: "finished", run, summary: run.summary ?? "" });
  }

  private emit(event: SupervisorEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger.warn(`run ${event.run.runId}: ${event.type} handler failed: ${errorMessage(error)}`);
    }
  }
}

/** One-line run summary for `/gsd status` and the `gsd_status` tool. */
export function describeRun(run: GsdRun | undefined): string {
  if (!run) return "Run: none";
  if (run.blocker) return `Waiting for input: ${run.blocker.title} — reply with /gsd reply <n or text>`;
  if (run.summary) return `Run: ${run.summary}`;
  const since = new Date(run.startedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `Run: ${run.runId} ${run.status} since ${since} (${run.command})`;
}

/** Chat text for a supervisor event. */
export function formatEvent(event: SupervisorEvent): string {
  if (event.type === "finished") return event.summary;
  if (event.type === "notice") return event.text;
  const { blocker, run } = event;
  const lines = [`**GSD needs input** (run ${run.runId})`, blocker.title];
  if (blocker.message) lines.push(blocker.message);
  if (blocker.method === "select") {
    lines.push(...(blocker.options ?? []).map((o, i) => `${i + 1}. ${o}`));
    if (blocker.allowMultiple) lines.push("[Only one option can be chosen from chat.]");
    lines.push("Reply with `/gsd reply <number or text>`");
  } else if (blocker.method === "confirm") {
    lines.push("Reply with `/gsd reply yes` or `/gsd reply no`");
  } else {
    if (blocker.placeholder) lines.push(`(${blocker.placeholder})`);
    lines.push("Reply with `/gsd reply <text>`");
  }
  lines.push("`/gsd reply cancel` skips the question.");
  return lines.join("\n");
}
