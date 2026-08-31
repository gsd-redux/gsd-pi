/**
 * Regression test for the extension-loader jiti aliases.
 *
 * jiti resolves alias keys by prefix-join: for "@gsd/agent-core/<sub>" it
 * joins the subpath onto the alias VALUE. When the "@gsd/agent-core" alias
 * pointed at the dist entry FILE (…/dist/index.js), a subpath import
 * produced "…/dist/index.js/lifecycle-hooks.js" and every jiti-loaded
 * module importing an @gsd/agent-core subpath failed with MODULE_NOT_FOUND
 * (this is what broke the search-tool registration gating coverage run).
 * Alias values that receive subpath joins must therefore be directories.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";

import { createJiti } from "@mariozechner/jiti";

import { getAliases } from "@gsd/pi-coding-agent/core/extensions/loader.js";

test("jiti aliases resolve @gsd/agent-core exact and subpath specifiers", async (t) => {
	const aliases = getAliases();
	const agentCore = aliases["@gsd/agent-core"];
	assert.ok(agentCore, "@gsd/agent-core alias must be defined");

	// Unbuilt checkouts fall back to import.meta.resolve, which names the dist
	// entry even when it is not on disk yet. CI and the coverage job always
	// build core first; skip rather than fail where no build exists.
	if (!existsSync(agentCore)) {
		t.skip(`@gsd/agent-core dist not built at ${agentCore}`);
		return;
	}

	const jiti = createJiti(import.meta.url, { alias: aliases });

	const exact = (await jiti.import("@gsd/agent-core")) as Record<string, unknown>;
	assert.equal(typeof exact.prepareLifecycleHooks, "function");

	const subpath = (await jiti.import("@gsd/agent-core/lifecycle-hooks.js")) as Record<string, unknown>;
	assert.equal(typeof subpath.prepareLifecycleHooks, "function");

	const message = "@gsd/agent-core alias must point at the dist directory, not a file";
	assert.equal(statSync(agentCore).isDirectory(), true, message);
	assert.ok(existsSync(`${agentCore}/index.js`), "dist directory must contain index.js");
	assert.ok(existsSync(`${agentCore}/lifecycle-hooks.js`), "dist directory must contain lifecycle-hooks.js");
});
