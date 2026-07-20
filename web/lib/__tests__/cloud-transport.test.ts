import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudTransport,
  decodeCloudProjectRef,
  encodeCloudProjectRef,
  isCloudProjectRef,
  type CloudWebSocketLike,
} from "../../../src/web/cloud-transport.ts";

const GATEWAY_URL = "https://gateway.example.com";
const GATEWAY_TOKEN = "internal-token";

class FakeWebSocket implements CloudWebSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: "open" | "message" | "close" | "error", ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  receive(message: unknown): void {
    this.emit("message", JSON.stringify(message));
  }
}

type FetchCall = { url: string; init?: RequestInit };

function harness(options: {
  token?: string;
  tokenStatus?: number;
  gatewayUrl?: string;
} = {}) {
  const fetchCalls: FetchCall[] = [];
  const sockets: FakeWebSocket[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const status = options.tokenStatus ?? 200;
    return new Response(JSON.stringify(status === 200 ? { token: options.token ?? "tok-123", expiresAt: 0 } : { error: "nope" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new CloudTransport({
    gatewayInternalUrl: options.gatewayUrl ?? GATEWAY_URL,
    gatewayInternalToken: GATEWAY_TOKEN,
    deviceId: "device-1",
    projectAlias: "alpha",
    role: "viewer",
    fetchFn,
    webSocketFactory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  });

  return { transport, fetchCalls, sockets };
}

describe("CloudTransport.connect", () => {
  test("mints an RPC token with the internal token and project claims", async () => {
    const { transport, fetchCalls, sockets } = harness();
    const connecting = transport.connect();
    const socket = await waitForSocket(sockets);
    socket.receive({ type: "opened" });
    await connecting;

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://gateway.example.com/internal/rpc/token");
    assert.equal(fetchCalls[0].init?.method, "POST");
    assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      deviceId: "device-1",
      projectAlias: "alpha",
      role: "viewer",
      userId: "cloud-web",
    });
  });

  test("opens the WebSocket at wss <gateway>/rpc/connect?token=", async () => {
    const { transport, sockets } = harness({ token: "tok-abc" });
    const connecting = transport.connect();
    const socket = await waitForSocket(sockets);
    socket.receive({ type: "opened" });
    await connecting;

    assert.equal(socket.url, "wss://gateway.example.com/rpc/connect?token=tok-abc");
    assert.equal(transport.connected, true);
  });

  test("uses ws:// for plain-http gateways", async () => {
    const { transport, sockets } = harness({ gatewayUrl: "http://127.0.0.1:8787" });
    const connecting = transport.connect();
    const socket = await waitForSocket(sockets);
    socket.receive({ type: "opened" });
    await connecting;
    assert.equal(socket.url, "ws://127.0.0.1:8787/rpc/connect?token=tok-123");
  });

  test("rejects when the token mint fails", async () => {
    const { transport, sockets } = harness({ tokenStatus: 403 });
    await assert.rejects(transport.connect(), /RPC token mint failed \(HTTP 403\)/);
    assert.equal(sockets.length, 0);
    assert.equal(transport.connected, false);
  });

  test("rejects when the mint response has no token", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ expiresAt: 0 }), { status: 200 })) as typeof fetch;
    const transport = new CloudTransport({
      gatewayInternalUrl: GATEWAY_URL,
      gatewayInternalToken: GATEWAY_TOKEN,
      deviceId: "d",
      projectAlias: "a",
      role: "owner",
      fetchFn,
      webSocketFactory: () => new FakeWebSocket(""),
    });
    await assert.rejects(transport.connect(), /missing token/);
  });

  test("rejects when the gateway answers error instead of opened", async () => {
    const { transport, sockets } = harness();
    const connecting = transport.connect();
    const socket = await waitForSocket(sockets);
    socket.receive({ type: "error", error: "unknown project alias" });
    await assert.rejects(connecting, /unknown project alias/);
    assert.equal(socket.closed, true);
    assert.equal(transport.connected, false);
  });

  test("rejects when the socket closes before opened", async () => {
    const { transport, sockets } = harness();
    const connecting = transport.connect();
    const socket = await waitForSocket(sockets);
    socket.emit("close", 1006, "");
    await assert.rejects(connecting, /closed before RPC channel opened/);
  });
});

describe("CloudTransport message mapping", () => {
  async function connectedTransport() {
    const ctx = harness();
    const connecting = ctx.transport.connect();
    const socket = await waitForSocket(ctx.sockets);
    socket.receive({ type: "opened" });
    await connecting;
    return { ...ctx, socket };
  }

  test("send wraps one NDJSON line per data frame", async () => {
    const { transport, socket } = await connectedTransport();
    transport.send({ id: "web_1", type: "get_state" });
    assert.equal(socket.sent.length, 1);
    const frame = JSON.parse(socket.sent[0]);
    assert.equal(frame.type, "data");
    assert.equal(frame.payload, JSON.stringify({ id: "web_1", type: "get_state" }));
    // Payload must be exactly one NDJSON line with no trailing newline.
    assert.ok(!frame.payload.includes("\n"));
  });

  test("data frames map 1:1 to onEvent lines", async () => {
    const { transport, socket } = await connectedTransport();
    const lines: string[] = [];
    transport.onEvent((line) => lines.push(line));

    const responseLine = JSON.stringify({ type: "response", command: "get_state", success: true, id: "web_1", data: {} });
    const eventLine = JSON.stringify({ type: "agent_end" });
    socket.receive({ type: "data", payload: responseLine });
    socket.receive({ type: "data", payload: eventLine });

    assert.deepEqual(lines, [responseLine, eventLine]);
  });

  test("closed surfaces to onClose once, with the reason, and drops the connection", async () => {
    const { transport, socket } = await connectedTransport();
    const closes: Array<{ code: number | null; error?: unknown }> = [];
    transport.onClose((info) => closes.push(info));

    socket.receive({ type: "closed", reason: "daemon detached" });
    socket.emit("close", 1000, "");

    assert.equal(closes.length, 1);
    assert.equal(closes[0].code, null);
    assert.match(String(closes[0].error), /daemon detached/);
    assert.equal(transport.connected, false);
  });

  test("socket error after open surfaces to onClose", async () => {
    const { transport, socket } = await connectedTransport();
    const closes: Array<{ error?: unknown }> = [];
    transport.onClose((info) => closes.push(info));
    socket.emit("error", new Error("boom"));
    assert.equal(closes.length, 1);
    assert.match(String(closes[0].error), /boom/);
    assert.equal(transport.connected, false);
  });

  test("close sends a close frame then closes the socket", async () => {
    const { transport, socket } = await connectedTransport();
    await transport.close();
    assert.deepEqual(socket.sent.map((frame) => JSON.parse(frame).type), ["close"]);
    assert.equal(socket.closed, true);
  });

  test("close is a no-op before connect", async () => {
    const { transport } = harness();
    await transport.close();
  });
});

describe("cloud project ref codec", () => {
  test("round-trips device, alias and role", () => {
    const key = encodeCloudProjectRef({ deviceId: "dev-1", alias: "my project", role: "member" });
    assert.equal(isCloudProjectRef(key), true);
    assert.deepEqual(decodeCloudProjectRef(key), { deviceId: "dev-1", alias: "my project", role: "member" });
  });

  test("keys are unique per device/alias/role and never look like paths", () => {
    const a = encodeCloudProjectRef({ deviceId: "d1", alias: "p", role: "owner" });
    const b = encodeCloudProjectRef({ deviceId: "d2", alias: "p", role: "owner" });
    const c = encodeCloudProjectRef({ deviceId: "d1", alias: "p", role: "viewer" });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.equal(isCloudProjectRef("/abs/path"), false);
    assert.equal(isCloudProjectRef("relative/path"), false);
  });

  test("decode rejects non-cloud keys and malformed payloads", () => {
    assert.throws(() => decodeCloudProjectRef("/abs/path"), /not a cloud project ref/);
    const bad = `cloud://${Buffer.from(JSON.stringify({ d: 1 }), "utf8").toString("base64url")}`;
    assert.throws(() => decodeCloudProjectRef(bad), /malformed/);
  });
});

async function waitForSocket(sockets: FakeWebSocket[]): Promise<FakeWebSocket> {
  const started = Date.now();
  while (sockets.length === 0) {
    if (Date.now() - started > 1000) throw new Error("no WebSocket was opened");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sockets[0];
}
