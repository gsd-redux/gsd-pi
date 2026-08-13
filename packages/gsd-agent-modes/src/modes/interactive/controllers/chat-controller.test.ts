import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";

import {
	findLatestPinnableText,
	handleAgentEvent,
	isProvisionalPreToolProse,
	isRedundantDiscussRestatement,
	priorAssistantTextFromSession,
	textInvitesUserReply,
} from "./chat-controller.js";
import { createStreamingRenderState } from "../streaming-render-state.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

function createStreamingHost(chatContainer: Container): any {
	return {
		isInitialized: true,
		streamingRenderState: createStreamingRenderState(),
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		getMarkdownThemeWithSettings() {
			return undefined;
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		formatWebSearchResult() {
			return "";
		},
		session: { messages: [], retryAttempt: 0 },
		chatContainer,
		pendingTools: new Map(),
		pendingMessagesContainer: { clear() {} },
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		hideThinkingBlock: true,
		toolOutputExpanded: false,
		loadingAnimation: undefined,
		pendingWorkingMessage: undefined,
		defaultWorkingMessage: "Working...",
		ui: {
			terminal: { rows: 60, columns: 100 },
			requestRender() {},
		},
	};
}

test("textInvitesUserReply: detects question handoff", () => {
	assert.equal(textInvitesUserReply("What do you want to build for M006?"), true);
	assert.equal(textInvitesUserReply("Let me write the context file now."), false);
});

test("isRedundantDiscussRestatement: drops second milestone ask sub-turn", () => {
	const prior = [
		"You have a neo-brutalist todo app with five milestones done.",
		"What do you want to build for M006?",
		"What's on your mind?",
	].join("\n");
	const next = [
		"I see M006 was created with a placeholder name.",
		"Before I can write the context file, what do you want M006 to be?",
	].join("\n");
	assert.equal(isRedundantDiscussRestatement(prior, next), true);
});

test("priorAssistantTextFromSession: skips tool results and newest assistant", () => {
	const prior = [
		"What do you want M006 to do?",
		"What's driving this?",
	].join("\n");
	const messages = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: [{ type: "text", text: prior }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "text", text: "What do you want M006 to be?" }] },
	];
	assert.equal(priorAssistantTextFromSession(messages, { skipLastAssistant: true }), prior);
});

test("isRedundantDiscussRestatement: keeps genuinely new follow-up questions", () => {
	const prior = "Should we add keyboard shortcuts or recurring tasks for M006?";
	const next = "Also, do you want this milestone to include a backend or stay local-only?";
	assert.equal(isRedundantDiscussRestatement(prior, next), false);
});

test("isRedundantDiscussRestatement: keeps short new follow-up questions", () => {
	const prior = "What do you want to build for M006?";
	const next = "I found 3 modules. Should I add docs?";
	assert.equal(isRedundantDiscussRestatement(prior, next), false);
});

test("isRedundantDiscussRestatement: drops holding-here wait ack after questions", () => {
	const prior = [
		"Oriented. Here's where things stand.",
		"1. Where should we take this?",
		"2. One focused capability, or a polish/utility pass?",
	].join("\n");
	const next =
		"I've asked my two questions above and I'm holding here for your answer - no need for anything else from me until you point M002 in a direction.";
	assert.equal(isRedundantDiscussRestatement(prior, next), true);
});

test("isRedundantDiscussRestatement: keeps wait ack that adds a new question", () => {
	const prior = "What do you want to build for M006?";
	const next = "I've asked about scope above. Should we also add offline support?";
	assert.equal(isRedundantDiscussRestatement(prior, next), false);
});

test("isRedundantDiscussRestatement: keeps holding ack that also asks a new question", () => {
	const prior = "What do you want to build for M006?";
	const next = "I'm holding here for your answer. Should we also add offline support?";
	assert.equal(isRedundantDiscussRestatement(prior, next), false);
});

test("isRedundantDiscussRestatement: keeps new question even when wait language is also present", () => {
	// ? + wait language together must NOT be suppressed.
	const prior = [
		"Oriented. Here's where things stand.",
		"1. Where should we take this?",
		"2. One focused capability, or a polish/utility pass?",
	].join("\n");
	const next = "I'm holding here. Should we also add offline support?";
	assert.equal(isRedundantDiscussRestatement(prior, next), false);
});

test("isRedundantDiscussRestatement: does not suppress long combined text with incidental wait language", () => {
	// Full extractAssistantText (questions + trailing wait-ack, >400 chars) must NOT be suppressed.
	const prior = "Let me know what you think.";
	const questions = [
		"Here is what I need to understand before proceeding:",
		"1. What is the primary goal of this milestone?",
		"2. Are there any hard deadlines we must hit?",
		"3. Which existing modules should this new work integrate with?",
		"4. Do you have a preference for the data storage approach?",
		"5. Should we prioritize mobile responsiveness or desktop-first for this phase?",
		"6. Are there any existing design patterns or component libraries we must follow?",
	].join("\n");
	const next = questions + "\n\nI'm holding here for your answers before I can move forward.";
	assert.ok(next.length > 400, "test fixture must exceed the guard threshold");
	assert.equal(isRedundantDiscussRestatement(prior, next), false);
});

test("handleAgentEvent: message_end keeps question segments when final payload mixes questions and wait ack", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const prior = [
		"Oriented. Here's where things stand.",
		"1. Where should we take this?",
		"2. One focused capability, or a polish/utility pass?",
	].join("\n");
	const waitAck =
		"I've asked my two questions above and I'm holding here for your answer - no need for anything else from me until you point M002 in a direction.";
	function makeMessage(content: any[]): any {
		return {
			id: "a-discuss",
			role: "assistant",
			provider: "claude-code",
			model: "claude-opus-4-8",
			timestamp: 1,
			stopReason: "stop",
			content,
		};
	}
	const host = createStreamingHost(chatContainer);
	host.session.messages = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: [{ type: "text", text: "What is your favorite color?" }] },
	];
	const first = makeMessage([{ type: "text", text: prior }]);

	await handleAgentEvent(host, { type: "message_start", message: makeMessage([]) } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: first,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: prior },
	} as any);

	const replaced = makeMessage([{ type: "text", text: waitAck }]);
	await handleAgentEvent(host, {
		type: "message_update",
		message: replaced,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: waitAck },
	} as any);

	const final = makeMessage([
		{ type: "text", text: prior },
		{ type: "text", text: waitAck },
	]);
	await handleAgentEvent(host, { type: "message_end", message: final } as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /Where should we take this/);
	assert.doesNotMatch(rendered, /holding here for your answer/);
});

test("handleAgentEvent: suppresses redundant holding-here sub-turn after discuss questions", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const prior = [
		"Oriented. Here's where things stand.",
		"1. Where should we take this?",
		"2. One focused capability, or a polish/utility pass?",
	].join("\n");
	const waitAck =
		"I've asked my two questions above and I'm holding here for your answer - no need for anything else from me until you point M002 in a direction.";
	function makeMessage(content: any[]): any {
		return {
			id: "a-discuss",
			role: "assistant",
			provider: "claude-code",
			model: "claude-opus-4-8",
			timestamp: 1,
			stopReason: "stop",
			content,
		};
	}
	const host = createStreamingHost(chatContainer);
	const first = makeMessage([{ type: "text", text: prior }]);

	await handleAgentEvent(host, { type: "message_start", message: makeMessage([]) } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: first,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: prior },
	} as any);

	// Claude Code can replace sub-turn text at the same content index.
	const replaced = makeMessage([{ type: "text", text: waitAck }]);
	await handleAgentEvent(host, {
		type: "message_update",
		message: replaced,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: waitAck },
	} as any);

	const final = makeMessage([
		{ type: "text", text: prior },
		{ type: "text", text: waitAck },
	]);
	await handleAgentEvent(host, { type: "message_end", message: final } as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /Where should we take this/);
	assert.doesNotMatch(rendered, /holding here for your answer/);
});

test("isProvisionalPreToolProse: only treats transient tool scaffolding as disposable", () => {
	assert.equal(isProvisionalPreToolProse("I'll inspect the current state and then patch it."), true);
	assert.equal(isProvisionalPreToolProse("Running the focused tests now."), true);
	assert.equal(
		isProvisionalPreToolProse(
			"I'm still waiting on your actual answer, and I want to be transparent about what I'm seeing.",
		),
		false,
	);
	assert.equal(isProvisionalPreToolProse("What do you want to build next?"), false);
});

test("findLatestPinnableText: empty content returns empty string", () => {
	assert.equal(findLatestPinnableText([]), "");
});

test("findLatestPinnableText: no tool calls returns empty string", () => {
	const blocks = [
		{ type: "text", text: "hello" },
		{ type: "text", text: "world" },
	];
	assert.equal(findLatestPinnableText(blocks), "");
});

test("findLatestPinnableText: returns text preceding a tool call", () => {
	const blocks = [
		{ type: "text", text: "doing the thing" },
		{ type: "toolCall", id: "1", name: "Read" },
	];
	assert.equal(findLatestPinnableText(blocks), "doing the thing");
});

test("findLatestPinnableText: ignores trailing streaming text after the last tool call (regression: pinned mirror duplicated chat-container tokens)", () => {
	const blocks = [
		{ type: "text", text: "first prose" },
		{ type: "toolCall", id: "1", name: "Read" },
		{ type: "text", text: "second prose still streaming" },
	];
	assert.equal(findLatestPinnableText(blocks), "first prose");
});

test("findLatestPinnableText: with multiple tools, picks text before the most recent tool call", () => {
	const blocks = [
		{ type: "text", text: "first" },
		{ type: "toolCall", id: "1", name: "Read" },
		{ type: "text", text: "second" },
		{ type: "toolCall", id: "2", name: "Grep" },
		{ type: "text", text: "third streaming" },
	];
	assert.equal(findLatestPinnableText(blocks), "second");
});

test("findLatestPinnableText: treats serverToolUse the same as toolCall", () => {
	const blocks = [
		{ type: "text", text: "before web search" },
		{ type: "serverToolUse", id: "ws1", name: "web_search" },
		{ type: "text", text: "answer streaming" },
	];
	assert.equal(findLatestPinnableText(blocks), "before web search");
});

test("findLatestPinnableText: skips empty/whitespace-only text blocks", () => {
	const blocks = [
		{ type: "text", text: "real prose" },
		{ type: "text", text: "   " },
		{ type: "text", text: "" },
		{ type: "toolCall", id: "1", name: "Read" },
	];
	assert.equal(findLatestPinnableText(blocks), "real prose");
});

test("findLatestPinnableText: thinking blocks are not pinnable", () => {
	const blocks = [
		{ type: "thinking", thinking: "internal" },
		{ type: "toolCall", id: "1", name: "Read" },
	];
	assert.equal(findLatestPinnableText(blocks), "");
});

test("handleAgentEvent: hidden thinking-only updates do not render transcript cards", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = createStreamingHost(chatContainer);
	const message = {
		id: "a-thinking",
		role: "assistant",
		provider: "claude-code",
		model: "claude-opus-4-8",
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "thinking", thinking: "I'm thinking through the next step." }],
	};

	await handleAgentEvent(host, { type: "message_start", message: { ...message, content: [] } } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "I'm thinking through the next step.",
			partial: message,
		},
	} as any);
	await handleAgentEvent(host, { type: "message_end", message } as any);

	assert.equal(stripAnsi(chatContainer.render(100).join("\n")).trim(), "");
});

test("handleAgentEvent: message_update does not rebuild unchanged earlier text-run segments", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = createStreamingHost(chatContainer);
	host.hideThinkingBlock = false;
	const updateCalls = new WeakMap<AssistantMessageComponent, number>();
	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	AssistantMessageComponent.prototype.updateContent = function (
		this: AssistantMessageComponent,
		...args: Parameters<AssistantMessageComponent["updateContent"]>
	): ReturnType<AssistantMessageComponent["updateContent"]> {
		updateCalls.set(this, (updateCalls.get(this) ?? 0) + 1);
		return originalUpdateContent.apply(this, args);
	};
	const makeMessage = (content: any[]): any => ({
		id: "a-stream",
		role: "assistant",
		provider: "claude-code",
		model: "claude-opus-4-8",
		timestamp: 1,
		stopReason: "stop",
		content,
	});
	const first = makeMessage([
		{ type: "thinking", thinking: "I am considering the answer." },
		{ type: "text", text: "First visible text." },
	]);
	const second = makeMessage([
		{ type: "thinking", thinking: "I am considering the answer." },
		{ type: "text", text: "First visible text. More streamed text." },
	]);

	try {
		await handleAgentEvent(host, { type: "message_start", message: makeMessage([]) } as any);
		await handleAgentEvent(host, {
			type: "message_update",
			message: first,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "First visible text.",
				partial: first,
			},
		} as any);

		const [thinkingSegment, textSegment] = chatContainer.children as AssistantMessageComponent[];
		assert.equal(updateCalls.get(thinkingSegment), 1);
		assert.equal(updateCalls.get(textSegment), 1);

		await handleAgentEvent(host, {
			type: "message_update",
			message: second,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: " More streamed text.",
				partial: second,
			},
		} as any);

		assert.equal(
			updateCalls.get(thinkingSegment),
			1,
			"unchanged earlier text-run segment must not rebuild on later deltas",
		);
		assert.equal(updateCalls.get(textSegment), 2);
	} finally {
		AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
		await handleAgentEvent(host, { type: "message_end", message: second } as any);
	}
});

test("handleAgentEvent: agent_start clears stale adaptive blocking error", async () => {
	initTheme("dark", false);
	let cleared = false;
	let requestedRender = false;
	const host = {
		isInitialized: true,
		clearBlockingError: () => {
			cleared = true;
		},
		retryEscapeHandler: undefined,
		retryLoader: undefined,
		loadingAnimation: undefined,
		statusContainer: {
			clear() {},
			addChild() {},
		},
		ui: {
			requestRender() {
				requestedRender = true;
			},
		},
		defaultEditor: {},
		footer: {
			invalidate() {},
		},
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
		},
		defaultWorkingMessage: "Working...",
		pendingWorkingMessage: undefined,
	} as any;

	await handleAgentEvent(host, { type: "agent_start" } as any);
	host.loadingAnimation?.stop();

	assert.equal(cleared, true);
	assert.equal(requestedRender, true);
});

test("handleAgentEvent: agent_start suppresses loader when extension requested no working message", async () => {
	initTheme("dark", false);
	let addChildCalled = false;
	let requestedRender = false;
	const host = {
		isInitialized: true,
		streamingRenderState: createStreamingRenderState(),
		clearBlockingError() {},
		retryEscapeHandler: undefined,
		retryLoader: undefined,
		loadingAnimation: undefined,
		statusContainer: {
			clear() {},
			addChild() {
				addChildCalled = true;
			},
		},
		ui: {
			requestRender() {
				requestedRender = true;
			},
		},
		defaultEditor: {},
		footer: {
			invalidate() {},
		},
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
		},
		defaultWorkingMessage: "Working...",
		pendingWorkingMessage: null,
	} as any;

	await handleAgentEvent(host, { type: "agent_start" } as any);

	assert.equal(host.loadingAnimation, undefined);
	assert.equal(host.pendingWorkingMessage, null);
	assert.equal(typeof host.activityLoader, "object");
	assert.equal(addChildCalled, true);
	assert.equal(requestedRender, true);
});

test("setWorkingMessage null starts activity indicator while streaming", async () => {
	initTheme("dark", false);
	let addChildCount = 0;
	const host = {
		pendingWorkingMessage: undefined,
		loadingAnimation: undefined,
		activityLoader: undefined,
		statusContainer: {
			clear() {},
			addChild() {
				addChildCount++;
			},
		},
		defaultWorkingMessage: "Working...",
		gsdProgressState: { phase: "Executing slice S01" },
		session: { isStreaming: true },
		ui: { requestRender() {} },
	} as any;

	const { createExtensionUIContext } = await import("./extension-ui-controller.js");
	const { stopActivityIndicator } = await import("./chat-controller.js");
	createExtensionUIContext(host).setWorkingMessage(null);

	assert.equal(typeof host.activityLoader, "object");
	assert.equal(addChildCount, 1);
	stopActivityIndicator(host);
});

test("handleAgentEvent: standalone completed tool events roll up incrementally", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	let renderCount = 0;
	const host = {
		isInitialized: true,
		streamingRenderState: createStreamingRenderState(),
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		chatContainer,
		pendingTools: new Map(),
		ui: {
			requestRender() {
				renderCount++;
			},
		},
	} as any;

	for (const [toolCallId, toolName] of [
		["read-1", "read"],
		["read-2", "read"],
		["edit-1", "edit"],
	] as const) {
		const target =
			toolName === "edit"
				? {
						kind: "file",
						action: "edit",
						inputPath: `src/${toolCallId}.txt`,
						resolvedPath: `/tmp/project/src/${toolCallId}.txt`,
						line: 10,
					}
				: {
						kind: "file",
						action: "read",
						inputPath: `src/${toolCallId}.txt`,
						resolvedPath: `/tmp/project/src/${toolCallId}.txt`,
					};
		await handleAgentEvent(host, {
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args: { path: `src/${toolCallId}.txt` },
		} as any);
		await handleAgentEvent(host, {
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content: [], details: { target }, isError: false },
			isError: false,
		} as any);
	}

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /Context reads · 2 files\s+success · \d+(ms|s)/);
	assert.match(rendered, /src\/read-1\.txt/);
	assert.match(rendered, /src\/read-2\.txt/);
	assert.match(rendered, /File changes · 1 file, 1 edit\s+success · \d+(ms|s)/);
	assert.match(rendered, /src\/edit-1\.txt:10/);
	assert.doesNotMatch(rendered, /^\s*│?\s*read\s+success ·/m);
	assert.doesNotMatch(rendered, /^\s*│?\s*edit\s+success ·/m);
	assert.ok(renderCount > 0);
});

test("handleAgentEvent: assistant error finalization does not fail completed tool calls", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = createStreamingHost(chatContainer);
	const toolCall = {
		type: "toolCall",
		id: "exec-1",
		name: "gsd_exec",
		arguments: { cmd: "true" },
	};
	const runningMessage = {
		id: "a-tool",
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.4",
		timestamp: 1,
		stopReason: "stop",
		content: [toolCall],
	};
	const erroredMessage = {
		...runningMessage,
		stopReason: "error",
		errorMessage: "Model hit a transient error",
	};

	await handleAgentEvent(host, {
		type: "message_start",
		message: { ...runningMessage, content: [] },
	} as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: runningMessage,
		assistantMessageEvent: { type: "toolcall_end", toolCall },
	} as any);
	await handleAgentEvent(host, {
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result: { content: [{ type: "text", text: "ok" }], isError: false },
		isError: false,
	} as any);

	await handleAgentEvent(host, {
		type: "message_end",
		message: erroredMessage,
	} as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /success · \d+(ms|s)/);
	assert.doesNotMatch(rendered, /failed · \d+(ms|s)/);
	assert.doesNotMatch(rendered, /Model hit a transient error/);
});

test("handleAgentEvent: message_end reattaches orphaned tool components only once", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = createStreamingHost(chatContainer);
	const toolA = { type: "serverToolUse", id: "mcp-a", name: "mcp__gsd__ls", input: { path: ".gsd" } };
	const toolB = { type: "serverToolUse", id: "mcp-b", name: "mcp__gsd__read", input: { path: "PLAN.md" } };
	function makeMessage(content: any[]): any {
		return {
			id: "a-mcp-tools",
			role: "assistant",
			provider: "claude-code",
			model: "claude-opus-4-8",
			timestamp: 1,
			stopReason: "stop",
			content,
		};
	}
	const countChild = (component: unknown) =>
		chatContainer.children.filter((child) => child === component).length;

	await handleAgentEvent(host, { type: "message_start", message: makeMessage([]) } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeMessage([toolA]),
		assistantMessageEvent: { type: "server_tool_use", contentIndex: 0, partial: makeMessage([toolA]) },
	} as any);

	const toolAComponent = host.pendingTools.get(toolA.id);
	assert.ok(toolAComponent);
	assert.equal(countChild(toolAComponent), 1);

	await handleAgentEvent(host, {
		type: "message_update",
		message: makeMessage([]),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: makeMessage([]) },
	} as any);
	assert.equal(host.streamingRenderState.renderedSegments.length, 0);
	assert.equal(countChild(toolAComponent), 1);

	await handleAgentEvent(host, {
		type: "message_update",
		message: makeMessage([toolB]),
		assistantMessageEvent: { type: "server_tool_use", contentIndex: 0, partial: makeMessage([toolB]) },
	} as any);

	const toolBComponent = host.pendingTools.get(toolB.id);
	assert.ok(toolBComponent);
	assert.equal(countChild(toolBComponent), 1);

	await handleAgentEvent(host, {
		type: "message_end",
		message: makeMessage([toolA, toolB]),
	} as any);

	assert.equal(countChild(toolAComponent), 1);
	assert.equal(countChild(toolBComponent), 1);
});

test("handleAgentEvent: Claude Code MCP post-tool text does not erase user-facing pre-tool prose", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const preToolText =
		"I'm still waiting on your actual answer, and I want to be transparent about what I'm seeing.";
	const postToolText = "I'll stay parked here until the missing project description arrives.";
	function makeMessage(content: any[]): any {
		return {
			id: "a-mcp",
			role: "assistant",
			provider: "claude-code",
			model: "claude-opus-4-8",
			timestamp: 1,
			stopReason: "stop",
			content,
		};
	}
	const host = createStreamingHost(chatContainer);
	const toolBlock = { type: "serverToolUse", id: "mcp-1", name: "mcp__gsd__status", input: {} };
	const first = makeMessage([{ type: "text", text: preToolText }, toolBlock]);

	await handleAgentEvent(host, { type: "message_start", message: makeMessage([]) } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: first,
		assistantMessageEvent: { type: "server_tool_use", contentIndex: 1 },
	} as any);

	assert.match(stripAnsi(chatContainer.render(100).join("\n")), /still waiting on your actual answer/);

	const final = makeMessage([{ type: "text", text: preToolText }, toolBlock, { type: "text", text: postToolText }]);
	await handleAgentEvent(host, {
		type: "message_update",
		message: final,
		assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: postToolText, partial: final },
	} as any);
	await handleAgentEvent(host, { type: "message_end", message: final } as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /still waiting on your actual answer/);
	assert.match(rendered, /stay parked here/);
});

test("handleAgentEvent: message_end keeps the current handoff reply visible", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const text = "What do you want to build next?";
	const message = {
		id: "a-question",
		role: "assistant",
		provider: "claude-code",
		model: "claude-opus-4-8",
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "text", text }],
	};
	const host = createStreamingHost(chatContainer);

	await handleAgentEvent(host, { type: "message_start", message: { ...message, content: [] } } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
	} as any);

	assert.match(stripAnsi(chatContainer.render(100).join("\n")), /What do you want to build next/);

	await handleAgentEvent(host, { type: "message_end", message } as any);

	assert.match(stripAnsi(chatContainer.render(100).join("\n")), /What do you want to build next/);
});

test("handleAgentEvent: message_end does not force-render viewport when pinned zone was never shown", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	let forceRenderCalled = false;
	const host = createStreamingHost(chatContainer);
	host.ui.requestRender = (force?: boolean) => {
		if (force) forceRenderCalled = true;
	};

	const message = {
		id: "a-simple",
		role: "assistant",
		provider: "claude-code",
		model: "claude-opus-4-8",
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "text", text: "Here is my response." }],
	};

	await handleAgentEvent(host, { type: "message_start", message: { ...message, content: [] } } as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Here is my response.", partial: message },
	} as any);
	await handleAgentEvent(host, { type: "message_end", message } as any);

	assert.equal(
		forceRenderCalled,
		false,
		"viewport must not be force-realigned at message_end when no pinned zone was shown this turn",
	);
});

test("handleAgentEvent: agent_end does not force-render viewport when pinned zone was never shown", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	let forceRenderCalled = false;
	const host = {
		isInitialized: true,
		streamingRenderState: createStreamingRenderState(),
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		chatContainer,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusContainer: { clear() {} },
		streamingComponent: undefined,
		streamingMessage: undefined,
		pinnedMessageContainer: { clear() {} },
		checkShutdownRequested: async () => {},
		ui: {
			requestRender(force?: boolean) {
				if (force) forceRenderCalled = true;
			},
		},
	} as any;

	await handleAgentEvent(host, {
		type: "agent_end",
		messages: [],
		willRetry: false,
	} as any);

	assert.equal(
		forceRenderCalled,
		false,
		"viewport must not be force-realigned at agent_end when no pinned zone was shown this turn",
	);
});

test("handleAgentEvent: agent_end finalizes orphaned pending tool cards", async () => {
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = {
		isInitialized: true,
		streamingRenderState: createStreamingRenderState(),
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		chatContainer,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusContainer: { clear() {} },
		streamingComponent: undefined,
		streamingMessage: undefined,
		pinnedMessageContainer: { clear() {} },
		checkShutdownRequested: async () => {},
		ui: {
			requestRender() {},
		},
	} as any;

	await handleAgentEvent(host, {
		type: "tool_execution_start",
		toolCallId: "capture-1",
		toolName: "capture_thought",
		args: { thought: "write the milestone roadmap" },
	} as any);

	assert.match(
		stripAnsi(chatContainer.render(100).join("\n")),
		/running/,
		"precondition: orphaned tool card starts in running state",
	);

	await handleAgentEvent(host, {
		type: "agent_end",
		messages: [],
		willRetry: false,
	} as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.doesNotMatch(rendered, /running/, "agent_end must not leave stale running tool cards");
	assert.match(rendered, /success/, "orphaned tool card should settle as no-result success");
});

test("handleAgentEvent: aborting a turn does NOT flip an already-completed tool to error (ESC regression)", async () => {
	// Repro: a background-bash tool finishes successfully, then the user presses
	// ESC during a later await. The turn ends with stopReason "aborted". The
	// already-finished tool must stay a success — only genuinely-pending tools
	// should be marked interrupted.
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = createStreamingHost(chatContainer);

	const message = {
		id: "turn-1",
		role: "assistant",
		provider: "claude-code",
		model: "claude-opus-4-8",
		timestamp: 1,
		stopReason: "aborted",
		content: [{ type: "toolCall", id: "bg-1", name: "async_bash", arguments: { command: "echo hi" } }],
	};

	await handleAgentEvent(host, {
		type: "tool_execution_start",
		toolCallId: "bg-1",
		toolName: "async_bash",
		args: { command: "echo hi" },
	} as any);
	await handleAgentEvent(host, {
		type: "tool_execution_end",
		toolCallId: "bg-1",
		toolName: "async_bash",
		result: { content: [{ type: "text", text: "Background job started: bg-1" }], isError: false },
		isError: false,
	} as any);

	// Precondition: the completed tool rendered as success before the abort.
	assert.match(
		stripAnsi(chatContainer.render(100).join("\n")),
		/success/,
		"precondition: completed tool should render success before abort",
	);

	await handleAgentEvent(host, { type: "message_end", message } as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /success/, "completed tool must stay green after the turn is aborted");
	assert.doesNotMatch(
		rendered,
		/Operation aborted/,
		"a completed tool must not be labelled aborted just because the turn was",
	);
});

test("handleAgentEvent: aborting a turn DOES mark a still-pending tool as interrupted", async () => {
	// Counterpart to the regression above: a tool that never produced a result
	// must still be marked interrupted when the turn aborts.
	initTheme("dark", false);
	const chatContainer = new Container();
	const host = createStreamingHost(chatContainer);

	const message = {
		id: "turn-2",
		role: "assistant",
		provider: "claude-code",
		model: "claude-opus-4-8",
		timestamp: 1,
		stopReason: "aborted",
		content: [{ type: "toolCall", id: "await-1", name: "await_job", arguments: {} }],
	};

	await handleAgentEvent(host, {
		type: "tool_execution_start",
		toolCallId: "await-1",
		toolName: "await_job",
		args: {},
	} as any);
	// No tool_execution_end — the tool is still pending when the abort lands.

	await handleAgentEvent(host, { type: "message_end", message } as any);

	const rendered = stripAnsi(chatContainer.render(100).join("\n"));
	assert.match(rendered, /Operation aborted/, "a genuinely-pending tool must be marked interrupted on abort");
});
