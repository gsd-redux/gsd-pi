// GSD-2 — regression tests for non-destructive depth gate (Fix #2).
//
// Two coupled bugs caused users to get stuck after answering "no" to a depth
// verification gate:
//
//   1) `setPendingGate` deleted `verifiedDepthMilestones[milestoneId]` on every
//      ask, even when the milestone had already been depth-verified. This
//      created disk/DB divergence: any prior CONTEXT.md/state from the verified
//      window was suddenly orphaned because the milestone was treated as
//      un-verified again.
//
//   2) The `tool_result` handler only called `clearPendingGate()` when the
//      user's answer matched the confirmation option. Any non-confirmation
//      response (e.g. "Needs adjustment") left `pendingGateId` set, which
//      blocks all non-read-only tool calls via `shouldBlockPendingGate`. The
//      user was permanently locked for the session — `gsd_plan_milestone` and
//      every subsequent write would HARD BLOCK on the lingering gate.
//
// These tests pin the fixed behavior:
//   - setPendingGate preserves a previously verified milestone state.
//   - A non-confirmation response (e.g. "Needs adjustment") clears the pending
//     gate so the model can iterate without being permanently blocked.
//   - The cancellation path (no response at all) still keeps the gate pending
//     and returns the HARD BLOCK message — that case must not regress.
//   - The confirmation path still verifies the milestone and clears the gate.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  getPendingGate,
  isMilestoneDepthVerified,
  markDepthVerified,
  resetWriteGateState,
  setPendingGate,
} from "../bootstrap/write-gate.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-depth-gate-non-destructive-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupHandlers(): Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>> {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  registerHooks(pi, []);
  return handlers;
}

test("setPendingGate preserves an already-verified milestone (does not destructively un-verify)", () => {
  resetWriteGateState();
  try {
    // Simulate the auto-dispatch path that auto-marks depth verified for a
    // milestone in non-deep mode (auto-dispatch.ts:384/531/696).
    markDepthVerified("M001");
    assert.equal(isMilestoneDepthVerified("M001"), true);

    // Model later calls ask_user_questions with the same milestone's gate.
    // Pre-fix: setPendingGate destroyed the prior verification, blocking all
    // subsequent CONTEXT.md writes / artifact saves for the milestone.
    setPendingGate("depth_verification_M001_confirm");

    assert.equal(
      isMilestoneDepthVerified("M001"),
      true,
      "milestone must remain verified — pending the gate is not the same as undoing prior approval",
    );
    assert.equal(getPendingGate(), "depth_verification_M001_confirm");
  } finally {
    resetWriteGateState();
  }
});

test("non-confirmation answer ('Needs adjustment') clears the pending gate", async (t) => {
  const dir = makeTempDir("needs-adjustment");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState();

  t.after(() => {
    resetWriteGateState();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const handlers = setupHandlers();

  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture this correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }
  assert.equal(getPendingGate(), questionId, "gate is pending after the ask");

  // User picks the non-recommended option — they engaged but want to iterate,
  // not approve. Pre-fix: pendingGateId stayed set forever and every
  // subsequent tool call would HARD BLOCK.
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Needs adjustment" },
          },
        },
      },
    });
  }

  assert.equal(
    getPendingGate(),
    null,
    "non-confirmation answer must clear pendingGate so user is not permanently locked",
  );
  // Critically: depth must NOT be marked verified. The user said no.
  assert.equal(
    isMilestoneDepthVerified("M001"),
    false,
    "non-confirmation must not mark the milestone as depth-verified",
  );
});

test("non-confirmation answer preserves a previously-verified milestone (Bug-1 + Bug-2 interaction)", async (t) => {
  const dir = makeTempDir("preserved");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState();

  t.after(() => {
    resetWriteGateState();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const handlers = setupHandlers();

  // Seed the auto-dispatch verification (non-deep mode) before the gate fires.
  markDepthVerified("M001");
  assert.equal(isMilestoneDepthVerified("M001"), true);

  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture this correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }
  // After Fix #2 (non-destructive setPendingGate) the milestone stays
  // verified even while the gate is pending.
  assert.equal(
    isMilestoneDepthVerified("M001"),
    true,
    "pending the gate must not destroy prior auto-dispatch verification",
  );

  // User declines.
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Needs adjustment" },
          },
        },
      },
    });
  }

  assert.equal(getPendingGate(), null, "decline still clears pending gate");
  assert.equal(
    isMilestoneDepthVerified("M001"),
    true,
    "decline must not undo a previously-marked verification — that is the disk/DB divergence regression",
  );
});

test("cancellation (no response) still keeps gate pending and returns HARD BLOCK", async (t) => {
  // Negative-control: the cancellation path is unchanged — the user did not
  // engage, so the gate must remain locked and the model must be told it has
  // no implicit approval.
  const dir = makeTempDir("cancelled");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState();

  t.after(() => {
    resetWriteGateState();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const handlers = setupHandlers();

  const questionId = "depth_verification_M002_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture this correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }

  let patch: any;
  for (const handler of handlers.get("tool_result") ?? []) {
    const result = await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null },
    });
    if (result) patch = result;
  }

  assert.equal(getPendingGate(), questionId, "cancelled question must leave gate pending");
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /HARD BLOCK: approval gate "depth_verification_M002_confirm" is still pending/,
  );
});

test("confirmation answer still marks verified and clears (positive control)", async (t) => {
  const dir = makeTempDir("confirmed");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState();

  t.after(() => {
    resetWriteGateState();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const handlers = setupHandlers();

  const questionId = "depth_verification_M003_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture this correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    });
  }

  assert.equal(getPendingGate(), null);
  assert.equal(isMilestoneDepthVerified("M003"), true);
});
