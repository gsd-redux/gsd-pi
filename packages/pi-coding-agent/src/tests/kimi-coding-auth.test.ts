import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AuthStorage } from "../core/auth-storage.js";
import { ModelRegistry } from "../core/model-registry.js";

function stubFetch(t: TestContext, implementation: typeof fetch): void {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = implementation;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
}

test("adds bearer headers only for Kimi OAuth credentials", async (t) => {
	const authStorage = AuthStorage.inMemory();
	authStorage.set("kimi-coding", {
		type: "oauth",
		access: "oa",
		refresh: "rf",
		expires: Date.now() + 60_000,
	});
	const registry = ModelRegistry.create(authStorage);
	const model = registry.find("kimi-coding", "kimi-for-coding");
	assert.ok(model);

	const oauthAuth = await registry.getApiKeyAndHeaders(model);
	assert.ok(oauthAuth.ok);
	assert.equal(oauthAuth.apiKey, "oa");
	assert.equal(oauthAuth.headers?.Authorization, "Bearer oa");

	authStorage.set("kimi-coding", { type: "api_key", key: "key" });
	assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
		ok: true,
		apiKey: "key",
		headers: { "User-Agent": "KimiCLI/1.5" },
	});

	authStorage.set("kimi-coding", {
		type: "oauth",
		access: "ex",
		refresh: "rf",
		expires: Date.now() - 1,
	});
	stubFetch(t, async () =>
		new Response(JSON.stringify({ access_token: "nb", refresh_token: "nr", expires_in: 3600 }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);

	const refreshedAuth = await registry.getApiKeyAndHeaders(model);
	assert.ok(refreshedAuth.ok);
	assert.equal(refreshedAuth.apiKey, "nb");
	assert.equal(refreshedAuth.headers?.Authorization, "Bearer nb");
});
