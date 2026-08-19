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
import { getGsdArgumentCompletions } from "../commands/catalog.js";

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

// ─── why <model>: strict parsing, registry analysis, routing eligibility ────

test("handleCopilotModels: why with no model argument reports usage and never touches auth or network", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });
  let fetchCalled = false;
  let apiKeyCalled = false;
  ctx.modelRegistry.getApiKey = async () => { apiKeyCalled = true; return "token-abc"; };

  await handleCopilotModels("why", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });
  await handleCopilotModels("why   ", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(apiKeyCalled, false);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].message, "Usage: /gsd copilot-models why <model>");
  assert.equal(notifications[0].level, "warning");
  assert.equal(notifications[1].message, "Usage: /gsd copilot-models why <model>");
});

test("handleCopilotModels: 'whywhatever' and 'why-gpt-5.4' are not recognized as the why command", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });

  await handleCopilotModels("whywhatever", ctx, {});
  await handleCopilotModels("why-gpt-5.4", ctx, {});

  // Both fall through to the normal sync path (no configured Copilot model
  // here), proving neither string was strictly parsed as "why".
  assert.equal(notifications.length, 2);
  assert.match(notifications[0].message, /not configured/);
  assert.match(notifications[1].message, /not configured/);
});

test("handleCopilotModels: why accepts a bare Copilot model ID", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, {
    fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  assert.match(notifications[0].message, /^GitHub Copilot: why github-copilot\/gpt-5\.4$/m);
  assert.match(notifications[0].message, /^- identity: github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why accepts a provider-qualified Copilot model ID", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why github-copilot/gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- identity: github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why rejects non-GitHub-Copilot provider-qualified model IDs", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  let fetchCalled = false;
  await handleCopilotModels("why anthropic/claude-sonnet-5", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      return jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }])() as unknown as Response;
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false, "wrong-provider why requests must not trigger fetches");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /github copilot.*anthropic|only accepts github-copilot|wrong provider/i);
});

test("handleCopilotModels: why never matches a bare ID that only exists under a different provider", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "claude-sonnet-5", provider: "anthropic" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why claude-sonnet-5", ctx, {});

  assert.match(notifications[0].message, /^- effective local: no$/m);
  assert.match(notifications[0].message, /^- session available: no$/m);
  assert.match(notifications[0].message, /^- last known live catalog: unknown$/m);
});

test("handleCopilotModels: why reports effective-local and session-available as yes when both hold", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- effective local: yes$/m);
  assert.match(notifications[0].message, /^- session available: yes$/m);
});

test("handleCopilotModels: why reports session-available as no when the model is local but not session-ready", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });
  ctx.modelRegistry.getAvailable = () => [];

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- effective local: yes$/m);
  assert.match(notifications[0].message, /^- session available: no$/m);
  assert.match(notifications[0].message, /^- automatic routing eligible: no$/m);
  assert.match(notifications[0].message, /^- reason: unavailable in this session$/m);
});

test("handleCopilotModels: why flags a remote-only snapshot model as quarantined and non-routable", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  // Establish a live snapshot that includes a model absent from the local registry.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "remote-only-model", name: "Remote Only Model", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("why remote-only-model", ctx, {
    fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  const explanation = notifications[notifications.length - 1].message;
  assert.match(explanation, /^- effective local: no$/m);
  assert.match(explanation, /^- last known live catalog: yes$/m);
  assert.match(explanation, /^- automatic routing eligible: no$/m);
  assert.match(explanation, /^- reason: remote-only and quarantined$/m);
});

test("handleCopilotModels: why reports last known live catalog as yes when the snapshot contains the model", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[1].message, /^- last known live catalog: yes$/m);
});

test("handleCopilotModels: why reports last known live catalog as no when the snapshot exists but omits the model", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("why totally-different-model", ctx, {});

  assert.match(notifications[1].message, /^- last known live catalog: no$/m);
});

test("handleCopilotModels: why reports last known live catalog as unknown when no snapshot exists yet", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- last known live catalog: unknown$/m);
});

test("handleCopilotModels: why marks an unknown capability tier/confidence as not routing-eligible", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "totally-custom-model-x", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why totally-custom-model-x", ctx, {});

  assert.match(notifications[0].message, /^- capability tier: unknown$/m);
  assert.match(notifications[0].message, /^- profile confidence: unknown$/m);
  assert.match(notifications[0].message, /^- automatic routing eligible: no$/m);
  assert.match(notifications[0].message, /^- reason: capability profile unknown$/m);
});

test("handleCopilotModels: why reports known economics with source and freshness", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "mai-code-1.1-flash", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why mai-code-1.1-flash", ctx, {});

  assert.match(notifications[0].message, /^- economics: \$0\.0002 per 1K input \/ \$0\.0012 per 1K output$/m);
  assert.match(notifications[0].message, /^- source: bundled-fallback$/m);
  assert.match(notifications[0].message, /^- freshness: stale$/m);
});

test("handleCopilotModels: why reports unknown economics without a synthetic zero placeholder", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "totally-custom-model-x", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why totally-custom-model-x", ctx, {});

  assert.match(notifications[0].message, /^- economics: unknown$/m);
  assert.match(notifications[0].message, /^- source: unknown$/m);
  assert.match(notifications[0].message, /^- freshness: unknown$/m);
  assert.doesNotMatch(notifications[0].message, /\$0\.0000/);
  assert.doesNotMatch(notifications[0].message, /\bstandard\b/);
});

test("handleCopilotModels: why succeeds even when getApiKey() throws", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });
  ctx.modelRegistry.getApiKey = async () => { throw new Error("token resolution boom"); };

  await assert.doesNotReject(handleCopilotModels("why gpt-5.4", ctx, {}));
  assert.match(notifications[0].message, /^GitHub Copilot: why github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why succeeds even when fetchImpl throws", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await assert.doesNotReject(handleCopilotModels("why gpt-5.4", ctx, {
    fetchImpl: (async () => { throw new Error("network boom"); }) as unknown as typeof fetch,
  }));
  assert.match(notifications[0].message, /^GitHub Copilot: why github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why never writes to the models-catalog.json overlay", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-why-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, { overlayPath });

  assert.equal(readModelsCatalogOverlay(overlayPath), null, "why must never write the overlay");
});

test("handleCopilotModels: why output never includes a token or API key", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.doesNotMatch(notifications[0].message, /token-abc/);
});

test("handleCopilotModels: sync still works unaffected by the stricter why parser", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /1 model\(s\) available/);
});

test("handleCopilotModels: --register quarantine still works unaffected by the stricter why parser", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-still-works-"));
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
      { id: "another-remote-model", name: "Another Remote Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(readModelsCatalogOverlay(overlayPath), null);
  assert.match(notifications[1].message, /quarantined|remote-only|not persisted/i);
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

test("getGsdArgumentCompletions: /gsd copilot-models completions include why <model>", () => {
  const completions = getGsdArgumentCompletions("copilot-models ");
  assert.ok(
    completions.some((entry) => entry.label === "why <model>"),
    "completion list must include the why <model> subcommand",
  );
});
