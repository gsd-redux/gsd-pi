import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SUMMARIZATION_SYSTEM_PROMPT } from "./utils.js";

describe("compaction state-snapshot prompts", () => {
	it("uses a handoff-briefing system prompt", () => {
		assert.match(SUMMARIZATION_SYSTEM_PROMPT, /handoff briefing writer/i);
		assert.match(SUMMARIZATION_SYSTEM_PROMPT, /state snapshot/i);
	});

	it("requires state-snapshot sections in compaction summarization prompts", () => {
		const source = readFileSync(join(import.meta.dirname, "compaction.ts"), "utf8");
		assert.match(source, /## Current Direction/);
		assert.match(source, /## Next Action/);
		assert.match(source, /## Failed Approaches/);
		assert.match(source, /STATE SNAPSHOT/);
	});

	it("wraps injected compaction summaries as authoritative briefings", () => {
		const messagesSource = readFileSync(
			join(import.meta.dirname, "../../../pi-coding-agent/src/core/messages.ts"),
			"utf8",
		);
		assert.match(messagesSource, /handoff briefing/i);
		assert.match(messagesSource, /Next Action/);
		assert.match(messagesSource, /<briefing>/);
		assert.match(messagesSource, /<\/briefing>/);
	});
});
