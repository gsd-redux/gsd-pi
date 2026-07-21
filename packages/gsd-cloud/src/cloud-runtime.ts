import WebSocket from "ws";
import type { Logger } from "./logger.js";
import type { DaemonConfig } from "./types.js";
import type { AdvertisedProject, Executor } from "./executors/executor.js";
import { decodeBinaryFrame, encodeBinaryFrame } from "./binary-frame.js";
import { TerminalManager } from "./terminal-manager.js";
import { createGatewayLookup, parseCloudGatewayUrl, validateGatewayNetworkTarget } from "./cloud-config.js";
import { SessionEventProducer } from "./session-events.js";
import {
  noopRuntimeTelemetry,
  type RuntimeTelemetryReporter,
} from "./runtime-telemetry.js";

const INITIAL_CONNECT_ATTEMPTS = 5;
const INITIAL_CONNECT_HANDSHAKE_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

export const CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS =
  INITIAL_CONNECT_ATTEMPTS * INITIAL_CONNECT_HANDSHAKE_TIMEOUT_MS
  + (INITIAL_CONNECT_ATTEMPTS - 1) * RECONNECT_DELAY_MS;

interface GatewayMessage {
  type: string;
  requestId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  projectAlias?: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
}

interface QueuedFrame {
  text: string;
  projectPath?: string;
}

interface InFlightRequest {
  message: GatewayMessage;
  routingKey?: string;
}

/**
 * Normalizes a `ws` binary payload to a single Buffer. Per the `RawData` type,
 * `ws` may deliver a binary message as a Buffer, an ArrayBuffer, or a Buffer[]
 * (fragmented frames); casting straight to Buffer silently drops the latter two
 * shapes, so decode fails and terminal input routing breaks.
 */
function toFrameBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Upper bound for terminal cols/rows; guards against absurd allocations. */
const MAX_TERMINAL_DIMENSION = 1000;

/**
 * Clamps an untrusted terminal dimension (cols/rows arrive over the network) to
 * a sane positive integer. node-pty throws synchronously on non-finite, zero,
 * negative, or non-integer sizes, which would otherwise crash the runtime.
 */
function toTerminalDimension(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  if (int < 1) return fallback;
  return Math.min(int, MAX_TERMINAL_DIMENSION);
}

/** Max UTF-8 byte length of a binary-frame channel name (1-byte length prefix). */
const MAX_CHANNEL_BYTES = 255;

export class CloudRuntime {
  private static readonly MAX_OUTBOX = 200;
  // How many times to retry the initial connect before rejecting start(). A
  // transient handshake failure (gateway briefly unreachable, DNS hiccup) should
  // retry like the daemon's reconnect loop rather than kill the runtime; a
  // persistent failure (gateway down, session rejected) must eventually reject so
  // the CLI reports an error instead of hanging or exiting silently.
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlight = new Map<string, InFlightRequest>();
  private outbox: QueuedFrame[] = [];
  private advertisedProjects: AdvertisedProject[] = [];
  private stopped = false;
  private firstConnectDeferred: PromiseWithResolvers<void> | undefined;
  private initialConnectAttempts = 0;
  // Kept across reconnects so per-session seq counters and replay buffers
  // survive; polling pauses while the socket is down.
  private sessionEvents: SessionEventProducer | undefined;
  // Created per connection so the send closures bind to the live socket.
  private terminalManager: TerminalManager | undefined;

  constructor(
    private readonly cloud: NonNullable<DaemonConfig["cloud"]>,
    private readonly executor: Executor,
    private readonly logger: Logger,
    private readonly telemetry: RuntimeTelemetryReporter = noopRuntimeTelemetry,
  ) {}

  start(): Promise<void> {
    this.stopped = false;
    this.initialConnectAttempts = 0;
    const firstConnect = Promise.withResolvers<void>();
    this.firstConnectDeferred = firstConnect;
    const result = firstConnect.promise.catch(async (error: unknown) => {
      this.telemetry.failed?.();
      await this.telemetry.flush?.();
      throw error;
    });
    try {
      this.executor.initialize?.();
      this.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.telemetry.socketError(message);
      this.rejectFirstConnect(error instanceof Error ? error : new Error(message));
    }
    return result;
  }

  stop(): void {
    this.stopped = true;
    this.telemetry.stopped();
    this.rejectFirstConnect(new Error("cloud runtime stopped"));
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.sessionEvents?.stopPolling();
    this.inFlight.clear();
    this.outbox = [];
    // Kill any active PTY session before closing the socket.
    this.terminalManager?.dispose();
    this.terminalManager = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private connect(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.telemetry.connecting();
    if (!this.cloud.device_token || !this.cloud.runtime_id) {
      const message = "cloud runtime missing device token or runtime id";
      this.logger.warn("cloud runtime skipped — missing device token or runtime id");
      this.telemetry.socketError(message);
      this.rejectFirstConnect(new Error(message));
      return;
    }
    const gatewayUrl = parseCloudGatewayUrl(this.cloud.gateway_url);
    try {
      validateGatewayNetworkTarget(gatewayUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("cloud runtime skipped unsafe gateway URL", { error: message });
      this.telemetry.socketError(message);
      this.rejectFirstConnect(new Error(`cloud runtime unsafe gateway URL: ${message}`));
      return;
    }
    const url = new URL("/runtime/connect", gatewayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.cloud.device_token}` },
      lookup: createGatewayLookup(gatewayUrl),
      handshakeTimeout: INITIAL_CONNECT_HANDSHAKE_TIMEOUT_MS,
    });
    const previousSocket = this.socket;
    this.socket = socket;
    if (previousSocket) {
      // Detach the old socket's handlers before closing so its listeners don't
      // linger on a socket we've already replaced (handlers also guard on
      // identity, but this releases them eagerly for GC).
      previousSocket.removeAllListeners();
      if (previousSocket.readyState !== WebSocket.CLOSING && previousSocket.readyState !== WebSocket.CLOSED) {
        previousSocket.close();
      }
    }

    // Per-connection terminal subsystem; its send closures bind to this socket.
    this.terminalManager?.dispose();
    this.terminalManager = new TerminalManager(
      (frame: Buffer) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame, { binary: true });
        }
      },
      (message: object) => this.send(message),
    );

    socket.on("open", () => {
      this.handleSocketOpen(socket);
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleBinaryInput(socket, toFrameBuffer(data));
      } else {
        void this.handleSocketMessage(socket, data.toString("utf8"));
      }
    });
    socket.on("close", () => {
      this.handleSocketClose(socket);
    });
    socket.on("error", (err) => {
      this.handleSocketError(socket, err);
    });
  }

  private handleSocketOpen(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.telemetry.connected();
    this.resolveFirstConnect();
    this.logger.info("cloud runtime connected", { gateway_url: this.cloud.gateway_url, runtime_id: this.cloud.runtime_id });
    // Re-advertise projects (async: the hello is sent on a later microtask), then
    // drain any messages buffered while disconnected. tool_results route by
    // requestId on the authenticated connection, so drain order vs the hello is
    // not significant.
    void this.advertiseProjects();
    const pending = this.outbox;
    this.outbox = [];
    for (const frame of pending) {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(frame.text);
        this.telemetry.sent(frame.text, frame.projectPath);
      }
      else this.outbox.push(frame);
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat", at: Date.now() }), 30_000);
  }

  private async handleSocketMessage(socket: WebSocket, text: string): Promise<void> {
    if (socket !== this.socket) return;
    this.telemetry.received(text);
    await this.handleMessage(text);
  }

  private handleSocketClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket = undefined;
    // Pause the producer while disconnected; its seq counters and replay
    // buffers persist so the stream resumes on the next hello.
    this.sessionEvents?.stopPolling();
    if (this.stopped) return;
    this.telemetry.disconnected();
    if (this.firstConnectDeferred) {
      // Still trying to establish the first connection: retry transient
      // handshake failures (like the daemon's reconnect loop) and only reject
      // start() once the bounded attempts are exhausted, so a brief blip does
      // not kill the runtime while a persistent outage still surfaces an error.
      this.initialConnectAttempts += 1;
      if (this.initialConnectAttempts >= INITIAL_CONNECT_ATTEMPTS) {
        const error = new Error(
          `cloud runtime connection failed after ${this.initialConnectAttempts} attempt(s)`,
        );
        this.telemetry.socketError(error.message);
        this.rejectFirstConnect(error);
        return;
      }
      this.logger.warn("cloud runtime initial connect failed; retrying", {
        attempt: this.initialConnectAttempts,
        max: INITIAL_CONNECT_ATTEMPTS,
      });
    } else {
      this.logger.warn("cloud runtime disconnected; reconnecting");
    }
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  private handleSocketError(socket: WebSocket, err: Error): void {
    if (socket !== this.socket) return;
    this.logger.warn("cloud runtime socket error", { error: err.message });
    this.telemetry.socketError(err.message);
  }

  private async advertiseProjects(): Promise<void> {
    const projects = await this.executor.advertisedProjects();
    this.advertisedProjects = projects;
    this.telemetry.projectsAdvertised(projects);
    // The hello and session-event producer are tied to this connection. If the
    // socket closed while advertisedProjects() was in flight, skip — the next
    // open will re-advertise and start polling with a replay.
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({
      type: "hello",
      runtimeId: this.cloud.runtime_id,
      runtimeName: this.cloud.runtime_name,
      projects,
    });
    // Only after the hello has been accepted does the live session-event
    // producer start polling gsd_status and streaming session_event frames.
    this.startSessionEvents();
  }

  private startSessionEvents(): void {
    if (this.cloud.session_events === false) return;
    if (!this.sessionEvents) {
      this.sessionEvents = new SessionEventProducer({
        runtimeId: this.cloud.runtime_id ?? "",
        projects: () => this.advertisedProjects,
        poll: (project, sessionId) => this.executor.execute(
          "gsd_status",
          sessionId ? { sessionId } : {},
          project.path,
        ),
        send: (frame, projectPath) => this.sendSessionEvent(frame, projectPath),
        logger: this.logger,
      });
    }
    this.sessionEvents.start();
  }

  /**
   * Handles incoming binary frames from the gateway (browser terminal input).
   * Decodes the channel header and writes the payload to the PTY.
   */
  private handleBinaryInput(socket: WebSocket, frame: Buffer): void {
    if (socket !== this.socket) return;
    try {
      const { channel, data } = decodeBinaryFrame(frame);
      if (!channel.startsWith("terminal:") || !this.terminalManager) return;
      // Only route input to the PTY when the frame's channel names the currently
      // active session. A stale or incorrect sessionId (e.g. a frame that raced a
      // reconnect) must not inject keystrokes into a different session's PTY.
      const sessionId = channel.slice("terminal:".length);
      if (sessionId !== this.terminalManager.getActiveSessionId()) return;
      this.terminalManager.write(data);
    } catch (err) {
      this.logger.warn("binary frame decode error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleMessage(text: string): Promise<void> {
    let message: GatewayMessage;
    try {
      message = JSON.parse(text) as GatewayMessage;
    } catch {
      return;
    }
    if (message.type === "cancel" && message.requestId) {
      void this.cancelInFlight(message.requestId);
      return;
    }

    // Terminal control messages (D-04-01, D-04-02, D-04-12)
    if (message.type === "terminal.start" && message.sessionId && this.terminalManager) {
      void this.terminalManager.startSession(
        message.sessionId,
        toTerminalDimension(message.cols, 80),
        toTerminalDimension(message.rows, 24),
      );
      return;
    }
    if (message.type === "terminal.resize" && this.terminalManager) {
      // cols/rows are untrusted; clamp them and guard the resize so a malformed
      // size (string/NaN/0) cannot make node-pty throw and crash the runtime.
      const cols = toTerminalDimension(message.cols, 80);
      const rows = toTerminalDimension(message.rows, 24);
      try {
        this.terminalManager.resize(cols, rows);
      } catch (err) {
        this.logger.warn("terminal resize failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (message.type === "terminal.stop" && this.terminalManager) {
      this.terminalManager.stopSession();
      return;
    }

    // Browser attach/detach notifications for 5-minute persistence (D-04-02)
    if (message.type === "terminal.detached" && this.terminalManager) {
      this.terminalManager.onBrowserDisconnect();
      return;
    }
    if (message.type === "terminal.attached" && this.terminalManager) {
      // Address replay to the active PTY session's channel, not the sessionId the
      // browser claims: output-channel selection must follow the real session so
      // replay cannot be mis-multiplexed onto a different session by untrusted
      // input. Fall back to message.sessionId only when no PTY is active, and
      // skip replay entirely when neither yields a channel.
      const sessionId = this.terminalManager.getActiveSessionId() ?? message.sessionId;
      if (!sessionId) return;
      const channel: `terminal:${string}` = `terminal:${sessionId}`;
      // encodeBinaryFrame throws when the channel name exceeds 255 UTF-8 bytes.
      // The fallback sessionId is untrusted, and handleMessage() rejections are
      // not caught upstream, so guard here rather than risk crashing the runtime.
      if (Buffer.byteLength(channel, "utf8") > MAX_CHANNEL_BYTES) {
        this.logger.warn("terminal.attached channel name too long; skipping replay", {
          bytes: Buffer.byteLength(channel, "utf8"),
        });
        return;
      }
      const replay = this.terminalManager.onBrowserReconnect();
      if (replay) {
        for (const buf of replay.replayData) {
          const frame = encodeBinaryFrame(channel, buf);
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(frame, { binary: true });
          }
        }
      }
      return;
    }

    if (message.type !== "tool_call" || !message.requestId || !message.toolName) return;
    const routingKey = this.resolveRoutingKey(message);
    const project = this.resolveProject(routingKey);
    const projectAlias = project?.alias;
    const projectPath = project?.path;
    const startedAt = Date.now();
    const receivedBytes = Buffer.byteLength(text);
    this.inFlight.set(message.requestId, {
      message,
      ...(routingKey !== undefined ? { routingKey } : {}),
    });
    this.telemetry.requestStarted({
      requestId: message.requestId,
      ...(projectAlias ? { projectAlias } : {}),
      ...(projectPath ? { projectPath } : {}),
      toolName: message.toolName,
      receivedBytes,
    });
    let outcome: "success" | "error" | "cancelled" = "success";
    let errorMessage: string | undefined;
    try {
      const result = await this.executor.execute(
        message.toolName,
        message.args ?? {},
        routingKey,
        message.requestId,
      );
      if (!this.inFlight.has(message.requestId)) {
        outcome = "cancelled";
        return;
      }
      this.send({ type: "tool_result", requestId: message.requestId, result }, projectPath);
    } catch (err) {
      if (!this.inFlight.has(message.requestId)) {
        outcome = "cancelled";
        return;
      }
      outcome = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      this.send({
        type: "tool_result",
        requestId: message.requestId,
        error: errorMessage,
      }, projectPath);
    } finally {
      this.inFlight.delete(message.requestId);
      this.telemetry.requestFinished({
        requestId: message.requestId,
        ...(projectAlias ? { projectAlias } : {}),
        ...(projectPath ? { projectPath } : {}),
        toolName: message.toolName,
        durationMs: Date.now() - startedAt,
        outcome,
        ...(errorMessage ? { error: errorMessage } : {}),
      });
    }
  }

  private resolveRoutingKey(message: GatewayMessage): string | undefined {
    return message.projectAlias
      ?? (typeof message.args?.projectDir === "string" ? message.args.projectDir : undefined)
      ?? (typeof message.args?.projectAlias === "string" ? message.args.projectAlias : undefined);
  }

  private resolveProject(routingKey?: string): AdvertisedProject | undefined {
    if (routingKey !== undefined) {
      const exact = this.advertisedProjects.find((project) => project.path === routingKey);
      if (exact) return exact;
      const matches = this.advertisedProjects.filter((project) => project.alias === routingKey);
      return matches.length === 1 ? matches[0] : undefined;
    }
    if (this.advertisedProjects.length === 1) return this.advertisedProjects[0];
    return undefined;
  }

  private async cancelInFlight(requestId: string): Promise<void> {
    const pending = this.inFlight.get(requestId);
    if (!pending) return;
    this.inFlight.delete(requestId);
    try {
      if (typeof pending.message.args?.sessionId === "string") {
        await this.executor.execute(
          "gsd_cancel",
          { sessionId: pending.message.args.sessionId },
          pending.routingKey,
        );
        return;
      }
      if (pending.routingKey !== undefined) {
        await this.executor.execute(
          "gsd_cancel",
          { projectDir: pending.routingKey },
          pending.routingKey,
        );
      }
    } catch (err) {
      this.logger.warn("cloud runtime cancel failed", {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveFirstConnect(): void {
    const deferred = this.firstConnectDeferred;
    if (!deferred) return;
    this.firstConnectDeferred = undefined;
    deferred.resolve();
  }

  private rejectFirstConnect(err: Error): void {
    const deferred = this.firstConnectDeferred;
    if (!deferred) return;
    this.firstConnectDeferred = undefined;
    deferred.reject(err);
  }

  /** Live session events are dropped while disconnected; the producer's replay
   * buffer re-sends a bounded tail on reconnect. Keeping them out of the
   * shared offline outbox avoids evicting tool_result frames. */
  private sendSessionEvent(frame: unknown, projectPath?: string): void {
    const text = JSON.stringify(frame);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(text);
      this.telemetry.sent(text, projectPath);
    }
  }

  private send(message: unknown, projectPath?: string): void {
    const text = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(text);
      this.telemetry.sent(text, projectPath);
      return;
    }
    // Buffer while disconnected; flushed on reconnect in handleSocketOpen. Bounded
    // so a long outage cannot grow memory without limit — a stale heartbeat is
    // worth less than a fresh tool_result, so drop oldest first.
    this.outbox.push({ text, ...(projectPath ? { projectPath } : {}) });
    if (this.outbox.length > CloudRuntime.MAX_OUTBOX) {
      this.outbox.shift();
    }
  }
}
