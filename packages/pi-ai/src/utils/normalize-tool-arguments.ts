import { normalizeClaudeCodeAgentArguments } from "./agent-shim.js";

/**
 * Normalize common LLM tool-argument mistakes before JSON-schema validation.
 *
 * Some models (notably Gemini Flash on Antigravity) emit valid-looking tool
 * calls with wrong shapes: `filePath`/`file` instead of `path`, or JSON-stringified
 * arrays for `subagent.tasks`. Claude Code models often call PascalCase tool names
 * with Cursor-style edit payloads (`file_path`, `old_string`, `new_string`).
 * AJV type coercion does not repair these.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalToolName(toolName: string): string {
	return toolName.toLowerCase();
}

function aliasPathArguments(args: Record<string, unknown>): void {
	if (args.path !== undefined) return;
	const alias = args.filePath ?? args.file_path ?? args.file;
	if (typeof alias !== "string" || alias.length === 0) return;
	args.path = alias;
	delete args.filePath;
	delete args.file_path;
	delete args.file;
}

function tryParseJsonValue(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function normalizeJsonStringCollections(args: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = args[key];
		if (typeof value !== "string") continue;
		const parsed = tryParseJsonValue(value);
		if (parsed !== value) {
			args[key] = parsed;
		}
	}
}

function normalizeEditEntry(entry: unknown): void {
	if (!isRecord(entry)) return;
	if (typeof entry.oldText !== "string" && typeof entry.old_string === "string") {
		entry.oldText = entry.old_string;
		delete entry.old_string;
	}
	if (typeof entry.newText !== "string" && typeof entry.new_string === "string") {
		entry.newText = entry.new_string;
		delete entry.new_string;
	}
}

function normalizeEditArguments(args: Record<string, unknown>): void {
	aliasPathArguments(args);

	if (typeof args.edits === "string") {
		const parsed = tryParseJsonValue(args.edits);
		if (Array.isArray(parsed)) {
			args.edits = parsed;
		}
	}

	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			normalizeEditEntry(entry);
		}
	}

	const oldString = args.old_string ?? args.oldString ?? args.oldText;
	const newString = args.new_string ?? args.newString ?? args.newText;
	if (typeof oldString === "string" && typeof newString === "string") {
		const edits = Array.isArray(args.edits) ? [...args.edits] : [];
		edits.push({ oldText: oldString, newText: newString });
		args.edits = edits;
	}

	delete args.old_string;
	delete args.oldString;
	delete args.oldText;
	delete args.new_string;
	delete args.newString;
	delete args.newText;
	delete args.replace_all;
	delete args.replaceAll;
}

/**
 * Apply tool-specific argument repairs in-place on a cloned args object.
 */
export function normalizeToolArguments(toolName: string, args: unknown): unknown {
	if (!isRecord(args)) {
		return args;
	}

	const canonical = canonicalToolName(toolName);

	if (canonical === "read" || canonical === "write") {
		aliasPathArguments(args);
	}

	if (canonical === "write") {
		if (args.content === undefined && typeof args.contents === "string") {
			args.content = args.contents;
			delete args.contents;
		}
	}

	if (canonical === "bash") {
		if (args.command === undefined && typeof args.cmd === "string") {
			args.command = args.cmd;
			delete args.cmd;
		}
	}

	if (canonical === "edit") {
		normalizeEditArguments(args);
	}

	if (canonical === "agent" || canonical === "subagent") {
		normalizeClaudeCodeAgentArguments(args);
	}

	if (canonical === "subagent") {
		normalizeJsonStringCollections(args, ["tasks", "chain"]);
	}

	if (canonical === "gsd_task_complete" || canonical === "gsd_complete_task") {
		normalizeJsonStringCollections(args, ["verificationEvidence"]);
	}

	return args;
}

/**
 * Returns true when a read tool call has no resolvable path after common aliases.
 * Models sometimes emit phantom paired Read {} calls alongside valid reads.
 */
export function isEmptyPathToolArguments(toolName: string, args: unknown): boolean {
	if (canonicalToolName(toolName) !== "read") {
		return false;
	}

	if (!isRecord(args)) {
		return true;
	}

	const path = args.path ?? args.file_path ?? args.filePath ?? args.file;
	return typeof path !== "string" || path.length === 0;
}
