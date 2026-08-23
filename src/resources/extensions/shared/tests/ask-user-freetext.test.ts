/**
 * Tests for ask-user-questions free-text input behavior.
 *
 * Bug #2715: The ask-user-questions UI lacks free-text input and can trap
 * users in a loop when the agent needs an explanation rather than a fixed
 * choice.
 *
 * These tests exercise the RPC fallback path (ctx.ui.select) in
 * ask-user-questions.ts to ensure that selecting "None of the above"
 * triggers a follow-up free-text input prompt via ctx.ui.input().
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #1923: execute() consults the operator's real Remote Questions config. Without
// this guard, fixture questions are posted to a configured Slack/Discord/Telegram
// channel on every test run.
process.env.GSD_DISABLE_REMOTE_QUESTIONS = "1";

// The ask-user-questions extension registers a tool via pi.registerTool().
// We capture that registration and call execute() directly with a mock context.
import AskUserQuestions from "../../ask-user-questions.js";
import { resetAskUserQuestionsCache } from "../../ask-user-questions.js";
import { isRemoteConfigured } from "../../remote-questions/manager.js";
import { resolveRemoteConfig } from "../../remote-questions/config.js";
import { clearGSDPreferencesCache, getGlobalGSDPreferencesPath } from "../../gsd/preferences.js";

interface CapturedTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

function captureTool(): CapturedTool {
	let captured: CapturedTool | null = null;
	const fakePi = {
		registerTool(tool: any) {
			captured = { name: tool.name, execute: tool.execute };
		},
	};
	AskUserQuestions(fakePi as any);
	if (!captured) throw new Error("No tool registered");
	return captured;
}

function makeQuestion(id: string, options: string[]) {
	return {
		id,
		header: id,
		question: `Pick for ${id}`,
		options: options.map((label) => ({ label, description: `Desc for ${label}` })),
	};
}

function makeMockCtx(opts: {
	selectReturns: (string | string[] | undefined)[];
	inputReturns?: (string | undefined)[];
}) {
	let selectCallIdx = 0;
	let inputCallIdx = 0;
	const selectCalls: { title: string; options: string[] }[] = [];
	const inputCalls: { title: string; placeholder?: string }[] = [];

	return {
		ctx: {
			hasUI: true,
			ui: {
				custom: () => undefined, // force RPC fallback
				select: async (title: string, options: string[], selectOpts?: any) => {
					selectCalls.push({ title, options });
					return opts.selectReturns[selectCallIdx++];
				},
				input: async (title: string, placeholder?: string) => {
					inputCalls.push({ title, placeholder });
					return (opts.inputReturns ?? [])[inputCallIdx++];
				},
			},
		},
		selectCalls,
		inputCalls,
	};
}

describe("ask-user-questions RPC fallback free-text", () => {
	beforeEach(() => {
		resetAskUserQuestionsCache();
	});

	it("prompts for free-text input when user selects 'None of the above'", async () => {
		const tool = captureTool();
		const { ctx, selectCalls, inputCalls } = makeMockCtx({
			selectReturns: ["None of the above"],
			inputReturns: ["I need to explain my reasoning"],
		});

		const params = {
			questions: [makeQuestion("q1", ["Option A", "Option B"])],
		};

		const result = await tool.execute("call-1", params, undefined, undefined, ctx);

		// The select should have been called with "None of the above" appended
		assert.equal(selectCalls.length, 1);
		assert.ok(
			selectCalls[0].options.includes("None of the above"),
			"select options should include 'None of the above'",
		);

		// A follow-up input() call should have been made to collect free text
		assert.equal(inputCalls.length, 1, "should call ctx.ui.input() for free-text after 'None of the above'");

		// The result should include the user's free-text note
		const text = result.content[0]?.text;
		assert.ok(text, "result should have text content");
		const parsed = JSON.parse(text);
		assert.ok(
			parsed.answers.q1,
			"answer for q1 should exist",
		);
		const q1Answers = parsed.answers.q1.answers;
		assert.ok(
			q1Answers.some((a: string) => a.includes("I need to explain my reasoning")),
			"answer should include the free-text explanation",
		);
	});

	it("does NOT prompt for free-text when user selects a normal option", async () => {
		const tool = captureTool();
		const { ctx, inputCalls } = makeMockCtx({
			selectReturns: ["Option A"],
		});

		const params = {
			questions: [makeQuestion("q1", ["Option A", "Option B"])],
		};

		const result = await tool.execute("call-2", params, undefined, undefined, ctx);

		// No input() call should have been made
		assert.equal(inputCalls.length, 0, "should NOT call ctx.ui.input() for a normal option");

		const text = result.content[0]?.text;
		const parsed = JSON.parse(text);
		assert.deepStrictEqual(parsed.answers.q1.answers, ["Option A"]);
	});

	it("handles cancelled free-text input gracefully", async () => {
		const tool = captureTool();
		const { ctx, inputCalls } = makeMockCtx({
			selectReturns: ["None of the above"],
			inputReturns: [undefined], // user cancelled the input
		});

		const params = {
			questions: [makeQuestion("q1", ["Option A", "Option B"])],
		};

		const result = await tool.execute("call-3", params, undefined, undefined, ctx);

		// Input should still have been called
		assert.equal(inputCalls.length, 1, "should call ctx.ui.input() even if user cancels");

		// Result should still contain "None of the above" without a note
		const text = result.content[0]?.text;
		assert.ok(text, "result should have text content");
		const parsed = JSON.parse(text);
		assert.deepStrictEqual(parsed.answers.q1.answers, ["None of the above"]);
	});
});

describe("ask-user-questions remote isolation (#1923)", () => {
	it("GSD_DISABLE_REMOTE_QUESTIONS=1 keeps execute() on the local path even when a channel is configured", async (t) => {
		const originalGsdHome = process.env.GSD_HOME;
		const originalToken = process.env.TELEGRAM_BOT_TOKEN;
		const tempGsdHome = mkdtempSync(join(tmpdir(), "ask-user-remote-isolation-"));
		t.after(() => {
			process.env.GSD_DISABLE_REMOTE_QUESTIONS = "1";
			if (originalGsdHome === undefined) delete process.env.GSD_HOME;
			else process.env.GSD_HOME = originalGsdHome;
			if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
			else process.env.TELEGRAM_BOT_TOKEN = originalToken;
			clearGSDPreferencesCache();
			rmSync(tempGsdHome, { recursive: true, force: true });
		});

		// Hermetic "operator has Remote Questions configured" state.
		process.env.GSD_HOME = tempGsdHome;
		process.env.TELEGRAM_BOT_TOKEN = "test-token-never-used";
		mkdirSync(tempGsdHome, { recursive: true });
		writeFileSync(
			getGlobalGSDPreferencesPath(),
			"---\nversion: 1\nremote_questions:\n  channel: telegram\n  channel_id: \"123456789\"\n---\n",
			"utf-8",
		);
		clearGSDPreferencesCache();

		// Sanity: without the guard this machine state WOULD dispatch remotely.
		delete process.env.GSD_DISABLE_REMOTE_QUESTIONS;
		assert.ok(resolveRemoteConfig(), "fixture must look like a configured channel without the guard");

		// With the guard, the manager sees no remote channel at all.
		process.env.GSD_DISABLE_REMOTE_QUESTIONS = "1";
		assert.equal(isRemoteConfigured(), false);

		// execute() therefore resolves purely through the mock local UI.
		resetAskUserQuestionsCache();
		const tool = captureTool();
		const { ctx, selectCalls } = makeMockCtx({ selectReturns: ["Option A"] });
		const result = await tool.execute(
			"call-4",
			{ questions: [makeQuestion("q1", ["Option A", "Option B"])] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(selectCalls.length, 1);
		assert.deepStrictEqual(JSON.parse(result.content[0].text).answers.q1.answers, ["Option A"]);
	});
});
