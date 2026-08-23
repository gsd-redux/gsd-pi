// Project/App: gsd-pi
// File Purpose: Tests for workspace git conflict probe, heal, and readiness gate.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { GIT_NO_PROMPT_ENV } from "../git-constants.js";
import { probeGitConflictState } from "../git-conflict-state.js";
import { ensureWorkspaceGitReadyForPath } from "../workspace-git-preflight.js";
import { isWorkspaceGitAllowedCommand } from "../workspace-git-guard.js";
import { cleanup, git, makeTempDir, makeTempRepo } from "./test-utils.ts";

function seedGsdConflict(base: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "STATE.md"), "root\n");
  git(base, "add", ".gsd/STATE.md");
  git(base, "commit", "-m", "add gsd state");
  git(base, "checkout", "-b", "side");
  writeFileSync(join(base, ".gsd", "STATE.md"), "side\n");
  git(base, "add", ".gsd/STATE.md");
  git(base, "commit", "-m", "side state");
  git(base, "checkout", "main");
  writeFileSync(join(base, ".gsd", "STATE.md"), "main\n");
  git(base, "add", ".gsd/STATE.md");
  git(base, "commit", "-m", "main state");
  try {
    git(base, "merge", "side");
  } catch {
    // Expected: merge conflict.
  }
}

function seedProductConflict(base: string): void {
  writeFileSync(join(base, "app.ts"), "root\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "add app");
  git(base, "checkout", "-b", "side");
  writeFileSync(join(base, "app.ts"), "side\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "side app");
  git(base, "checkout", "main");
  writeFileSync(join(base, "app.ts"), "main\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "main app");
  try {
    git(base, "merge", "side");
  } catch {
    // Expected: merge conflict.
  }
}

function installCountingGitShim(binDir: string, logPath: string): void {
  const posixShim = join(binDir, "git");
  writeFileSync(
    posixShim,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$GSD_GIT_LOG"',
      'PATH="$GSD_REAL_PATH"',
      "export PATH",
      'exec git "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(posixShim, 0o755);

  writeFileSync(
    join(binDir, "git.cmd"),
    [
      "@echo off",
      'echo %*>>"%GSD_GIT_LOG%"',
      'set "PATH=%GSD_REAL_PATH%"',
      "git %*",
      "",
    ].join("\r\n"),
  );
}

function countGitShimInvocations(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf-8").split(/\r?\n/).filter(Boolean).length;
}

test("probeGitConflictState reports clean repo", () => {
  const base = makeTempRepo("gsd-ws-git-clean-");
  try {
    const result = probeGitConflictState(base);
    assert.equal(result.status, "clean");
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath caches clean target probes briefly", async () => {
  const base = makeTempRepo("gsd-ws-git-clean-cache-");
  const binDir = makeTempDir("gsd-ws-git-shim-");
  const logPath = join(binDir, "git.log");
  const originalProcessPath = process.env.PATH;
  const originalEnvPath = GIT_NO_PROMPT_ENV.PATH;
  const originalEnvGitLog = GIT_NO_PROMPT_ENV.GSD_GIT_LOG;
  const originalEnvRealPath = GIT_NO_PROMPT_ENV.GSD_REAL_PATH;

  try {
    installCountingGitShim(binDir, logPath);
    const shimmedPath = `${binDir}${delimiter}${originalProcessPath ?? ""}`;
    process.env.PATH = shimmedPath;
    GIT_NO_PROMPT_ENV.PATH = shimmedPath;
    GIT_NO_PROMPT_ENV.GSD_GIT_LOG = logPath;
    GIT_NO_PROMPT_ENV.GSD_REAL_PATH = originalProcessPath ?? "";

    const first = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(first.ok, true);
    const firstCount = countGitShimInvocations(logPath);
    assert.equal(firstCount, 3, "first clean probe should run the existing conflict checks");

    const second = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(second.ok, true);
    assert.equal(
      countGitShimInvocations(logPath),
      firstCount,
      "second clean probe within the cache window must not spawn git again",
    );
  } finally {
    if (originalProcessPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalProcessPath;
    if (originalEnvPath === undefined) delete GIT_NO_PROMPT_ENV.PATH;
    else GIT_NO_PROMPT_ENV.PATH = originalEnvPath;
    if (originalEnvGitLog === undefined) delete GIT_NO_PROMPT_ENV.GSD_GIT_LOG;
    else GIT_NO_PROMPT_ENV.GSD_GIT_LOG = originalEnvGitLog;
    if (originalEnvRealPath === undefined) delete GIT_NO_PROMPT_ENV.GSD_REAL_PATH;
    else GIT_NO_PROMPT_ENV.GSD_REAL_PATH = originalEnvRealPath;
    cleanup(binDir);
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath detects merge state that appears after a clean probe", async () => {
  const base = makeTempRepo("gsd-ws-git-cache-stale-");
  const binDir = makeTempDir("gsd-ws-git-shim2-");
  const logPath = join(binDir, "git2.log");
  const originalProcessPath = process.env.PATH;
  const originalEnvPath = GIT_NO_PROMPT_ENV.PATH;
  const originalEnvGitLog = GIT_NO_PROMPT_ENV.GSD_GIT_LOG;
  const originalEnvRealPath = GIT_NO_PROMPT_ENV.GSD_REAL_PATH;

  try {
    installCountingGitShim(binDir, logPath);
    const shimmedPath = `${binDir}${delimiter}${originalProcessPath ?? ""}`;
    process.env.PATH = shimmedPath;
    GIT_NO_PROMPT_ENV.PATH = shimmedPath;
    GIT_NO_PROMPT_ENV.GSD_GIT_LOG = logPath;
    GIT_NO_PROMPT_ENV.GSD_REAL_PATH = originalProcessPath ?? "";

    // First call — repo is clean, cache is populated.
    const first = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(first.ok, true);
    const afterFirstCount = countGitShimInvocations(logPath);
    assert.ok(afterFirstCount > 0, "first probe must have called git");

    // Introduce MERGE_HEAD to simulate merge state appearing mid-TTL window.
    writeFileSync(join(base, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");

    // Second call — cache should be bypassed because merge state markers are present.
    await ensureWorkspaceGitReadyForPath(base);
    const afterSecondCount = countGitShimInvocations(logPath);
    assert.ok(
      afterSecondCount > afterFirstCount,
      "cache must be invalidated when merge state appears, causing a fresh git probe",
    );
  } finally {
    if (originalProcessPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalProcessPath;
    if (originalEnvPath === undefined) delete GIT_NO_PROMPT_ENV.PATH;
    else GIT_NO_PROMPT_ENV.PATH = originalEnvPath;
    if (originalEnvGitLog === undefined) delete GIT_NO_PROMPT_ENV.GSD_GIT_LOG;
    else GIT_NO_PROMPT_ENV.GSD_GIT_LOG = originalEnvGitLog;
    if (originalEnvRealPath === undefined) delete GIT_NO_PROMPT_ENV.GSD_REAL_PATH;
    else GIT_NO_PROMPT_ENV.GSD_REAL_PATH = originalEnvRealPath;
    cleanup(binDir);
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath detects conflicts after a non-git folder becomes a repo", async () => {
  const base = makeTempDir("gsd-ws-git-non-repo-cache-");
  try {
    const first = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(first.ok, true);

    git(base, "init");
    git(base, "config", "user.email", "test@test.com");
    git(base, "config", "user.name", "Test");
    git(base, "config", "core.autocrlf", "false");
    writeFileSync(join(base, "README.md"), "# init\n");
    git(base, "add", "-A");
    git(base, "commit", "-m", "init");
    git(base, "branch", "-M", "main");
    seedProductConflict(base);

    const second = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.severity, "product-conflicts");
    assert.ok(second.conflictedPaths.includes("app.ts"));
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath allows fresh non-git project setup folders", async () => {
  const base = makeTempDir("gsd-ws-git-non-repo-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });

    const probe = probeGitConflictState(base);
    assert.equal(probe.status, "clean");

    const ready = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(ready.ok, true);
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath auto-resolves .gsd/ conflicts", async () => {
  const base = makeTempRepo("gsd-ws-git-heal-");
  try {
    seedGsdConflict(base);
    const dirty = probeGitConflictState(base);
    assert.equal(dirty.status, "dirty");
    if (dirty.status !== "dirty") return;
    assert.ok(dirty.unmerged.length > 0);

    const ready = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(ready.ok, true);
    assert.ok(ready.fixesApplied.some((fix) => fix.includes("auto-resolved")));

    const after = probeGitConflictState(base);
    assert.equal(after.status, "clean");
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath blocks product file conflicts", async () => {
  const base = makeTempRepo("gsd-ws-git-product-");
  try {
    seedProductConflict(base);
    const ready = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(ready.ok, false);
    if (ready.ok) return;
    assert.equal(ready.severity, "product-conflicts");
    assert.ok(ready.conflictedPaths.includes("app.ts"));
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath does not block on staged files with trailing whitespace", async () => {
  // Regression test for #599: git diff --check exits non-zero for whitespace
  // errors as well as conflict markers. Staged files from auto-generated code
  // often have trailing whitespace; these must not trigger the conflict gate.
  const base = makeTempRepo("gsd-ws-git-whitespace-");
  try {
    writeFileSync(join(base, "app.ts"), "const x = 1;   \n"); // trailing whitespace
    git(base, "add", "app.ts");
    const ready = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(ready.ok, true, "trailing whitespace in staged files must not block");
  } finally {
    cleanup(base);
  }
});

test("isWorkspaceGitAllowedCommand allowlists recovery commands and dispatch complete-milestone", () => {
  assert.equal(isWorkspaceGitAllowedCommand("doctor"), true);
  assert.equal(isWorkspaceGitAllowedCommand("doctor fix"), true);
  assert.equal(isWorkspaceGitAllowedCommand("recover recovery-action-1"), true);
  assert.equal(isWorkspaceGitAllowedCommand("closeout retry"), true);
  assert.equal(isWorkspaceGitAllowedCommand("dispatch complete-milestone M001"), true);
  assert.equal(isWorkspaceGitAllowedCommand("dispatch complete M001"), true);
  assert.equal(isWorkspaceGitAllowedCommand("auto"), false);
  assert.equal(isWorkspaceGitAllowedCommand("status"), false);
  assert.equal(isWorkspaceGitAllowedCommand("dispatch next"), false);
});
