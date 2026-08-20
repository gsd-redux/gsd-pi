import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CURSOR_AGENT_MODELS,
	parseCursorAgentModelList,
	resolveCursorAgentModels,
} from "../models.ts";

const fixture = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "fixtures/cursor-list-models.txt"),
	"utf8",
);

test("parseCursorAgentModelList reads id - Name lines and skips headers (#1869)", () => {
	const models = parseCursorAgentModelList(`Available models\n${fixture}\nTip: use --model <id>`);
	assert.ok(models.length > 50);
	assert.ok(models.some((m) => m.id === "composer-2.5"));
	assert.ok(models.some((m) => m.id === "gpt-5.6-sol-high"));
	assert.ok(models.some((m) => m.id === "claude-sonnet-5-thinking-high"));
	assert.ok(models.some((m) => m.id === "gemini-3.1-pro"));
	assert.ok(!models.some((m) => m.id === "claude-sonnet-4-6"));
	assert.ok(!models.some((m) => m.id === "gpt-5.5"));
	assert.ok(!models.some((m) => m.id.includes("[")));
});

test("every hardcoded fallback ID appears in the --list-models fixture (#1869)", () => {
	const listed = new Set(parseCursorAgentModelList(fixture).map((m) => m.id));
	for (const model of CURSOR_AGENT_MODELS) {
		assert.ok(listed.has(model.id), `fallback id missing from CLI list: ${model.id}`);
	}
});

test("1M naming sets a 1M context window; thinking/effort IDs are reasoning (#1869)", () => {
	const [sol] = parseCursorAgentModelList("gpt-5.6-sol-high - GPT-5.6 Sol 1M High");
	assert.equal(sol?.contextWindow, 1_000_000);
	assert.equal(sol?.reasoning, true);
	const [flash] = parseCursorAgentModelList("gemini-3.7-flash-high - Gemini 3.7 Flash");
	assert.equal(flash?.contextWindow, 256_000);
	assert.equal(flash?.name, "Gemini 3.7 Flash (via Cursor)");
});

test("resolveCursorAgentModels falls back when CLI output is empty (#1869)", () => {
	assert.equal(resolveCursorAgentModels(null), CURSOR_AGENT_MODELS);
	assert.equal(resolveCursorAgentModels(""), CURSOR_AGENT_MODELS);
	assert.equal(resolveCursorAgentModels("Available models\n"), CURSOR_AGENT_MODELS);
	const discovered = resolveCursorAgentModels("kimi-k3 - Kimi K3");
	assert.equal(discovered.length, 1);
	assert.equal(discovered[0]?.id, "kimi-k3");
});
