// Regression/behavior tests for the production wiring of the GitHub Copilot
// model catalog check (/gsd copilot-models). Exercises the real entry point —
// ctx.modelRegistry gating, last-known-good preservation, and deduped diff
// notifications — as opposed to the pure-function fixtures in
// copilot-model-catalog.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetCopilotModelsSessionStateForTests,
  handleCopilotModels,
} from "../commands/handlers/copilot-models.js";
import { readModelsCatalogOverlay } from "../copilot-overlay-writer.js";

interface FakeModel {
  id: string;
  provider: string;
}

function createFakeCtx(options: {
  models?: FakeModel[];
  apiKey?: string | undefined;
}): { ctx: any; notifications: Array<{ message: string; level: string }> } {
  const notifications: Array<{ message: string; level: string }> = [];
  const models = options.models ?? [];
  const ctx = {
    modelRegistry: {
      getAll: () => models.map((model) => ({ ...model, api: "openai-completions", name: model.id, baseUrl: "https://example.test", provider: model.provider, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, compat: {} })),
      getAvailable: () => models,
      getApiKey: async (_model: FakeModel) => options.apiKey,
    },
    ui: {
      notify: (message: string, level: string = "info") => {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx, notifications };
}

function jsonResponse(data: Array<Record<string, unknown>>) {
  return async () => ({ ok: true, json: async () => ({ data }) }) as unknown as Response;
}

test("handleCopilotModels: no Copilot model available makes zero network requests", async () => {
  _resetCopilotModelsSessionStateForTests();
  let fetchCalled = false;
  const { ctx, notifications } = createFakeCtx({ models: [] });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false, "no network request without a configured Copilot credential");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /not configured/);
  assert.equal(notifications[0].level, "info");
});

test("handleCopilotModels: missing API key warns without a network request", async () => {
  _resetCopilotModelsSessionStateForTests();
  let fetchCalled = false;
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /no access token/);
});

test("handleCopilotModels: first successful check reports model count and caches snapshot", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /2 model\(s\) available/);
});

test("handleCopilotModels: reports added/removed/changed drift and dedupes repeats", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  const drift = notifications[1];
  assert.equal(drift.level, "info");
  assert.match(drift.message, /\+ mai-code-1\.1-flash added/);
  assert.match(drift.message, /- claude-sonnet-5 removed/);

  // Re-running the identical fetch should not repeat the same drift notice.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
    ]) as unknown as typeof fetch,
  });
  assert.equal(notifications.length, 3);
  assert.match(notifications[2].message, /no new changes/);
});

test("handleCopilotModels: fetch failure preserves last-known-good snapshot", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch,
  });
  assert.equal(notifications[1].level, "warning");
  assert.match(notifications[1].message, /refresh failed/);

  // A subsequent successful call must diff against the pre-failure baseline,
  // proving the failed attempt never clobbered the cached snapshot.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "gpt-5.5", name: "GPT-5.5", tool_call: true },
    ]) as unknown as typeof fetch,
  });
  assert.match(notifications[2].message, /\+ gpt-5\.5 added/);
});

test("handleCopilotModels: empty response never overwrites the cached catalog", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([]) as unknown as typeof fetch,
  });
  assert.equal(notifications[1].level, "warning");
  assert.match(notifications[1].message, /empty response/);
});

test("handleCopilotModels: failure with no cached catalog yet reports clearly", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch,
  });

  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /no cached catalog yet/);
});

test("handleCopilotModels: newly added model with a known GSD capability tier is annotated", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  // claude-sonnet-5 has a real, existing "standard" entry in MODEL_CAPABILITY_TIER.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.match(notifications[1].message, /\+ claude-sonnet-5 added.*\(known capability tier: standard\)/);
});

test("handleCopilotModels: newly added model without a GSD capability profile is flagged as manual-only", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  // "brand-new-unreleased-model" has no entry in MODEL_CAPABILITY_TIER.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-unreleased-model", name: "Brand New Unreleased Model", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.match(
    notifications[1].message,
    /\+ brand-new-unreleased-model added.*\(no GSD capability profile yet — manual selection only, not auto-routed\)/,
  );
});

test("handleCopilotModels: without --register, newly added models are never written to the overlay", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(readModelsCatalogOverlay(overlayPath), null, "no --register flag means no overlay file is ever written");
});

test("handleCopilotModels: --register quarantines remote-only models instead of persisting placeholders", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  const onDisk = readModelsCatalogOverlay(overlayPath);
  assert.equal(onDisk, null, "remote-only models are quarantined instead of persisting placeholder metadata");
  assert.match(notifications[1].message, /quarantined|remote-only|not persisted/i);
});

test("handleCopilotModels: --register on a no-diff run makes no overlay writes", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  // First call establishes the cached snapshot (no diff computed yet).
  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  assert.equal(readModelsCatalogOverlay(overlayPath), null, "first-run report has no diff.added, so nothing to register yet");
});

test("handleCopilotModels: --register keeps remote-only models quarantined and never persists placeholders", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-quarantine-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(readModelsCatalogOverlay(overlayPath), null, "no placeholder metadata may be persisted for remote-only models");
  assert.match(notifications[1].message, /quarantined.*brand-new-model|remote-only.*quarantined|not persisted/i);
});
