import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ManagedMcpServerConfig } from "./manager.js";

interface TrustStoreFile {
	version: 1;
	entries: string[];
}

function gsdHomeDir(): string {
	return process.env.GSD_HOME ? resolve(process.env.GSD_HOME) : join(homedir(), ".gsd");
}

function trustStorePath(): string {
	return join(gsdHomeDir(), "mcp-stdio-trust.json");
}

export function stdioPersistTrustKey(config: ManagedMcpServerConfig, projectRoot: string = process.cwd()): string {
	return JSON.stringify({
		project: resolve(projectRoot),
		name: config.name,
		sourcePath: config.sourcePath,
		command: config.command,
		args: config.args ?? [],
		cwd: config.cwd ?? null,
	});
}

function readStore(): TrustStoreFile {
	const path = trustStorePath();
	if (!existsSync(path)) return { version: 1, entries: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as TrustStoreFile;
		if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
		return { version: 1, entries: parsed.entries.filter((entry) => typeof entry === "string") };
	} catch {
		return { version: 1, entries: [] };
	}
}

export function hasPersistedStdioTrust(config: ManagedMcpServerConfig, projectRoot?: string): boolean {
	const key = stdioPersistTrustKey(config, projectRoot);
	return readStore().entries.includes(key);
}

export function persistStdioTrust(config: ManagedMcpServerConfig, projectRoot?: string): void {
	const key = stdioPersistTrustKey(config, projectRoot);
	const store = readStore();
	if (store.entries.includes(key)) return;
	store.entries.push(key);
	const path = trustStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}
