/**
 * Regression test for #2230: the headless query path must call
 * resolveDispatch with preview: true so a read-only query computes the
 * next-action preview without persisting dispatch effects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runHeadlessQuery } from "../headless-query.ts";

test("headless query passes preview: true to resolveDispatch (#2230)", async () => {
  const resolveDispatchArgs: Array<Record<string, unknown>> = [];

  const result = await runHeadlessQuery(
    "/tmp/project",
    {
      openProjectDbIfPresent: async () => {},
      deriveState: async () => ({
        phase: "evaluating-gates",
        nextAction: "evaluate quality gates",
        activeMilestone: { id: "M001", title: "Test Milestone" },
      }),
      resolveDispatch: async (opts: Record<string, unknown>) => {
        resolveDispatchArgs.push(opts);
        return { action: "skip" };
      },
      readAllSessionStatuses: () => [],
      loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    } as any,
    () => {},
  );

  assert.equal(result.exitCode, 0);
  assert.equal(resolveDispatchArgs.length, 1);
  assert.equal(resolveDispatchArgs[0].preview, true);
  assert.equal(result.data?.next.action, "skip");
});
