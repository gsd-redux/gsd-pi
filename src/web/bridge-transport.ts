import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcExtensionUIResponse } from "@opengsd/contracts";

// ─── Bridge transport seam (ADR-047) ────────────────────────────────────────
//
// BridgeService speaks NDJSON RpcCommand/RpcResponse lines to a per-project
// backend. Locally that backend is a spawned `gsd --mode rpc` child over
// stdio (LocalTransport); in cloud mode it is a relay-proxied WebSocket
// channel to the target machine (CloudTransport, see cloud-transport.ts).
// One send() call = exactly one NDJSON line; one onEvent emission = exactly
// one received NDJSON line (without the trailing newline).

export interface BridgeTransportCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
}

export interface BridgeTransport {
  /** Establish the connection. Rejects when the backend cannot be reached. */
  connect(): Promise<void>;
  /** Send one command as a single NDJSON line. */
  send(command: RpcCommand | RpcExtensionUIResponse): void;
  /** Register a listener for received NDJSON lines (responses and events). */
  onEvent(listener: (line: string) => void): void;
  /** Register a listener fired once when the backend goes away. */
  onClose(listener: (info: BridgeTransportCloseInfo) => void): void;
  /** Terminate the connection. Idempotent; resolves when teardown settles. */
  close(): Promise<void>;
  /** True when commands can be written. */
  readonly connected: boolean;
  /** Captured stderr tail (local child only) for exit diagnostics. */
  getStderrTail?(): string;
}

interface SpawnedRpcChild extends ChildProcess {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
}

const MAX_STDERR_BUFFER = 8_000;

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function captureStderr(buffer: string, chunk: string): string {
  const next = `${buffer}${chunk}`;
  return next.length <= MAX_STDERR_BUFFER ? next : next.slice(next.length - MAX_STDERR_BUFFER);
}

function attachJsonLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function destroyChildStreams(child: Partial<SpawnedRpcChild> | null | undefined): void {
  try {
    child?.stdin?.destroy();
  } catch {
    // Ignore cleanup failures.
  }
  try {
    child?.stdout?.destroy();
  } catch {
    // Ignore cleanup failures.
  }
  try {
    child?.stderr?.destroy();
  } catch {
    // Ignore cleanup failures.
  }
}

export interface LocalTransportOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * stdio transport over a spawned `gsd --mode rpc` child process. This is the
 * extracted pre-convergence behavior of BridgeService — no behavior change.
 */
export class LocalTransport implements BridgeTransport {
  private process: SpawnedRpcChild | null = null;
  private detachStdoutReader: (() => void) | null = null;
  private stderrBuffer = "";
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<(info: BridgeTransportCloseInfo) => void>();
  private closeNotified = false;
  private readonly options: LocalTransportOptions;

  constructor(options: LocalTransportOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return Boolean(this.process?.stdin);
  }

  getStderrTail(): string {
    return this.stderrBuffer;
  }

  async connect(): Promise<void> {
    const spawnFn =
      this.options.spawn ?? ((command: string, args: readonly string[], options: SpawnOptions) => spawn(command, args, options));

    const child = spawnFn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as SpawnedRpcChild;

    this.process = child;
    this.stderrBuffer = "";
    this.closeNotified = false;
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = captureStderr(this.stderrBuffer, chunk.toString());
    });
    this.detachStdoutReader = attachJsonLineReader(child.stdout, (line) => this.emitLine(line));
    child.once("exit", (code, signal) => this.notifyClose({ code, signal }));
    child.once("error", (error) => this.notifyClose({ code: null, signal: null, error }));
  }

  send(command: RpcCommand | RpcExtensionUIResponse): void {
    this.process?.stdin?.write(serializeJsonLine(command));
  }

  onEvent(listener: (line: string) => void): void {
    this.lineListeners.add(listener);
  }

  onClose(listener: (info: BridgeTransportCloseInfo) => void): void {
    this.closeListeners.add(listener);
  }

  async close(): Promise<void> {
    const proc = this.process;
    if (!proc) return;

    // Detach before killing so an explicit close never surfaces as an
    // unexpected exit to onClose listeners.
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    proc.removeAllListeners();
    this.process = null;
    proc.kill("SIGTERM");
    destroyChildStreams(proc);

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, 2_000);
      proc.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }

  private emitLine(line: string): void {
    for (const listener of this.lineListeners) {
      try {
        listener(line);
      } catch {
        // Listener failures should not break delivery.
      }
    }
  }

  private notifyClose(info: BridgeTransportCloseInfo): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    this.process = null;
    for (const listener of this.closeListeners) {
      try {
        listener(info);
      } catch {
        // Listener failures should not break delivery.
      }
    }
  }
}
