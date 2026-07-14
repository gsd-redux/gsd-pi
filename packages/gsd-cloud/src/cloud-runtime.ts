import WebSocket from "ws";
import type { Logger } from "./logger.js";
import type { DaemonConfig } from "./types.js";
import type { AdvertisedProject, Executor } from "./executors/executor.js";
import { createGatewayLookup, parseCloudGatewayUrl, validateGatewayNetworkTarget } from "./cloud-config.js";
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
}

interface QueuedFrame {
  text: string;
  projectPath?: string;
}

interface InFlightRequest {
  message: GatewayMessage;
  routingKey?: string;
}

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
    this.inFlight.clear();
    this.outbox = [];
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

    socket.on("open", () => {
      this.handleSocketOpen(socket);
    });
    socket.on("message", (data) => {
      void this.handleSocketMessage(socket, data.toString("utf8"));
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
    this.send({
      type: "hello",
      runtimeId: this.cloud.runtime_id,
      runtimeName: this.cloud.runtime_name,
      projects,
    });
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
