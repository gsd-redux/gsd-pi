import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-opus-4-6",
	"anthropic/claude-opus-4-7",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-sonnet-4-6",
	"anthropic-vertex/claude-opus-4-6",
	"anthropic-vertex/claude-opus-4-7",
	"anthropic-vertex/claude-opus-4-8",
	"anthropic-vertex/claude-sonnet-4-6",
	"cloudflare-ai-gateway/claude-opus-4-6",
	"cloudflare-ai-gateway/claude-opus-4-7",
	"cloudflare-ai-gateway/claude-opus-4-8",
	"cloudflare-ai-gateway/claude-sonnet-4-6",
	"github-copilot/claude-opus-4.6",
	"github-copilot/claude-opus-4.7",
	"github-copilot/claude-opus-4.8",
	"github-copilot/claude-sonnet-4.6",
	"opencode/claude-opus-4-6",
	"opencode/claude-opus-4-7",
	"opencode/claude-opus-4-8",
	"opencode/claude-sonnet-4-6",
	"vercel-ai-gateway/anthropic/claude-opus-4.6",
	"vercel-ai-gateway/anthropic/claude-opus-4.7",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-sonnet-4.6",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks exactly the built-in Anthropic API models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model) => model.api === "anthropic-messages" || model.api === "anthropic-vertex")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual([...EXPECTED_ADAPTIVE_THINKING_MODELS].sort());
	});
});
