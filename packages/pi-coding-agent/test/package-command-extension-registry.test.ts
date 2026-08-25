import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PackageCommandExtensionRegistry,
	runPackageCommand,
} from "../src/core/package-commands.ts";

function captureStream(chunks: string[]): NodeJS.WriteStream {
	return new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(String(chunk));
			callback();
		},
	}) as unknown as NodeJS.WriteStream;
}

describe("package command extension registry", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists installed extensions when package settings are empty", async () => {
		const stdout: string[] = [];
		const registry: PackageCommandExtensionRegistry = {
			list: () => [{
				id: "demo.extension",
				enabled: true,
				scope: "user",
				version: "1.2.3",
				installedFrom: "@demo/extension",
			}],
			register: vi.fn(),
			unregister: vi.fn(),
		};

		const result = await runPackageCommand({
			appName: "gsd",
			args: ["list"],
			cwd: projectDir,
			agentDir,
			stdout: captureStream(stdout),
			stderr: captureStream([]),
			extensionRegistry: registry,
		});

		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(stdout.join("")).toContain("User extensions:");
		expect(stdout.join("")).toContain("demo.extension@1.2.3");
		expect(stdout.join("")).not.toContain("No packages installed.");
	});

	it("registers resolved extension paths after a successful install", async () => {
		const packageDir = join(tempDir, "extension-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "index.ts"), "export default function extension() {}\n");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ pi: { extensions: ["index.ts"] } }),
		);

		const register = vi.fn();
		const unregister = vi.fn();
		const extensionRegistry = { list: () => [], register, unregister };
		const result = await runPackageCommand({
			appName: "gsd",
			args: ["install", packageDir],
			cwd: projectDir,
			agentDir,
			stdout: captureStream([]),
			stderr: captureStream([]),
			extensionRegistry,
		});

		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(register).toHaveBeenCalledWith({
			source: packageDir,
			scope: "user",
			cwd: projectDir,
			extensions: [{ path: join(packageDir, "index.ts"), packageRoot: packageDir }],
		});

		const removeResult = await runPackageCommand({
			appName: "gsd",
			args: ["remove", packageDir],
			cwd: projectDir,
			agentDir,
			stdout: captureStream([]),
			stderr: captureStream([]),
			extensionRegistry,
		});
		expect(removeResult).toEqual({ handled: true, exitCode: 0 });
		expect(unregister).toHaveBeenCalledWith({
			source: packageDir,
			scope: "user",
			cwd: projectDir,
		});
	});
});
