// Project/App: GSD-2
// File Purpose: Regression coverage for the public npm package identity.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 10; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.name === "@opengsd/gsd-pi" && pkg.workspaces) return dir;
		} catch {
			// Keep walking.
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not locate repo root from ${start}`);
}

const projectRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function readPackageJson(path: string): { name?: string; optionalDependencies?: Record<string, string> } {
	return JSON.parse(readFileSync(join(projectRoot, path), "utf8"));
}

test("published npm package names use the @opengsd scope", () => {
	const rootPackage = readPackageJson("package.json");
	assert.equal(rootPackage.name, "@opengsd/gsd-pi");

	const platforms = [
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64-gnu",
		"linux-x64-gnu",
		"win32-x64-msvc",
	];

	for (const platform of platforms) {
		const nativePackage = readPackageJson(`native/npm/${platform}/package.json`);
		const expectedName = `@opengsd/engine-${platform}`;
		assert.equal(nativePackage.name, expectedName);
		assert.equal(
			rootPackage.optionalDependencies?.[expectedName],
			">=1.0.0",
			`root package must install the ${expectedName} native optional dependency`,
		);
	}
});
