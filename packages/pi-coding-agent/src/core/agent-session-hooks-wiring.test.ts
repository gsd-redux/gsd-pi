/**
 * Regression tests for shell-hook wiring in AgentSession.
 *
 * Issue (from ~/Desktop/hooks-issue.md):
 *   1. createHooksRunner was never called — the hooks key in settings was dead config.
 *   2. ExtensionRunner was not created when no extensions existed, so even if
 *      createHooksRunner were called, there was no runner to attach the hook bridge to.
 *
 * Both fixes are in _buildRuntime():
 *   - ExtensionRunner is always created (empty extensions array when none found).
 *   - createHooksRunner is always called when _extensionRunner exists.
 *
 * These tests verify that _hooksRunner is initialized and that SessionStart fires
 * even when there are zero extensions loaded.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Agent } from "@gsd/pi-agent-core";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

let testDir: string;

async function createSession(options: {
	settingsManager?: SettingsManager;
}): Promise<AgentSession> {
	const agentDir = join(testDir, "agent-home");
	const authStorage = AuthStorage.inMemory({});
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	const settingsManager =
		options.settingsManager ?? SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: testDir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	return new AgentSession({
		agent: new Agent(),
		sessionManager: SessionManager.inMemory(testDir),
		settingsManager,
		cwd: testDir,
		resourceLoader,
		modelRegistry,
	});
}

describe("AgentSession hooks wiring — regression for hooks-issue.md", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "agent-session-hooks-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("_extensionRunner is created even when no extensions are loaded", async () => {
		const session = await createSession({});
		assert.notEqual(
			(session as any)._extensionRunner,
			undefined,
			"_extensionRunner must exist even with zero extensions (fix for issue #2)",
		);
	});

	it("_hooksRunner is initialized even when no extensions are loaded", async () => {
		const session = await createSession({});
		assert.notEqual(
			(session as any)._hooksRunner,
			undefined,
			"_hooksRunner must be wired when _extensionRunner exists (fix for issue #1)",
		);
	});

	it("SessionStart hook fires when configured in global settings with no extensions", async () => {
		const markerFile = join(testDir, "session-start-fired");
		const settingsManager = SettingsManager.inMemory();
		// Inject a global hook that creates a marker file
		(settingsManager as any).getGlobalSettings = () => ({
			hooks: {
				SessionStart: [
					{
						command: `node -e "require('fs').writeFileSync('${markerFile}','fired')"`,
					},
				],
			},
		});

		const session = await createSession({ settingsManager });

		// SessionStart fires in bindExtensions(), not in the constructor.
		await session.bindExtensions({});

		assert.ok(
			existsSync(markerFile),
			"SessionStart hook must fire and create the marker file",
		);
	});

	it("_hooksRunner survives reload() with no extensions", async () => {
		const session = await createSession({});
		assert.notEqual(
			(session as any)._hooksRunner,
			undefined,
			"_hooksRunner must exist before reload",
		);

		await session.reload();
		assert.notEqual(
			(session as any)._hooksRunner,
			undefined,
			"_hooksRunner must be re-created after reload() even with no extensions",
		);
	});

	it("old _hooksRunner is disposed before new one is created on reload", async () => {
		const session = await createSession({});
		const firstRunner = (session as any)._hooksRunner;
		assert.notEqual(firstRunner, undefined, "_hooksRunner must exist before reload");

		let disposed = false;
		const origDispose = firstRunner.dispose.bind(firstRunner);
		firstRunner.dispose = () => { disposed = true; origDispose(); };

		await session.reload();

		assert.ok(disposed, "old _hooksRunner.dispose() must be called during reload");
		const secondRunner = (session as any)._hooksRunner;
		assert.notEqual(secondRunner, undefined, "new _hooksRunner must exist after reload");
		assert.notStrictEqual(secondRunner, firstRunner, "new runner must be a different instance");
	});

	it("fireSessionEnd is called during reload before the runner is replaced", async () => {
		const session = await createSession({});
		const firstRunner = (session as any)._hooksRunner;
		assert.notEqual(firstRunner, undefined, "_hooksRunner must exist before reload");

		let endFired = false;
		let endReason: string | undefined;
		const origFireEnd = firstRunner.fireSessionEnd.bind(firstRunner);
		firstRunner.fireSessionEnd = async (reason: string) => {
			endFired = true;
			endReason = reason;
			return origFireEnd(reason);
		};

		await session.reload();

		assert.ok(endFired, "fireSessionEnd must be called during reload");
		assert.equal(endReason, "programmatic", "reason must be 'programmatic' for reload");
	});
});
