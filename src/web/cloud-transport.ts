import { WebSocket } from "ws";
import type { RpcCommand, RpcExtensionUIResponse } from "@opengsd/contracts";
import type { CloudRole } from "../../web/lib/cloud-mode.ts";
import type { BridgeTransport, BridgeTransportCloseInfo } from "./bridge-transport.ts";

// ─── Cloud RPC transport (ADR-047) ──────────────────────────────────────────
//
// Server-side WebSocket client to the gsd-cloud gateway. Replaces the local
// stdio child in cloud mode: each BridgeService instance maps to one
// relay-proxied RPC channel for (deviceId, projectAlias, role).
//
// Handshake: POST {GATEWAY_INTERNAL_URL}/internal/rpc/token with the internal
// token mints a 30s single-use RPC token; the channel is then opened at
// wss {gateway}/rpc/connect?token=. NDJSON RpcCommand/RpcResponse lines ride
// 1:1 inside {"type":"data","payload":<line>} frames. Reconnect is NOT
// automatic — a closed channel surfaces to the UI like a child exit.

/** Minimal structural WebSocket contract (satisfied by `ws`; fakeable in tests). */
export interface CloudWebSocketLike {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface CloudTransportOptions {
  gatewayInternalUrl: string;
  gatewayInternalToken: string;
  deviceId: string;
  projectAlias: string;
  role: CloudRole;
  /** Identity recorded in the token mint; defaults to "cloud-web". */
  userId?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable for tests. */
  webSocketFactory?: (url: string) => CloudWebSocketLike;
}

type GatewayClientMessage = { type: "data"; payload: string } | { type: "close" };

type GatewayServerMessage =
  | { type: "opened" }
  | { type: "data"; payload: string }
  | { type: "error"; error: string }
  | { type: "closed"; reason?: string };

// ─── Cloud project registry keys ────────────────────────────────────────────
//
// API routes resolve `?project=` to a registry key for the per-project
// BridgeService map. In cloud mode the key encodes (deviceId, alias, role)
// so bridges for different devices/roles never share an instance. The key is
// server-internal: the client only ever sees the plain alias.

export interface CloudProjectRef {
  deviceId: string;
  alias: string;
  role: CloudRole;
}

const CLOUD_PROJECT_KEY_PREFIX = "cloud://";

export function encodeCloudProjectRef(ref: CloudProjectRef): string {
  const json = JSON.stringify({ d: ref.deviceId, a: ref.alias, r: ref.role });
  return `${CLOUD_PROJECT_KEY_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function isCloudProjectRef(value: string): boolean {
  return value.startsWith(CLOUD_PROJECT_KEY_PREFIX);
}

export function decodeCloudProjectRef(key: string): CloudProjectRef {
  if (!isCloudProjectRef(key)) {
    throw new Error(`not a cloud project ref: ${key}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(key.slice(CLOUD_PROJECT_KEY_PREFIX.length), "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`malformed cloud project ref: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = parsed as { d?: unknown; a?: unknown; r?: unknown };
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.d !== "string" ||
    typeof record.a !== "string" ||
    (record.r !== "owner" && record.r !== "member" && record.r !== "viewer")
  ) {
    throw new Error("malformed cloud project ref payload");
  }
  return { deviceId: record.d, alias: record.a, role: record.r };
}

function buildGatewayHttpUrl(gatewayInternalUrl: string, path: string): string {
  const url = new URL(gatewayInternalUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  return url.toString();
}

function buildConnectUrl(gatewayInternalUrl: string, token: string): string {
  const url = new URL(gatewayInternalUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc/connect`;
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

// `ws` delivers a "message" payload as RawData: a string, a Buffer, an
// ArrayBuffer / typed-array view, or a Buffer[] of fragments (depending on the
// binaryType and whether the frame arrived fragmented). Normalize every shape
// to UTF-8 text so no frame is silently dropped.
function rawDataToText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) {
    if (data.length === 0 || !data.every((chunk) => Buffer.isBuffer(chunk))) return null;
    return Buffer.concat(data as Buffer[]).toString("utf8");
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

function parseGatewayMessage(data: unknown): GatewayServerMessage | null {
  const text = rawDataToText(data);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
    return null;
  }
  return parsed as GatewayServerMessage;
}

export class CloudTransport implements BridgeTransport {
  private ws: CloudWebSocketLike | null = null;
  private opened = false;
  private closeNotified = false;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<(info: BridgeTransportCloseInfo) => void>();
  private readonly options: CloudTransportOptions;

  constructor(options: CloudTransportOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.opened && this.ws !== null && !this.closeNotified;
  }

  async connect(): Promise<void> {
    const token = await this.mintRpcToken();
    const url = buildConnectUrl(this.options.gatewayInternalUrl, token);
    const factory =
      this.options.webSocketFactory ?? ((u: string) => new WebSocket(u) as unknown as CloudWebSocketLike);

    await new Promise<void>((resolve, reject) => {
      const ws = factory(url);
      this.ws = ws;
      let settled = false;

      const failOpen = (error: Error) => {
        settled = true;
        this.ws = null;
        try {
          ws.close();
        } catch {
          // Best effort.
        }
        reject(error);
      };

      ws.on("message", (data) => {
        const message = parseGatewayMessage(data);
        if (!message) return;
        if (!settled) {
          if (message.type === "opened") {
            settled = true;
            this.opened = true;
            resolve();
            return;
          }
          if (message.type === "error") {
            failOpen(new Error(message.error || "RPC channel rejected by gateway"));
            return;
          }
          if (message.type === "closed") {
            failOpen(new Error(message.reason ? `RPC channel closed during open: ${message.reason}` : "RPC channel closed during open"));
            return;
          }
          // Data frames before "opened" are unexpected — ignore.
          return;
        }
        this.handleMessage(message);
      });

      ws.on("error", (error) => {
        if (!settled) {
          failOpen(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.notifyClose({ code: null, signal: null, error });
      });

      ws.on("close", () => {
        if (!settled) {
          failOpen(new Error("WebSocket closed before RPC channel opened"));
          return;
        }
        this.notifyClose({ code: null, signal: null });
      });
    });
  }

  send(command: RpcCommand | RpcExtensionUIResponse): void {
    if (!this.connected || !this.ws) return;
    const frame: GatewayClientMessage = { type: "data", payload: JSON.stringify(command) };
    this.ws.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    try {
      if (this.opened && !this.closeNotified) {
        const frame: GatewayClientMessage = { type: "close" };
        ws.send(JSON.stringify(frame));
      }
    } catch {
      // Best effort — the socket close below is authoritative.
    }
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    this.ws = null;
    this.opened = false;
  }

  onEvent(listener: (line: string) => void): void {
    this.lineListeners.add(listener);
  }

  onClose(listener: (info: BridgeTransportCloseInfo) => void): void {
    this.closeListeners.add(listener);
  }

  private handleMessage(message: GatewayServerMessage): void {
    if (message.type === "data") {
      this.emitLine(message.payload);
      return;
    }
    if (message.type === "closed") {
      this.notifyClose({
        code: null,
        signal: null,
        error: message.reason ? new Error(`RPC channel closed: ${message.reason}`) : undefined,
      });
      return;
    }
    if (message.type === "error") {
      this.notifyClose({ code: null, signal: null, error: new Error(message.error || "RPC channel error") });
    }
  }

  private async mintRpcToken(): Promise<string> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const url = buildGatewayHttpUrl(this.options.gatewayInternalUrl, "/internal/rpc/token");
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.gatewayInternalToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceId: this.options.deviceId,
        projectAlias: this.options.projectAlias,
        role: this.options.role,
        userId: this.options.userId ?? "cloud-web",
      }),
    });
    if (!response.ok) {
      throw new Error(`RPC token mint failed (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { token?: string };
    if (typeof body.token !== "string" || body.token.length === 0) {
      throw new Error("RPC token mint response missing token");
    }
    return body.token;
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
    this.opened = false;
    // Drop the socket reference and best-effort close the underlying TCP
    // connection. A gateway "closed"/"error" frame does not guarantee the ws
    // itself is closed, so leaving it referenced would leak the connection.
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already closing/closed.
      }
    }
    for (const listener of this.closeListeners) {
      try {
        listener(info);
      } catch {
        // Listener failures should not break delivery.
      }
    }
  }
}
