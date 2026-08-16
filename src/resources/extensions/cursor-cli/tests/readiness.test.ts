import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildCursorAgentSpawnInvocation,
	getCursorAgentCommandCandidates,
	isCursorAgentApiKeyValue,
	isCursorAgentReadyUncached,
	parseCursorAgentStatus,
} from "../readiness.ts";

test("getCursorAgentCommandCandidates includes Windows shims", () => {
	assert.deepEqual(getCursorAgentCommandCandidates("win32"), ["cursor-agent.cmd", "cursor-agent.exe", "cursor-agent"]);
	assert.deepEqual(getCursorAgentCommandCandidates("linux"), ["cursor-agent"]);
});

test("buildCursorAgentSpawnInvocation uses cmd /c on Windows", () => {
	assert.deepEqual(buildCursorAgentSpawnInvocation("cursor-agent.cmd", ["--version"], "win32"), {
		command: "cmd",
		args: ["/c", "cursor-agent.cmd", "--version"],
	});
});

test("parseCursorAgentStatus recognizes auth status output", () => {
	assert.equal(parseCursorAgentStatus('{"authenticated":true}'), true);
	assert.equal(parseCursorAgentStatus('{"loggedIn":false}'), false);
	assert.equal(parseCursorAgentStatus("Authenticated as user@example.com"), true);
	assert.equal(parseCursorAgentStatus("not authenticated"), false);
	assert.equal(parseCursorAgentStatus(""), null);
});

test("isCursorAgentApiKeyValue rejects external CLI sentinel values", () => {
	assert.equal(isCursorAgentApiKeyValue("cursor-token"), true);
	assert.equal(isCursorAgentApiKeyValue("cli"), false);
	assert.equal(isCursorAgentApiKeyValue("  "), false);
});

test("readiness checks only the supported status command", () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "cursor-readiness-"));
	const logPath = join(fixtureDir, "invocations.log");
	const commandPath = join(fixtureDir, process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent");
	const originalPath = process.env.PATH;
	const originalApiKey = process.env.CURSOR_API_KEY;
	const originalLogPath = process.env.CURSOR_AGENT_TEST_LOG;

	if (process.platform === "win32") {
		writeFileSync(commandPath, [
			"@echo off",
			"echo %*>>\"%CURSOR_AGENT_TEST_LOG%\"",
			"if \"%1\"==\"--version\" (echo 1.0.0 & exit /b 0)",
			"if \"%1\"==\"status\" (echo Not authenticated & exit /b 0)",
			"exit /b 1",
		].join("\r\n"));
	} else {
		writeFileSync(commandPath, [
			"#!/bin/sh",
			"printf '%s\\n' \"$*\" >> \"$CURSOR_AGENT_TEST_LOG\"",
			"[ \"$1\" = \"--version\" ] && { echo 1.0.0; exit 0; }",
			"[ \"$1\" = \"status\" ] && { echo 'Not authenticated'; exit 0; }",
			"exit 1",
		].join("\n"), { mode: 0o755 });
	}

	try {
		process.env.PATH = `${fixtureDir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
		process.env.CURSOR_AGENT_TEST_LOG = logPath;
		delete process.env.CURSOR_API_KEY;

		assert.equal(isCursorAgentReadyUncached(), false);
		assert.deepEqual(readFileSync(logPath, "utf8").trim().split(/\r?\n/), ["--version", "status"]);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
		else process.env.CURSOR_API_KEY = originalApiKey;
		if (originalLogPath === undefined) delete process.env.CURSOR_AGENT_TEST_LOG;
		else process.env.CURSOR_AGENT_TEST_LOG = originalLogPath;
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
