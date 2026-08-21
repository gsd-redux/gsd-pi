// Regression/behavior tests for GSD-W018: the session-start GitHub Copilot
// catalog refresh coordinator and 3-tier runtime model classification.
// Exercises the coordinator's dedup/timeout/auth-safety contract and the
// classifier's refusal to fabricate capability or pricing data — as opposed
// to the production command wiring covered by copilot-models-handler.test.ts.

import test from "node:test";
import assert from "node:assert/strict";

import {
	_resetCopilotCatalogSessionRefreshStateForTests,
	awaitCopilotCatalogSessionRefresh,
	classifyRemoteCopilotModel,
	resolveCopilotCatalogNotifyOnChanges,
	resolveCopilotCatalogRefreshMode,
	resolveCopilotCatalogStaleAfterMs,
	shouldTriggerCopilotCatalogRefresh,
	startCopilotCatalogSessionRefresh,
	type CopilotCatalogSessionRefreshResult,
} from "../copilot-catalog-session-refresh.js";
import type { CopilotModelRecord } from "../copilot-model-catalog.js";

interface FakeModel {
	id: string;
	provider: string;
}

function createFakeCtx(options: {
	models?: FakeModel[];
	apiKey?: string | undefined;
	apiKeyThrows?: boolean;
}): { ctx: any; notifications: Array<{ message: string; level: string }> } {
	const notifications: Array<{ message: string; level: string }> = [];
	const models = options.models ?? [];
	const ctx = {
		modelRegistry: {
			getAvailable: () => models,
			getApiKey: async (_model: FakeModel) => {
				if (options.apiKeyThrows) throw new Error("token refresh failed");
				return options.apiKey;
			},
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

function neverResolves() {
	return (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

function buildRecord(overrides: Partial<CopilotModelRecord> = {}): CopilotModelRecord {
	return {
		provider: "github-copilot",
		id: "claude-sonnet-5",
		registryId: "github-copilot/claude-sonnet-5",
		name: "Claude Sonnet 5",
		availability: { enabled: true, pickerEnabled: true, preview: false, policyState: "enabled" },
		execution: {
			toolCalls: true,
			supportedEndpoints: [],
			reasoningLevels: [],
			contextWindow: 200_000,
			maxTokens: 8_192,
		},
		billing: { billingUnit: "tokens", inputPer1k: 0.003, outputPer1k: 0.015 },
		provenance: {
			displayName: { source: "provider-live", freshness: "fresh" },
			availability: { source: "provider-live", freshness: "fresh" },
			endpoints: { source: "provider-live", freshness: "fresh" },
			reasoning: { source: "provider-live", freshness: "fresh" },
			limits: { source: "provider-live", freshness: "fresh" },
			billingUnit: { source: "provider-live", freshness: "fresh" },
			tokenPrices: { source: "provider-live", freshness: "fresh" },
			requestMultiplier: { source: "unknown", freshness: "unknown" },
			promotion: { source: "unknown", freshness: "unknown" },
		},
		conflicts: [],
		hash: "test-hash",
		...overrides,
	} as CopilotModelRecord;
}

// ─── Config resolution ──────────────────────────────────────────────────────

test("resolveCopilotCatalogRefreshMode defaults to off", () => {
	assert.equal(resolveCopilotCatalogRefreshMode(undefined), "off");
	assert.equal(resolveCopilotCatalogRefreshMode({}), "off");
	assert.equal(resolveCopilotCatalogRefreshMode({ copilot_catalog: {} }), "off");
});

test("resolveCopilotCatalogRefreshMode respects configured mode", () => {
	assert.equal(
		resolveCopilotCatalogRefreshMode({ copilot_catalog: { refresh_on_session_start: "always" } }),
		"always",
	);
	assert.equal(
		resolveCopilotCatalogRefreshMode({ copilot_catalog: { refresh_on_session_start: "if_stale" } }),
		"if_stale",
	);
});

test("resolveCopilotCatalogNotifyOnChanges defaults to true", () => {
	assert.equal(resolveCopilotCatalogNotifyOnChanges(undefined), true);
	assert.equal(resolveCopilotCatalogNotifyOnChanges({ copilot_catalog: { notify_on_changes: false } }), false);
});

test("resolveCopilotCatalogStaleAfterMs defaults and clamps out-of-range values", () => {
	assert.equal(resolveCopilotCatalogStaleAfterMs(undefined), 6 * 60 * 60 * 1000);
	assert.equal(
		resolveCopilotCatalogStaleAfterMs({ copilot_catalog: { stale_after_ms: 30_000 } }),
		60_000,
		"clamped up to the 1-minute floor",
	);
	assert.equal(
		resolveCopilotCatalogStaleAfterMs({ copilot_catalog: { stale_after_ms: 999_999_999_999 } }),
		604_800_000,
		"clamped down to the 7-day ceiling",
	);
});

// ─── shouldTriggerCopilotCatalogRefresh (pure) ──────────────────────────────

test("shouldTriggerCopilotCatalogRefresh: off never triggers", () => {
	assert.equal(shouldTriggerCopilotCatalogRefresh("off", null, Date.now(), 1000), false);
	assert.equal(shouldTriggerCopilotCatalogRefresh("off", 0, Date.now(), 1000), false);
});

test("shouldTriggerCopilotCatalogRefresh: always triggers every time", () => {
	assert.equal(shouldTriggerCopilotCatalogRefresh("always", Date.now(), Date.now(), 1000), true);
});

test("shouldTriggerCopilotCatalogRefresh: if_stale triggers on first run and after the threshold", () => {
	assert.equal(shouldTriggerCopilotCatalogRefresh("if_stale", null, 1000, 500), true, "no prior refresh yet");
	assert.equal(shouldTriggerCopilotCatalogRefresh("if_stale", 1000, 1400, 500), false, "still fresh");
	assert.equal(shouldTriggerCopilotCatalogRefresh("if_stale", 1000, 1500, 500), true, "exactly at threshold");
	assert.equal(shouldTriggerCopilotCatalogRefresh("if_stale", 1000, 2000, 500), true, "past threshold");
});

// ─── classifyRemoteCopilotModel (pure) ──────────────────────────────────────

test("classifyRemoteCopilotModel: trusted when tier, profile, pricing, and limits are all known", () => {
	const result = classifyRemoteCopilotModel(buildRecord());
	assert.equal(result.modelClass, "trusted");
	assert.equal(result.tier, "standard");
	assert.equal(result.hasKnownPricing, true);
});

test("classifyRemoteCopilotModel: manual-only when capability tier is unknown", () => {
	const result = classifyRemoteCopilotModel(buildRecord({ id: "some-brand-new-unlisted-model" }));
	assert.equal(result.modelClass, "manual-only");
	assert.ok(result.reasons.some((reason) => reason.includes("capability tier")));
});

test("classifyRemoteCopilotModel: manual-only when pricing is unknown and tier/profile are unknown too", () => {
	const result = classifyRemoteCopilotModel(
		buildRecord({ id: "some-brand-new-unlisted-model-2", billing: { billingUnit: "unknown" } }),
	);
	assert.equal(result.modelClass, "manual-only");
	assert.equal(result.hasKnownPricing, false);
});

test("classifyRemoteCopilotModel: quarantined when not tool-call capable", () => {
	const result = classifyRemoteCopilotModel(
		buildRecord({ execution: { ...buildRecord().execution, toolCalls: false } }),
	);
	assert.equal(result.modelClass, "quarantined");
	assert.match(result.reasons[0]!, /tool-call/);
});

test("classifyRemoteCopilotModel: quarantined when policy-restricted or disabled", () => {
	const restricted = classifyRemoteCopilotModel(
		buildRecord({ availability: { ...buildRecord().availability, policyState: "restricted" } }),
	);
	assert.equal(restricted.modelClass, "quarantined");

	const disabled = classifyRemoteCopilotModel(
		buildRecord({ availability: { ...buildRecord().availability, policyState: "disabled" } }),
	);
	assert.equal(disabled.modelClass, "quarantined");
});

test("classifyRemoteCopilotModel: quarantined when preview", () => {
	const result = classifyRemoteCopilotModel(
		buildRecord({ availability: { ...buildRecord().availability, preview: true } }),
	);
	assert.equal(result.modelClass, "quarantined");
	assert.match(result.reasons[0]!, /preview/);
});

test("classifyRemoteCopilotModel: quarantined when normalization reported conflicts", () => {
	const result = classifyRemoteCopilotModel(buildRecord({ conflicts: ["endpoint mismatch"] }));
	assert.equal(result.modelClass, "quarantined");
	assert.match(result.reasons[0]!, /conflict/);
});

// ─── startCopilotCatalogSessionRefresh (coordinator) ────────────────────────

test("startCopilotCatalogSessionRefresh: mode off makes zero network requests", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	let fetchCalled = false;
	const { ctx } = createFakeCtx({ models: [{ id: "claude-sonnet-5", provider: "github-copilot" }], apiKey: "tok" });

	const result = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project",
		preferences: { copilot_catalog: { refresh_on_session_start: "off" } },
		fetchImpl: (async () => {
			fetchCalled = true;
			throw new Error("must not be called");
		}) as unknown as typeof fetch,
	});

	assert.equal(fetchCalled, false);
	assert.equal(result.ran, false);
});

test("startCopilotCatalogSessionRefresh: no configured Copilot provider skips without error", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({ models: [] });

	const result = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project",
		preferences: { copilot_catalog: { refresh_on_session_start: "always" } },
	});

	assert.equal(result.ran, true);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "provider-not-configured");
});

test("startCopilotCatalogSessionRefresh: missing token skips silently, never throws, never fetches", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	let fetchCalled = false;
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: undefined,
	});

	const result = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project",
		preferences: { copilot_catalog: { refresh_on_session_start: "always" } },
		fetchImpl: (async () => {
			fetchCalled = true;
			throw new Error("must not be called");
		}) as unknown as typeof fetch,
	});

	assert.equal(fetchCalled, false);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "auth-unavailable");
});

test("startCopilotCatalogSessionRefresh: a throwing getApiKey never triggers a login flow and never throws", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKeyThrows: true,
	});

	const result = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project",
		preferences: { copilot_catalog: { refresh_on_session_start: "always" } },
	});

	assert.equal(result.reason, "auth-unavailable");
});

test("startCopilotCatalogSessionRefresh: successful refresh classifies models and reports changes", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: "token-abc",
	});

	const result = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project",
		preferences: { copilot_catalog: { refresh_on_session_start: "always" } },
		fetchImpl: jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }]),
	});

	assert.equal(result.ok, true);
	assert.ok(result.snapshot);
	assert.equal(result.changedModelIds.length, 1, "first-ever snapshot reports every model as changed");
	assert.ok(result.classifications["claude-sonnet-5"]);
});

test("startCopilotCatalogSessionRefresh: no-diff second refresh reports zero changes", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: "token-abc",
	});
	const fetchImpl = jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }]);
	const preferences = { copilot_catalog: { refresh_on_session_start: "always" as const } };

	await startCopilotCatalogSessionRefresh({ ctx, basePath: "/project-2", preferences, fetchImpl });
	const second = await startCopilotCatalogSessionRefresh({ ctx, basePath: "/project-2", preferences, fetchImpl });

	assert.equal(second.ok, true);
	assert.equal(second.changedModelIds.length, 0);
});

test("startCopilotCatalogSessionRefresh: a failed refresh preserves the last-known-good snapshot", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: "token-abc",
	});
	const preferences = { copilot_catalog: { refresh_on_session_start: "always" as const } };

	const first = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project-3",
		preferences,
		fetchImpl: jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }]),
	});
	assert.equal(first.ok, true);

	const second = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project-3",
		preferences,
		fetchImpl: (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch,
	});

	assert.equal(second.ok, false);
	assert.deepEqual(second.snapshot, first.snapshot, "last-known-good snapshot is preserved on failure");
});

test("startCopilotCatalogSessionRefresh: concurrent calls for the same basePath share one in-flight refresh", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	let fetchCallCount = 0;
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: "token-abc",
	});
	const preferences = { copilot_catalog: { refresh_on_session_start: "always" as const } };
	const fetchImpl = (async () => {
		fetchCallCount += 1;
		return { ok: true, json: async () => ({ data: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }] }) } as unknown as Response;
	}) as unknown as typeof fetch;

	const [a, b] = await Promise.all([
		startCopilotCatalogSessionRefresh({ ctx, basePath: "/project-4", preferences, fetchImpl }),
		startCopilotCatalogSessionRefresh({ ctx, basePath: "/project-4", preferences, fetchImpl }),
	]);

	assert.equal(fetchCallCount, 1, "only one network request for two simultaneous triggers");
	assert.equal(a, b, "both callers receive the exact same result object");
});

test("startCopilotCatalogSessionRefresh: a hanging fetch resolves via the bounded timeout instead of hanging", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: "token-abc",
	});

	const result = await startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project-5",
		preferences: { copilot_catalog: { refresh_on_session_start: "always" } },
		fetchImpl: neverResolves(),
		timeoutMs: 25,
	});

	assert.equal(result.reason, "timeout");
});

test("awaitCopilotCatalogSessionRefresh: resolves immediately when nothing is in flight", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const result = await awaitCopilotCatalogSessionRefresh("/no-such-project", 50);
	assert.equal(result.ran, false);
});

test("awaitCopilotCatalogSessionRefresh: joins an in-flight refresh started elsewhere", async () => {
	_resetCopilotCatalogSessionRefreshStateForTests();
	const { ctx } = createFakeCtx({
		models: [{ id: "claude-sonnet-5", provider: "github-copilot" }],
		apiKey: "token-abc",
	});

	const started: Promise<CopilotCatalogSessionRefreshResult> = startCopilotCatalogSessionRefresh({
		ctx,
		basePath: "/project-6",
		preferences: { copilot_catalog: { refresh_on_session_start: "always" } },
		fetchImpl: jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }]),
	});

	const joined = await awaitCopilotCatalogSessionRefresh("/project-6", 1000);
	const original = await started;
	assert.equal(joined.ok, original.ok);
	assert.deepEqual(joined.snapshot, original.snapshot);
});
