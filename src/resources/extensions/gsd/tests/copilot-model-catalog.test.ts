import test from "node:test";
import assert from "node:assert/strict";

import {
  applyLastKnownGood,
  computeCatalogRegistrationCandidates,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  registerCopilotModelsInOverlay,
  sanitizeGitHubCopilotModels,
} from "../copilot-overlay-writer.js";

import {
  applyLastKnownGood as applyLastKnownGoodSnapshot,
  dedupeShellNotifications as dedupeShellNotificationsSnapshot,
  diffCatalogSnapshots as diffCatalogSnapshotsSnapshot,
  fetchGitHubCopilotModels as fetchGitHubCopilotModelsSnapshot,
  sanitizeGitHubCopilotModels as sanitizeGitHubCopilotModelsSnapshot,
} from "../copilot-model-catalog.js";

test("fetchGitHubCopilotModels skips non-Copilot providers", async () => {
  let fetchCalled = false;
  const result = await fetchGitHubCopilotModels({
    provider: "openai",
    authToken: "token",
    fetchImpl: async () => {
      fetchCalled = true;
      return {
        ok: true,
        json: async () => ({ data: [] }),
      } as Response;
    },
  });

  assert.deepEqual(result, { skipped: true, reason: "provider-not-copilot", models: [] });
  assert.equal(fetchCalled, false);
});

test("fetchGitHubCopilotModels fetches GET /models and sanitizes data", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

  const result = await fetchGitHubCopilotModels({
    provider: "github-copilot",
    authToken: "abc123",
    baseUrl: "https://api.example.com",
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      });

      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
            { id: "  ", name: "bad id" },
            { id: "claude-sonnet-5", name: " Claude Sonnet 5 ", tool_call: true },
            { id: "gpt-5.4", name: "gpt-5.4", tool_call: false },
          ],
        }),
      } as Response;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.example.com/models");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers.Authorization, "Bearer abc123");

  assert.deepEqual(result.models.map((model) => model.id), [
    "mai-code-1.1-flash",
    "claude-sonnet-5",
  ]);
  assert.equal(result.models[1]?.name, "Claude Sonnet 5");
});

test("fetchGitHubCopilotModels computes a provider-qualified registryId for each sanitized model", async () => {
  const result = await fetchGitHubCopilotModels({
    provider: "github-copilot",
    authToken: "abc123",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true }],
      }),
    }) as Response,
  });

  assert.equal(result.models[0]?.registryId, "github-copilot/mai-code-1.1-flash");
});

test("sanitizeGitHubCopilotModels drops invalid, duplicate, and non-tool-capable rows", () => {
  const sanitized = sanitizeGitHubCopilotModels({
    data: [
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
      { id: "mai-code-1.1-flash", name: "duplicate", tool_call: true },
      { id: "  ", name: "bad" },
      { id: "gpt-5.4", name: "gpt-5.4", tool_call: false },
      { id: "claude-sonnet-5", name: " Claude Sonnet 5 ", tool_call: true },
    ],
  });

  assert.deepEqual(sanitized.map((model) => model.id), [
    "mai-code-1.1-flash",
    "claude-sonnet-5",
  ]);
});

test("applyLastKnownGood preserves the prior valid snapshot on failure", () => {
  const previous = {
    generatedAt: "2026-08-14T00:00:00Z",
    models: ["mai-code-1.1-flash"],
  };

  const next = applyLastKnownGood(previous, {
    ok: false,
    error: "network error",
    snapshot: null,
  });

  assert.deepEqual(next, previous);
});

test("diffCatalogSnapshots reports adds, removals, and changes", () => {
  const diff = diffCatalogSnapshots(
    {
      generatedAt: "2026-08-14T00:00:00Z",
      models: [
        { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      ],
    },
    {
      generatedAt: "2026-08-14T00:10:00Z",
      models: [
        { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash" },
        { id: "gpt-5.4", name: "GPT-5.4" },
      ],
    },
  );

  assert.deepEqual(diff.added.map((model) => model.id), ["gpt-5.4"]);
  assert.deepEqual(diff.removed.map((model) => model.id), ["claude-sonnet-5"]);
  assert.deepEqual(diff.changed.map((model) => model.id), []);
});

test("dedupeShellNotifications collapses repeated alerts for the same model snapshot", () => {
  const deduped = dedupeShellNotifications([
    "copilot catalog updated",
    "copilot catalog updated",
    "copilot catalog updated",
    "copilot catalog changed",
    "copilot catalog changed",
  ]);

  assert.deepEqual(deduped, [
    "copilot catalog updated",
    "copilot catalog changed",
  ]);
});

test("computeCatalogRegistrationCandidates subtracts the effective local catalog", () => {
  const candidates = computeCatalogRegistrationCandidates(
    [
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ],
    [
      { id: "mai-code-1.1-flash", provider: "github-copilot" },
      { id: "gpt-5.4", provider: "github-copilot" },
    ],
  );

  assert.deepEqual(candidates.map((model) => model.id), ["brand-new-model"]);
});

test("registerCopilotModelsInOverlay quarantines remote-only candidates instead of writing fabricated metadata", () => {
  const plan = registerCopilotModelsInOverlay(
    "/tmp/gsd-copilot-should-stay-quarantined.json",
    [{ id: "brand-new-model", name: "Brand New Model", tool_call: true }],
    [{ id: "gpt-5.4", provider: "github-copilot" }],
  );

  assert.deepEqual(plan.registeredIds, []);
  assert.deepEqual(plan.quarantined.map((model) => model.id), ["brand-new-model"]);
  assert.equal(plan.overlayPath, "/tmp/gsd-copilot-should-stay-quarantined.json");
});
