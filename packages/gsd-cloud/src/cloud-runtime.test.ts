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

test("one routing selector drives execution, cancellation, and telemetry", async (t) => {
  const selectors: Array<string | undefined> = [];
  const started: Array<{ projectAlias?: string; projectPath?: string }> = [];
  const execution = Promise.withResolvers<unknown>();
  const telemetry = {
    ...Object.fromEntries([
      "connecting", "connected", "disconnected", "socketError", "received", "sent",
      "projectsAdvertised", "requestFinished", "stopped",
    ].map((name) => [name, () => undefined])),
    requestStarted: (request: { projectAlias?: string; projectPath?: string }) => started.push(request),
  } as never;
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "fixture", runtime_id: "runtime" },
    {
      execute: async (toolName: string, _args: unknown, selector?: string) => {
        selectors.push(selector);
        if (toolName === "gsd_cancel") return {};
        return execution.promise;
      },
      advertisedProjects: async () => [],
    } as never,
    noopLogger as never,
    telemetry,
  );
  const internals = runtime as unknown as RuntimeInternals;
  t.after(() => runtime.stop());
  internals.advertisedProjects = [
    { alias: "one", path: "/work/one", repoIdentity: "one", markers: [".gsd"] },
    { alias: "two", path: "/work/two", repoIdentity: "two", markers: [".gsd"] },
  ];
  const socket = fakeSocket();
  internals.socket = socket;

    const request = internals.handleSocketMessage(socket, JSON.stringify({
      type: "tool_call",
      requestId: "request-routing",
      toolName: "gsd_status",
      projectAlias: "one",
      args: { projectDir: "/work/two" },
    }));
    await Promise.resolve();
    await internals.handleSocketMessage(socket, JSON.stringify({
      type: "cancel",
      requestId: "request-routing",
    }));
    execution.resolve({});
    await request;

    assert.deepEqual(selectors, ["one", "one"]);
    assert.equal(started[0]?.projectAlias, "one");
    assert.equal(started[0]?.projectPath, "/work/one");

    internals.advertisedProjects = [
      { alias: "app", path: "/work/one/app", repoIdentity: "one", markers: [".gsd"] },
      { alias: "app", path: "/work/two/app", repoIdentity: "two", markers: [".gsd"] },
    ];
    await internals.handleSocketMessage(socket, JSON.stringify({
      type: "tool_call",
      requestId: "request-ambiguous",
      toolName: "gsd_status",
      projectAlias: "app",
    }));
    assert.equal(started[1]?.projectAlias, undefined);
    assert.equal(started[1]?.projectPath, undefined);

});

test("queued project bytes are reported only after transmission", async (t) => {
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
  t.after(() => runtime.stop());
  internals.advertisedProjects = [
    { alias: "app", path: "/work/one/app", repoIdentity: "one", markers: [".gsd"] },
    { alias: "app", path: "/work/two/app", repoIdentity: "two", markers: [".gsd"] },
  ];
  internals.socket = fakeSocket(WebSocket.CLOSED);

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

});

test("start()'s first-connect promise resolves only when the relay socket opens", async (t) => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  t.after(() => runtime.stop());
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

});

test("an early socket close retries instead of rejecting while attempts remain", async (t) => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  t.after(() => runtime.stop());
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

});

test("start()'s first-connect promise rejects once the initial connect attempts are exhausted", async (t) => {
  const errors: string[] = [];
  const telemetry = {
    ...Object.fromEntries([
      "connecting", "connected", "disconnected", "received", "sent", "projectsAdvertised",
      "requestStarted", "requestFinished", "stopped",
    ].map((name) => [name, () => undefined])),
    socketError: (message: string) => errors.push(message),
  } as never;
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "fixture", runtime_id: "runtime" },
    noopExecutor as never,
    noopLogger as never,
    telemetry,
  );
  const internals = runtime as unknown as RuntimeInternals;
  t.after(() => runtime.stop());
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
    // Simulate having already burned every retry but the last so the next close
    // is the one that must give up and reject.
    internals.initialConnectAttempts = 4;
    const socket = fakeSocket();
    internals.socket = socket;

    internals.handleSocketClose(socket);
    await assert.rejects(deferred.promise, /connection failed/);
    assert.deepEqual(errors, ["cloud runtime connection failed after 5 attempt(s)"]);

});

test("connect() rejects the first-connect promise when the device token is missing", async (t) => {
  const runtime = makeRuntime({ device_token: "" });
  const internals = runtime as unknown as RuntimeInternals;
  t.after(() => runtime.stop());
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
    internals.connect();
    await assert.rejects(deferred.promise, /missing device token/);

});

test("socket activity is reported to runtime telemetry", async (t) => {
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
  t.after(() => runtime.stop());
  const socket = fakeSocket();
  internals.socket = socket;

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

});

test("startup failures flush runtime telemetry before rejecting", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-startup-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const telemetry = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "wss://cloud.example.net",
  });
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "", runtime_id: "runtime" },
    noopExecutor as never,
    noopLogger as never,
    telemetry,
  );
  t.after(() => runtime.stop());

    await assert.rejects(runtime.start(), /missing device token/);
    const status = JSON.parse(readFileSync(join(root, "cloud-runtime-status.json"), "utf8")) as {
      state?: string;
      last_error?: string;
    };
    assert.equal(status.state, "error");
    assert.equal(status.last_error, "cloud runtime missing device token or runtime id");

});

test("malformed gateway failures flush runtime telemetry before rejecting", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-startup-url-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const telemetry = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "not-a-url",
  });
  const runtime = new CloudRuntime(
    { gateway_url: "not-a-url", device_token: "fixture", runtime_id: "runtime" },
    noopExecutor as never,
    noopLogger as never,
    telemetry,
  );
  t.after(() => runtime.stop());

    await assert.rejects(runtime.start(), /absolute HTTP\(S\) URL/);
    const status = JSON.parse(readFileSync(join(root, "cloud-runtime-status.json"), "utf8")) as {
      state?: string;
      last_error?: string;
    };
    assert.equal(status.state, "error");
    assert.match(status.last_error ?? "", /absolute HTTP\(S\) URL/);

});
