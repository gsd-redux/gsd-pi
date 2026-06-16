import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";

import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "./utils.js";

/** Build an assistant message carrying the given tool calls. */
function assistantWithToolCalls(
	calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): AgentMessage {
	return {
		role: "assistant",
		content: calls.map((call, i) => ({
			type: "toolCall",
			id: `tool-${i}`,
			name: call.name,
			arguments: call.arguments,
		})),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

test("createFileOps returns three empty sets", () => {
	const ops = createFileOps();
	assert.equal(ops.read.size, 0);
	assert.equal(ops.written.size, 0);
	assert.equal(ops.edited.size, 0);
});

test("extractFileOpsFromMessage buckets read/write/edit tool calls by path", () => {
	const ops = createFileOps();
	extractFileOpsFromMessage(
		assistantWithToolCalls([
			{ name: "read", arguments: { path: "src/a.ts" } },
			{ name: "write", arguments: { path: "src/b.ts" } },
			{ name: "edit", arguments: { path: "src/c.ts" } },
		]),
		ops,
	);

	assert.deepEqual([...ops.read], ["src/a.ts"]);
	assert.deepEqual([...ops.written], ["src/b.ts"]);
	assert.deepEqual([...ops.edited], ["src/c.ts"]);
});

test("extractFileOpsFromMessage ignores non-assistant messages", () => {
	const ops = createFileOps();
	const userMessage = { role: "user", content: "do a thing" } as unknown as AgentMessage;
	extractFileOpsFromMessage(userMessage, ops);
	assert.equal(ops.read.size + ops.written.size + ops.edited.size, 0);
});

test("extractFileOpsFromMessage skips tool calls without a string path and unknown tools", () => {
	const ops = createFileOps();
	extractFileOpsFromMessage(
		assistantWithToolCalls([
			{ name: "read", arguments: { notAPath: 123 } },
			{ name: "bash", arguments: { path: "should-be-ignored" } },
		]),
		ops,
	);
	assert.equal(ops.read.size, 0);
	assert.equal(ops.written.size, 0);
	assert.equal(ops.edited.size, 0);
});

test("computeFileLists treats a file as modified (not read) when both read and written", () => {
	const ops = createFileOps();
	ops.read.add("shared.ts");
	ops.read.add("only-read.ts");
	ops.written.add("shared.ts");
	ops.edited.add("edited.ts");

	const { readFiles, modifiedFiles } = computeFileLists(ops);

	assert.deepEqual(readFiles, ["only-read.ts"]);
	assert.deepEqual(modifiedFiles, ["edited.ts", "shared.ts"]);
});

test("computeFileLists returns sorted lists", () => {
	const ops = createFileOps();
	ops.read.add("z.ts");
	ops.read.add("a.ts");
	ops.edited.add("m.ts");
	ops.written.add("b.ts");

	const { readFiles, modifiedFiles } = computeFileLists(ops);
	assert.deepEqual(readFiles, ["a.ts", "z.ts"]);
	assert.deepEqual(modifiedFiles, ["b.ts", "m.ts"]);
});

test("formatFileOperations emits both XML sections when present", () => {
	const out = formatFileOperations(["r1.ts", "r2.ts"], ["m1.ts"]);
	assert.match(out, /<read-files>\nr1\.ts\nr2\.ts\n<\/read-files>/);
	assert.match(out, /<modified-files>\nm1\.ts\n<\/modified-files>/);
});

test("formatFileOperations returns an empty string when there are no files", () => {
	assert.equal(formatFileOperations([], []), "");
});

test("formatFileOperations omits the read section when only modified files exist", () => {
	const out = formatFileOperations([], ["m1.ts"]);
	assert.ok(!out.includes("<read-files>"));
	assert.match(out, /<modified-files>/);
});
