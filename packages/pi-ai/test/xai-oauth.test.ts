import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviders } from "../src/models.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Api, Model } from "../src/types.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import { enforceXaiTokenOrigin, loginXai, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

describe("xAI OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	it("is registered as a built-in OAuth provider under the model provider id", () => {
		const provider = getOAuthProvider("xai");
		expect(provider).toBeDefined();
		expect(provider?.id).toBe("xai");
		expect(provider?.usesCallbackServer).toBe(true);
	});

	it("returns the access token as the API key", () => {
		const key = xaiOAuthProvider.getApiKey({ access: "tok_access", refresh: "tok_refresh", expires: 0 });
		expect(key).toBe("tok_access");
	});

	describe("token lifecycle", () => {
		it("surfaces token exchange failure responses", async () => {
			const fetchMock = vi.fn(async (): Promise<Response> => new Response("invalid authorization code", {
				status: 400,
				statusText: "Bad Request",
			}));
			vi.stubGlobal("fetch", fetchMock);

			let redirectState = "";
			await expect(loginXai({
				onAuth: (info) => {
					redirectState = new URL(info.url).searchParams.get("state") ?? "";
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => `http://127.0.0.1:56121/callback?code=bad_code&state=${redirectState}`,
			})).rejects.toThrow("xAI token exchange failed (400): invalid authorization code");

			expect(fetchMock).toHaveBeenCalledOnce();
		});

		it("surfaces token refresh failure responses", async () => {
			const fetchMock = vi.fn(async (): Promise<Response> => new Response("expired refresh token", {
				status: 401,
				statusText: "Unauthorized",
			}));
			vi.stubGlobal("fetch", fetchMock);

			await expect(refreshXaiToken("stale_refresh")).rejects.toThrow(
				"xAI token refresh failed (401): expired refresh token",
			);
		});

		it("preserves the existing refresh token when refresh responses omit one", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));

			const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse({
				["access_" + "token"]: "new_access",
				expires_in: 900,
			}));
			vi.stubGlobal("fetch", fetchMock);

			const credentials = await refreshXaiToken("existing_refresh");

			expect(credentials).toEqual({
				access: "new_access",
				refresh: "existing_refresh",
				expires: Date.parse("2026-07-14T00:15:00Z"),
			});
		});
	});

	describe("token origin guard", () => {
		const makeModel = (baseUrl: string, provider = "xai"): Model<Api> =>
			({
				id: "grok-4.5",
				name: "Grok 4.5",
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: true,
				input: ["text"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500000,
				maxTokens: 30000,
			}) as Model<Api>;

		it("keeps models already pointing at https://api.x.ai", () => {
			const models = enforceXaiTokenOrigin([makeModel("https://api.x.ai/v1")]);
			expect(models[0]?.baseUrl).toBe("https://api.x.ai/v1");
		});

		it("rewrites xai models pointing at a foreign origin", () => {
			const models = enforceXaiTokenOrigin([
				makeModel("https://evil.example.com/v1"),
				makeModel("http://api.x.ai/v1"), // http downgrade is also a foreign origin
				makeModel("not a url"),
			]);
			for (const model of models) {
				expect(model.baseUrl).toBe("https://api.x.ai/v1");
			}
		});

		it("leaves non-xai models untouched", () => {
			const model = makeModel("https://api.openai.com/v1", "openai");
			const models = enforceXaiTokenOrigin([model]);
			expect(models[0]?.baseUrl).toBe("https://api.openai.com/v1");
		});

		it("is wired into the provider's modifyModels hook", () => {
			const models = xaiOAuthProvider.modifyModels?.(
				[makeModel("https://evil.example.com/v1")],
				{ access: "a", refresh: "r", expires: 0 },
			);
			expect(models?.[0]?.baseUrl).toBe("https://api.x.ai/v1");
		});
	});

	it("catalog has the full xAI chat/code lineup (docs.x.ai parity, 2026-07-14)", () => {
		expect(getProviders()).toContain("xai");
		const xaiCatalog = MODELS.xai as Record<string, Model<Api>>;
		const xaiModels = Object.keys(xaiCatalog ?? {});
		for (const expected of [
			"grok-4.5",
			"grok-4.3",
			"grok-4.20-0309-reasoning",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-multi-agent-0309",
			"grok-build-0.1",
		]) {
			expect(xaiModels).toContain(expected);
		}
		for (const model of Object.values(xaiCatalog ?? {})) {
			expect(new URL(model.baseUrl).origin).toBe("https://api.x.ai");
		}
	});
});
