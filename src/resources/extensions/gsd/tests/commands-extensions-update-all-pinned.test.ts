// gsd-pi — Regression test: update-all must query the registry by bare package
// name even when installedFrom carries a version pin (pkg@1.2.3), which
// previously produced registry.npmjs.org/pkg@1.2.3/latest → 404 → skip.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { handleExtensions } from "../commands-extensions.ts";

test("update-all resolves pinned installedFrom to the bare package name", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gsd-ext-update-pinned-"));
	const previousHome = process.env.GSD_HOME;
	t.after(() => {
		if (previousHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousHome;
		delete (globalThis as { __gsdLastFetchUrl?: string }).__gsdLastFetchUrl;
		rmSync(root, { recursive: true, force: true });
	});

	// GSD_HOME is the .gsd config dir itself, so the registry lives at
	// $GSD_HOME/extensions/registry.json.
	const gsdHomeDir = join(root, "home", ".gsd");
	mkdirSync(join(gsdHomeDir, "extensions"), { recursive: true });
	writeFileSync(
		join(gsdHomeDir, "extensions", "registry.json"),
		JSON.stringify({
			version: 1,
			entries: {
				"demo-ext": {
					id: "demo-ext",
					enabled: true,
					source: "user",
					installType: "npm",
					installedFrom: "@scope/demo-ext@0.8.0",
					version: "0.8.0",
				},
			},
		}),
	);
	process.env.GSD_HOME = gsdHomeDir;

	const fetchedUrls: string[] = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		fetchedUrls.push(url);
		return new Response(JSON.stringify({ version: "0.9.0" }), { status: 200 });
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = previousFetch;
	});

	const notices: string[] = [];
	const ctx = {
		ui: {
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionCommandContext;

	await handleExtensions("update", ctx);

	assert.equal(fetchedUrls.length, 1, "exactly one registry lookup expected");
	assert.equal(
		fetchedUrls[0],
		"https://registry.npmjs.org/@scope/demo-ext/latest",
		"must query the bare package name, not the pinned specifier",
	);
	assert.ok(
		fetchedUrls[0]!.includes("@0.8.0") === false,
		"the version pin must never reach the registry URL",
	);
});
