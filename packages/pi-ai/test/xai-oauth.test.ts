import { describe, expect, it } from "vitest";
import { getProviders } from "../src/models.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Api, Model } from "../src/types.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import { enforceXaiTokenOrigin, xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

describe("xAI OAuth provider", () => {
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
