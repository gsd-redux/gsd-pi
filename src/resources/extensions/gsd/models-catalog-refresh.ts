// In-session `gsd update --models` — refresh the models-catalog.json overlay
// from the published all-provider catalog (every provider, models + pricing),
// without a full CLI upgrade.
//
// Mirrors the fetch/validate/write path of `runModelsUpdate` in
// `src/update-cmd.ts`. Duplicated rather than imported because
// tsconfig.resources.json rootDir prevents importing from src/ (see
// `resolveGsdBrowserPathVersionForCommand` in commands-handlers.ts for the
// same convention). After a successful write the caller must invoke
// `ctx.modelRegistry.refresh()` so the new catalog is active in the running
// session — the same seam `copilot-models sync --register` uses.
//
// Failure never clobbers an existing overlay: the write happens only after a
// full fetch + validate, to the exact location `ModelRegistry` reads
// (resolveGsdModelsCatalogPath).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isModelsCatalog, isModelsCatalogOverlay, type ModelsCatalog } from "@gsd/pi-ai";

import { resolveGsdModelsCatalogPath } from "./copilot-overlay-writer.js";

export const GSD_MODELS_CATALOG_URL =
	"https://raw.githubusercontent.com/open-gsd/gsd-pi/main/packages/pi-ai/src/models.generated.json";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export type ModelsCatalogRefreshResult =
	| {
			ok: true;
			path: string;
			providers: number;
			models: number;
			previous: { providers: number; models: number } | null;
	  }
	| { ok: false; reason: "network" | "invalid" | "http" | "write"; message: string };

interface CatalogCounts {
	providers: number;
	models: number;
}

function countCatalogModels(catalog: ModelsCatalog): CatalogCounts {
	let models = 0;
	for (const provider of Object.keys(catalog)) {
		models += Object.keys(catalog[provider] ?? {}).length;
	}
	return { providers: Object.keys(catalog).length, models };
}

/** Best-effort read of an existing overlay for before/after counts. */
function readExistingCatalogCounts(catalogPath: string): CatalogCounts | null {
	try {
		if (!existsSync(catalogPath)) return null;
		const parsed: unknown = JSON.parse(readFileSync(catalogPath, "utf-8"));
		if (!isModelsCatalogOverlay(parsed)) return null;
		return countCatalogModels(parsed.models);
	} catch {
		// Missing/malformed overlay must never break the update
		return null;
	}
}

export interface RefreshModelsCatalogOptions {
	/** Override for tests; defaults to the real models-catalog.json overlay path. */
	catalogPath?: string;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
	/** Injectable timeout for tests. Defaults to 15s, matching the CLI command. */
	timeoutMs?: number;
}

/**
 * Fetch the published catalog, validate it, and atomically replace the
 * models-catalog.json overlay. In-session counterpart of `gsd update
 * --models`.
 */
export async function refreshModelsCatalogOverlay(
	options: RefreshModelsCatalogOptions = {},
): Promise<ModelsCatalogRefreshResult> {
	const catalogPath = options.catalogPath ?? resolveGsdModelsCatalogPath();
	const fetchImpl = options.fetchImpl ?? fetch;

	let data: unknown;
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
		try {
			const res = await fetchImpl(GSD_MODELS_CATALOG_URL, { signal: controller.signal });
			// A non-2xx response reached the server; report the status instead
			// of a generic network message.
			if (!res.ok) {
				const statusText = res.statusText ? ` ${res.statusText}` : "";
				return {
					ok: false,
					reason: "http",
					message: `Failed to fetch model catalog: server responded with HTTP ${res.status}${statusText}. Existing catalog left unchanged.`,
				};
			}
			data = await res.json();
		} finally {
			clearTimeout(timeout);
		}
	} catch (err) {
		// res.json() throws a SyntaxError on malformed JSON — that is an
		// invalid payload, not a network error.
		if (err instanceof SyntaxError) {
			return {
				ok: false,
				reason: "invalid",
				message: "Fetched model catalog is invalid: expected a provider → model map. Existing catalog left unchanged.",
			};
		}
		return {
			ok: false,
			reason: "network",
			message: "Failed to fetch model catalog. Check your network connection. Existing catalog left unchanged.",
		};
	}

	if (!isModelsCatalog(data)) {
		return {
			ok: false,
			reason: "invalid",
			message: "Fetched model catalog is invalid: expected a provider → model map. Existing catalog left unchanged.",
		};
	}

	const previous = readExistingCatalogCounts(catalogPath);
	const after = countCatalogModels(data);

	const overlay = {
		version: 1,
		fetchedAt: new Date().toISOString(),
		source: GSD_MODELS_CATALOG_URL,
		models: data,
	};

	// Atomic write: temp file in the same directory, then rename — same
	// convention as `src/update-cmd.ts` and `copilot-overlay-writer.ts`.
	const tmpPath = `${catalogPath}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(catalogPath), { recursive: true });
		writeFileSync(tmpPath, `${JSON.stringify(overlay, null, 2)}\n`);
		renameSync(tmpPath, catalogPath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		const detail = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			reason: "write",
			message: `Failed to write model catalog: ${detail}. Existing catalog left unchanged.`,
		};
	}

	return { ok: true, path: catalogPath, providers: after.providers, models: after.models, previous };
}
