/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { Message } from "@gsd/pi-ai";
import { convertToLlm } from "@gsd/pi-coding-agent/core/messages.js";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for each content block in serialized summaries. */
const SUMMARY_CONTENT_MAX_CHARS = 2000;

/**
 * Truncate text for summarization while preserving head and tail context.
 */
export function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const tailChars = Math.floor(maxChars / 2);
	const headChars = maxChars - tailChars;
	const truncatedChars = text.length - headChars - tailChars;
	const tail = tailChars > 0 ? `\n\n${text.slice(-tailChars)}` : "";

	return `${text.slice(0, headChars)}\n\n[... ${truncatedChars} more characters truncated]${tail}`;
}

function cappedLength(text: string, maxChars: number): number {
	return Math.min(text.length, maxChars);
}

/**
 * Estimate the token size of a message after summary serialization.
 *
 * This mirrors the serializer's truncation behavior for tool results and uses
 * the same cap for bulky direct conversation blocks when planning chunks.
 */
export function estimateSerializedTokens(message: AgentMessage): number {
	if (message.role === "branchSummary" || message.role === "compactionSummary" || message.role === "toolResult") {
		return Math.ceil(serializeConversation(convertToLlm([message])).length / 4);
	}

	let chars = 0;
	switch (message.role) {
		case "user":
		case "custom": {
			const content = message.content;
			if (typeof content === "string") {
				chars = cappedLength(content, SUMMARY_CONTENT_MAX_CHARS);
			} else {
				for (const block of content) {
					if (block.type === "text" && block.text) chars += cappedLength(block.text, SUMMARY_CONTENT_MAX_CHARS);
				}
			}
			break;
		}
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") {
					chars += cappedLength(block.text, SUMMARY_CONTENT_MAX_CHARS);
				} else if (block.type === "thinking") {
					chars += cappedLength(block.thinking, SUMMARY_CONTENT_MAX_CHARS);
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			break;
		}
		case "bashExecution": {
			chars = cappedLength(message.command + message.output, SUMMARY_CONTENT_MAX_CHARS);
			break;
		}
	}

	return Math.ceil(chars / 4);
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Content blocks are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) {
				parts.push(`**User said:** ${truncateForSummary(content, SUMMARY_CONTENT_MAX_CHARS)}`);
			}
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(
					`**Assistant thinking:** ${truncateForSummary(thinkingParts.join("\n"), SUMMARY_CONTENT_MAX_CHARS)}`,
				);
			}
			if (textParts.length > 0) {
				parts.push(
					`**Assistant responded:** ${truncateForSummary(textParts.join("\n"), SUMMARY_CONTENT_MAX_CHARS)}`,
				);
			}
			if (toolCalls.length > 0) {
				parts.push(
					`**Assistant tool calls:** ${truncateForSummary(toolCalls.join("; "), SUMMARY_CONTENT_MAX_CHARS)}`,
				);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`**Tool result:** ${truncateForSummary(content, SUMMARY_CONTENT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a handoff briefing writer. Your task is to read a conversation between a user and an AI coding assistant, then produce a state snapshot that enables a successor to continue the work immediately.

Write from the perspective of "what does the next person need to know to keep going?" — not "what happened in this conversation." Prioritize current direction and next actions over historical narrative. If the conversation shifted goals, lead with the CURRENT goal — the original goal is background context only if still relevant.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured briefing.`;
