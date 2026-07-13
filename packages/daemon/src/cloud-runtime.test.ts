import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudRuntime } from "./cloud-runtime.js";

function makeRuntime(): CloudRuntime {
  return new CloudRuntime(
    { gateway_url: "ws://127.0.0.1:1", device_token: "fixture", runtime_id: "runtime" },
    { execute: async () => ({}), advertisedProjects: async () => [] } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
  );
}

type FakeSocket = { readyState: number; sent: string[]; send: (t: string) => void; close: () => void };
function fakeSocket(readyState = WebSocket.OPEN): FakeSocket {
  const sent: string[] = [];
  return { readyState, sent, send: (t: string) => sent.push(t), close: () => undefined };
}
type RuntimeInternals = {
  socket: FakeSocket | undefined;
  outbox: string[];
  send: (message: unknown) => void;
  handleSocketOpen: (socket: unknown) => void;
};

test("cloud runtime forwards the stable request identity to tool execution", async () => {
  let execution: unknown[] | undefined;
  const runtime = new CloudRuntime(
    { gateway_url: "ws://127.0.0.1:1", device_token: "fixture", runtime_id: "runtime" },
    {
      execute: async (...args: unknown[]) => {
        execution = args;
        return {};
      },
      advertisedProjects: async () => [],
    } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
  );

  await (runtime as unknown as { handleMessage: (text: string) => Promise<void> }).handleMessage(JSON.stringify({
    type: "tool_call",
    requestId: "request-42",
    toolName: "gsd_task_recovery_resume",
    args: { recoveryActionId: "action-1" },
  }));

  assert.deepEqual(execution, [
    "gsd_task_recovery_resume",
    { recoveryActionId: "action-1" },
    undefined,
    "request-42",
  ]);
  runtime.stop();
});

test("cloud runtime buffers sends while disconnected and flushes them on reconnect (FIFO)", () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  try {
    internals.socket = undefined; // disconnected
    internals.send({ type: "tool_result", requestId: "a" });
    internals.send({ type: "tool_result", requestId: "b" });
    assert.equal(internals.outbox.length, 2, "messages buffered, not dropped");

    const socket = fakeSocket();
    internals.socket = socket;
    internals.handleSocketOpen(socket); // triggers advertise (send) + drain
    // advertiseProjects sends a hello first, then the two buffered results in order.
    const results = socket.sent.filter((t) => t.includes("tool_result"));
    assert.deepEqual(
      results.map((t) => (JSON.parse(t) as { requestId: string }).requestId),
      ["a", "b"],
    );
    assert.equal(internals.outbox.length, 0, "outbox drained");
  } finally {
    runtime.stop();
  }
});

test("cloud runtime caps the outbox and drops oldest", () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  try {
    internals.socket = undefined;
    for (let i = 0; i < 210; i += 1) internals.send({ type: "tool_result", requestId: `r${i}` });
    assert.equal(internals.outbox.length, 200, "bounded at MAX_OUTBOX");
    // Oldest dropped: r0..r9 gone, newest retained.
    const first = JSON.parse(internals.outbox[0]) as { requestId: string };
    const last = JSON.parse(internals.outbox[internals.outbox.length - 1]) as { requestId: string };
    assert.equal(first.requestId, "r10");
    assert.equal(last.requestId, "r209");
  } finally {
    runtime.stop();
  }
});

test("cloud runtime stop() clears the outbox", () => {
  const runtime = makeRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  internals.socket = undefined;
  internals.send({ type: "tool_result", requestId: "x" });
  assert.equal(internals.outbox.length, 1);
  runtime.stop();
  assert.equal(internals.outbox.length, 0);
});

test("cloud runtime ignores stale socket close events after replacement", () => {
  const runtime = makeRuntime();
  const staleSocket = {};
  const activeSocket = { close: () => undefined };
  const heartbeat = setInterval(() => undefined, 30_000);
  try {
    Object.assign(runtime as unknown as { socket: unknown; heartbeat: ReturnType<typeof setInterval> }, {
      socket: activeSocket,
      heartbeat,
    });

    (runtime as unknown as { handleSocketClose: (socket: unknown) => void }).handleSocketClose(staleSocket);

    const state = runtime as unknown as {
      socket: unknown;
      heartbeat: ReturnType<typeof setInterval> | undefined;
      reconnect: ReturnType<typeof setTimeout> | undefined;
    };
    assert.equal(state.socket, activeSocket);
    assert.equal(state.heartbeat, heartbeat);
    assert.equal(state.reconnect, undefined);
  } finally {
    clearInterval(heartbeat);
    runtime.stop();
  }
});
