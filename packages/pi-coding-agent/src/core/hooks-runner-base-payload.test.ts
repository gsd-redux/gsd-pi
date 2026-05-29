/**
 * Tests for base fields (session_id, cwd) in dispatched hook payloads.
 *
 * These tests verify that every hook event receives session_id and cwd
 * in its JSON payload on stdin — matching the contract that consumers
 * (context-mode, agentmemory, notebook hooks) depend on.
 *
 * Pattern: configure a hook that echoes its stdin back to stdout,
 * then inspect the captured invocation's stdout for expected fields.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "../config.js";
import { ExtensionRunner } from "./extensions/runner.js";
import { createHooksRunner } from "./hooks-runner.js";
import type { ExtensionRuntime } from "./extensions/types.js";
import type { Settings } from "./settings-manager.js";

function makeTempProject() {
	const base = mkdtempSync(join(tmpdir(), "hooks-base-payload-test-"));
	mkdirSync(join(base, CONFIG_DIR_NAME), { recursive: true });
	return base;
}

function stubRuntime(): ExtensionRuntime {
	return {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		registerProvider: () => {},
		unregisterProvider: () => {},
		emitBeforeModelSelect: async () => undefined,
		emitAdjustToolSet: async () => undefined,
		emitExtensionEvent: async () => undefined,
		sendMessage: () => {},
		sendUserMessage: () => {},
		retryLastTurn: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getVisibleSkills: () => undefined,
		setVisibleSkills: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};
}

/**
 * Create an ExtensionRunner with a mock sessionManager that returns a known sessionId.
 */
function makeRunnerWithSession(cwd: string, sessionId: string): ExtensionRunner {
	const sessionManager = {
		getSessionId: () => sessionId,
	} as never;
	return new ExtensionRunner(
		[],
		stubRuntime(),
		cwd,
		sessionManager,
		{} as never,
	);
}

/**
 * Hook command that echoes stdin back to stdout as-is.
 * This lets us inspect exactly what payload was sent to the hook.
 */
const ECHO_STDIN = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))"`;

describe("createHooksRunner — base payload fields", () => {
	let tmpCwd: string | undefined;
	afterEach(() => {
		if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
		tmpCwd = undefined;
	});

	it("includes session_id in SessionStart payload", async () => {
		tmpCwd = makeTempProject();
		const runner = makeRunnerWithSession(tmpCwd, "test-session-001");
		let capturedPayload: Record<string, unknown> | undefined;

		const hooks = createHooksRunner({
			extensionRunner: runner,
			getGlobalSettings: (): Settings => ({
				hooks: { SessionStart: [{ command: ECHO_STDIN }] },
			}),
			getProjectSettings: (): Settings => ({}),
			cwd: tmpCwd,
			onInvocation: (i) => {
				try { capturedPayload = JSON.parse(i.stdout); } catch { /* ignore */ }
			},
		});

		await hooks.fireSessionStart();
		hooks.dispose();

		assert.ok(capturedPayload, "hook should have been invoked");
		assert.equal(capturedPayload!.session_id, "test-session-001",
			"payload must include session_id from ExtensionRunner's sessionManager");
	});

	it("includes cwd in SessionStart payload", async () => {
		tmpCwd = makeTempProject();
		const runner = makeRunnerWithSession(tmpCwd, "s2");
		let capturedPayload: Record<string, unknown> | undefined;

		const hooks = createHooksRunner({
			extensionRunner: runner,
			getGlobalSettings: (): Settings => ({
				hooks: { SessionStart: [{ command: ECHO_STDIN }] },
			}),
			getProjectSettings: (): Settings => ({}),
			cwd: tmpCwd,
			onInvocation: (i) => {
				try { capturedPayload = JSON.parse(i.stdout); } catch { /* ignore */ }
			},
		});

		await hooks.fireSessionStart();
		hooks.dispose();

		assert.ok(capturedPayload, "hook should have been invoked");
		assert.equal(capturedPayload!.cwd, tmpCwd,
			"payload must include cwd from createHooksRunner options");
	});

	it("includes session_id and cwd in PreToolUse payload", async () => {
		tmpCwd = makeTempProject();
		const runner = makeRunnerWithSession(tmpCwd, "s3");
		let capturedPayload: Record<string, unknown> | undefined;

		createHooksRunner({
			extensionRunner: runner,
			getGlobalSettings: (): Settings => ({
				hooks: { PreToolUse: [{ command: ECHO_STDIN }] },
			}),
			getProjectSettings: (): Settings => ({}),
			cwd: tmpCwd,
			onInvocation: (i) => {
				try { capturedPayload = JSON.parse(i.stdout); } catch { /* ignore */ }
			},
		});

		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tc1",
			toolName: "bash",
			input: { command: "ls" },
		});

		assert.ok(capturedPayload, "PreToolUse hook should have been invoked");
		assert.equal(capturedPayload!.session_id, "s3",
			"PreToolUse payload must include session_id");
		assert.equal(capturedPayload!.cwd, tmpCwd,
			"PreToolUse payload must include cwd");
		// Also verify event-specific fields are still present
		assert.equal(capturedPayload!.toolName, "bash");
		assert.equal(capturedPayload!.toolCallId, "tc1");
	});

	it("includes session_id and cwd in PostToolUse payload", async () => {
		tmpCwd = makeTempProject();
		const runner = makeRunnerWithSession(tmpCwd, "s4");
		let capturedPayload: Record<string, unknown> | undefined;

		createHooksRunner({
			extensionRunner: runner,
			getGlobalSettings: (): Settings => ({
				hooks: { PostToolUse: [{ command: ECHO_STDIN }] },
			}),
			getProjectSettings: (): Settings => ({}),
			cwd: tmpCwd,
			onInvocation: (i) => {
				try { capturedPayload = JSON.parse(i.stdout); } catch { /* ignore */ }
			},
		});

		await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "tc2",
			toolName: "read",
			input: { path: "/tmp/x" },
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			details: undefined,
		});

		assert.ok(capturedPayload, "PostToolUse hook should have been invoked");
		assert.equal(capturedPayload!.session_id, "s4",
			"PostToolUse payload must include session_id");
		assert.equal(capturedPayload!.cwd, tmpCwd,
			"PostToolUse payload must include cwd");
	});

	it("falls back to empty session_id when sessionManager lacks getSessionId", async () => {
		tmpCwd = makeTempProject();
		// Create runner with no sessionManager.getSessionId
		const runner = new ExtensionRunner(
			[],
			stubRuntime(),
			tmpCwd,
			{} as never,
			{} as never,
		);
		let capturedPayload: Record<string, unknown> | undefined;

		const hooks = createHooksRunner({
			extensionRunner: runner,
			getGlobalSettings: (): Settings => ({
				hooks: { SessionStart: [{ command: ECHO_STDIN }] },
			}),
			getProjectSettings: (): Settings => ({}),
			cwd: tmpCwd,
			onInvocation: (i) => {
				try { capturedPayload = JSON.parse(i.stdout); } catch { /* ignore */ }
			},
		});

		await hooks.fireSessionStart();
		hooks.dispose();

		assert.ok(capturedPayload, "hook should have been invoked");
		assert.equal(capturedPayload!.session_id, "",
			"session_id should be empty string when sessionManager has no getSessionId");
		assert.equal(capturedPayload!.cwd, tmpCwd,
			"cwd should still be present even without session_id");
	});
});
