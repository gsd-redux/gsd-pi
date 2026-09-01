import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runReadCli, type ReadCliSchemaPreflight } from "../read-cli.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dirname, "../../integrations/hermes/tests/fixtures/minimal-project");

// Hermetic probe: never opens a DB, so the DB-backed progress path stays
// disengaged and this test pins argument parsing only. Without this, a
// dist-test run resolves gsdRoot by walking up to the repo's own .gsd (the
// hermes fixture is not copied into dist-test) and would depend on the
// developer machine's extension bundle state.
const probelessPreflight: ReadCliSchemaPreflight = {
	resolveProjectRootDbPath: (basePath) => resolve(basePath, ".gsd", "gsd.db"),
	openIsolatedDatabase: () => null,
	supportedSchemaVersion: Number.MAX_SAFE_INTEGER,
	createSchemaTooNewError: (currentVersion, supportedVersion) =>
		new Error(`schema ${currentVersion} > ${supportedVersion}`),
};

test("runReadCli handles global flags before read", async () => {
	const stdout = captureWrite(process.stdout);
	const stderr = captureWrite(process.stderr);
	try {
		const exitCode = await runReadCli(
			[
				"node",
				"gsd",
				"--model",
				"claude-sonnet",
				"read",
				"progress",
				"--json",
				"--project",
				fixture,
			],
			probelessPreflight,
			async () => null,
		);

		assert.equal(exitCode, 0, stderr.output());
		const envelope = JSON.parse(stdout.output());
		assert.equal(envelope.kind, "progress");
		assert.equal(envelope.projectDir, fixture);
	} finally {
		stdout.restore();
		stderr.restore();
	}
});

function captureWrite(stream: NodeJS.WriteStream): { output: () => string; restore: () => void } {
	const chunks: string[] = [];
	const original = stream.write.bind(stream);
	stream.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof stream.write;
	return {
		output: () => chunks.join(""),
		restore: () => {
			stream.write = original;
		},
	};
}
