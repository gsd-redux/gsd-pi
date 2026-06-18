import assert from "node:assert/strict";
import test from "node:test";

import { isClaudeCodeWorkflowModel, liveEnv, normalizeLiveWorkflowModel } from "./harness.ts";

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
  const previousModel = process.env.GSD_LIVE_WORKFLOW_MODEL;
  const previousHome = process.env.HOME;
  process.env.GSD_LIVE_WORKFLOW_MODEL = "claude-code/claude-haiku-4-5";
  process.env.HOME = "/tmp/real-claude-home";
  t.after(() => {
    if (previousModel === undefined) delete process.env.GSD_LIVE_WORKFLOW_MODEL;
    else process.env.GSD_LIVE_WORKFLOW_MODEL = previousModel;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  assert.equal(liveEnv().HOME, "/tmp/real-claude-home");
  assert.equal(liveEnv({ HOME: "/tmp/custom-home" }).HOME, "/tmp/custom-home");
});
