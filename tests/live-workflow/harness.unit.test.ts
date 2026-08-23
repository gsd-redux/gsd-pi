import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialNames,
  hasUsableCredentials,
  isClaudeCodeWorkflowModel,
  liveEnv,
  normalizeLiveWorkflowModel,
} from "./harness.ts";

function withEnv(t: { after: (fn: () => void) => void }, overrides: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("GSD_LIVE_WORKFLOW_USE_HOME=1 forwards HOME and counts as a credential source", (t) => {
  withEnv(t, { GSD_LIVE_WORKFLOW_MODEL: undefined, GSD_LIVE_WORKFLOW_USE_HOME: "1", HOME: "/tmp/operator-home" });
  assert.equal(liveEnv().HOME, "/tmp/operator-home");
  assert.ok(credentialNames().includes("GSD_LIVE_WORKFLOW_USE_HOME"));
  assert.equal(hasUsableCredentials(), true);
});

test("without GSD_LIVE_WORKFLOW_USE_HOME the child keeps an isolated HOME", (t) => {
  withEnv(t, { GSD_LIVE_WORKFLOW_MODEL: undefined, GSD_LIVE_WORKFLOW_USE_HOME: undefined, HOME: "/tmp/operator-home" });
  assert.equal(liveEnv().HOME, undefined);
  assert.ok(!credentialNames().includes("GSD_LIVE_WORKFLOW_USE_HOME"));
});

test("normalizeLiveWorkflowModel maps claude-code-cli aliases to the registered provider", () => {
  assert.equal(normalizeLiveWorkflowModel("claude-code-cli"), "claude-code");
  assert.equal(normalizeLiveWorkflowModel("claude-code-cli/claude-haiku-4-5"), "claude-code/claude-haiku-4-5");
  assert.equal(normalizeLiveWorkflowModel("claude-code/claude-haiku-4-5"), "claude-code/claude-haiku-4-5");
  assert.equal(normalizeLiveWorkflowModel(" google-gemini-cli/gemini-2.5-flash "), "google-gemini-cli/gemini-2.5-flash");
});

test("isClaudeCodeWorkflowModel recognizes Claude Code CLI workflow models", () => {
  assert.equal(isClaudeCodeWorkflowModel("claude-code/claude-haiku-4-5"), true);
  assert.equal(isClaudeCodeWorkflowModel("claude-code"), true);
  assert.equal(isClaudeCodeWorkflowModel("claude-code-cli/claude-haiku-4-5"), true);
  assert.equal(isClaudeCodeWorkflowModel("claude-code-cli"), true);
  assert.equal(isClaudeCodeWorkflowModel("google-gemini-cli/gemini-2.5-flash"), false);
});

test("liveEnv preserves HOME when live workflow targets Claude Code CLI", (t) => {
  withEnv(t, { GSD_LIVE_WORKFLOW_MODEL: "claude-code/claude-haiku-4-5", HOME: "/tmp/real-claude-home" });

  assert.equal(liveEnv().HOME, "/tmp/real-claude-home");
  assert.equal(liveEnv({ HOME: "/tmp/custom-home" }).HOME, "/tmp/custom-home");
});
