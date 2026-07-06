// Project/App: Open GSD
// File Purpose: Regression tests for CloudRuntime.start()'s first-connect promise
// — it must resolve only once the relay is actually up and reject on connect
// failure, so the CLI never reports "connected" for a socket that never opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { CloudRuntime } from "./cloud-runtime.js";

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
function fakeSocket(readyState = WebSocket.OPEN): FakeSocket {
  const sent: string[] = [];
  return { readyState, sent, send: (t: string) => sent.push(t), close: () => undefined };
}
type RuntimeInternals = {
  socket: FakeSocket | undefined;
  firstConnectDeferred: PromiseWithResolvers<void> | undefined;
  handleSocketOpen: (socket: unknown) => void;
  handleSocketClose: (socket: unknown) => void;
  connect: () => void;
};

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

test("start()'s first-connect promise rejects when the socket closes before opening", async () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  try {
    const deferred = Promise.withResolvers<void>();
    internals.firstConnectDeferred = deferred;
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
