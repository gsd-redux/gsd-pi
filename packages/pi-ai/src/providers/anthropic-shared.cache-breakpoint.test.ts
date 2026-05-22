// @gsd/pi-ai + anthropic-shared.cache-breakpoint.test — coverage for #5027.
// `convertMessages` must apply Anthropic `cache_control` to:
//   - the last message (existing volatile-suffix anchor — preserved)
//   - the most recent message flagged with `cacheBreakpoint: true`
//     (new compaction-boundary anchor)
// And it must NOT exceed the 4-breakpoint limit by treating multiple
// breakpoints as one — only the most recent earns the marker.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildParams, convertMessages } from "./anthropic-shared.js";
import type { Context, Message, Model, Tool } from "../types.js";
import type { AnthropicApi } from "./anthropic-shared.js";

// Minimal model stub — convertMessages only reads `input` to decide whether to
// drop image blocks. Returning ["image"] keeps the conversion paths exercised.
const model = { input: ["text", "image"] } as unknown as Model<AnthropicApi>;
const cacheControl = { type: "ephemeral" as const };

function userMsg(text: string, opts: { cacheBreakpoint?: boolean } = {}): Message {
	return {
		role: "user",
		content: text,
		timestamp: 0,
		...(opts.cacheBreakpoint ? { cacheBreakpoint: true } : {}),
	} as Message;
}

/** Produces a UserMessage whose content is an array of text blocks —
 * the production shape emitted by `convertToLlm()` for compaction summaries. */
function userMsgArray(text: string, opts: { cacheBreakpoint?: boolean } = {}): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
		...(opts.cacheBreakpoint ? { cacheBreakpoint: true } : {}),
	} as Message;
}

function assistantMsg(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as Message;
}

/** Returns whether the message at the given index has cache_control on its last block. */
function hasCacheControl(params: ReturnType<typeof convertMessages>, index: number): boolean {
	const param = params[index];
	if (!param || param.role !== "user") return false;
	if (!Array.isArray(param.content)) return false;
	const lastBlock = param.content[param.content.length - 1];
	return Boolean(lastBlock && (lastBlock as any).cache_control);
}

describe("convertMessages — cache breakpoints (#5027)", () => {
	test("with no cacheControl option: no breakpoints are placed", () => {
		const result = convertMessages([userMsg("hello"), assistantMsg("hi"), userMsg("again")], model, false);
		for (let i = 0; i < result.length; i++) {
			assert.equal(hasCacheControl(result, i), false, `index ${i} should have no cache_control`);
		}
	});

	test("no cacheBreakpoint anywhere: only the last message gets cache_control (existing behavior preserved)", () => {
		const result = convertMessages(
			[userMsg("first"), assistantMsg("response"), userMsg("second")],
			model,
			false,
			cacheControl,
		);
		assert.equal(hasCacheControl(result, 0), false, "first user msg has no breakpoint");
		assert.equal(hasCacheControl(result, result.length - 1), true, "last msg gets the volatile-suffix anchor");
	});

	test("one cacheBreakpoint message: both that message AND the last message get breakpoints", () => {
		const result = convertMessages(
			[
				userMsg("ancient"),
				assistantMsg("ancient response"),
				userMsg("[COMPACTION SUMMARY]", { cacheBreakpoint: true }),
				assistantMsg("post-compaction response"),
				userMsg("new turn"),
			],
			model,
			false,
			cacheControl,
		);
		// Find the compaction-summary index (it's the third user-shaped param)
		const compactionIdx = result.findIndex(
			(p) => p.role === "user" && Array.isArray(p.content) && (p.content as any)[0]?.text?.includes("COMPACTION SUMMARY"),
		);
		assert.ok(compactionIdx >= 0, "compaction summary should be in the params");
		assert.equal(hasCacheControl(result, compactionIdx), true, "compaction boundary gets a breakpoint");
		assert.equal(hasCacheControl(result, result.length - 1), true, "last msg still gets the volatile-suffix anchor");
	});

	test("array-content cacheBreakpoint message: breakpoint is applied (production shape for compaction summary)", () => {
		// convertToLlm() emits compaction summaries as content:[{type:"text",...}];
		// this exercises the array-backed branch in anthropic-shared.ts.
		const result = convertMessages(
			[
				userMsgArray("[COMPACTION SUMMARY]", { cacheBreakpoint: true }),
				assistantMsg("post-compaction response"),
				userMsg("post-compaction turn"),
			],
			model,
			false,
			cacheControl,
		);
		const compactionIdx = result.findIndex(
			(p) =>
				p.role === "user" &&
				Array.isArray(p.content) &&
				(p.content as any)[0]?.text?.includes("COMPACTION SUMMARY"),
		);
		assert.ok(compactionIdx >= 0, "compaction summary param should be present");
		assert.equal(hasCacheControl(result, compactionIdx), true, "array-content boundary gets cache_control");
		assert.equal(hasCacheControl(result, result.length - 1), true, "last msg still gets the volatile-suffix anchor");
	});

	test("multiple cacheBreakpoint messages: only the most recent one earns a breakpoint (4-limit safety)", () => {
		const result = convertMessages(
			[
				userMsg("[OLD COMPACTION]", { cacheBreakpoint: true }),
				assistantMsg("post-old response"),
				userMsg("[NEW COMPACTION]", { cacheBreakpoint: true }),
				assistantMsg("post-new response"),
				userMsg("latest turn"),
			],
			model,
			false,
			cacheControl,
		);
		const oldIdx = result.findIndex(
			(p) => p.role === "user" && Array.isArray(p.content) && (p.content as any)[0]?.text?.includes("OLD COMPACTION"),
		);
		const newIdx = result.findIndex(
			(p) => p.role === "user" && Array.isArray(p.content) && (p.content as any)[0]?.text?.includes("NEW COMPACTION"),
		);
		assert.equal(hasCacheControl(result, oldIdx), false, "older boundary should not earn a breakpoint");
		assert.equal(hasCacheControl(result, newIdx), true, "most recent boundary earns the breakpoint");
		assert.equal(hasCacheControl(result, result.length - 1), true, "last msg still gets the volatile-suffix anchor");
	});

	test("cacheBreakpoint on the LAST message: only one breakpoint applied (deduplication)", () => {
		// When the boundary message IS the last message, applying twice would be
		// a no-op overwrite but the deduplication guard avoids the double-call.
		const result = convertMessages(
			[userMsg("hello"), userMsg("[BOUNDARY AS LAST]", { cacheBreakpoint: true })],
			model,
			false,
			cacheControl,
		);
		assert.equal(hasCacheControl(result, result.length - 1), true);
		// Only one user message besides the last, with no breakpoint
		assert.equal(hasCacheControl(result, 0), false);
	});

	test("cacheBreakpoint flag is ignored when no cacheControl option is provided", () => {
		const result = convertMessages(
			[userMsg("[COMPACTION]", { cacheBreakpoint: true }), userMsg("turn")],
			model,
			false,
		);
		for (let i = 0; i < result.length; i++) {
			assert.equal(hasCacheControl(result, i), false, `index ${i} should have no cache_control`);
		}
	});

	test("array-content cacheBreakpoint on last message: deduplication guard prevents double application", () => {
		// The boundary IS the last message — both anchors target the same param,
		// so cache_control should appear exactly once.
		const result = convertMessages(
			[userMsg("prior turn"), userMsgArray("[BOUNDARY AS LAST]", { cacheBreakpoint: true })],
			model,
			false,
			cacheControl,
		);
		const lastParam = result[result.length - 1];
		assert.ok(lastParam && Array.isArray(lastParam.content), "last param has array content");
		const cacheBlocks = (lastParam!.content as any[]).filter((b) => b.cache_control);
		assert.equal(cacheBlocks.length, 1, "cache_control applied exactly once");
		assert.equal(hasCacheControl(result, 0), false, "prior turn has no cache_control");
	});
});

// ─── 4-breakpoint-limit safety at buildParams level (OAuth path) ──────────

/** Count cache_control occurrences across system + tools + messages params. */
function countBreakpoints(params: { system?: any; tools?: any[]; messages: any[] }): number {
	let n = 0;
	if (Array.isArray(params.system)) {
		for (const block of params.system) if (block.cache_control) n++;
	}
	if (Array.isArray(params.tools)) {
		for (const tool of params.tools) if ((tool as any).cache_control) n++;
	}
	for (const m of params.messages) {
		if (m.role === "user" && Array.isArray(m.content)) {
			for (const block of m.content) if (block.cache_control) n++;
		}
	}
	return n;
}

const buildParamsModel = {
	id: "claude-sonnet-4-6",
	baseUrl: "https://api.anthropic.com",
	api: "anthropic-messages",
	input: ["text", "image"],
	maxTokens: 64000,
} as unknown as Model<AnthropicApi>;

describe("buildParams — 4-breakpoint limit safety in OAuth + boundary scenario (#5027)", () => {
	test("OAuth + system prompt + last user: ≤2 breakpoints (no boundary, no tools)", () => {
		const ctx: Context = {
			messages: [userMsg("hello")],
			systemPrompt: "You are a helpful coding assistant.",
		} as Context;
		const params = buildParams(buildParamsModel, ctx, true) as any;
		assert.ok(countBreakpoints(params) <= 4, `expected ≤4 breakpoints, got ${countBreakpoints(params)}`);
		// One on user system block, one on last user msg.
		assert.equal(countBreakpoints(params), 2);
	});

	test("OAuth + system prompt + boundary + last user: ≤3 breakpoints (system de-duplicated)", () => {
		const ctx: Context = {
			messages: [
				userMsg("[COMPACTION SUMMARY]", { cacheBreakpoint: true }),
				userMsg("post-compaction turn"),
			],
			systemPrompt: "You are a helpful coding assistant.",
		} as Context;
		const params = buildParams(buildParamsModel, ctx, true) as any;
		const count = countBreakpoints(params);
		assert.ok(count <= 4, `must stay under Anthropic's 4-breakpoint limit, got ${count}`);
		// system(1, the user's prompt — Claude Code header skipped) + boundary(1) + last(1) = 3.
		assert.equal(count, 3);
	});

	test("OAuth + system prompt + tools + boundary + last user: exactly 4 breakpoints (ceiling)", () => {
		// Worst-case breakpoint budget:
		//   system(user prompt, 1) + last tool(1) + boundary(1) + last user(1) = 4.
		// The "You are Claude Code" header intentionally carries NO cache_control
		// when a user systemPrompt is present (#5027), which keeps us at 4 rather than 5.
		const tool: Tool = {
			name: "Read",
			description: "Read a file from disk.",
			parameters: {
				type: "object" as const,
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			} as any,
		};
		const ctx: Context = {
			messages: [
				userMsg("[COMPACTION SUMMARY]", { cacheBreakpoint: true }),
				userMsg("post-compaction turn"),
			],
			systemPrompt: "You are a helpful coding assistant.",
			tools: [tool],
		} as Context;
		const params = buildParams(buildParamsModel, ctx, true) as any;
		const count = countBreakpoints(params);
		assert.ok(count <= 4, `must stay under Anthropic's 4-breakpoint limit, got ${count}`);
		// system(1) + tool(1) + boundary(1) + last-user(1) = 4 exactly.
		assert.equal(count, 4);
	});

	test("OAuth header WITHOUT user systemPrompt still cache-marks the header", () => {
		// When there's no user systemPrompt, the Claude Code header IS the
		// last system block, so it correctly carries cache_control.
		const ctx: Context = { messages: [userMsg("hello")] } as Context;
		const params = buildParams(buildParamsModel, ctx, true) as any;
		assert.equal(countBreakpoints(params), 2, "header(1) + last user(1) = 2");
	});
});
