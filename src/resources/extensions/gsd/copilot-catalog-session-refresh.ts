// Project/App: gsd-pi
// File Purpose: GSD-W018 — session-start GitHub Copilot catalog refresh
// coordinator and 3-tier runtime model classification.
//
// Extends the explicit, user-invoked `/gsd copilot-models sync` (GSD-W014)
// with an OPT-IN automatic refresh at GSD session start, gated by
// `copilot_catalog.refresh_on_session_start` (default "off"). Reuses the
// same read-only fetch/sanitize/last-known-good pipeline from
// `copilot-model-catalog.ts` — this module never duplicates network/auth
// logic, it only coordinates *when* to call it and classifies the result for
// safe runtime selection.
//
// Invariants:
//   - Never blocks ordinary session startup: callers must fire-and-forget
//     via `startCopilotCatalogSessionRefresh`, never await it synchronously
//     on the startup path.
//   - At most one in-flight refresh per basePath — concurrent triggers (e.g.
//     a terminal session racing a VS Code daemon connect) share one promise.
//   - Never triggers or waits on an OAuth/login flow: auth resolution reuses
//     `ctx.modelRegistry.getApiKey()`, which only ever returns a token that
//     is already available, and any thrown/missing token is treated as
//     "auth unavailable, skip silently" — never surfaced as an error.
//   - Bounded wall-clock timeout; a slow/hanging fetch never wedges startup
//     or a caller awaiting the in-flight refresh (e.g. the model picker).
//   - Classification never fabricates capability or pricing data: unknown
//     stays unknown (manual-only), and structurally incomplete records are
//     quarantined rather than silently defaulted.
//   - State here is session-scoped only (module-level, per basePath) —
//     nothing is persisted to disk, mirroring the existing
//     `commands/handlers/copilot-models.ts` session-scoped snapshot.

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { getGitHubCopilotBaseUrl } from "@gsd/pi-ai/oauth";

import {
	applyLastKnownGood,
	diffCatalogSnapshots,
	fetchGitHubCopilotModels,
	type CopilotModelRecord,
	type CopilotModelSnapshot,
} from "./copilot-model-catalog.js";
import { resolveModelEconomics } from "./model-cost-table.js";
import {
	canonicalizeModelId,
	getModelProfileConfidence,
	MODEL_CAPABILITY_TIER,
	type CapabilityProfileConfidence,
} from "./model-router.js";
import type {
	CopilotCatalogPreferences,
	CopilotCatalogRefreshMode,
} from "./preferences-types.js";

// ─── Config resolution (pure — no I/O, no defaults hidden elsewhere) ───────

export const DEFAULT_COPILOT_CATALOG_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h
export const DEFAULT_COPILOT_CATALOG_REFRESH_TIMEOUT_MS = 10_000;
const MIN_STALE_AFTER_MS = 60_000; // 1 minute
const MAX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type PreferencesLike = { copilot_catalog?: CopilotCatalogPreferences } | null | undefined;

/** Resolve the effective refresh mode. Default is "off" — matches KNOWN_PREFERENCE_KEYS/validation defaults. */
export function resolveCopilotCatalogRefreshMode(
	prefs: PreferencesLike,
): CopilotCatalogRefreshMode {
	return prefs?.copilot_catalog?.refresh_on_session_start ?? "off";
}

/** Resolve whether a non-blocking notification should surface catalog changes. Default: true. */
export function resolveCopilotCatalogNotifyOnChanges(prefs: PreferencesLike): boolean {
	return prefs?.copilot_catalog?.notify_on_changes ?? true;
}

/** Resolve the "if_stale" staleness threshold in ms, clamped to a sane range. Default: 6h. */
export function resolveCopilotCatalogStaleAfterMs(prefs: PreferencesLike): number {
	const raw = prefs?.copilot_catalog?.stale_after_ms;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		return DEFAULT_COPILOT_CATALOG_STALE_AFTER_MS;
	}
	return Math.min(Math.max(raw, MIN_STALE_AFTER_MS), MAX_STALE_AFTER_MS);
}

/**
 * Pure decision of whether a refresh should run for the given mode/staleness
 * state. No I/O — safe to unit test directly.
 */
export function shouldTriggerCopilotCatalogRefresh(
	mode: CopilotCatalogRefreshMode,
	lastRefreshedAtMs: number | null,
	nowMs: number,
	staleAfterMs: number,
): boolean {
	if (mode === "off") return false;
	if (mode === "always") return true;
	if (lastRefreshedAtMs === null) return true;
	return nowMs - lastRefreshedAtMs >= staleAfterMs;
}

// ─── Runtime model classification (Class A / B / C) ────────────────────────

/**
 * - "trusted" (Class A): capability tier, profile confidence, and pricing are
 *   all known — exposed for manual selection AND eligible for automatic
 *   routing (subject to the existing routing confidence/economics gates in
 *   model-router.ts).
 * - "manual-only" (Class B): the live record is transport-valid
 *   (`tool_call: true`) but capability tier, profile confidence, or pricing
 *   is unknown — selectable manually, never auto-routed, never used for
 *   cheaper-model suggestions.
 * - "quarantined" (Class C): structurally incomplete (not tool-call capable)
 *   — not exposed as selectable, not routed, not suggested.
 */
export type ModelRuntimeClass = "trusted" | "manual-only" | "quarantined";

export interface ModelClassification {
	modelClass: ModelRuntimeClass;
	reasons: string[];
	tier?: string;
	profileConfidence?: CapabilityProfileConfidence;
	hasKnownPricing: boolean;
}

/**
 * Classify a single live-catalog GitHub Copilot model for safe runtime
 * exposure (GSD-W018 Decision 6). Never invents capability or pricing data —
 * absence of evidence always resolves to "manual-only" or "quarantined",
 * never a synthesized "trusted" classification.
 */
export function classifyRemoteCopilotModel(
	record: CopilotModelRecord,
): ModelClassification {
	if (!record.execution.toolCalls) {
		return {
			modelClass: "quarantined",
			reasons: ["missing required tool-call capability"],
			hasKnownPricing: false,
		};
	}
	if (record.availability.policyState === "disabled" || record.availability.policyState === "restricted") {
		return {
			modelClass: "quarantined",
			reasons: [`policy state: ${record.availability.policyState}`],
			hasKnownPricing: false,
		};
	}
	if (record.availability.preview) {
		return {
			modelClass: "quarantined",
			reasons: ["preview model — not yet stable for automatic exposure"],
			hasKnownPricing: false,
		};
	}
	if (record.conflicts.length > 0) {
		return {
			modelClass: "quarantined",
			reasons: [`unresolved normalization conflict(s): ${record.conflicts.join(", ")}`],
			hasKnownPricing: false,
		};
	}

	const tier = MODEL_CAPABILITY_TIER[canonicalizeModelId(record.id)];
	const profileConfidence = getModelProfileConfidence(record.id);
	const hasKnownLimits =
		typeof record.execution.contextWindow === "number" && typeof record.execution.maxTokens === "number";
	const hasBillingOnRecord = record.billing.inputPer1k !== undefined && record.billing.outputPer1k !== undefined;
	const economics = resolveModelEconomics({
		provider: "github-copilot",
		modelId: record.id,
		fallbackEconomics: {
			source: "bundled-fallback",
			stale: false,
			billingUnit: "tokens",
		},
		// BUNDLED_COST_TABLE entries are keyed by bare model ID and are not
		// provider-qualified — without this, a same-named model priced by a
		// different provider (e.g. OpenAI's "gpt-5.4") could silently be
		// reported as this Copilot model's known price. See model-cost-table.ts.
		disableImplicitFallback: true,
	});
	const fallbackPrices = economics.tokenPrices?.default;
	const hasKnownPricing =
		hasBillingOnRecord ||
		economics.source !== "bundled-fallback" ||
		Boolean(fallbackPrices && (fallbackPrices.inputPer1k > 0 || fallbackPrices.outputPer1k > 0));

	if (tier && profileConfidence !== "unknown" && hasKnownPricing && hasKnownLimits) {
		return {
			modelClass: "trusted",
			reasons: [
				`capability tier known (${tier})`,
				`profile confidence: ${profileConfidence}`,
				"pricing known",
				"context/token limits known",
			],
			tier,
			profileConfidence,
			hasKnownPricing,
		};
	}

	const reasons: string[] = [];
	if (!tier) reasons.push("no known capability tier");
	if (profileConfidence === "unknown") reasons.push("no capability profile (unknown confidence)");
	if (!hasKnownPricing) reasons.push("no known pricing");
	if (!hasKnownLimits) reasons.push("no known context/token limits");

	return {
		modelClass: "manual-only",
		reasons,
		tier,
		profileConfidence,
		hasKnownPricing,
	};
}

// ─── Session-start refresh coordinator ─────────────────────────────────────

export interface CopilotCatalogSessionRefreshResult {
	/** False when the refresh was skipped entirely (mode=off, not stale, no provider, no token). */
	ran: boolean;
	ok: boolean;
	reason?: string;
	snapshot: CopilotModelSnapshot | null;
	classifications: Record<string, ModelClassification>;
	changedModelIds: string[];
}

const NOOP_RESULT: Readonly<CopilotCatalogSessionRefreshResult> = Object.freeze({
	ran: false,
	ok: false,
	snapshot: null,
	classifications: {},
	changedModelIds: [],
});

// Session-scoped only (module-level, per basePath) — never persisted to disk.
const inFlightRefreshes = new Map<string, Promise<CopilotCatalogSessionRefreshResult>>();
const lastRefreshedAtByBasePath = new Map<string, number>();
const lastSnapshotByBasePath = new Map<string, CopilotModelSnapshot>();

/** Test-only hook to reset module-level session state between test cases. */
export function _resetCopilotCatalogSessionRefreshStateForTests(): void {
	inFlightRefreshes.clear();
	lastRefreshedAtByBasePath.clear();
	lastSnapshotByBasePath.clear();
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: T,
): Promise<T> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(onTimeout);
		}, timeoutMs);
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(onTimeout);
			},
		);
	});
}

export interface RefreshCopilotCatalogSessionOptions {
	ctx: ExtensionContext;
	basePath: string;
	preferences: PreferencesLike;
	/** Injectable clock for tests. Defaults to Date.now. */
	now?: () => number;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
	/** Injectable timeout for tests. Defaults to DEFAULT_COPILOT_CATALOG_REFRESH_TIMEOUT_MS. */
	timeoutMs?: number;
}

async function runCopilotCatalogRefresh(
	options: RefreshCopilotCatalogSessionOptions,
): Promise<CopilotCatalogSessionRefreshResult> {
	const { ctx, basePath } = options;
	const nowFn = options.now ?? Date.now;

	const available = ctx.modelRegistry.getAvailable();
	const copilotModel = available.find((model) => model.provider === "github-copilot");
	if (!copilotModel) {
		return { ...NOOP_RESULT, ran: true, reason: "provider-not-configured" };
	}

	let token: string | undefined;
	try {
		token = await ctx.modelRegistry.getApiKey(copilotModel);
	} catch {
		// Never surface auth resolution failures as errors, and never trigger
		// a login/OAuth flow — silently skip this session's refresh.
		return { ...NOOP_RESULT, ran: true, reason: "auth-unavailable" };
	}
	if (!token) {
		return { ...NOOP_RESULT, ran: true, reason: "auth-unavailable" };
	}

	const baseUrl = getGitHubCopilotBaseUrl(token);
	const previousSnapshot = lastSnapshotByBasePath.get(basePath) ?? null;

	let fetchResult: Awaited<ReturnType<typeof fetchGitHubCopilotModels>>;
	try {
		fetchResult = await fetchGitHubCopilotModels({
			provider: "github-copilot",
			authToken: token,
			baseUrl,
			fetchImpl: options.fetchImpl,
		});
	} catch (err) {
		return {
			...NOOP_RESULT,
			ran: true,
			ok: false,
			reason: err instanceof Error ? err.message : "fetch-failed",
			snapshot: previousSnapshot,
		};
	}

	const ok = !fetchResult.skipped && fetchResult.models.length > 0 && Boolean(fetchResult.snapshot);
	const nextSnapshot = previousSnapshot
		? applyLastKnownGood(previousSnapshot, { ok, snapshot: ok ? fetchResult.snapshot! : null })
		: ok
			? fetchResult.snapshot!
			: null;

	if (!nextSnapshot) {
		return {
			...NOOP_RESULT,
			ran: true,
			ok: false,
			reason: fetchResult.reason ?? "empty-response",
		};
	}

	lastSnapshotByBasePath.set(basePath, nextSnapshot);
	lastRefreshedAtByBasePath.set(basePath, nowFn());

	const classifications: Record<string, ModelClassification> = {};
	for (const model of nextSnapshot.models) {
		classifications[model.id] = classifyRemoteCopilotModel(model);
	}

	const changedModelIds = previousSnapshot
		? (() => {
				const diff = diffCatalogSnapshots(previousSnapshot, nextSnapshot);
				return [...diff.added, ...diff.changed].map((model) => model.id);
			})()
		: nextSnapshot.models.map((model) => model.id);

	return {
		ran: true,
		ok: true,
		snapshot: nextSnapshot,
		classifications,
		changedModelIds,
	};
}

/**
 * Start (or join an already in-flight) session-start Copilot catalog
 * refresh. Callers on the startup path MUST NOT `await` this synchronously —
 * fire it and let it resolve in the background (`void
 * startCopilotCatalogSessionRefresh(...)`), per the non-blocking-startup
 * invariant. `awaitCopilotCatalogSessionRefresh` is the bounded-wait join
 * point for callers (e.g. the model picker) that need the result.
 *
 * Returns `NOOP_RESULT` synchronously-resolved when the mode is "off" or
 * "if_stale" and the snapshot is not yet stale — no promise is stored in
 * that case, so `awaitCopilotCatalogSessionRefresh` has nothing to join.
 */
export function startCopilotCatalogSessionRefresh(
	options: RefreshCopilotCatalogSessionOptions,
): Promise<CopilotCatalogSessionRefreshResult> {
	const { basePath, preferences } = options;
	const nowFn = options.now ?? Date.now;
	const mode = resolveCopilotCatalogRefreshMode(preferences);
	const staleAfterMs = resolveCopilotCatalogStaleAfterMs(preferences);
	const lastRefreshedAt = lastRefreshedAtByBasePath.get(basePath) ?? null;

	if (!shouldTriggerCopilotCatalogRefresh(mode, lastRefreshedAt, nowFn(), staleAfterMs)) {
		return Promise.resolve(NOOP_RESULT);
	}

	const existing = inFlightRefreshes.get(basePath);
	if (existing) return existing;

	const timeoutMs = options.timeoutMs ?? DEFAULT_COPILOT_CATALOG_REFRESH_TIMEOUT_MS;
	const timedOutResult: CopilotCatalogSessionRefreshResult = {
		...NOOP_RESULT,
		ran: true,
		reason: "timeout",
	};
	const runPromise = withTimeout(runCopilotCatalogRefresh(options), timeoutMs, timedOutResult).finally(() => {
		inFlightRefreshes.delete(basePath);
	});

	inFlightRefreshes.set(basePath, runPromise);
	return runPromise;
}

/**
 * Await an in-flight refresh for `basePath`, bounded by `timeoutMs`. Used by
 * the model picker so a just-started refresh can populate newly available
 * models before the picker renders, without ever blocking indefinitely.
 * Resolves immediately with `NOOP_RESULT` when nothing is in flight.
 */
export function awaitCopilotCatalogSessionRefresh(
	basePath: string,
	timeoutMs = DEFAULT_COPILOT_CATALOG_REFRESH_TIMEOUT_MS,
): Promise<CopilotCatalogSessionRefreshResult> {
	const pending = inFlightRefreshes.get(basePath);
	if (!pending) return Promise.resolve(NOOP_RESULT);
	return withTimeout(pending, timeoutMs, { ...NOOP_RESULT, ran: true, reason: "timeout" });
}
