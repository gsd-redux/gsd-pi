// Regression/behavior tests for GSD-W017's non-blocking cheaper/better
// same-tier notification feature (copilot-catalog-notifications.ts).
// Exercises the messaging distinction, fingerprint-based dedup, and
// provider/scope gating on top of the already-tested suggestion-finding
// logic in copilot-models-handler.test.ts.

import test from "node:test";
import assert from "node:assert/strict";

import {
  _resetCopilotCatalogNotificationStateForTests,
  compareCapabilityScores,
  maybeNotifyCheaperAlternative,
} from "../copilot-catalog-notifications.js";
import { _resetCopilotModelsSessionStateForTests } from "../commands/handlers/copilot-models.js";

interface FakeModel {
  id: string;
  provider: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function createFakeCtx(models: FakeModel[]): { ctx: any; notifications: Array<{ message: string; level: string }> } {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    modelRegistry: {
      getAll: () => models.map((model) => ({ ...model, cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      getAvailable: () => models,
      getApiKey: async () => undefined,
    },
    ui: {
      notify: (message: string, level: string = "info") => {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx, notifications };
}

const SAME_TIER_SESSION: FakeModel[] = [
  { id: "claude-sonnet-5", provider: "github-copilot", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
  { id: "gpt-4.1", provider: "github-copilot", cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
  { id: "mai-code-1.1-flash", provider: "github-copilot", cost: { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 } },
];

// ─── compareCapabilityScores (pure) ─────────────────────────────────────────

test("compareCapabilityScores: higher when candidate average exceeds selected by more than the margin", () => {
  const selected = { coding: 50, debugging: 50, research: 50, reasoning: 50, speed: 50, longContext: 50, instruction: 50 };
  const candidate = { coding: 60, debugging: 60, research: 60, reasoning: 60, speed: 60, longContext: 60, instruction: 60 };
  assert.equal(compareCapabilityScores(selected, candidate), "higher");
});

test("compareCapabilityScores: equal-or-lower when within the noise margin or candidate is lower", () => {
  const selected = { coding: 50, debugging: 50, research: 50, reasoning: 50, speed: 50, longContext: 50, instruction: 50 };
  const closeCandidate = { ...selected, coding: 50.5 };
  assert.equal(compareCapabilityScores(selected, closeCandidate), "equal-or-lower");

  const lowerCandidate = { ...selected, coding: 10 };
  assert.equal(compareCapabilityScores(selected, lowerCandidate), "equal-or-lower");
});

test("compareCapabilityScores: equal-or-lower when either profile is missing (never guesses)", () => {
  const selected = { coding: 50, debugging: 50, research: 50, reasoning: 50, speed: 50, longContext: 50, instruction: 50 };
  assert.equal(compareCapabilityScores(undefined, selected), "equal-or-lower");
  assert.equal(compareCapabilityScores(selected, undefined), "equal-or-lower");
});

// ─── maybeNotifyCheaperAlternative ──────────────────────────────────────────

test("maybeNotifyCheaperAlternative: no qualifying alternative sends no notification", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx([{ id: "claude-sonnet-5", provider: "github-copilot", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }]);

  const sent = maybeNotifyCheaperAlternative({
    ctx,
    accountScope: "/project",
    selectedModelProvider: "github-copilot",
    selectedModelId: "claude-sonnet-5",
    snapshot: null,
  });

  assert.equal(sent, false);
  assert.equal(notifications.length, 0);
});

test("maybeNotifyCheaperAlternative: non-Copilot provider is always a no-op", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx(SAME_TIER_SESSION);

  const sent = maybeNotifyCheaperAlternative({
    ctx,
    accountScope: "/project",
    selectedModelProvider: "openai",
    selectedModelId: "claude-sonnet-5",
    snapshot: null,
  });

  assert.equal(sent, false);
  assert.equal(notifications.length, 0);
});

test("maybeNotifyCheaperAlternative: same-tier cheaper option notifies as a cheaper equivalent", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx(SAME_TIER_SESSION);

  const sent = maybeNotifyCheaperAlternative({
    ctx,
    accountScope: "/project",
    selectedModelProvider: "github-copilot",
    selectedModelId: "claude-sonnet-5",
    snapshot: null,
  });

  assert.equal(sent, true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.message, /cheaper equivalent to github-copilot\/claude-sonnet-5/);
  assert.match(notifications[0]!.message, /github-copilot\/gpt-4\.1/);
  assert.match(notifications[0]!.message, /current model was not changed/i);
  assert.doesNotMatch(notifications[0]!.message, /better, cheaper alternative/);
});

test("maybeNotifyCheaperAlternative: never leaks tokens or raw provider payloads in the message", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx(SAME_TIER_SESSION);

  maybeNotifyCheaperAlternative({
    ctx,
    accountScope: "secret-account-scope-value",
    selectedModelProvider: "github-copilot",
    selectedModelId: "claude-sonnet-5",
    snapshot: null,
  });

  assert.doesNotMatch(notifications[0]!.message, /secret-account-scope-value/);
  assert.doesNotMatch(notifications[0]!.message, /Bearer|token|gho_|ghu_/i);
});

test("maybeNotifyCheaperAlternative: deduplicates the identical pairing within the same scope and revision", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx(SAME_TIER_SESSION);
  const call = () =>
    maybeNotifyCheaperAlternative({
      ctx,
      accountScope: "/project",
      selectedModelProvider: "github-copilot",
      selectedModelId: "claude-sonnet-5",
      snapshot: null,
    });

  assert.equal(call(), true, "first call notifies");
  assert.equal(call(), false, "second identical call is deduped");
  assert.equal(notifications.length, 1);
});

test("maybeNotifyCheaperAlternative: a different scope re-notifies despite the identical pairing", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx(SAME_TIER_SESSION);
  const notifyFor = (scope: string) =>
    maybeNotifyCheaperAlternative({
      ctx,
      accountScope: scope,
      selectedModelProvider: "github-copilot",
      selectedModelId: "claude-sonnet-5",
      snapshot: null,
    });

  assert.equal(notifyFor("/project-a"), true);
  assert.equal(notifyFor("/project-b"), true, "a different scope is not deduped against a different scope");
  assert.equal(notifications.length, 2);
});

test("maybeNotifyCheaperAlternative: a changed catalog revision allows a fresh notification", () => {
  _resetCopilotModelsSessionStateForTests();
  _resetCopilotCatalogNotificationStateForTests();
  const { ctx, notifications } = createFakeCtx(SAME_TIER_SESSION);
  const notifyWithSnapshot = (hash: string | undefined) =>
    maybeNotifyCheaperAlternative({
      ctx,
      accountScope: "/project",
      selectedModelProvider: "github-copilot",
      selectedModelId: "claude-sonnet-5",
      snapshot: hash ? ({ hash, generatedAt: "", modelCount: 0, models: [] } as any) : null,
    });

  assert.equal(notifyWithSnapshot(undefined), true);
  assert.equal(notifyWithSnapshot(undefined), false, "same revision (no snapshot) is deduped");
  assert.equal(notifyWithSnapshot("revision-2"), true, "a materially different revision re-notifies");
  assert.equal(notifications.length, 2);
});
