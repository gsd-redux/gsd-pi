// Tests for the in-session `gsd update --models` path:
// refreshModelsCatalogOverlay (fetch/validate/atomic-write of the
// models-catalog.json overlay, failure must never clobber an existing
// overlay) and the /gsd update --models handler wiring (registry refresh,
// usage errors).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	GSD_MODELS_CATALOG_URL,
	refreshModelsCatalogOverlay,
} from "../models-catalog-refresh.js";
import { handleUpdate } from "../commands-handlers.js";

function validModelEntry(provider: string, id: string) {
	return {
		id,
		name: `Test ${id}`,
		api: "openai-completions",
		provider,
		baseUrl: "https://api.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function validCatalogBody() {
	return {
		"github-copilot": { "claude-sonnet-5": validModelEntry("github-copilot", "claude-sonnet-5") },
		anthropic: { "claude-opus-5": validModelEntry("anthropic", "claude-opus-5") },
	};
}

function jsonResponse(body: unknown) {
	return (async () => ({ ok: true, status: 200, statusText: "OK", json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

function tmpOverlayPath(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "gsd-models-catalog-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "agent", "models-catalog.json");
}

function writeExistingOverlay(catalogPath: string, content: unknown): void {
	mkdirSync(dirname(catalogPath), { recursive: true });
	writeFileSync(catalogPath, typeof content === "string" ? content : JSON.stringify(content));
}

// ─── refreshModelsCatalogOverlay ────────────────────────────────────────────

test("refreshModelsCatalogOverlay writes the overlay and reports counts", async (t) => {
	const catalogPath = tmpOverlayPath(t);
	let fetchedUrl: string | undefined;
	const result = await refreshModelsCatalogOverlay({
		catalogPath,
		fetchImpl: (async (input: string | URL | Request) => {
			fetchedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return ({ ok: true, status: 200, statusText: "OK", json: async () => validCatalogBody() }) as unknown as Response;
		}) as unknown as typeof fetch,
	});

	assert.equal(fetchedUrl, GSD_MODELS_CATALOG_URL);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.providers, 2);
	assert.equal(result.models, 2);
	assert.equal(result.previous, null, "no existing overlay yet");

	const written = JSON.parse(readFileSync(catalogPath, "utf-8"));
	assert.equal(written.version, 1);
	assert.equal(written.source, GSD_MODELS_CATALOG_URL);
	assert.ok(typeof written.fetchedAt === "string");
	assert.deepEqual(Object.keys(written.models).sort(), ["anthropic", "github-copilot"]);
	assert.equal(existsSync(`${catalogPath}.tmp-${process.pid}`), false, "temp file must be renamed away");
});

test("refreshModelsCatalogOverlay reports previous counts when an overlay already exists", async (t) => {
	const catalogPath = tmpOverlayPath(t);
	writeExistingOverlay(catalogPath, {
		version: 1,
		fetchedAt: "2026-01-01T00:00:00.000Z",
		source: "old",
		models: validCatalogBody(),
	});

	const result = await refreshModelsCatalogOverlay({
		catalogPath,
		fetchImpl: jsonResponse({ anthropic: { "claude-opus-5": validModelEntry("anthropic", "claude-opus-5") } }),
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.previous, { providers: 2, models: 2 });
	assert.equal(result.providers, 1);
	assert.equal(result.models, 1);
});

test("refreshModelsCatalogOverlay rejects an invalid payload and leaves the existing overlay untouched", async (t) => {
	const catalogPath = tmpOverlayPath(t);
	const existing = JSON.stringify({
		version: 1,
		fetchedAt: "2026-01-01T00:00:00.000Z",
		source: "old",
		models: validCatalogBody(),
	});
	writeExistingOverlay(catalogPath, existing);

	const result = await refreshModelsCatalogOverlay({
		catalogPath,
		fetchImpl: jsonResponse({ "not-a-catalog": true }),
	});

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "invalid");
	assert.equal(readFileSync(catalogPath, "utf-8"), existing, "existing overlay must not be clobbered");
});

test("refreshModelsCatalogOverlay distinguishes an HTTP error from a network failure", async (t) => {
	const catalogPath = tmpOverlayPath(t);
	const existing = "{}-sentinel-not-valid-json-but-byte-compared";
	writeExistingOverlay(catalogPath, existing);

	const httpResult = await refreshModelsCatalogOverlay({
		catalogPath,
		fetchImpl: (async () =>
			({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
	});
	assert.equal(httpResult.ok, false);
	if (!httpResult.ok) {
		assert.equal(httpResult.reason, "http");
		assert.match(httpResult.message, /HTTP 503 Service Unavailable/);
	}

	const networkResult = await refreshModelsCatalogOverlay({
		catalogPath,
		fetchImpl: (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch,
	});
	assert.equal(networkResult.ok, false);
	if (!networkResult.ok) assert.equal(networkResult.reason, "network");

	assert.equal(readFileSync(catalogPath, "utf-8"), existing, "failures must never write");
});

// ─── /gsd update --models handler wiring ────────────────────────────────────

function commandCtx(overrides: {
	notify: (message: string, level?: string) => void;
	refresh: () => void;
}): any {
	return {
		ui: { notify: overrides.notify },
		modelRegistry: { refresh: overrides.refresh },
	} as any;
}

test("/gsd update --models refreshes the overlay into the real GSD_HOME path and reloads the registry", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gsd-models-catalog-e2e-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const previousHome = process.env.GSD_HOME;
	const previousFetch = globalThis.fetch;
	t.after(() => {
		if (previousHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousHome;
		globalThis.fetch = previousFetch;
	});

	process.env.GSD_HOME = dir;
	globalThis.fetch = jsonResponse(validCatalogBody());

	const notifications: string[] = [];
	let refreshCalls = 0;
	await handleUpdate(
		commandCtx({
			notify: (message: string) => notifications.push(message),
			refresh: () => {
				refreshCalls += 1;
			},
		}),
		"--models",
	);

	assert.equal(refreshCalls, 1, "modelRegistry.refresh() must run after a successful write");
	const writtenPath = join(dir, "agent", "models-catalog.json");
	const written = JSON.parse(readFileSync(writtenPath, "utf-8"));
	assert.equal(written.version, 1);
	assert.ok(
		notifications.some((message) => message.includes("Updated model catalog: 2 providers, 2 models")),
		`unexpected notifications: ${JSON.stringify(notifications)}`,
	);
	assert.ok(notifications.some((message) => message.includes("Model registry refreshed")));
});

test("/gsd update --models reports failure without touching the registry", async (t) => {
	const previousFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = previousFetch;
	});
	globalThis.fetch = (async () => {
		throw new Error("network down");
	}) as unknown as typeof fetch;

	const notifications: Array<{ message: string; level?: string }> = [];
	let refreshCalls = 0;
	await handleUpdate(
		commandCtx({
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			refresh: () => {
				refreshCalls += 1;
			},
		}),
		"--models",
	);

	assert.equal(refreshCalls, 0, "a failed fetch must not reload the registry");
	assert.ok(notifications.some((n) => n.level === "error" && n.message.includes("Existing catalog left unchanged")));
});

test("/gsd update --models with an extra value shows usage and never fetches", async (t) => {
	const previousFetch = globalThis.fetch;
	let fetchCalled = false;
	t.after(() => {
		globalThis.fetch = previousFetch;
	});
	globalThis.fetch = (async () => {
		fetchCalled = true;
		return ({ ok: true, json: async () => validCatalogBody() }) as unknown as Response;
	}) as unknown as typeof fetch;

	const notifications: Array<{ message: string; level?: string }> = [];
	await handleUpdate(
		commandCtx({
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			refresh: () => {},
		}),
		"--models newest",
	);

	assert.equal(fetchCalled, false);
	assert.ok(notifications.some((n) => n.level === "warning" && n.message.includes("Usage: /gsd update [browser] [--models]")));
});
