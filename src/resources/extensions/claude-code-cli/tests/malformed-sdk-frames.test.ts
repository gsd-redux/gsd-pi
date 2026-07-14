// gsd-pi - Claude Code stream adapter: malformed SDK frame hardening.
//
// Regression coverage for the "Cannot read properties of undefined (reading
// 'type')" crash: the Claude Agent SDK subprocess can yield a `stream_event`
// with a missing `.event` payload, or an `assistant` message whose content
// array contains a null/undefined hole. Reading `.type` on those threw and
// killed the entire provider stream loop, ending the session. The stream
// adapter must drop the malformed frame (with a warning) and keep going.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	streamViaClaudeCode,
	handleClaudeCodePartialStreamEvent,
} from "../stream-adapter.ts";
import type { Context, Message } from "@gsd/pi-ai";

const MODEL = { id: "claude-sonnet-4-6" } as any;

function context(): Context {
	return { systemPrompt: "sys", messages: [{ role: "user", content: "hi" } as Message] };
}

async function driveSdkWith(frames: unknown[]): Promise<{ stopReason?: string; errorMessage?: string }> {
	const cwd = mkdtempSync(join(tmpdir(), "claude-malformed-"));
	try {
		const stream = streamViaClaudeCode(MODEL, context(), {
			cwd,
			_skipWorkflowMcpPreflightForTest: true,
			async *_sdkQueryForTest() {
				for (const frame of frames) yield frame;
				yield {
					type: "result", subtype: "success", uuid: "r", session_id: "s",
					duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
					result: "ok", stop_reason: "end_turn", total_cost_usd: 0,
					usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				};
			},
		} as any);
		const message = await stream.result();
		return { stopReason: (message as any).stopReason, errorMessage: (message as any).errorMessage };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("claude-code stream adapter: malformed SDK frame hardening", () => {
	test("handleClaudeCodePartialStreamEvent tolerates an undefined event", () => {
		assert.doesNotThrow(() => {
			const result = handleClaudeCodePartialStreamEvent(null, undefined as never, "m");
			assert.equal(result.assistantEvent, null);
		});
	});

	test("a stream_event with a missing .event payload does not crash the loop", async () => {
		const outcome = await driveSdkWith([
			{ type: "stream_event", event: undefined, parent_tool_use_id: null, uuid: "p", session_id: "s" },
		]);
		assert.notEqual(outcome.stopReason, "error");
		assert.equal(outcome.errorMessage, undefined);
	});

	test("an assistant message with a null content hole does not crash the loop", async () => {
		const outcome = await driveSdkWith([
			{ type: "assistant", uuid: "a", session_id: "s", message: { model: "claude-sonnet-4-6", content: [undefined] } },
		]);
		assert.notEqual(outcome.stopReason, "error");
		assert.equal(outcome.errorMessage, undefined);
	});

	test("a well-formed content block missing only optional fields still does not crash", async () => {
		const outcome = await driveSdkWith([
			{ type: "assistant", uuid: "a", session_id: "s", message: { model: "claude-sonnet-4-6", content: [{}] } },
		]);
		assert.notEqual(outcome.stopReason, "error");
	});

	test("an unhandled streamed block type does not desync the index map and crash", async () => {
		// content_block_start for a block type the streaming path does not push
		// (e.g. web_search_tool_result, redacted_thinking) must NOT record an
		// index mapping; otherwise the paired content_block_stop resolves that
		// mapping to an unpushed slot and reads `.type` off undefined — the exact
		// "reading 'type'" crash, from a well-formed frame the guards don't cover.
		const outcome = await driveSdkWith([
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "web_search_tool_result", tool_use_id: "t", content: [] },
				},
				parent_tool_use_id: null, uuid: "p1", session_id: "s",
			},
			{
				type: "stream_event",
				event: { type: "content_block_stop", index: 0 },
				parent_tool_use_id: null, uuid: "p2", session_id: "s",
			},
		]);
		assert.notEqual(outcome.stopReason, "error");
		assert.equal(outcome.errorMessage, undefined);
	});

	test("a null or type-less top-level SDK frame is dropped, not fatal", async () => {
		// The raw frame from the for-await loop is dispatched via `switch (msg.type)`;
		// a null frame or one missing a string `.type` must be dropped, not throw.
		const outcome = await driveSdkWith([
			null,
			{ not_a_type: true },
		]);
		assert.notEqual(outcome.stopReason, "error");
		assert.equal(outcome.errorMessage, undefined);
	});
});
