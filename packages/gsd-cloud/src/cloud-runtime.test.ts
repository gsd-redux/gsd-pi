// Project/App: Open GSD
// File Purpose: Regression tests for CloudRuntime.start()'s first-connect promise
// — it must resolve only once the relay is actually up and reject on connect
// failure, so the CLI never reports "connected" for a socket that never opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { CloudRuntime } from "./cloud-runtime.js";
import { RuntimeTelemetryStore } from "./runtime-telemetry.js";

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const noopExecutor = { execute: async () => ({}), advertisedProjects: async () => [] };

function makeRuntime(cloud: Record<string, unknown> = {}): CloudRuntime {
  return new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "fixture", runtime_id: "runtime", ...cloud } as never,
    noopExecutor as never,
    noopLogger as never,
  );
}

type FakeSocket = { readyState: number; sent: string[]; send: (t: string) => void; close: () => void };
function fakeSocket(readyState: number = WebSocket.OPEN): FakeSocket {
  const sent: string[] = [];
  return { readyState, sent, send: (t: string) => sent.push(t), close: () => undefined };
}
type RuntimeInternals = {
  socket: FakeSocket | undefined;
  advertisedProjects: Array<{ alias: string; path: string; repoIdentity: string; markers: string[] }>;
  firstConnectDeferred: PromiseWithResolvers<void> | undefined;
  initialConnectAttempts: number;
  reconnect: ReturnType<typeof setTimeout> | undefined;
  handleSocketOpen: (socket: unknown) => void;
  handleSocketClose: (socket: unknown) => void;
  handleSocketMessage: (socket: unknown, text: string) => Promise<void>;
  connect: () => void;
};

test("queued project bytes are reported only after transmission", async () => {
  const sentProjects: Array<string | undefined> = [];
  const telemetry = {
    ...Object.fromEntries([
      "connecting", "connected", "disconnected", "socketError", "received",
      "projectsAdvertised", "requestStarted", "requestFinished", "stopped",
    ].map((name) => [name, () => undefined])),
    sent: (_text: string, projectPath?: string) => sentProjects.push(projectPath),
  } as never;
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "fixture", runtime_id: "runtime" },
    {
      execute: async () => ({ ok: true }),
      advertisedProjects: async () => [
        { alias: "app", path: "/work/one/app", repoIdentity: "one", markers: [".gsd"] },
        { alias: "app", path: "/work/two/app", repoIdentity: "two", markers: [".gsd"] },
      ],
    } as never,
    noopLogger as never,
    telemetry,
  );
  const internals = runtime as unknown as RuntimeInternals;
  internals.advertisedProjects = [
    { alias: "app", path: "/work/one/app", repoIdentity: "one", markers: [".gsd"] },
    { alias: "app", path: "/work/two/app", repoIdentity: "two", markers: [".gsd"] },
  ];
  internals.socket = fakeSocket(WebSocket.CLOSED);

  try {
    await internals.handleSocketMessage(internals.socket, JSON.stringify({
      type: "tool_call",
      requestId: "request-queued",
      toolName: "gsd_status",
      args: { projectDir: "/work/two/app" },
    }));
    assert.deepEqual(sentProjects, []);

    const openSocket = fakeSocket();
    internals.socket = openSocket;
    internals.handleSocketOpen(openSocket);
    assert.deepEqual(sentProjects, ["/work/two/app"]);
  } finally {
    runtime.stop();
  }
});

test("start()'s first-connect promise resolves only when the relay socket opens", async () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  try {
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
    const socket = fakeSocket();
    internals.socket = socket;

    let settled = false;
    void deferred.promise.then(() => (settled = true));
    await Promise.resolve(); // let any premature settle flush
    assert.equal(settled, false, "promise must not resolve before the socket opens");

    internals.handleSocketOpen(socket);
    await deferred.promise; // resolves — otherwise this hangs/throws
  } finally {
    runtime.stop();
  }
});

test("an early socket close retries instead of rejecting while attempts remain", async () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  try {
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
    const socket = fakeSocket();
    internals.socket = socket;

    let settled = false;
    void deferred.promise.then(() => (settled = true), () => (settled = true));

    internals.handleSocketClose(socket); // first transient failure
    await Promise.resolve();
    assert.equal(settled, false, "a single early close must not settle start()");
    assert.equal(internals.initialConnectAttempts, 1);
    assert.notEqual(internals.reconnect, undefined, "a reconnect must be scheduled");
  } finally {
    runtime.stop();
  }
});

test("start()'s first-connect promise rejects once the initial connect attempts are exhausted", async () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  try {
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
    // Simulate having already burned every retry but the last so the next close
    // is the one that must give up and reject.
    internals.initialConnectAttempts = 4;
    const socket = fakeSocket();
    internals.socket = socket;

    internals.handleSocketClose(socket);
    await assert.rejects(deferred.promise, /connection failed/);
  } finally {
    runtime.stop();
  }
});

test("connect() rejects the first-connect promise when the device token is missing", async () => {
  const runtime = makeRuntime({ device_token: "" });
  const internals = runtime as unknown as RuntimeInternals;
  try {
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
    internals.connect();
    await assert.rejects(deferred.promise, /missing device token/);
  } finally {
    runtime.stop();
  }
});

test("socket activity is reported to runtime telemetry", async () => {
  const events: Array<{ name: string; details?: unknown }> = [];
  const telemetry = {
    connecting: () => events.push({ name: "connecting" }),
    connected: () => events.push({ name: "connected" }),
    disconnected: () => events.push({ name: "disconnected" }),
    socketError: () => events.push({ name: "error" }),
    received: () => events.push({ name: "received" }),
    sent: () => events.push({ name: "sent" }),
    projectsAdvertised: (details: unknown) => events.push({ name: "projects", details }),
    requestStarted: (details: unknown) => events.push({ name: "request-started", details }),
    requestFinished: (details: unknown) => events.push({ name: "request-finished", details }),
    stopped: () => events.push({ name: "stopped" }),
  };
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "fixture", runtime_id: "runtime" },
    {
      execute: async () => ({ ok: true }),
      advertisedProjects: async () => [{
        alias: "project-one",
        path: "/work/project-one",
        repoIdentity: "repo-one",
        markers: [".gsd"],
      }],
    } as never,
    noopLogger as never,
    telemetry,
  );
  const internals = runtime as unknown as RuntimeInternals;
  const socket = fakeSocket();
  internals.socket = socket;

  try {
    internals.handleSocketOpen(socket);
    await new Promise((resolve) => setImmediate(resolve));
    await internals.handleSocketMessage(socket, JSON.stringify({
      type: "tool_call",
      requestId: "request-1",
      toolName: "gsd_status",
      projectAlias: "project-one",
    }));

    assert.ok(events.some((event) => event.name === "connected"));
    assert.ok(events.some((event) => event.name === "received"));
    const advertised = events.find((event) => event.name === "projects");
    assert.equal((advertised?.details as Array<{ alias?: string }>)[0]?.alias, "project-one");
    const started = events.find((event) => event.name === "request-started");
    assert.equal((started?.details as { projectAlias?: string }).projectAlias, "project-one");
    assert.equal((started?.details as { toolName?: string }).toolName, "gsd_status");
    assert.ok(((started?.details as { receivedBytes?: number }).receivedBytes ?? 0) > 0);
    const finished = events.find((event) => event.name === "request-finished");
    assert.equal((finished?.details as { projectAlias?: string }).projectAlias, "project-one");
    assert.equal((finished?.details as { outcome?: string }).outcome, "success");
    assert.equal((finished?.details as { sentBytes?: number }).sentBytes, undefined);
    assert.ok(events.some((event) => event.name === "sent"));
  } finally {
    runtime.stop();
  }
});

test("startup failures flush runtime telemetry before rejecting", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-startup-error-"));
  const telemetry = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "wss://cloud.example.net",
  });
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "", runtime_id: "runtime" },
    noopExecutor as never,
    noopLogger as never,
    telemetry,
  );

  try {
    await assert.rejects(runtime.start(), /missing device token/);
    const status = JSON.parse(readFileSync(join(root, "cloud-runtime-status.json"), "utf8")) as {
      state?: string;
      last_error?: string;
    };
    assert.equal(status.state, "error");
    assert.equal(status.last_error, "cloud runtime missing device token or runtime id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
