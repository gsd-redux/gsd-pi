// @gsd-build/mcp-server + alias-telemetry.test — coverage for #5031.
// `logAliasUsage` must:
//   - emit one valid JSON line per call to stderr with the documented shape
//   - never throw, even if stderr.write fails (telemetry must not break MCP)
//   - include the alias name and canonical name so downstream analysis can
//     attribute usage and drive the eventual removal in step 2.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ALIAS_USAGE_EVENT, logAliasUsage } from "./alias-telemetry.js";

describe("logAliasUsage", () => {
	let captured: string[];
	let originalWrite: typeof process.stderr.write;

	beforeEach(() => {
		captured = [];
		originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		process.stderr.write = originalWrite;
	});

	test("emits a single JSON line per call", () => {
		logAliasUsage("gsd_save_decision", "gsd_decision_save");
		assert.equal(captured.length, 1);
		assert.ok(captured[0].endsWith("\n"), "line must terminate with newline");
	});

	test("emitted JSON has the documented shape", () => {
		logAliasUsage("gsd_save_decision", "gsd_decision_save");
		const parsed = JSON.parse(captured[0].trimEnd());
		assert.equal(parsed.event, ALIAS_USAGE_EVENT);
		assert.equal(parsed.alias, "gsd_save_decision");
		assert.equal(parsed.canonical, "gsd_decision_save");
		assert.equal(typeof parsed.ts, "number");
	});

	test("event field is namespaced under 'deprecation.' for grep-friendly filtering", () => {
		logAliasUsage("gsd_save_decision", "gsd_decision_save");
		const parsed = JSON.parse(captured[0].trimEnd());
		assert.ok(
			(parsed.event as string).startsWith("deprecation."),
			`event '${parsed.event}' should be namespaced for 'grep deprecation' workflow`,
		);
	});

	test("ts field is a recent timestamp (within ~5s of Date.now())", () => {
		const before = Date.now();
		logAliasUsage("gsd_x", "gsd_y");
		const after = Date.now();
		const parsed = JSON.parse(captured[0].trimEnd());
		assert.ok(parsed.ts >= before && parsed.ts <= after, `ts ${parsed.ts} should be in [${before}, ${after}]`);
	});

	test("multiple calls emit multiple lines", () => {
		logAliasUsage("a", "A");
		logAliasUsage("b", "B");
		logAliasUsage("c", "C");
		assert.equal(captured.length, 3);
		const aliases = captured.map((l) => JSON.parse(l.trimEnd()).alias);
		assert.deepEqual(aliases, ["a", "b", "c"]);
	});

	test("never throws — telemetry must not break the MCP request handler", () => {
		// Force a write failure to exercise the swallow path.
		process.stderr.write = (() => {
			throw new Error("simulated stderr failure");
		}) as typeof process.stderr.write;
		assert.doesNotThrow(() => logAliasUsage("x", "y"));
	});
});
