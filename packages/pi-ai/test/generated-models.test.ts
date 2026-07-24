// Project/App: gsd-pi
// File Purpose: Regression tests for generated model catalog output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { calculateCost } from "../src/models.ts";
import { MODELS } from "../src/models.generated.ts";

describe("models.generated.ts", () => {
	test("does not include floating-point precision artifacts in cost literals", () => {
		// allow-source-grep: generated catalog is data output; this test guards numeric literal formatting only
		const generated = readFileSync(join(import.meta.dirname, "../src/models.generated.ts"), "utf8");
		const noisyCostLiteral = /^\s+(?:input|output|cacheRead|cacheWrite): \d+\.\d{13,},/m;

		expect(generated).not.toMatch(noisyCostLiteral);
	});

	test("includes Claude Fable 5 across its supported providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-fable-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-fable-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		expect(MODELS["amazon-bedrock"]["us.anthropic.claude-fable-5"]).toBeDefined();
		expect(MODELS.openrouter["anthropic/claude-fable-5"]).toBeDefined();
	});

	test("includes Claude Sonnet 5 across Anthropic-backed providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-sonnet-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.name).toBe("Claude Sonnet 5");
		expect(anthropic.contextWindow).toBe(1_000_000);
		expect(anthropic.maxTokens).toBe(128_000);
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-sonnet-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.name).toBe("Claude Sonnet 5 (Vertex)");
		expect(vertex.contextWindow).toBe(1_000_000);
		expect(vertex.maxTokens).toBe(128_000);
		expect(vertex.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		for (const [id, name] of [
			["anthropic.claude-sonnet-5", "Claude Sonnet 5"],
			["us.anthropic.claude-sonnet-5", "Claude Sonnet 5 (US)"],
			["global.anthropic.claude-sonnet-5", "Claude Sonnet 5 (Global)"],
		] as const) {
			const bedrock = MODELS["amazon-bedrock"][id];
			expect(bedrock).toBeDefined();
			expect(bedrock.api).toBe("bedrock-converse-stream");
			expect(bedrock.name).toBe(name);
			expect(bedrock.contextWindow).toBe(1_000_000);
			expect(bedrock.maxTokens).toBe(128_000);
			expect(bedrock.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		}
	});

	test("includes GPT-5.6 variants for the GitHub Copilot provider", () => {
		expect("gpt-5.6" in MODELS["github-copilot"]).toBe(false);

		for (const [id, name, input, output, cacheRead] of [
			["gpt-5.6-sol", "GPT-5.6 Sol", 5, 30, 0.5],
			["gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15, 0.25],
			["gpt-5.6-luna", "GPT-5.6 Luna", 1, 6, 0.1],
		] as const) {
			const copilot = MODELS["github-copilot"][id];
			expect(copilot).toBeDefined();
			expect(copilot.api).toBe("openai-responses");
			expect(copilot.name).toBe(name);
			expect(copilot.baseUrl).toBe("https://api.individual.githubcopilot.com");
			expect(copilot.contextWindow).toBe(400_000);
			expect(copilot.maxTokens).toBe(128_000);
			expect(copilot.thinkingLevelMap).toMatchObject({ minimal: "low", xhigh: "xhigh", max: "max" });
			expect(copilot.cost.input).toBe(input);
			expect(copilot.cost.output).toBe(output);
			expect(copilot.cost.cacheRead).toBe(cacheRead);
		}
	});

	test("includes GPT-5.6 variants for OpenAI and OpenAI Codex providers", () => {
		expect("gpt-5.6" in MODELS.openai).toBe(false);
		expect("gpt-5.6" in MODELS["openai-codex"]).toBe(false);

		const variants = [
			["gpt-5.6-sol", "GPT-5.6 Sol", 5, 30],
			["gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15],
			["gpt-5.6-luna", "GPT-5.6 Luna", 1, 6],
		] as const;

		for (const [id, name, input, output] of variants) {
			const openai = MODELS.openai[id];
			expect(openai).toBeDefined();
			expect(openai.api).toBe("openai-responses");
			expect(openai.name).toBe(name);
			expect(openai.contextWindow).toBe(272_000);
			expect(openai.maxTokens).toBe(128_000);
			expect(openai.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", max: "max" });
			expect(openai.cost.input).toBe(input);
			expect(openai.cost.output).toBe(output);

			const codex = MODELS["openai-codex"][id];
			expect(codex).toBeDefined();
			expect(codex.api).toBe("openai-codex-responses");
			expect(codex.name).toBe(name);
			expect(codex.baseUrl).toBe("https://chatgpt.com/backend-api");
			expect(codex.contextWindow).toBe(372_000);
			expect(codex.maxTokens).toBe(128_000);
			expect(codex.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max", minimal: "low" });
			expect(codex.cost.input).toBe(input);
			expect(codex.cost.output).toBe(output);
		}

		const sol = MODELS["openai-codex"]["gpt-5.6-sol"];
		expect(sol.cost.tiers?.[0]).toMatchObject({ inputTokensAbove: 272_000, input: 10, output: 45 });
		const usage = {
			input: 272_001,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 273_001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(calculateCost(sol, usage).input).toBeCloseTo((10 / 1_000_000) * 272_001);
	});

	test("includes Anthropic Vertex models from the generated catalog", () => {
		const models = MODELS["anthropic-vertex"];

		expect(models).toBeDefined();
		expect(models["claude-sonnet-4-6"]).toBeDefined();
		expect(models["claude-opus-4-8"]).toBeDefined();
		expect(models["claude-haiku-4-5@20251001"]).toBeDefined();
		expect(Object.keys(models).some((id) => id.includes("@default"))).toBe(false);

		for (const model of Object.values(models)) {
			expect(model.provider).toBe("anthropic-vertex");
			expect(model.api).toBe("anthropic-vertex");
		}
	});

	test("includes MiniMax M3 for direct MiniMax providers", () => {
		const providers = [
			["minimax", "https://api.minimax.io/anthropic"],
			["minimax-cn", "https://api.minimaxi.com/anthropic"],
		] as const;

		for (const [provider, baseUrl] of providers) {
			const model = MODELS[provider]["MiniMax-M3"];

			expect(model).toMatchObject({
				id: "MiniMax-M3",
				name: "MiniMax-M3",
				api: "anthropic-messages",
				provider,
				baseUrl,
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: 0.6,
					output: 2.4,
					cacheRead: 0.12,
					cacheWrite: 0,
				},
				contextWindow: 1000000,
				maxTokens: 131072,
			});
		}
	});

	test("includes Grok 4.5 as a first-class xAI model", () => {
		const model = MODELS.xai["grok-4.5"];

		expect(model).toMatchObject({
			id: "grok-4.5",
			name: "Grok 4.5",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.5,
				cacheWrite: 0,
			},
			contextWindow: 500000,
			maxTokens: 30000,
		});
	});

	test("includes Muse Spark 1.1 as a first-class Vercel AI Gateway model", () => {
		const model = MODELS["vercel-ai-gateway"]["meta/muse-spark-1.1"];

		expect(model).toMatchObject({
			id: "meta/muse-spark-1.1",
			name: "Muse Spark 1.1",
			// The generator tags every Vercel AI Gateway model as anthropic-messages;
			// the gateway serves an Anthropic-compatible endpoint across its catalog.
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 4.25,
				cacheRead: 0.15,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 1048576,
		});
	});

	test("keeps GitHub Copilot Claude 4.6 context at Copilot's 200K limit", () => {
		for (const id of ["claude-opus-4.6", "claude-sonnet-4.6"] as const) {
			const model = MODELS["github-copilot"][id];

			expect(model.provider).toBe("github-copilot");
			expect(model.api).toBe("anthropic-messages");
			expect(model.contextWindow).toBe(200000);
			expect(model.maxTokens).toBe(32000);
		}
	});
});
