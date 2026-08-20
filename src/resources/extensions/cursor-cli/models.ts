const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const CURSOR_INPUT: ("text" | "image")[] = ["text"];

export type CursorAgentModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: typeof ZERO_COST;
	contextWindow: number;
	maxTokens: number;
};

/** Offline fallback when `cursor-agent --list-models` is unavailable (#1869). */
export const CURSOR_AGENT_MODELS: CursorAgentModel[] = [
	model("composer-2.5", "Composer 2.5"),
	model("claude-4.6-sonnet-medium", "Claude Sonnet 4.6 1M"),
	model("claude-opus-4-7-medium", "Claude Opus 4.7 1M Medium"),
	model("gpt-5.5-medium", "GPT-5.5 1M"),
	model("gemini-3.1-pro", "Gemini 3.1 Pro"),
	model("cursor-grok-4.6-high", "Cursor Grok 4.6"),
];

const LIST_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*) - (.+)$/;

function model(id: string, name: string): CursorAgentModel {
	return cursorAgentModelFromListEntry(id, name);
}

export function cursorAgentModelFromListEntry(id: string, name: string): CursorAgentModel {
	const blob = `${id} ${name}`;
	const contextWindow = /\b1M\b/i.test(blob) || /1m/i.test(id) ? 1_000_000 : 256_000;
	const reasoning =
		/thinking|composer/i.test(blob) ||
		/(?:^|-)(?:none|low|medium|high|xhigh|extra-high|max)(?:-|$)/i.test(id);
	const display = name.replace(/\s+\(via Cursor\)$/i, "").trim();
	return {
		id,
		name: /via Cursor/i.test(name) ? name : `${display} (via Cursor)`,
		reasoning,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow,
		maxTokens: /opus/i.test(id) ? 128_000 : 64_000,
	};
}

export function parseCursorAgentModelList(output: string): CursorAgentModel[] {
	const models: CursorAgentModel[] = [];
	const seen = new Set<string>();
	for (const raw of output.split(/\r?\n/)) {
		const match = LIST_LINE_RE.exec(raw.trim());
		if (!match) continue;
		const id = match[1]!;
		if (id.includes("[") || seen.has(id)) continue;
		seen.add(id);
		models.push(cursorAgentModelFromListEntry(id, match[2]!.trim()));
	}
	return models;
}

export function resolveCursorAgentModels(listOutput: string | null | undefined): CursorAgentModel[] {
	if (!listOutput) return CURSOR_AGENT_MODELS;
	const parsed = parseCursorAgentModelList(listOutput);
	return parsed.length > 0 ? parsed : CURSOR_AGENT_MODELS;
}
