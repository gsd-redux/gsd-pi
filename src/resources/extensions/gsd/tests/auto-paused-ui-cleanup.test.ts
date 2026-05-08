import { test } from "node:test";
import assert from "node:assert/strict";
import { autoSession } from "../auto-runtime-state.ts";
import { _cleanupAfterLoopExitForTest } from "../auto.ts";

test.afterEach(() => {
  autoSession.reset();
});

test("#3370: cleanupAfterLoopExit preserves paused auto badge after provider pause", () => {
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];
  autoSession.active = true;
  autoSession.paused = true;

  _cleanupAfterLoopExitForTest({
    ui: {
      setStatus: (...args: unknown[]) => statusCalls.push(args),
      setWidget: (...args: unknown[]) => widgetCalls.push(args),
    },
  } as any);

  assert.deepEqual(statusCalls, []);
  assert.deepEqual(widgetCalls, []);
  assert.equal(autoSession.active, false);
  assert.equal(autoSession.paused, true);
});

test("#3370: cleanupAfterLoopExit clears status and widget when auto is not paused", () => {
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];
  autoSession.active = true;
  autoSession.paused = false;

  _cleanupAfterLoopExitForTest({
    ui: {
      setStatus: (...args: unknown[]) => statusCalls.push(args),
      setWidget: (...args: unknown[]) => widgetCalls.push(args),
    },
  } as any);

  assert.deepEqual(statusCalls, [["gsd-auto", undefined]]);
  assert.deepEqual(widgetCalls, [["gsd-progress", undefined]]);
});
