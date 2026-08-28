import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, ServerToolUse, ToolCall, WebSearchResult } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

function createCapturingAnthropicClient(response: Response, capture: { params?: unknown }): Anthropic {
	return {
		messages: {
			create: (params: unknown) => {
				capture.params = params;
				return {
					asResponse: async () => response,
				};
			},
		},
	} as unknown as Anthropic;
}

describe("Anthropic raw SSE parsing", () => {
	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		};

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("preserves native web search blocks from Anthropic streams", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Search the web.", timestamp: Date.now() }],
		};
		const webSearchContent = [
			{
				type: "web_search_result",
				title: "Example",
				url: "https://example.com",
				encrypted_content: "encrypted-result",
				page_age: null,
			},
		];
		const caller = { type: "direct" };
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "gsd" }, caller },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: webSearchContent, caller },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		const serverToolUse = result.content.find((block): block is ServerToolUse => block.type === "serverToolUse");
		const webSearchResult = result.content.find((block): block is WebSearchResult => block.type === "webSearchResult");
		expect(serverToolUse).toMatchObject({
			id: "srv_1",
			name: "web_search",
			input: { query: "gsd" },
			caller,
		});
		expect(webSearchResult).toMatchObject({
			toolUseId: "srv_1",
			content: webSearchContent,
			caller,
		});
	});

	it("accumulates native web search input JSON deltas", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Search the web.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"query":' },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '"gsd","max_uses":2}' },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		const serverToolUse = result.content.find((block): block is ServerToolUse => block.type === "serverToolUse");
		expect(serverToolUse).toMatchObject({
			id: "srv_1",
			name: "web_search",
			input: { query: "gsd", max_uses: 2 },
		});
		expect(serverToolUse).not.toHaveProperty("partialJson");
	});

	it("replays preserved native web search blocks in assistant history", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const caller = { type: "direct" };
		const webSearchContent = [
			{
				type: "web_search_result",
				title: "Example",
				url: "https://example.com",
				encrypted_content: "encrypted-result",
			},
		];
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Search the web.",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "thinking", thinking: "Need a current result.", thinkingSignature: "sig_1" },
						{ type: "serverToolUse", id: "srv_1", name: "web_search", input: { query: "gsd" }, caller },
						{ type: "webSearchResult", toolUseId: "srv_1", content: webSearchContent, caller },
						{ type: "text", text: "Found one result." },
					],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{
					role: "user",
					content: "Continue.",
					timestamp: Date.now(),
				},
			],
		};
		const capture: { params?: any } = {};
		const stream = streamAnthropic(model, context, {
			client: createCapturingAnthropicClient(createSseResponse(minimalAnthropicEvents), capture),
		});

		await stream.result();

		expect(capture.params.messages[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Need a current result.",
					signature: "sig_1",
				},
				{
					type: "server_tool_use",
					id: "srv_1",
					name: "web_search",
					input: { query: "gsd" },
					caller,
				},
				{
					type: "web_search_tool_result",
					tool_use_id: "srv_1",
					content: webSearchContent,
					caller,
				},
				{ type: "text", text: "Found one result." },
			],
		});
	});

	it("drops unpaired native web search blocks from assistant history", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const webSearchContent = [
			{
				type: "web_search_result",
				title: "Example",
				url: "https://example.com",
				encrypted_content: "encrypted-result",
			},
		];
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Search the web.",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "text", text: "Starting search." },
						{ type: "serverToolUse", id: "srv_orphan", name: "web_search", input: { query: "orphaned" } },
						{ type: "webSearchResult", toolUseId: "srv_stray", content: webSearchContent },
						{ type: "webSearchResult", toolUseId: "srv_out_of_order", content: webSearchContent },
						{ type: "serverToolUse", id: "srv_out_of_order", name: "web_search", input: { query: "late" } },
						{ type: "serverToolUse", id: "srv_paired", name: "web_search", input: { query: "gsd" } },
						{ type: "webSearchResult", toolUseId: "srv_paired", content: webSearchContent },
						{ type: "text", text: "Found one result." },
					],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{
					role: "user",
					content: "Continue.",
					timestamp: Date.now(),
				},
			],
		};
		const capture: { params?: any } = {};
		const stream = streamAnthropic(model, context, {
			client: createCapturingAnthropicClient(createSseResponse(minimalAnthropicEvents), capture),
		});

		await stream.result();

		expect(capture.params.messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Starting search." },
				{
					type: "server_tool_use",
					id: "srv_paired",
					name: "web_search",
					input: { query: "gsd" },
				},
				{
					type: "web_search_tool_result",
					tool_use_id: "srv_paired",
					content: webSearchContent,
				},
				{ type: "text", text: "Found one result." },
			],
		});
	});

	// A new/proxied stop reason used to throw mid-stream, aborting the turn and
	// dropping partial output. It must map to the error terminal instead.
	it.each(["some_new_stop_reason", "pause_turn"])("maps unknown stop reason %s to error with errorMessage instead of throwing", async (stopReason) => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [],
		};

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_stop",
						usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: stopReason },
					usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});

		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain(stopReason);
	});
});
