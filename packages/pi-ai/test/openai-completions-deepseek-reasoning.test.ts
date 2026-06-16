import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/openai-completions.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Full Required compat as detectCompat produces it for DeepSeek: replay reasoning
// under reasoning_content. Mirrors the fixture shape used by the sibling
// openai-completions tests in this directory.
const deepseekCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

// Same wire shape, but the provider does NOT require reasoning_content (e.g. a
// vanilla OpenAI-compatible endpoint): the captured field name must be preserved.
const standardCompat = {
	...deepseekCompat,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai" as const,
};

function buildDeepSeekModel(): Model<"openai-completions"> {
	return {
		id: "deepseek/deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

// OpenRouter normalises DeepSeek's reasoning to the "reasoning" field, so that is
// the signature captured during streaming and carried into the next request.
function buildContextWithCapturedReasoning(): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal chain", thinkingSignature: "reasoning" },
			{ type: "text", text: "Hi" },
		],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek/deepseek-chat",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 2,
	};
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions DeepSeek reasoning_content replay (#209)", () => {
	it("replays reasoning under reasoning_content when the captured field was 'reasoning'", () => {
		const messages = convertMessages(buildDeepSeekModel(), buildContextWithCapturedReasoning(), deepseekCompat);
		const assistant = messages.find((m) => m.role === "assistant") as Record<string, unknown> | undefined;
		expect(assistant).toBeDefined();
		// The reasoning text must land in reasoning_content (what DeepSeek requires on replay),
		// not the inbound "reasoning" field that OpenRouter happened to use.
		expect(assistant?.reasoning_content).toBe("internal chain");
		expect(assistant?.reasoning).toBeUndefined();
	});

	it("keeps the captured field name when the provider does not require reasoning_content", () => {
		const messages = convertMessages(buildDeepSeekModel(), buildContextWithCapturedReasoning(), standardCompat);
		const assistant = messages.find((m) => m.role === "assistant") as Record<string, unknown> | undefined;
		expect(assistant).toBeDefined();
		// No coercion for non-DeepSeek: the inbound field name is preserved unchanged.
		expect(assistant?.reasoning).toBe("internal chain");
		expect(assistant?.reasoning_content).toBeUndefined();
	});
});
