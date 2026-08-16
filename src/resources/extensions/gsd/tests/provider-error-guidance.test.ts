import test from "node:test";
import assert from "node:assert/strict";

import { classifyError, isTransient } from "../error-classifier.ts";
import {
  resolveProviderErrorGuidance,
  unitTypeToPrefsPhaseKey,
} from "../provider-error-guidance.ts";
import { formatGuidance } from "../guidance.ts";

test("classifyError: Cloud Code Assist 400 invalid argument is model-error", () => {
  const result = classifyError(
    "Cloud Code Assist API error (400): Request contains an invalid argument.",
  );
  assert.equal(result.kind, "model-error");
  assert.equal(isTransient(result), false);
});

test("classifyError: Cloud Code Assist const schema rejection is model-error", () => {
  const result = classifyError(
    "Cloud Code Assist API error (400): Invalid JSON payload received. Unknown name \"const\" at 'request.tools[0].function_declarations[10].parameters.properties[0].value.any_of[0]': Cannot find field.",
  );
  assert.equal(result.kind, "model-error");
  assert.equal(isTransient(result), false);
});

test("classifyError: Cloud Code Assist patternProperties schema rejection is model-error", () => {
  const result = classifyError(
    "Cloud Code Assist API error (400): Invalid JSON payload received. Unknown name \"patternProperties\" at 'request.tools[0].function_declarations[50].parameters.properties[5].value': Cannot find field.",
  );
  assert.equal(result.kind, "model-error");
  assert.equal(isTransient(result), false);
});

test("classifyError: Claude input_schema draft 2020-12 rejection is model-error", () => {
  const result = classifyError(
    'Cloud Code Assist API error (400): {"type":"error","error":{"type":"invalid_request_error","message":"tools.27.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12 (https://json-schema.org/draft/2020-12). Learn more about tool use at https://docs.claude.com/en/docs/tool-use."}}',
  );
  assert.equal(result.kind, "model-error");
  assert.equal(isTransient(result), false);
});

test("classifyError: xAI grammar limit is model-error", () => {
  const result = classifyError("Grammar is too complex");
  assert.equal(result.kind, "model-error");
});

test("classifyError: Anthropic cache_control.ttl ordering 400 is model-error (#1709)", () => {
  const result = classifyError(
    "API Error: 400 messages.16.content.0.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block. Note that blocks are processed in the following order: `tools`, `system`, `messages`.",
  );
  assert.equal(result.kind, "model-error");
  assert.equal(isTransient(result), false);
});

test("classifyError: context window 400 stays server (transient)", () => {
  const result = classifyError("400 invalid params, context window exceeds limit (2013)");
  assert.equal(result.kind, "server");
  assert.ok(isTransient(result));
});

test("unitTypeToPrefsPhaseKey maps research units", () => {
  assert.equal(unitTypeToPrefsPhaseKey("research-milestone"), "research");
  assert.equal(unitTypeToPrefsPhaseKey("plan-slice"), "planning");
});

test("resolveProviderErrorGuidance suggests Antigravity migration for deprecated Gemini CLI", () => {
  const guidance = resolveProviderErrorGuidance({
    errorMsg:
      "IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google.",
    provider: "google-gemini-cli",
    modelId: "gemini-2.5-pro",
    unitType: "execute-task",
  });

  assert.match(guidance.summary, /Antigravity CLI/);
  assert.ok(guidance.steps.some((step) => step.includes("antigravity.google/cli/install.sh")));
  assert.ok(guidance.steps.some((step) => step.includes("/login")));
  assert.ok(guidance.steps.some((step) => step.includes("/gsd next")));
});

test("resolveProviderErrorGuidance suggests gemini-3-flash for antigravity pro-high", () => {
  const guidance = resolveProviderErrorGuidance({
    errorMsg: "Cloud Code Assist API error (400): Request contains an invalid argument.",
    provider: "google-antigravity",
    modelId: "gemini-3.1-pro-high",
    unitType: "research-milestone",
    preferencesPath: "/tmp/project/.gsd/PREFERENCES.md",
    hasConfiguredFallbacks: false,
  });

  assert.match(guidance.summary, /google-antigravity\/gemini-3\.1-pro-high/);
  assert.match(guidance.summary, /research-milestone/);
  assert.ok(
    guidance.steps.some((step) => step.includes("models.research") && step.includes("gemini-3-flash")),
  );
  assert.ok(guidance.steps.some((step) => step.includes("/gsd next")));
  assert.ok(guidance.steps.some((step) => step.includes("fallbacks")));
});

test("formatGuidance numbers steps", () => {
  const text = formatGuidance({
    summary: "Provider error on test/model.",
    steps: ["Change model", "Run /gsd next"],
  });
  assert.match(text, /^Provider error on test\/model\./);
  assert.match(text, /1\. Change model/);
  assert.match(text, /2\. Run \/gsd next/);
});
