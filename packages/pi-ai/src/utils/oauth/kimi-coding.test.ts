import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test, type TestContext } from "node:test";
import { getModel } from "../../models.js";
import { streamAnthropic } from "../../providers/anthropic.js";
import type { Context, StreamOptions } from "../../types.js";
import { getOAuthApiKey, getOAuthProvider } from "./index.js";
import { kimiCodingOAuthProvider, loginKimiCoding, refreshKimiCodingToken } from "./kimi-coding.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function stubFetch(t: TestContext, implementation: typeof fetch): () => void {
	const originalFetch = globalThis.fetch;
	let restored = false;
	const restore = () => {
		if (!restored) {
			globalThis.fetch = originalFetch;
			restored = true;
		}
	};
	globalThis.fetch = implementation;
	t.after(restore);
	return restore;
}

async function captureKimiRequestHeaders(
	t: TestContext,
	auth: Pick<StreamOptions, "apiKey" | "apiKeyProvenance">,
): Promise<IncomingHttpHeaders> {
	let capturedHeaders: IncomingHttpHeaders | undefined;
	const server = createServer((request, response) => {
		capturedHeaders = request.headers;
		request.resume();
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	);

	const address = server.address() as AddressInfo;
	const model = {
		...getModel("kimi-coding", "kimi-for-coding"),
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	await streamAnthropic(model, context, auth).result();
	assert.ok(capturedHeaders, "Kimi request was not captured");
	return capturedHeaders;
}

describe("Kimi Code OAuth provider", () => {
	test("is registered as a built-in OAuth provider under the model provider id", () => {
		const provider = getOAuthProvider("kimi-coding");
		assert.ok(provider);
		assert.equal(provider.id, "kimi-coding");
	});

	test("returns the access token as the API key", () => {
		const key = kimiCodingOAuthProvider.getApiKey({ access: "tok_access", refresh: "tok_refresh", expires: 0 });
		assert.equal(key, "tok_access");
	});

	describe("device authorization login", () => {
		test("completes the public OAuth flow with bearer authentication", async (t) => {
			const restoreFetch = stubFetch(t, async (input) => {
				const url = String(input);
				if (url.endsWith("/api/oauth/device_authorization")) {
					return jsonResponse({
						device_code: "dev_code",
						user_code: "USER-CODE",
						verification_uri: "https://auth.kimi.com/device",
						verification_uri_complete: "https://auth.kimi.com/device?user_code=USER-CODE",
						interval: 1,
						expires_in: 900,
					});
				}
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			});

			let deviceInfo: { userCode: string; verificationUri: string } | undefined;
			const credentials = await loginKimiCoding({
				onAuth: () => {},
				onDeviceCode: (info) => {
					deviceInfo = info;
				},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			});

			assert.equal(deviceInfo?.userCode, "USER-CODE");
			assert.equal(deviceInfo?.verificationUri, "https://auth.kimi.com/device?user_code=USER-CODE");
			assert.equal(credentials.access, "access");
			assert.equal(credentials.refresh, "refresh");
			assert.ok(credentials.expires > Date.now());

			const result = await getOAuthApiKey("kimi-coding", { "kimi-coding": credentials });
			assert.ok(result);
			restoreFetch();
			const headers = await captureKimiRequestHeaders(t, result);
			assert.equal(headers.authorization, "Bearer access");
			assert.equal(headers["x-api-key"], undefined);

			const staticHeaders = await captureKimiRequestHeaders(t, { apiKey: result.apiKey });
			assert.equal(staticHeaders.authorization, undefined);
			assert.equal(staticHeaders["x-api-key"], "access");

			const otherOAuthHeaders = await captureKimiRequestHeaders(t, {
				apiKey: result.apiKey,
				apiKeyProvenance: { type: "oauth", provider: "github-copilot" },
			});
			assert.equal(otherOAuthHeaders.authorization, undefined);
			assert.equal(otherOAuthHeaders["x-api-key"], "access");
		});

		test("surfaces device authorization failure responses", async (t) => {
			stubFetch(t, async () => new Response("boom", { status: 500, statusText: "Server Error" }));

			await assert.rejects(
				loginKimiCoding({
					onAuth: () => {},
					onDeviceCode: () => {},
					onPrompt: async () => "",
					onSelect: async () => undefined,
				}),
				/Kimi Code device authorization failed with status 500/,
			);
		});
	});

	describe("token refresh", () => {
		test("uses bearer authentication for refreshed public OAuth credentials", async (t) => {
			const restoreFetch = stubFetch(t, async () =>
				jsonResponse({ access_token: "new-a", refresh_token: "new-r", expires_in: 3600 }),
			);

			const result = await getOAuthApiKey("kimi-coding", {
				"kimi-coding": { access: "old-a", refresh: "old-r", expires: 0 },
			});
			assert.ok(result);
			assert.equal(result.newCredentials.access, "new-a");
			assert.equal(result.newCredentials.refresh, "new-r");

			restoreFetch();
			const headers = await captureKimiRequestHeaders(t, result);
			assert.equal(headers.authorization, "Bearer new-a");
			assert.equal(headers["x-api-key"], undefined);
		});

		test("preserves API key authentication for static credentials", async (t) => {
			const headers = await captureKimiRequestHeaders(t, { apiKey: "static-key" });
			assert.equal(headers.authorization, undefined);
			assert.equal(headers["x-api-key"], "static-key");
		});

		test("does not expose token values from malformed successful responses", async (t) => {
			const responseAccess = "aa";
			const responseRefresh = "rr";
			stubFetch(t, async () => jsonResponse({ access_token: responseAccess, refresh_token: responseRefresh }));

			await assert.rejects(
				refreshKimiCodingToken("old-r"),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.equal(error.message, "Kimi Code token refresh response has invalid fields: expires_in");
					assert.equal(error.message.includes(responseAccess), false);
					assert.equal(error.message.includes(responseRefresh), false);
					return true;
				},
			);
		});

		test("does not expose token values from malformed error responses", async (t) => {
			const responseAccess = "aa";
			const responseRefresh = "rr";
			stubFetch(t, async () =>
				jsonResponse(
					{
						error: "unexpected_response",
						error_description: "contains aa and rr",
						access_token: responseAccess,
						refresh_token: responseRefresh,
					},
					400,
				),
			);

			await assert.rejects(
				refreshKimiCodingToken("old"),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.equal(error.message, "Kimi Code token refresh failed with status 400");
					assert.equal(error.message.includes(responseAccess), false);
					assert.equal(error.message.includes(responseRefresh), false);
					return true;
				},
			);
		});

		test("surfaces unauthorized refresh responses", async (t) => {
			stubFetch(t, async () => jsonResponse({ error: "invalid_grant" }, 401));
			await assert.rejects(refreshKimiCodingToken("dead-r"), /Kimi Code token refresh unauthorized/);
		});
	});
});
