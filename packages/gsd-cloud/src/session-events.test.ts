// Project/App: Open GSD
// File Purpose: Unit tests for the live session-event producer — normalization
// of gsd_status deltas into session_event frames, per-session seq monotonicity,
// replay buffer behavior, size/session bounds, the enable flag, and the
// CloudRuntime wiring (producer starts after hello, stops on close).
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { CloudRuntime } from "./cloud-runtime.js";
import { validateConfig } from "./config.js";
import { SessionEventProducer, type SessionEventFrame } from "./session-events.js";

const PROJECT = { alias: "one", path: "/work/one", repoIdentity: "repo-one", markers: [".gsd"] };

function makeLogger(warnings: Array<Record<string, unknown>> = []) {
  return {
    info: () => undefined,
    warn: (_msg: string, data?: Record<string, unknown>) => {
      if (data) warnings.push(data);
      return undefined;
    },
    error: () => undefined,
    debug: () => undefined,
  };
}

/** MCP-shaped success result, as returned by the Executor seam. */
function mcpResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** MCP-shaped error result. */
function mcpError(text: string) {
  return { isError: true, content: [{ type: "text", text }] };
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    projectDir: "/work/one",
    status: "running",
    progress: { eventCount: 0, toolCalls: 0 },
    recentEvents: [],
    pendingBlocker: null,
    cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    durationMs: 1,
    ...overrides,
  };
}

function makeProducer(
  t: test.TestContext,
  opts: {
    poll: (project: unknown, sessionId?: string) => Promise<unknown>;
    options?: Record<string, unknown>;
  },
) {
  const sent: SessionEventFrame[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const producer = new SessionEventProducer({
    runtimeId: "runtime",
    projects: () => [PROJECT],
    poll: opts.poll as never,
    send: (frame) => sent.push(frame),
    logger: makeLogger(warnings) as never,
    ...(opts.options ?? {}),
  });
  t.after(() => producer.stopPolling());
  return { producer, sent, warnings };
}

const kinds = (sent: SessionEventFrame[]) => sent.map((frame) => frame.event.kind);

test("first observation emits session_started with a spec-shaped frame", async (t) => {
  const { producer, sent } = makeProducer(t, {
    poll: async () => mcpResult(statusPayload()),
  });
  await producer.pollOnce();

  assert.equal(sent.length, 1);
  const frame = sent[0]!;
  assert.equal(frame.type, "session_event");
  assert.equal(frame.runtimeId, "runtime");
  assert.equal(frame.projectAlias, "one");
  assert.equal(frame.sessionId, "s1");
  assert.equal(frame.seq, 1);
  assert.equal(frame.event.kind, "session_started");
  assert.deepEqual(frame.event.data, {});
  assert.ok(!Number.isNaN(Date.parse(frame.event.at)), "event.at must be ISO-8601");
});

test("normalizes turn, assistant text, tool call, and tool result deltas", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce(); // baseline: session_started only

  payload = statusPayload({
    progress: { eventCount: 4, toolCalls: 1 },
    recentEvents: [
      { type: "turn_start", turnIndex: 0 },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "Read", args: { path: "/x/file.ts" } },
      { type: "tool_execution_end", toolCallId: "tc1", toolName: "Read", result: { content: [{ type: "text", text: "file body" }] }, isError: false },
    ],
  });
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started", "turn_started", "assistant_text", "tool_call", "tool_result"]);
  assert.deepEqual(sent[1]!.event.data, { turn: 0 });
  assert.deepEqual(sent[2]!.event.data, { text: "hello world" });
  assert.deepEqual(sent[3]!.event.data, { name: "Read", summary: JSON.stringify({ path: "/x/file.ts" }) });
  assert.deepEqual(sent[4]!.event.data, { name: "Read", ok: true, summary: "file body" });
  assert.deepEqual(sent.map((frame) => frame.seq), [1, 2, 3, 4, 5]);
});

test("tool_use alias maps to tool_call; failing tool result maps ok:false", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce();

  payload = statusPayload({
    progress: { eventCount: 2, toolCalls: 1 },
    recentEvents: [
      { type: "tool_use", name: "Bash", args: { command: "rm -rf /tmp/x" } },
      { type: "tool_execution_end", toolName: "Bash", result: "boom", isError: true },
    ],
  });
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started", "tool_call", "tool_result"]);
  assert.equal(sent[1]!.event.data.name, "Bash");
  assert.deepEqual(sent[2]!.event.data, { name: "Bash", ok: false, summary: "boom" });
});

test("non-assistant messages and unknown raw events are ignored", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce();

  payload = statusPayload({
    progress: { eventCount: 4, toolCalls: 0 },
    recentEvents: [
      { type: "message_end", message: { role: "user", content: "hi" } },
      { type: "message_update", message: { role: "assistant" } },
      { type: "cost_update", cumulativeCost: 1 },
      { type: "agent_end", messages: [] },
    ],
  });
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started"]);
});

test("blocker lifecycle: pending on appearance, resolved on disappearance, idle once quiet", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce();

  payload = statusPayload({
    status: "blocked",
    pendingBlocker: { id: "b1", method: "select", message: "Proceed with deletion?" },
  });
  await producer.pollOnce();

  payload = statusPayload({ status: "running" });
  await producer.pollOnce();

  await producer.pollOnce(); // quiet after activity → idle
  await producer.pollOnce(); // still quiet → no second idle

  assert.deepEqual(kinds(sent), [
    "session_started",
    "blocker_pending",
    "blocker_resolved",
    "session_idle",
  ]);
  assert.deepEqual(sent[1]!.event.data, { blockerId: "b1", question: "Proceed with deletion?" });
  assert.deepEqual(sent[2]!.event.data, { blockerId: "b1" });
  assert.deepEqual(sent[3]!.event.data, {});
});

test("a blocked session is not reported idle", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce(); // baseline

  payload = statusPayload({
    progress: { eventCount: 1, toolCalls: 0 },
    recentEvents: [{ type: "turn_start", turnIndex: 0 }],
  });
  await producer.pollOnce(); // turn_started → activity

  payload = statusPayload({
    status: "blocked",
    progress: { eventCount: 1, toolCalls: 0 },
    pendingBlocker: { id: "b1", method: "confirm", message: "OK?" },
  });
  await producer.pollOnce(); // blocker_pending
  await producer.pollOnce(); // quiet but blocked → no idle

  assert.deepEqual(kinds(sent), ["session_started", "turn_started", "blocker_pending"]);
});

test("terminal statuses map to session_ended reasons; later repeats are ignored", async (t) => {
  for (const [status, reason] of [["completed", "completed"], ["cancelled", "cancelled"]] as const) {
    let payload = statusPayload();
    const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
    await producer.pollOnce();

    payload = statusPayload({ status });
    await producer.pollOnce();
    await producer.pollOnce(); // server still returns the ended session — no flap

    assert.deepEqual(kinds(sent), ["session_started", "session_ended"]);
    assert.deepEqual(sent[1]!.event.data, { reason });
  }
});

test("a reused sessionId is revived after it ended, with a continuing seq", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce(); // session_started (seq 1)

  payload = statusPayload({ status: "completed" });
  await producer.pollOnce(); // session_ended (seq 2)

  // Same sessionId reported active again (resumed): re-announce immediately
  // rather than waiting for the ~10 min TTL prune of the ended entry.
  payload = statusPayload({ status: "running" });
  await producer.pollOnce(); // session_started (seq 3)

  // A subsequent event streams as a normal delta on the revived session.
  payload = statusPayload({
    status: "running",
    progress: { eventCount: 1, toolCalls: 0 },
    recentEvents: [{ type: "turn_start", turnIndex: 0 }],
  });
  await producer.pollOnce(); // turn_started (seq 4)

  assert.deepEqual(kinds(sent), [
    "session_started",
    "session_ended",
    "session_started",
    "turn_started",
  ]);
  // seq keeps climbing across the revive so the relay's (device, session, seq)
  // dedupe accepts the resumed stream instead of dropping it as a replay.
  assert.deepEqual(sent.map((frame) => frame.seq), [1, 2, 3, 4]);
  assert.equal(sent[2]!.sessionId, "s1");
});

test("error status emits an error event before session_ended", async (t) => {
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce();

  payload = statusPayload({ status: "error", errorMessage: "agent process crashed" });
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started", "error", "session_ended"]);
  assert.deepEqual(sent[1]!.event.data, { message: "agent process crashed" });
  assert.deepEqual(sent[2]!.event.data, { reason: "error" });
});

test("a session that vanishes from the project is ended", async (t) => {
  let result: unknown = mcpResult(statusPayload());
  const { producer, sent } = makeProducer(t, { poll: async () => result });
  await producer.pollOnce();

  result = mcpError("No tracked GSD sessions. Call gsd_execute first, or pass projectDir for a session tracked by this server.");
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started", "session_ended"]);
  assert.deepEqual(sent[1]!.event.data, { reason: "completed" });
});

test("snapshot fires every 30s with status, open tool, pending blocker, and lastSeq", async (t) => {
  let now = 1_000_000;
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, {
    poll: async () => mcpResult(payload),
    options: { now: () => now },
  });
  await producer.pollOnce();
  assert.deepEqual(kinds(sent), ["session_started"]); // no snapshot at t0

  now += 31_000;
  payload = statusPayload({
    status: "blocked",
    progress: { eventCount: 1, toolCalls: 1 },
    recentEvents: [{ type: "tool_execution_start", toolCallId: "tc1", toolName: "Edit", args: {} }],
    pendingBlocker: { id: "b9", method: "input", message: "Which file?" },
  });
  await producer.pollOnce();

  const snapshot = sent.at(-1)!;
  assert.equal(snapshot.event.kind, "snapshot");
  assert.deepEqual(snapshot.event.data, {
    status: "blocked",
    activeTool: "Edit",
    pendingBlockerId: "b9",
    lastSeq: snapshot.seq, // the snapshot's own seq is the high-water mark
  });
});

test("seq stays monotonic across many cycles and never repeats", async (t) => {
  let eventCount = 0;
  const { producer, sent } = makeProducer(t, {
    poll: async () => {
      eventCount += 1;
      return mcpResult(statusPayload({
        progress: { eventCount, toolCalls: 0 },
        recentEvents: [{ type: "turn_start", turnIndex: eventCount }],
      }));
    },
  });
  for (let cycle = 0; cycle < 25; cycle += 1) {
    await producer.pollOnce();
  }
  const seqs = sent.map((frame) => frame.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, index) => index + 1));
});

test("replay buffer keeps the last 500 events and replays a bounded tail on restart", async (t) => {
  let eventCount = 0;
  const events: Array<Record<string, unknown>> = [];
  const { producer, sent } = makeProducer(t, {
    poll: async () => mcpResult(statusPayload({
      progress: { eventCount, toolCalls: 0 },
      recentEvents: events,
    })),
  });
  await producer.pollOnce(); // baseline: session_started only
  // 505 assistant texts + session_started = 506 frames → buffer trimmed to 500.
  for (let index = 0; index < 505; index += 1) {
    events.push({ type: "message_end", message: { role: "assistant", content: `msg ${index}` } });
  }
  eventCount = 505;
  await producer.pollOnce();
  assert.equal(sent.length, 506);

  const internals = producer as unknown as { sessions: Map<string, { replay: SessionEventFrame[] }> };
  const buffer = [...internals.sessions.values()][0]!.replay;
  assert.equal(buffer.length, 500);
  assert.equal(buffer[0]!.seq, 7); // session_started + first five texts dropped

  await producer.pollOnce(); // consume the idle transition so restart replay is exact
  assert.equal(sent.length, 507);
  producer.stopPolling();
  sent.length = 0;

  producer.start();
  await new Promise((resolve) => setImmediate(resolve)); // flush start()'s immediate poll
  assert.equal(sent.length, 100, "reconnect replays a bounded tail, not the whole buffer");
  assert.deepEqual(
    sent.map((frame) => frame.seq),
    buffer.slice(-100).map((frame) => frame.seq),
  );
});

test("assistant text is truncated to 2000 chars and frames stay under 8KB", async (t) => {
  const big = "x".repeat(50_000);
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce(); // baseline

  payload = statusPayload({
    progress: { eventCount: 2, toolCalls: 1 },
    recentEvents: [
      { type: "message_end", message: { role: "assistant", content: big } },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "Write", args: { content: big } },
    ],
  });
  await producer.pollOnce();

  const assistant = sent.find((frame) => frame.event.kind === "assistant_text")!;
  assert.equal((assistant.event.data.text as string).length, 2_000);
  const toolCall = sent.find((frame) => frame.event.kind === "tool_call")!;
  assert.equal((toolCall.event.data.summary as string).length, 500);
  for (const frame of sent) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 8 * 1024);
  }
});

test("pathologically oversized frames are skipped without burning a seq", async (t) => {
  let payload = statusPayload();
  const { producer, sent, warnings } = makeProducer(t, {
    poll: async () => mcpResult(payload),
    // Tiny bound: session_started/turn_started still fit, but a blocker payload
    // whose capped options array alone exceeds it can never be truncated to fit.
    options: { maxEventBytes: 400 },
  });
  await producer.pollOnce(); // session_started fits
  assert.deepEqual(kinds(sent), ["session_started"]);

  payload = statusPayload({
    status: "blocked",
    pendingBlocker: {
      id: "b1",
      method: "select",
      message: "q".repeat(100),
      options: Array.from({ length: 10 }, () => "o".repeat(500)),
    },
  });
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started"], "oversized frame is dropped");
  assert.ok(warnings.some((data) => data.kind === "blocker_pending"));

  payload = statusPayload({
    status: "blocked", // blocker still pending server-side; not re-announced
    progress: { eventCount: 1, toolCalls: 0 },
    recentEvents: [{ type: "turn_start", turnIndex: 0 }],
    pendingBlocker: {
      id: "b1",
      method: "select",
      message: "q".repeat(100),
      options: Array.from({ length: 10 }, () => "o".repeat(500)),
    },
  });
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started", "turn_started"]);
  assert.deepEqual(sent.map((frame) => frame.seq), [1, 2], "no seq gap from the dropped frame");
  assert.equal(
    warnings.filter((data) => data.kind === "blocker_pending").length,
    2,
    "blocker_pending is retried when the first emit is dropped",
  );
});

test("event window overflow reports the gap without re-emitting an overlapping tail", async (t) => {
  // The server keeps only the last three events. Between the baseline and the
  // next poll, five events elapsed, so two are unrecoverable (never in any
  // future window). The visible tail must be emitted exactly once and the gap
  // logged; a later poll that slides the window forward must not re-emit the
  // events it already streamed (duplicates carry fresh seqs the relay's
  // (device, session, seq) dedupe cannot catch).
  let payload = statusPayload();
  const { producer, sent, warnings } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce(); // baseline: eventCount 0

  payload = statusPayload({
    progress: { eventCount: 5, toolCalls: 0 },
    recentEvents: [
      { type: "tool_use", name: "e3" },
      { type: "tool_use", name: "e4" },
      { type: "tool_use", name: "e5" },
    ],
  });
  await producer.pollOnce();

  payload = statusPayload({
    progress: { eventCount: 6, toolCalls: 0 },
    recentEvents: [
      { type: "tool_use", name: "e4" },
      { type: "tool_use", name: "e5" },
      { type: "tool_use", name: "e6" },
    ],
  });
  await producer.pollOnce();

  const toolNames = sent.filter((frame) => frame.event.kind === "tool_call").map((frame) => frame.event.data.name);
  assert.deepEqual(toolNames, ["e3", "e4", "e5", "e6"], "no event is emitted twice across the gap");
  const seqs = sent.map((frame) => frame.seq);
  assert.deepEqual(seqs, [...new Set(seqs)], "seqs stay unique");
  assert.ok(
    warnings.some((data) => data.skipped === 2 && data.windowSize === 3),
    "the unrecoverable gap is reported",
  );
});

test("a server counter reset realigns the cursor instead of re-streaming the window", async (t) => {
  // When gsd_status reports a lower eventCount than we tracked (the session
  // object was rebuilt server-side and counts from a lower base), deltaEvents
  // re-streams the visible window once. The cursor must realign DOWN to the new
  // count; pinning it at the prior high-water mark would re-emit the whole
  // window on every later poll under fresh seqs the relay's (device, session,
  // seq) dedupe cannot catch.
  let payload = statusPayload();
  const { producer, sent } = makeProducer(t, { poll: async () => mcpResult(payload) });
  await producer.pollOnce(); // baseline: eventCount 0, session_started

  payload = statusPayload({
    progress: { eventCount: 3, toolCalls: 0 },
    recentEvents: [
      { type: "tool_use", name: "a1" },
      { type: "tool_use", name: "a2" },
      { type: "tool_use", name: "a3" },
    ],
  });
  await producer.pollOnce(); // streams a1, a2, a3; cursor at 3

  // Server counter resets to a lower base (session rebuilt); one new event.
  payload = statusPayload({
    progress: { eventCount: 1, toolCalls: 0 },
    recentEvents: [{ type: "tool_use", name: "b1" }],
  });
  await producer.pollOnce(); // re-streams the window once: b1

  // Counter moves forward from the reset base; only the new tail is new.
  payload = statusPayload({
    progress: { eventCount: 2, toolCalls: 0 },
    recentEvents: [
      { type: "tool_use", name: "b1" },
      { type: "tool_use", name: "b2" },
    ],
  });
  await producer.pollOnce(); // must emit only b2, not b1 again

  const toolNames = sent
    .filter((frame) => frame.event.kind === "tool_call")
    .map((frame) => frame.event.data.name);
  assert.deepEqual(
    toolNames,
    ["a1", "a2", "a3", "b1", "b2"],
    "the cursor realigns after the reset; no event is re-streamed",
  );
  const seqs = sent.map((frame) => frame.seq);
  assert.deepEqual(seqs, [...new Set(seqs)], "seqs stay unique");
});

test("concurrent session bound: extra sessions are skipped and logged once", async (t) => {
  const payloads: Record<string, unknown> = {
    s1: statusPayload({ sessionId: "s1" }),
    s2: statusPayload({ sessionId: "s2" }),
    s3: statusPayload({ sessionId: "s3" }),
  };
  const { producer, sent, warnings } = makeProducer(t, {
    poll: async (_project, sessionId) => {
      if (!sessionId) {
        return mcpError(
          "Multiple tracked GSD sessions; pass sessionId or projectDir. Tracked sessions: s1 /work/one; s2 /work/one; s3 /work/one",
        );
      }
      return mcpResult(payloads[sessionId]);
    },
    options: { maxSessions: 2 },
  });
  await producer.pollOnce();
  await producer.pollOnce();

  assert.deepEqual(
    sent.filter((frame) => frame.event.kind === "session_started").map((frame) => frame.sessionId),
    ["s1", "s2"],
  );
  const boundWarnings = warnings.filter((data) => data.maxSessions === 2);
  assert.equal(boundWarnings.length, 1, "skip is logged once, not every cycle");
  assert.equal(boundWarnings[0]!.sessionId, "s3");
});

test("per-session poll failure surfaces an error event", async (t) => {
  let failS2 = false;
  const { producer, sent } = makeProducer(t, {
    poll: async (_project, sessionId) => {
      if (!sessionId) {
        return mcpError("Multiple tracked GSD sessions; pass sessionId or projectDir. Tracked sessions: s1 /work/one; s2 /work/one");
      }
      if (sessionId === "s2" && failS2) throw new Error("MCP request timed out");
      return mcpResult(statusPayload({ sessionId }));
    },
  });
  await producer.pollOnce(); // track s1 + s2
  failS2 = true;
  await producer.pollOnce();

  const error = sent.find((frame) => frame.event.kind === "error")!;
  assert.equal(error.sessionId, "s2");
  assert.match(error.event.data.message as string, /timed out/);
});

test("per-session poll failure racing stopPolling does not emit onto the next connection", async (t) => {
  let stopDuringS2 = false;
  let producerRef: SessionEventProducer | undefined;
  const { producer, sent } = makeProducer(t, {
    poll: async (_project, sessionId) => {
      if (!sessionId) {
        return mcpError("Multiple tracked GSD sessions; pass sessionId or projectDir. Tracked sessions: s1 /work/one; s2 /work/one");
      }
      if (sessionId === "s2" && stopDuringS2) {
        // The WebSocket drops while this per-session poll is in flight:
        // stopPolling() bumps the generation before the poll settles.
        producerRef!.stopPolling();
        throw new Error("MCP request timed out");
      }
      return mcpResult(statusPayload({ sessionId }));
    },
  });
  producerRef = producer;
  await producer.pollOnce(); // track s1 + s2
  stopDuringS2 = true;
  await producer.pollOnce();

  assert.equal(
    sent.filter((frame) => frame.event.kind === "error").length,
    0,
    "a poll failure that outlives stopPolling must not emit a stale error frame",
  );
});

test("project-level poll failure logs and does not end tracked sessions", async (t) => {
  let result: unknown = mcpResult(statusPayload());
  const { producer, sent, warnings } = makeProducer(t, { poll: async () => result });
  await producer.pollOnce();

  result = mcpError("gsd MCP request 'tools/call' timed out after 1800000ms");
  await producer.pollOnce();

  assert.deepEqual(kinds(sent), ["session_started"], "no spurious session_ended on poll failure");
  assert.ok(warnings.some((data) => typeof data.error === "string"));
});

test("disabled producer emits zero frames", async (t) => {
  const { producer, sent } = makeProducer(t, {
    poll: async () => mcpResult(statusPayload()),
    options: { enabled: false },
  });
  producer.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// Config flag parsing
// ---------------------------------------------------------------------------

test("GSD_CLOUD_SESSION_EVENTS env override: 0/false disable, anything else enables", (t) => {
  const original = process.env["GSD_CLOUD_SESSION_EVENTS"];
  t.after(() => {
    if (original === undefined) delete process.env["GSD_CLOUD_SESSION_EVENTS"];
    else process.env["GSD_CLOUD_SESSION_EVENTS"] = original;
  });
  const base = { cloud: { gateway_url: "https://cloud.example.net" } };

  process.env["GSD_CLOUD_SESSION_EVENTS"] = "0";
  assert.equal(validateConfig(base).cloud?.session_events, false);
  process.env["GSD_CLOUD_SESSION_EVENTS"] = "false";
  assert.equal(validateConfig(base).cloud?.session_events, false);
  process.env["GSD_CLOUD_SESSION_EVENTS"] = "1";
  assert.equal(validateConfig(base).cloud?.session_events, true);
  delete process.env["GSD_CLOUD_SESSION_EVENTS"];
  assert.equal(validateConfig(base).cloud?.session_events, undefined, "unset means default-on");
  assert.equal(
    validateConfig({ cloud: { gateway_url: "https://cloud.example.net", session_events: false } }).cloud?.session_events,
    false,
    "yaml flag is honored when the env var is unset",
  );
});

// ---------------------------------------------------------------------------
// CloudRuntime wiring
// ---------------------------------------------------------------------------

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

type FakeSocket = { readyState: number; sent: string[]; send: (t: string) => void; close: () => void };
function fakeSocket(readyState: number = WebSocket.OPEN): FakeSocket {
  const sent: string[] = [];
  return { readyState, sent, send: (t: string) => sent.push(t), close: () => undefined };
}

function makeWiredRuntime(cloud: Record<string, unknown>, executor: Record<string, unknown>) {
  const runtime = new CloudRuntime(
    { gateway_url: "wss://cloud.example.net", device_token: "fixture", runtime_id: "runtime", ...cloud } as never,
    executor as never,
    noopLogger as never,
  );
  const internals = runtime as unknown as {
    socket: FakeSocket | undefined;
    handleSocketOpen: (socket: unknown) => void;
    handleSocketClose: (socket: unknown) => void;
    sessionEvents: SessionEventProducer | undefined;
  };
  return { runtime, internals };
}

const wiredExecutor = {
  advertisedProjects: async () => [PROJECT],
  execute: async (toolName: string) => {
    assert.equal(toolName, "gsd_status");
    return mcpResult(statusPayload());
  },
};

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("producer starts after the hello and streams session_event frames", async (t) => {
  const { runtime, internals } = makeWiredRuntime({}, wiredExecutor);
  t.after(() => runtime.stop());
  const socket = fakeSocket();
  internals.socket = socket;

  internals.handleSocketOpen(socket);
  await flushAsync();

  const frames = socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  const helloIndex = frames.findIndex((frame) => frame.type === "hello");
  const eventIndex = frames.findIndex((frame) => frame.type === "session_event");
  assert.ok(helloIndex !== -1, "hello is sent");
  assert.ok(eventIndex > helloIndex, "session_event frames follow the hello");
  assert.equal((frames[eventIndex] as { event?: { kind?: string } }).event?.kind, "session_started");
  assert.equal(frames[eventIndex]!.runtimeId, "runtime");
});

test("session_events: false produces zero session_event frames", async (t) => {
  const { runtime, internals } = makeWiredRuntime({ session_events: false }, wiredExecutor);
  t.after(() => runtime.stop());
  const socket = fakeSocket();
  internals.socket = socket;

  internals.handleSocketOpen(socket);
  await flushAsync();

  assert.equal(internals.sessionEvents, undefined, "producer is never created");
  assert.ok(socket.sent.every((text) => (JSON.parse(text) as { type: string }).type !== "session_event"));
});

test("socket close pauses polling; reconnect resumes without recreating the producer", async (t) => {
  const { runtime, internals } = makeWiredRuntime({}, wiredExecutor);
  t.after(() => runtime.stop());
  const socket = fakeSocket();
  internals.socket = socket;

  internals.handleSocketOpen(socket);
  await flushAsync();
  const producer = internals.sessionEvents;
  assert.ok(producer);
  assert.ok((producer as unknown as { timer?: unknown }).timer !== undefined);

  internals.handleSocketClose(socket);
  assert.equal((producer as unknown as { timer?: unknown }).timer, undefined, "polling stops on close");

  const reopened = fakeSocket();
  internals.socket = reopened;
  internals.handleSocketOpen(reopened);
  await flushAsync();

  assert.equal(internals.sessionEvents, producer, "same producer resumes across reconnects");
  assert.ok(
    reopened.sent.some((text) => (JSON.parse(text) as { type: string }).type === "session_event"),
    "replayed/heartbeat frames flow on the new socket",
  );
});

test("session events bypass the offline outbox; must-deliver frames are buffered", (t) => {
  const { runtime, internals } = makeWiredRuntime({}, wiredExecutor);
  t.after(() => runtime.stop());
  // No open socket: a session_event is dropped (the producer's replay buffer
  // redelivers it on reconnect) so it cannot evict a queued tool_result from
  // the bounded offline outbox.
  const priv = internals as unknown as {
    sendSessionEvent: (frame: unknown, projectPath?: string) => void;
    send: (message: unknown, projectPath?: string) => void;
    outbox: Array<{ text: string }>;
  };
  priv.sendSessionEvent({ type: "session_event", seq: 1 });
  priv.send({ type: "tool_result", requestId: "r1", result: {} });

  const buffered = priv.outbox.map((frame) => (JSON.parse(frame.text) as { type: string }).type);
  assert.deepEqual(buffered, ["tool_result"], "only the tool_result is queued while disconnected");
});
