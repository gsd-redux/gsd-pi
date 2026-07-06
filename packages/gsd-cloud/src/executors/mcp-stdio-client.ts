// Project/App: Open GSD
// File Purpose: Minimal MCP JSON-RPC 2.0 client over a child process's stdio.
//
// Zero external deps — just enough of the Model Context Protocol to `initialize`
// a server and issue `tools/call` requests. Used by the gsd-pi shell-out adapter
// to drive `gsd --mode mcp` without linking any GSD package.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Logger } from "../logger.js";

const PROTOCOL_VERSION = "2024-11-05";
const INIT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 30 * 60_000; // GSD tool calls (e.g. gsd_execute) can be long-running.

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Long-lived MCP client bound to a single spawned server process.
 * Lazily starts and initializes the server on first use; subsequent calls reuse
 * the same connection.
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private rl: Interface | undefined;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private initPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    private readonly options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ) {}

  /** Ensure the server is spawned and `initialize` has completed. Idempotent. */
  async ensureReady(): Promise<void> {
    await this.awaitReadyProcess();
  }

  private awaitReadyProcess(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("MCP client closed"));
    }
    if (!this.initPromise) {
      this.initPromise = this.startAndInitialize().catch((err) => {
        this.resetConnection();
        throw err;
      });
    }
    return this.initPromise.then(
      async () => {
        if (this.closed) throw new Error("MCP client closed");
        if (this.isProcessAlive()) return;
        this.resetConnection();
        throw new Error("gsd MCP process is not running after initialize");
      },
      (err) => {
        if (this.closed) throw new Error("MCP client closed");
        throw err;
      },
    );
  }

  /** Invoke an MCP tool and return its raw result object. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureReady();
    return this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
  }

  close(): void {
    this.closed = true;
    this.resetConnection(new Error("MCP client closed"));
  }

  private async startAndInitialize(): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("error", (err) => {
      this.logger.error("gsd MCP process error", { error: err.message });
      this.resetConnection(new Error(`gsd MCP process error: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.logger.warn("gsd MCP process exited", { code, signal });
      this.resetConnection(
        new Error(`gsd MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });

    // MCP servers commonly log human-readable startup noise on stderr; forward at debug.
    child.stderr.on("data", (chunk: Buffer) => {
      this.logger.debug("gsd MCP stderr", { text: chunk.toString("utf8").trimEnd() });
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "@opengsd/gsd-cloud", version: "1.7.1" },
      },
      INIT_TIMEOUT_MS,
    );
    // Per MCP spec, the client sends an `initialized` notification (no id, no response).
    this.notify("notifications/initialized");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error("gsd MCP process is not running"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gsd MCP request '${method}' timed out after ${timeoutMs}ms`));
        this.resetConnection();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to write MCP request: ${err.message}`));
          this.resetConnection();
        }
      });
    });
  }

  private notify(method: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      // Non-JSON line (stray log). Ignore.
      return;
    }
    if (message.id === undefined || message.id === null) return; // notification/request from server — ignored.
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP error ${message.error.code}`));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private isProcessAlive(): boolean {
    const child = this.child;
    return child !== undefined && child.exitCode === null && child.signalCode === null;
  }

  private resetConnection(reason = new Error("MCP connection reset")): void {
    this.failAll(reason);
    this.rl?.close();
    this.rl = undefined;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
    this.child = undefined;
    this.initPromise = undefined;
  }
}
