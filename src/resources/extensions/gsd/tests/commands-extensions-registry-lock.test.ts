// gsd-pi — Regression test for Issue #1598 registry lock (commands-extensions.ts)
//
// `withRegistryLock` used to call proper-lockfile's `lockSync` with a `retries`
// option. proper-lockfile deliberately throws ESYNC ("Cannot use retries with the
// sync api") for that — retries are only supported by the async `lock()` API — so
// every `gsd extensions enable/disable/install/uninstall` failed. The fix routes
// the transaction through `withFileLockSync`, which drives retries manually.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { handleExtensions } from "../commands-extensions.ts";

function setupHome(): string {
	const home = mkdtempSync(join(tmpdir(), "gsd-ext-lock-"));
	const extDir = join(home, "extensions", "demo-ext");
	mkdirSync(extDir, { recursive: true });
	writeFileSync(
		join(extDir, "extension-manifest.json"),
		JSON.stringify({ id: "demo-ext", name: "Demo", tier: "community" }),
	);
	return home;
}

function makeCtx(notices: string[]): ExtensionCommandContext {
	return {
		ui: {
			notify: (message: string, _type?: "info" | "warning" | "error" | "success") => {
				notices.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;
}

describe("extensions registry lock (#1598)", () => {
	test("disable then enable mutate the registry without throwing ESYNC", async () => {
		const previous = process.env.GSD_HOME;
		const home = setupHome();
		process.env.GSD_HOME = home;
		const notices: string[] = [];
		const ctx = makeCtx(notices);

		try {
			await handleExtensions("disable demo-ext", ctx);
			const disabled = JSON.parse(readFileSync(join(home, "extensions", "registry.json"), "utf-8"));
			assert.equal(disabled.entries["demo-ext"].enabled, false);

			await handleExtensions("enable demo-ext", ctx);
			const enabled = JSON.parse(readFileSync(join(home, "extensions", "registry.json"), "utf-8"));
			assert.equal(enabled.entries["demo-ext"].enabled, true);
		} finally {
			if (previous === undefined) delete process.env.GSD_HOME;
			else process.env.GSD_HOME = previous;
			rmSync(home, { recursive: true, force: true });
		}

		assert.deepEqual(notices, [
			'Disabled "demo-ext". Restart GSD to deactivate.',
			'Enabled "demo-ext". Restart GSD to activate.',
		]);
	});
});
