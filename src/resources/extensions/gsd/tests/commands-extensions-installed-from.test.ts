// gsd-pi — Regression test for Issue #2008 npm install source normalization

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { handleExtensions } from "../commands-extensions.ts";

test("npm install stores a reusable source and list renders one npm prefix (#2008)", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gsd-ext-installed-from-"));
	const previousHome = process.env.GSD_HOME;
	const previousPath = process.env.PATH;
	const previousTarball = process.env.GSD_TEST_NPM_TARBALL;
	t.after(() => {
		if (previousHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousHome;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousTarball === undefined) delete process.env.GSD_TEST_NPM_TARBALL;
		else process.env.GSD_TEST_NPM_TARBALL = previousTarball;
		rmSync(root, { recursive: true, force: true });
	});

	const home = join(root, "home");
	const packageRoot = join(root, "fixture", "package");
	const binDir = join(root, "bin");
	const tarball = join(root, "fixture.tgz");
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "@scope/pkg", version: "0.8.0", gsd: { extension: true } }),
	);
	writeFileSync(
		join(packageRoot, "extension-manifest.json"),
		JSON.stringify({ id: "demo-ext", name: "Demo", version: "0.8.0", tier: "community" }),
	);
	execFileSync("tar", ["czf", tarball, "-C", join(root, "fixture"), "package"]);

	const fakeNpm = join(binDir, "npm.cjs");
	writeFileSync(
		fakeNpm,
		[
			'const { copyFileSync } = require("node:fs");',
			'const { join } = require("node:path");',
			'const args = process.argv.slice(2);',
			'const destination = args[args.indexOf("--pack-destination") + 1];',
			'copyFileSync(process.env.GSD_TEST_NPM_TARBALL, join(destination, "package.tgz"));',
		].join("\n"),
	);
	const npmShim = join(binDir, "npm");
	writeFileSync(npmShim, '#!/bin/sh\nexec node "$(dirname "$0")/npm.cjs" "$@"\n');
	chmodSync(npmShim, 0o755);
	writeFileSync(join(binDir, "npm.cmd"), '@node "%~dp0npm.cjs" %*\r\n');

	process.env.GSD_HOME = home;
	process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
	process.env.GSD_TEST_NPM_TARBALL = tarball;

	const notices: string[] = [];
	const ctx = {
		ui: {
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionCommandContext;

	await handleExtensions("install npm:@scope/pkg", ctx);
	await handleExtensions("list", ctx);

	const registry = JSON.parse(readFileSync(join(home, "extensions", "registry.json"), "utf-8"));
	assert.equal(registry.entries["demo-ext"].installedFrom, "@scope/pkg");
	assert.match(notices.at(-1) ?? "", /installed from: npm:@scope\/pkg@0\.8\.0/);
	assert.doesNotMatch(notices.at(-1) ?? "", /npm:npm:/);
});
