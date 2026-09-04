import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const CONTINUATION_TEXT = "Your previous response was cut off at the output limit. Continue exactly where you left off.";

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

function createUsage(output = 0) {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(id = "mock", provider = "openai"): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	usage: AssistantMessage["usage"] = createUsage(),
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createEchoTool(executed: string[], terminate = false): AgentTool<any, { value: string }> {
	const toolSchema = Type.Object({ value: Type.String() });
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: `echoed: ${params.value}` }],
				details: { value: params.value },
				terminate,
			};
		},
	};
}

describe("agent loop stopReason=length (max_tokens truncation)", () => {
	it("injects a continuation message and completes the truncated turn", async () => {
		const executed: string[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		let replacedContext = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: ({ context: currentContext }) => {
				if (replacedContext) return undefined;
				replacedContext = true;
				return {
					context: {
						...currentContext,
						messages: currentContext.messages.filter((message) => message.role !== "user"),
					},
				};
			},
		};

		let callIndex = 0;
		const contextsSeen: AgentMessage[][] = [];
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// Truncated turn: tool call issued, narration cut mid-sentence.
					stream.push({
						type: "done",
						reason: "length",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } },
								{ type: "text", text: "Both aud" },
							],
							"length",
							createUsage(24),
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "both audits finished" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run both audits")], context, config, undefined, (_model, ctx) => {
			contextsSeen.push([...ctx.messages]);
			return streamFn();
		});

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Second stream call happened (continuation re-streamed).
		expect(callIndex).toBe(2);

		// Tool call from the truncated turn still executed.
		expect(executed).toEqual(["hello"]);

		// The continuation user message was injected into the context the second
		// stream call reads, after the truncated assistant message and its tool result.
		const secondCallContext = contextsSeen[1];
		const continuationIndex = secondCallContext.findIndex(
			(m) => m.role === "user" && JSON.stringify(m.content).includes(CONTINUATION_TEXT),
		);
		expect(continuationIndex).toBeGreaterThan(-1);
		const truncatedIndex = secondCallContext.findIndex(
			(m) => m.role === "assistant" && m.stopReason === "length",
		);
		const toolResultIndex = secondCallContext.findIndex((m) => m.role === "toolResult");
		expect(truncatedIndex).toBeGreaterThan(-1);
		expect(toolResultIndex).toBeGreaterThan(truncatedIndex);
		expect(continuationIndex).toBeGreaterThan(toolResultIndex);

		// Continuation message was emitted to consumers.
		expect(continuations(events)).toHaveLength(1);
		const truncatedTurnEndIndex = events.findIndex(
			(event) => event.type === "turn_end" && event.message.role === "assistant" && event.message.stopReason === "length",
		);
		const continuationStartIndex = events.findIndex(
			(event) =>
				event.type === "message_start" &&
				event.message.role === "user" &&
				JSON.stringify(event.message.content).includes(CONTINUATION_TEXT),
		);
		expect(truncatedTurnEndIndex).toBeGreaterThan(-1);
		expect(continuationStartIndex).toBeGreaterThan(truncatedTurnEndIndex);

		// The run ended with the model's clean completion, not the truncation.
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		expect(lastAssistant?.stopReason).toBe("stop");
		expect(lastAssistant?.content).toEqual([{ type: "text", text: "both audits finished" }]);
	});

	it("halts with a terminal error after the continuation cap is exhausted", async () => {
		const executed: string[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				// Provider always truncates: the loop must not spin forever.
				const content: AssistantMessage["content"] =
					streamCallCount === 4
						? [{ type: "toolCall", id: "tool-at-cap", name: "echo", arguments: { value: "at-cap" } }]
						: [{ type: "text", text: "partial narrati" }];
				stream.push({
					type: "done",
					reason: "length",
					message: createAssistantMessage(content, "length", createUsage(12)),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("narrate forever")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Initial call + one per injected continuation, then halt.
		expect(streamCallCount).toBe(4);

		// Exactly three continuation messages were injected.
		expect(continuations(events)).toHaveLength(3);
		expect(executed).toEqual(["at-cap"]);
		expect(messages.slice(-3).map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant"]);

		// The loop surfaced a terminal error instead of ending cleanly.
		const lastMessage = messages[messages.length - 1];
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toContain("Provider stop_reason: length");
		expect(lastMessage.errorMessage).toContain("continuation cap (3) exhausted");
		expect(lastMessage.errorMessage).toContain("continuing was halted");

		// The stream ended with agent_end (clean drain, no hang).
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("surfaces a terminal error when the stop hook halts an injected continuation", async () => {
		const sourceModel = createModel("source-model", "source-provider");
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: sourceModel,
			convertToLlm: identityConverter,
			prepareNextTurn: () => ({ model: createModel("next-model", "next-provider") }),
			shouldStopAfterTurn: () => true,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "length",
					message: {
						...createAssistantMessage([{ type: "text", text: "partial" }], "length", createUsage(5)),
						model: sourceModel.id,
						provider: sourceModel.provider,
					},
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const lastMessage = messages[messages.length - 1];
		expect(streamCallCount).toBe(1);
		expect(continuations(events)).toHaveLength(1);
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toContain("stop hook halted the continuation");
		expect(lastMessage.api).toBe(sourceModel.api);
		expect(lastMessage.provider).toBe(sourceModel.provider);
		expect(lastMessage.model).toBe(sourceModel.id);
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("honors tool termination after a length-truncated tool-call turn", async () => {
		const executed: string[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed, true)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "length",
					message: createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"length",
						createUsage(5),
					),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const lastMessage = messages[messages.length - 1];
		expect(streamCallCount).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(continuations(events)).toHaveLength(0);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toContain("tool termination requested");
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("lets the schema breaker stop repeated truncated validation failures", async () => {
		const executed: string[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "length",
					message: createAssistantMessage(
						[{ type: "toolCall", id: `invalid-${streamCallCount}`, name: "echo", arguments: {} }],
						"length",
						createUsage(5),
					),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const lastMessage = messages[messages.length - 1];
		expect(streamCallCount).toBe(3);
		expect(executed).toHaveLength(0);
		expect(continuations(events)).toHaveLength(2);
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toContain("Schema overload");
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("does not continue a length stop carrying an errorMessage (provider failure, not truncation)", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = {
					...createAssistantMessage([{ type: "text", text: "partial" }], "length", createUsage(5)),
					errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
				};
				stream.push({ type: "done", reason: "length", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// No continuation injected: the provider flagged a failure, not a truncation.
		expect(streamCallCount).toBe(1);
		expect(continuations(events)).toHaveLength(0);

		// Surfaced as a terminal error carrying the provider's message.
		const lastMessage = messages[messages.length - 1];
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toContain("prompt is too long");
		expect(lastMessage.errorMessage).toContain("continuing was halted");
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("does not continue a zero-output length stop (silent context overflow)", async () => {
		// pi-ai classifies length + output=0 as context overflow (isContextOverflow
		// case 3): the provider truncated the INPUT, leaving no room to generate.
		// Continuing would grow the context further, so halt with a terminal error.
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "" }], "length", createUsage(0));
				stream.push({ type: "done", reason: "length", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		expect(streamCallCount).toBe(1);
		expect(continuations(events)).toHaveLength(0);

		const lastMessage = messages[messages.length - 1];
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toContain("no output was generated");
		expect(lastMessage.errorMessage).toContain("continuing was halted");
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("does not inject a continuation when the turn stops normally", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let streamCallCount = 0;
		const streamFn = () => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hello")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		expect(streamCallCount).toBe(1);
		expect(continuations(events)).toHaveLength(0);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});
});

function continuations(events: AgentEvent[]) {
	return events.filter(
		(event): event is Extract<AgentEvent, { type: "message_start" }> =>
			event.type === "message_start" &&
			event.message.role === "user" &&
			JSON.stringify(event.message.content).includes(CONTINUATION_TEXT),
	);
}
