import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager } from "./package-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

function writeExtension(dir: string, id: string, entry = "index.ts"): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "extension-manifest.json"),
		JSON.stringify({ id, name: id, version: "1.0.0", tier: "community" }),
	);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ pi: { extensions: [`./${entry}`] } }));
	const entryPath = join(dir, entry);
	mkdirSync(join(entryPath, ".."), { recursive: true });
	writeFileSync(entryPath, "export default function() {};");
	return entryPath;
}

test("resolve includes installed extensions and only shadows bundled manifest IDs", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pm-installed-extensions-"));
	const cwd = join(tempDir, "project");
	const agentDir = join(tempDir, ".gsd", "agent");
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));

	const bundledPath = writeExtension(join(agentDir, "extensions", "bundled-copy"), "shared-id", "src/index.ts");
	const projectPath = writeExtension(join(cwd, ".gsd", "extensions", "project-copy"), "shared-id");
	const installedPath = writeExtension(
		join(tempDir, ".gsd", "extensions", "installed-copy"),
		"shared-id",
		"dist/index.js",
	);
	writeFileSync(
		join(tempDir, ".gsd", "extensions", "registry.json"),
		JSON.stringify({
			version: 1,
			entries: { "shared-id": { id: "shared-id", enabled: true, source: "user" } },
		}),
	);

	const packageManager = new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
	});
	const result = await packageManager.resolve();
	const resolvedPaths = result.extensions.map((extension) => extension.path);

	assert.equal(resolvedPaths.includes(installedPath), true);
	assert.equal(resolvedPaths.includes(projectPath), true, "project extensions must retain their precedence");
	assert.equal(resolvedPaths.includes(bundledPath), false, "the installed manifest ID must shadow its bundled copy");
});
