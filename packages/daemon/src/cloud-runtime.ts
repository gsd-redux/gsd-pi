import WebSocket from "ws";
import type { Logger } from "./logger.js";
import type { DaemonConfig } from "./types.js";
import type { LocalToolExecutor } from "./local-tool-executor.js";
import { createGatewayLookup, parseCloudGatewayUrl, validateGatewayNetworkTarget } from "./cloud-config.js";

interface GatewayMessage {
  type: string;
  requestId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  projectAlias?: string;
}

export class CloudRuntime {
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlight = new Map<string, GatewayMessage>();
  private stopped = false;

  constructor(
    private readonly cloud: NonNullable<DaemonConfig["cloud"]>,
    private readonly executor: LocalToolExecutor,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.inFlight.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private connect(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    if (!this.cloud.device_token || !this.cloud.runtime_id) {
      this.logger.warn("cloud runtime skipped — missing device token or runtime id");
      return;
    }
    const gatewayUrl = parseCloudGatewayUrl(this.cloud.gateway_url);
    try {
      validateGatewayNetworkTarget(gatewayUrl);
    } catch (err) {
      this.logger.warn("cloud runtime skipped unsafe gateway URL", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const url = new URL("/runtime/connect", gatewayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.cloud.device_token}` },
      lookup: createGatewayLookup(gatewayUrl),
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
    this.logger.info("cloud runtime connected", { gateway_url: this.cloud.gateway_url, runtime_id: this.cloud.runtime_id });
    void this.advertiseProjects();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat", at: Date.now() }), 30_000);
  }

  private async handleSocketMessage(socket: WebSocket, text: string): Promise<void> {
    if (socket !== this.socket) return;
    await this.handleMessage(text);
  }

  private handleSocketClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket = undefined;
    if (!this.stopped) {
      this.logger.warn("cloud runtime disconnected; reconnecting");
      if (this.reconnect) clearTimeout(this.reconnect);
      this.reconnect = setTimeout(() => this.connect(), 5_000);
    }
  }

  private handleSocketError(socket: WebSocket, err: Error): void {
    if (socket !== this.socket) return;
    this.logger.warn("cloud runtime socket error", { error: err.message });
  }

  private async advertiseProjects(): Promise<void> {
    const projects = await this.executor.advertisedProjects();
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
    this.inFlight.set(message.requestId, message);
    try {
      const result = await this.executor.execute(message.toolName, message.args ?? {}, message.projectAlias);
      if (!this.inFlight.has(message.requestId)) return;
      this.send({ type: "tool_result", requestId: message.requestId, result });
    } catch (err) {
      if (!this.inFlight.has(message.requestId)) return;
      this.send({
        type: "tool_result",
        requestId: message.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlight.delete(message.requestId);
    }
  }

  private async cancelInFlight(requestId: string): Promise<void> {
    const pending = this.inFlight.get(requestId);
    if (!pending) return;
    this.inFlight.delete(requestId);
    try {
      if (typeof pending.args?.sessionId === "string") {
        await this.executor.execute("gsd_cancel", { sessionId: pending.args.sessionId }, pending.projectAlias);
        return;
      }
      const projectDir = typeof pending.args?.projectDir === "string" ? pending.args.projectDir : pending.projectAlias;
      if (projectDir) {
        await this.executor.execute("gsd_cancel", { projectDir });
      }
    } catch (err) {
      this.logger.warn("cloud runtime cancel failed", {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
