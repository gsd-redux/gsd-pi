import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { killChildProcess } from "./child-process-guard.ts";

export type RunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

const projectRoot = process.cwd();
const loaderPath = join(projectRoot, "dist", "loader.js");

export function ensureBuiltLoader(): void {
  if (!existsSync(loaderPath)) {
    throw new Error("dist/loader.js not found — run: npm run build");
  }
}

export function runGsd(
  args: string[],
  timeoutMs = 8_000,
  env: NodeJS.ProcessEnv = {},
  cwd: string = projectRoot,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("node", [loaderPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killChildProcess(child, "SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export function spawnGsd(
  args: string[],
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = {},
  cwd: string = projectRoot,
): { child: ReturnType<typeof spawn>; result: Promise<RunResult> } {
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn("node", [loaderPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end();

  const timer = setTimeout(() => {
    timedOut = true;
    killChildProcess(child, "SIGTERM");
  }, timeoutMs);

  const result = new Promise<RunResult>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });

  return { child, result };
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function createTempGitRepo(prefix: string): string {
  const dir = createTempDir(prefix);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "pipe" });
  return dir;
}

export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createTempWithGsd(prefix: string): string {
  const dir = createTempDir(prefix);
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  return dir;
}

export function assertNoCrashMarkers(output: string): void {
  const crashMarkers = [
    "SyntaxError:",
    "ReferenceError:",
    "TypeError: Cannot read",
    "FATAL ERROR",
    "ERR_MODULE_NOT_FOUND",
    "Error: Cannot find module",
    "SIGSEGV",
    "SIGABRT",
  ];

  for (const marker of crashMarkers) {
    assert.ok(
      !output.includes(marker),
      `output should not contain crash marker '${marker}':\n${output.slice(0, 500)}`,
    );
  }
}
