import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = resolve(new URL("../../", import.meta.url).pathname);
const { prepareBackup, restoreStaleBackup } = require(
	join(root, "scripts/bootstrap-pi-coding-agent-build.cjs"),
);

async function withFixture(prefix, run) {
	const fixture = await mkdtemp(join(tmpdir(), prefix));
	try {
		await run({
			piCore: join(fixture, "packages/pi-coding-agent/src/core"),
			backupDir: join(fixture, ".cache/pi-shim-backup"),
		});
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}

test("restores stale shim backups before building", async () => {
	await withFixture("pi-shim-restore-test-", async ({ piCore, backupDir }) => {
		await mkdir(piCore, { recursive: true });
		await mkdir(backupDir, { recursive: true });
		const shimPath = join(piCore, "keybindings.ts");
		const backupContent = "export const original = true;\n";
		await writeFile(shimPath, "export const temporary = true;\n");
		await writeFile(join(backupDir, "keybindings.ts"), backupContent);

		assert.equal(
			restoreStaleBackup({ piCore, backupDir, shims: ["keybindings.ts"] }),
			true,
		);
		assert.equal(await readFile(shimPath, "utf8"), backupContent);
		await assert.rejects(access(backupDir), /ENOENT|not found/);
	});
});

test("snapshots restored originals after an interrupted run", async () => {
	await withFixture("pi-shim-prepare-test-", async ({ piCore, backupDir }) => {
		await mkdir(piCore, { recursive: true });
		await mkdir(backupDir, { recursive: true });
		const interruptedShimPath = join(piCore, "keybindings.ts");
		const untouchedShimPath = join(piCore, "fallback-resolver.ts");
		const incompleteBackupPath = join(backupDir, "fallback-resolver.ts.tmp");
		const originalInterruptedShim = "export const original = true;\n";
		const originalUntouchedShim = "export const untouched = true;\n";
		await writeFile(interruptedShimPath, "export const temporary = true;\n");
		await writeFile(untouchedShimPath, originalUntouchedShim);
		await writeFile(join(backupDir, "keybindings.ts"), originalInterruptedShim);
		await writeFile(incompleteBackupPath, "truncated");

		prepareBackup({
			piCore,
			backupDir,
			shims: ["keybindings.ts", "fallback-resolver.ts"],
		});

		assert.equal(
			await readFile(interruptedShimPath, "utf8"),
			originalInterruptedShim,
		);
		assert.equal(
			await readFile(join(backupDir, "keybindings.ts"), "utf8"),
			originalInterruptedShim,
		);
		assert.equal(
			await readFile(join(backupDir, "fallback-resolver.ts"), "utf8"),
			originalUntouchedShim,
		);
		await assert.rejects(access(incompleteBackupPath), /ENOENT|not found/);
	});
});
