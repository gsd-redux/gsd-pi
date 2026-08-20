// Project/App: gsd-pi
// File Purpose: Regression tests for ScheduleWakeup tool behavior.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { autoSession } from "../auto-runtime-state.ts";
import {
  registerScheduleWakeupTool,
  _resetInteractiveWakeupsForTest,
} from "../bootstrap/schedule-wakeup-tool.ts";

test("ScheduleWakeup arms an interactive wakeup when auto-mode is inactive", async () => {
  autoSession.reset();
  _resetInteractiveWakeupsForTest();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: unknown; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.equal(tool.name, "gsd_schedule_wakeup");

    const result = await tool.execute(
      "call-1",
      {
        delaySeconds: 1,
        prompt: "Check the external job and report back.",
        reason: "poll external job",
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Wakeup scheduled for 1s/);
    assert.equal(sent.length, 0, "wakeup should not dispatch synchronously");

    mock.timers.tick(999);
    assert.equal(sent.length, 0, "wakeup should wait for the configured delay");

    mock.timers.tick(1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].options, { triggerTurn: true });
    assert.deepEqual(sent[0].message, {
      customType: "gsd-schedule-wakeup",
      content: "Check the external job and report back.",
      display: true,
      details: {
        delaySeconds: 1,
        reason: "poll external job",
      },
    });
  } finally {
    mock.timers.reset();
    _resetInteractiveWakeupsForTest();
    autoSession.reset();
  }
});

test("ScheduleWakeup re-arm cancels the prior interactive timer instead of stacking", async () => {
  autoSession.reset();
  _resetInteractiveWakeupsForTest();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: any; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options } as { message: any; options: unknown });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.equal(tool.name, "gsd_schedule_wakeup");

    const ctx = { cwd: process.cwd() };
    await tool.execute(
      "call-1",
      { delaySeconds: 5, prompt: "stale prompt", reason: "first arm" },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "call-2",
      { delaySeconds: 5, prompt: "fresh prompt", reason: "re-arm" },
      undefined,
      undefined,
      ctx,
    );

    mock.timers.tick(5000);

    assert.equal(sent.length, 1, "re-arming must not stack overlapping wakeups");
    assert.equal(sent[0].message.content, "fresh prompt");
  } finally {
    mock.timers.reset();
    _resetInteractiveWakeupsForTest();
    autoSession.reset();
  }
});

test("ScheduleWakeup keeps interactive wakeups isolated per session base path", async () => {
  autoSession.reset();
  _resetInteractiveWakeupsForTest();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: any; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options } as { message: any; options: unknown });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.equal(tool.name, "gsd_schedule_wakeup");

    // Two concurrent interactive sessions (different cwds) arm wakeups. One
    // session re-arming must not cancel the other session's pending wakeup.
    await tool.execute(
      "call-a",
      { delaySeconds: 5, prompt: "session A", reason: "poll A" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    await tool.execute(
      "call-b",
      { delaySeconds: 5, prompt: "session B", reason: "poll B" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    mock.timers.tick(5000);

    assert.equal(sent.length, 2, "distinct sessions must each keep their wakeup");
    assert.deepEqual(
      sent.map((s) => s.message.content).sort(),
      ["session A", "session B"],
    );
  } finally {
    mock.timers.reset();
    _resetInteractiveWakeupsForTest();
    autoSession.reset();
  }
});
