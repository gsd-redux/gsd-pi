import { execFileSync } from "node:child_process";

const VERSION_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 10_000;
const LIST_MODELS_TIMEOUT_MS = 15_000;
const CHECK_INTERVAL_MS = 30_000;

let cachedBinaryPresent: boolean | null = null;
let cachedAuthed: boolean | null = null;
let lastCheckMs = 0;

export function getCursorAgentCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
}

export function getCursorAgentCommandCandidates(platform: NodeJS.Platform = process.platform): string[] {
	const command = getCursorAgentCommand(platform);
	return platform === "win32" ? [command, "cursor-agent.exe", "cursor-agent"] : [command];
}

export function buildCursorAgentSpawnInvocation(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", command, ...args] };
	}
	return { command, args };
}

function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CURSOR_DEBUG) {
		process.stderr.write(`[cursor-readiness] ${parts.map((part) => String(part)).join(" ")}\n`);
	}
}

function spawnCursorAgent(command: string, args: string[], timeout: number): Buffer {
	const invocation = buildCursorAgentSpawnInvocation(command, args);
	return execFileSync(invocation.command, invocation.args, { timeout, stdio: "pipe" });
}

function findWorkingCommand(): string | null {
	for (const command of getCursorAgentCommandCandidates()) {
		try {
			spawnCursorAgent(command, ["--version"], VERSION_TIMEOUT_MS);
			debugLog("version probe ok via", command);
			return command;
		} catch (error) {
			debugLog("version probe failed for", command, (error as Error).message?.slice(0, 200));
		}
	}
	return null;
}

export function parseCursorAgentStatus(output: string): boolean | null {
	const trimmed = output.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			for (const key of ["authenticated", "loggedIn", "logged_in", "isAuthenticated"]) {
				if (typeof parsed[key] === "boolean") return parsed[key];
			}
		} catch {
			// Fall through to text heuristics.
		}
	}

	const lower = trimmed.toLowerCase();
	if (/not authenticated|not logged in|no credentials|logged out|unauthenticated/.test(lower)) return false;
	if (/authenticated|logged in|signed in|cursor account|subscription/.test(lower)) return true;
	return null;
}

export function isCursorAgentApiKeyValue(value: string | undefined): boolean {
	const trimmed = value?.trim();
	return Boolean(trimmed && trimmed !== "cli");
}

function hasCursorApiKey(): boolean {
	return isCursorAgentApiKeyValue(process.env.CURSOR_API_KEY);
}

function probeAuth(command: string): boolean | null {
	if (hasCursorApiKey()) return true;

	try {
		const out = spawnCursorAgent(command, ["status"], STATUS_TIMEOUT_MS).toString();
		debugLog("status output", out.slice(0, 200));
		return parseCursorAgentStatus(out);
	} catch (error) {
		debugLog("status failed", (error as Error).message?.slice(0, 200));
	}

	return null;
}

export function isCursorAgentReadyUncached(): boolean {
	const command = findWorkingCommand();
	if (!command) return false;
	return probeAuth(command) === true;
}

function refreshCache(): void {
	const now = Date.now();
	if (cachedBinaryPresent !== null && now - lastCheckMs < CHECK_INTERVAL_MS) return;
	lastCheckMs = now;

	const command = findWorkingCommand();
	if (!command) {
		cachedBinaryPresent = false;
		cachedAuthed = false;
		return;
	}

	cachedBinaryPresent = true;
	const authed = probeAuth(command);
	if (authed === null) {
		if (cachedAuthed === null) cachedAuthed = false;
		return;
	}
	cachedAuthed = authed;
}

export function isCursorAgentBinaryPresent(): boolean {
	refreshCache();
	return cachedBinaryPresent ?? false;
}

export function isCursorAgentReady(): boolean {
	refreshCache();
	return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

export function clearCursorAgentReadinessCache(): void {
	cachedBinaryPresent = null;
	cachedAuthed = null;
	lastCheckMs = 0;
}

export function readCursorAgentListModels(): string | null {
	const command = findWorkingCommand();
	if (!command) return null;
	try {
		return spawnCursorAgent(command, ["--list-models"], LIST_MODELS_TIMEOUT_MS).toString("utf8");
	} catch (error) {
		debugLog("list-models failed", (error as Error).message?.slice(0, 200));
		return null;
	}
}
