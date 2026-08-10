// Project/App: gsd-pi
// File Purpose: Assistant handoff / redundant prose filtering for interactive chat.
import type { DesiredSegment, RenderedSegment } from "../streaming-render-state.js";

const PROVISIONAL_PRE_TOOL_ACTIONS =
	"check|inspect|look(?:\\s+into)?|read|open|search|grep|scan|run|verify|test|trace|review|investigate|reproduce|use|gather|find|pull|query|take a look|update|patch|edit|change|modify|write|create|add|remove|apply";
const FIRST_PERSON_PROVISIONAL_PRE_TOOL_RE = new RegExp(
	`^(?:i(?:'ll| will)|i(?:'m| am) going to|let me|i need to)\\s+(?:${PROVISIONAL_PRE_TOOL_ACTIONS})\\b`,
	"i",
);
const GERUND_PROVISIONAL_PRE_TOOL_RE =
	/^(?:checking|inspecting|reading|searching|running|verifying|testing|tracing|reviewing|investigating|scanning|updating|patching|editing|writing|creating|applying)\b/i;

export function getVisibleTextLikeBlockType(block: any, hideThinkingBlock = false): "text" | "thinking" | undefined {
	if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) return "text";
	if (hideThinkingBlock) return undefined;
	if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) return "thinking";
	return undefined;
}

/** True when assistant prose is handing off to the user (question or explicit invite). */
export function textInvitesUserReply(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (/\?(?:\s|$)/m.test(trimmed)) return true;
	return /\b(?:what do you want|what's on your mind|let me know|tell me what|help me understand)\b/i.test(trimmed);
}

const DISCUSS_RESTATE_RE =
	/\b(?:what do you want|what should we|before i can write|context file|placeholder name|need to understand what|what(?:'s| is) (?:on your mind|the next)|help me understand what you want)\b/i;

/** Second sub-turn that only says it is waiting after questions were already asked. */
const HANDOFF_WAIT_RESTATE_RE =
	/\b(?:holding\s+(?:here|for)|waiting\s+(?:here|for)|no\s+need\s+for\s+anything\s+else|until\s+you\s+(?:point|tell|let\s+me\s+know|answer|reply)|i(?:'ve| have)\s+asked)\b/i;

function isWaitOnlyQuestionFragment(fragment: string): boolean {
	return /^(?:i(?:'ve| have)\s+asked\b|(?:i'?m|i am)\s+(?:holding|waiting)\b|no\s+need\s+for\s+anything\s+else\b)/i.test(fragment)
		&& !/\b(?:should|do you|would you|can we|could we|what|which|how|where|when|who|also|add|include)\b/i.test(fragment);
}

/** True when text adds a question beyond wait/hold boilerplate. */
function containsNewSubstantiveQuestion(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "?") continue;
		const previousBreak = Math.max(
			text.lastIndexOf("\n", i),
			text.lastIndexOf(".", i),
			text.lastIndexOf("!", i),
			text.lastIndexOf("?", i - 1),
			-1,
		);
		const fragment = text.slice(previousBreak + 1, i + 1).trim();
		if (fragment.length < 8) continue;
		if (isWaitOnlyQuestionFragment(fragment)) continue;
		return true;
	}
	return false;
}

function isHandoffWaitRestatement(next: string): boolean {
	if (!HANDOFF_WAIT_RESTATE_RE.test(next)) return false;
	// Keep follow-ups that add a real question even when they also say holding/waiting.
	if (containsNewSubstantiveQuestion(next)) return false;
	// Only classify as a pure wait ack when the text is short; long text likely
	// contains substantive content alongside incidental wait language.
	if (next.length > 400) return false;
	return true;
}

/**
 * Claude Code can emit a second text sub-turn that restates the same milestone
 * discuss ask. Drop it when the prior sub-turn already invited a user reply.
 */
export function isRedundantDiscussRestatement(priorText: string, newText: string): boolean {
	const prior = priorText.trim();
	const next = newText.trim();
	if (!prior || !next) return false;
	if (!textInvitesUserReply(prior)) return false;
	const isDiscussRestate = DISCUSS_RESTATE_RE.test(next);
	const isWaitRestate = isHandoffWaitRestatement(next);
	if (!isDiscussRestate && !isWaitRestate) return false;
	// Wait acks are gated on length and no-? inside isHandoffWaitRestatement.
	if (isWaitRestate) return true;
	if (next.length > prior.length * 1.1) return false;
	return next.length <= prior.length || next.length < 900;
}

export function isSubTurnTextReplacement(
	blocks: Array<any>,
	rendered: RenderedSegment[],
): number | null {
	for (const seg of rendered) {
		if (seg.kind !== "text-run") continue;
		const oldText = (seg.cachedText ?? "").trim();
		if (!oldText) continue;
		const newText = getTextFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType).trim();
		if (!newText || newText === oldText) continue;
		// Streaming growth extends prior text; a new sub-turn replaces it wholesale.
		if (!newText.startsWith(oldText) && !oldText.startsWith(newText)) return seg.startIndex;
	}
	return null;
}

export function getTextFromContentBlocks(
	blocks: Array<any>,
	startIndex: number,
	endIndex: number,
	contentType: "text" | "thinking" = "text",
): string {
	const parts: string[] = [];
	for (let i = startIndex; i <= endIndex && i < blocks.length; i++) {
		const block = blocks[i];
		if (contentType === "text" && block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			parts.push(block.text.trim());
		} else if (
			contentType === "thinking"
			&& block?.type === "thinking"
			&& typeof block.thinking === "string"
			&& block.thinking.trim()
		) {
			parts.push(block.thinking.trim());
		}
	}
	return parts.join("\n\n");
}

/**
 * Calculate the total character length of text in content blocks WITHOUT
 * creating a new string. Used as a fast O(1) cache check before calling
 * getTextFromContentBlocks which allocates a new string each time.
 *
 * Returns the length of the string that getTextFromContentBlocks would
 * produce (including "\n\n" separators between parts).
 */
export function getTextLengthFromContentBlocks(
	blocks: Array<any>,
	startIndex: number,
	endIndex: number,
	contentType: "text" | "thinking" = "text",
): number {
	let totalLength = 0;
	let partCount = 0;
	for (let i = startIndex; i <= endIndex && i < blocks.length; i++) {
		const block = blocks[i];
		if (contentType === "text" && block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			totalLength += block.text.trim().length;
			partCount++;
		} else if (
			contentType === "thinking"
			&& block?.type === "thinking"
			&& typeof block.thinking === "string"
			&& block.thinking.trim()
		) {
			totalLength += block.thinking.trim().length;
			partCount++;
		}
	}
	// Add "\n\n" separators between parts
	return totalLength + (partCount > 1 ? (partCount - 1) * 2 : 0);
}

export function filterRedundantDiscussTextRuns(
	desired: DesiredSegment[],
	blocks: Array<any>,
): DesiredSegment[] {
	const textRuns = desired.filter(
		(seg): seg is Extract<DesiredSegment, { kind: "text-run" }> =>
			seg.kind === "text-run" && seg.contentType === "text",
	);
	if (textRuns.length < 2) return desired;

	const skipStarts = new Set<number>();
	let lastKeptText: string | undefined;
	for (const seg of textRuns) {
		const text = getTextFromContentBlocks(blocks, seg.startIndex, seg.endIndex);
		if (lastKeptText && isRedundantDiscussRestatement(lastKeptText, text)) {
			skipStarts.add(seg.startIndex);
		} else {
			lastKeptText = text;
		}
	}

	return desired.filter(
		(seg) => !(seg.kind === "text-run" && seg.contentType === "text" && skipStarts.has(seg.startIndex)),
	);
}

function extractAssistantText(msg: { content?: unknown }): string {
	if (!msg) return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if ((block as { type?: string }).type === "text" && typeof (block as { text?: string }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

function latestPriorUserFacingText(
	orphaned: RenderedSegment[],
	rendered: RenderedSegment[],
): string | undefined {
	const runs = [...orphaned, ...rendered].filter(
		(seg): seg is Extract<RenderedSegment, { kind: "text-run" }> =>
			seg.kind === "text-run" && seg.contentType === "text",
	);
	return runs.at(-1)?.cachedText;
}

/**
 * Walk session history backward for the previous assistant prose block, skipping
 * toolResult rows. Used when Claude Code emits a second assistant message
 * (new timestamp) after tools in the same prompt.
 */
export function priorAssistantTextFromSession(
	messages: Array<{ role?: string; content?: unknown }>,
	opts?: { skipLastAssistant?: boolean },
): string | undefined {
	let assistantFromEnd = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "user") return undefined;
		if (message.role === "toolResult") continue;
		if (message.role === "assistant") {
			const text = extractAssistantText(message).trim();
			if (!text) continue;
			if (opts?.skipLastAssistant) {
				assistantFromEnd += 1;
				if (assistantFromEnd === 1) continue;
			}
			return text;
		}
	}
	return undefined;
}

export function shouldSuppressEntireAssistantMessage(
	message: { content?: Array<any> },
	sessionMessages: Array<{ role?: string; content?: unknown }>,
	orphaned: RenderedSegment[],
): boolean {
	const textBlocks = (message.content ?? []).filter(
		(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim(),
	);
	if (textBlocks.length !== 1) return false;
	return shouldSuppressRedundantHandoffText(
		sessionMessages,
		textBlocks[0].text,
		orphaned,
		[],
	);
}

export function shouldSuppressRedundantHandoffText(
	sessionMessages: Array<{ role?: string; content?: unknown }>,
	currentText: string,
	orphaned: RenderedSegment[],
	rendered: RenderedSegment[],
): boolean {
	const next = currentText.trim();
	if (!next) return false;

	const priorInline = latestPriorUserFacingText(orphaned, rendered);
	if (priorInline && isRedundantDiscussRestatement(priorInline, next)) {
		return true;
	}

	const last = sessionMessages[sessionMessages.length - 1];
	const skipLastAssistant =
		last?.role === "assistant" && extractAssistantText(last).trim() === next;
	const priorSession = priorAssistantTextFromSession(sessionMessages, { skipLastAssistant });
	return !!(priorSession && isRedundantDiscussRestatement(priorSession, next));
}

export function buildDesiredSegments(
	blocks: Array<any>,
	options: { hideThinkingBlock?: boolean; shouldSkipTextBlock?: (block: any, index: number) => boolean } = {},
): DesiredSegment[] {
	const desired: DesiredSegment[] = [];
	let runStart = -1;
	let runEnd = -1;
	let runType: "text" | "thinking" | undefined;
	const closeRun = () => {
		if (runStart !== -1 && runType) {
			desired.push({ kind: "text-run", startIndex: runStart, endIndex: runEnd, contentType: runType });
			runStart = -1;
			runEnd = -1;
			runType = undefined;
		}
	};

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const blockType = getVisibleTextLikeBlockType(block, options.hideThinkingBlock);
		const isInvisibleTextLike = blockType === undefined && (block?.type === "text" || block?.type === "thinking");
		const isTool = block?.type === "toolCall" || block?.type === "serverToolUse";

		if (blockType) {
			if (options.shouldSkipTextBlock?.(block, i)) {
				closeRun();
				continue;
			}
			if (runStart === -1) {
				runStart = i;
				runEnd = i;
				runType = blockType;
			} else if (runType !== blockType) {
				closeRun();
				runStart = i;
				runEnd = i;
				runType = blockType;
			} else {
				runEnd = i;
			}
		} else {
			if (isInvisibleTextLike) continue;
			closeRun();
			if (isTool) {
				desired.push({ kind: "tool", contentIndex: i, toolId: block.id });
			}
		}
	}
	closeRun();

	return desired;
}

function isToolUseBlock(block: any): boolean {
	return block?.type === "toolCall" || block?.type === "serverToolUse";
}

function isMcpToolBlock(block: any): boolean {
	if (!isToolUseBlock(block)) return false;
	const toolName = typeof block?.name === "string" ? block.name : "";
	return typeof block?.mcpServer === "string" || toolName.startsWith("mcp__");
}

function hasPostToolText(blocks: Array<any>, firstToolIdx: number): boolean {
	if (firstToolIdx < 0) return false;
	return blocks.some(
		(b: any, idx: number) => (
			idx > firstToolIdx
			&& b?.type === "text"
			&& typeof b?.text === "string"
			&& b.text.trim().length > 0
		),
	);
}

function normalizeProvisionalText(text: string): string {
	return text
		.trim()
		.replace(/[’`]/g, "'")
		.replace(/\s+/g, " ");
}

export function isProvisionalPreToolProse(text: string): boolean {
	const normalized = normalizeProvisionalText(text);
	if (!normalized) return false;
	if (textInvitesUserReply(normalized)) return false;
	if (/\?\s*$/.test(normalized)) return false;

	return FIRST_PERSON_PROVISIONAL_PRE_TOOL_RE.test(normalized)
		|| GERUND_PROVISIONAL_PRE_TOOL_RE.test(normalized);
}

export function getProvisionalPreToolPrunePlan(message: { provider?: string; content: Array<any> }): {
	shouldPrune: boolean;
	firstToolIdx: number;
} {
	const blocks = message.content;
	const firstToolIdx = blocks.findIndex(isToolUseBlock);
	return {
		firstToolIdx,
		shouldPrune:
			message.provider === "claude-code"
			&& firstToolIdx >= 0
			&& blocks.some(isMcpToolBlock)
			&& hasPostToolText(blocks, firstToolIdx),
	};
}

export function buildDesiredSegmentsForMessage(
	message: { provider?: string; content: Array<any> },
	options: { hideThinkingBlock?: boolean } = {},
): DesiredSegment[] {
	const { shouldPrune, firstToolIdx } = getProvisionalPreToolPrunePlan(message);
	return buildDesiredSegments(message.content, {
		hideThinkingBlock: options.hideThinkingBlock,
		shouldSkipTextBlock: (block: any, index: number) => {
			if (!shouldPrune || firstToolIdx < 0 || index >= firstToolIdx) return false;
			if (getVisibleTextLikeBlockType(block, options.hideThinkingBlock) !== "text") return false;
			const textValue = typeof block?.text === "string" ? block.text : "";
			return isProvisionalPreToolProse(textValue);
		},
	});
}

export function hasVisibleAssistantContent(message: { content: Array<any> }, hideThinkingBlock = false): boolean {
	return message.content.some((c) => getVisibleTextLikeBlockType(c, hideThinkingBlock) !== undefined);
}

export function hasAssistantToolBlocks(message: { content: Array<any> }): boolean {
	return message.content.some((c) => c.type === "toolCall" || c.type === "serverToolUse");
}
