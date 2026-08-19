import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@gsd/pi-ai";
import { agentLoop } from "./agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((message) =>
		message.role === "user" || message.role === "assistant" || message.role === "toolResult"
	) as Message[];
}

test("agent loop accumulates streamed content and emits fresh message objects", async () => {
	const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
	const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
	const toolCall = { type: "toolCall" as const, id: "tool-1", name: "echo", arguments: { value: "hello" } };
	const providerPartial = createAssistantMessage([]);
	const streamFn = () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: providerPartial });
		});
		setImmediate(() => {
			stream.push({ type: "thinking_start", contentIndex: 0 });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "think" });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "ing" });
			stream.push({ type: "thinking_end", contentIndex: 0, content: "thinking" });
			stream.push({ type: "text_start", contentIndex: 1 });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "hel" });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "lo" });
			stream.push({ type: "text_end", contentIndex: 1, content: "hello" });
			providerPartial.content[2] = { ...toolCall, arguments: {} };
			stream.push({ type: "toolcall_start", contentIndex: 2 });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: '{"value":' });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: '"hello"}' });
			stream.push({ type: "toolcall_end", contentIndex: 2, toolCall });
			stream.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([
					{ type: "thinking", thinking: "thinking" },
					{ type: "text", text: "hello" },
					toolCall,
				]),
			});
		});
		return stream;
	};

	const updateMessages: AssistantMessage[] = [];
	const contentSnapshots: AssistantMessage["content"][] = [];
	const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, streamFn);
	for await (const event of stream) {
		if (event.type === "message_update" && event.message.role === "assistant") {
			updateMessages.push(event.message);
			contentSnapshots.push(structuredClone(event.message.content));
		}
	}

	assert.deepEqual(contentSnapshots[2], [{ type: "thinking", thinking: "thinking" }]);
	assert.deepEqual(contentSnapshots[6], [
		{ type: "thinking", thinking: "thinking" },
		{ type: "text", text: "hello" },
	]);
	assert.deepEqual(contentSnapshots[8]?.[2], { ...toolCall, arguments: {} });
	const streamedToolCall = contentSnapshots[10]?.[2];
	assert.equal(streamedToolCall?.type, "toolCall");
	if (streamedToolCall?.type === "toolCall") {
		assert.deepEqual(streamedToolCall.arguments, { value: "hello" });
	}
	assert.deepEqual(contentSnapshots[11]?.[2], toolCall);
	assert.equal(new Set(updateMessages).size, updateMessages.length);
});
