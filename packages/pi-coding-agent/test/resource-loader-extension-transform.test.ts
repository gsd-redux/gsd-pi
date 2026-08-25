import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

describe("resource loader extension path transform", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("does not let path transforms bypass noExtensions", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-resource-loader-transform-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const transform = vi.fn((paths: string[]) => ({ paths }));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			extensionPathsTransform: transform,
		});

		await loader.reload();

		expect(transform).not.toHaveBeenCalled();
	});
});
