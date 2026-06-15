// Project/App: gsd-pi
// File Purpose: Regression tests for auto-unit closeout activity classification.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  isSuspiciousGhostCompletion,
  snapshotUnitActivity,
} from "../auto-unit-closeout.ts";
import {
  closeUnit,
  type UnitCloseoutRequest,
  type UnitCloseoutDeps,
} from "../unit-closeout.ts";
import type { NotifySeverity } from "../notification-store.js";

function makeCtx(entries: unknown[]) {
  return {
    sessionManager: {
      getEntries: () => entries,
    },
  } as any;
}

function createTempGitRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "closeout-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  return dir;
}

function makeMockDeps(overrides: Partial<UnitCloseoutDeps> = {}): UnitCloseoutDeps & { notifications: Array<{ message: string; severity: NotifySeverity }> } {
  const notifications: Array<{ message: string; severity: NotifySeverity }> = [];
  return {
    isolationMode: () => "none",
    currentBranch: () => "main",
    commit: () => null,
    notify: (message, severity) => notifications.push({ message, severity }),
    notifications,
    ...overrides,
  };
}

function baseRequest(overrides: Partial<UnitCloseoutRequest> = {}): UnitCloseoutRequest {
  return {
    basePath: "/tmp/ignored",
    unitType: "complete-milestone",
    unitId: "M001",
    boundary: "milestone",
    outcome: "complete",
    ...overrides,
  };
}

test("isSuspiciousGhostCompletion rejects fast completions with no assistant output or tools", () => {
  const startedAt = Date.now();
  const ctx = makeCtx([]);

  assert.equal(isSuspiciousGhostCompletion(ctx, startedAt, 500), true);
});

test("isSuspiciousGhostCompletion allows fast completions with assistant output", () => {
  const startedAt = Date.now();
  const ctx = makeCtx([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    },
  ]);

  assert.equal(isSuspiciousGhostCompletion(ctx, startedAt, 500), false);
});

test("snapshotUnitActivity counts assistant messages and tool calls", () => {
  const ctx = makeCtx([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Working." },
          { type: "toolCall", name: "read_file" },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "continue",
      },
    },
  ]);

  assert.deepEqual(snapshotUnitActivity(ctx, 1_000, 1_250), {
    elapsedMs: 250,
    toolCalls: 1,
    assistantMessages: 1,
  });
});

test("closeUnit: nothing-to-commit / isolation none", (t) => {
  const dir = createTempGitRepo(t);
  const deps = makeMockDeps({
    isolationMode: () => "none",
    commit: () => null,
  });

  const result = closeUnit(baseRequest({ basePath: dir, boundary: "milestone" }), deps);

  assert.equal(result.gitVerdict, "nothing-to-commit");
  assert.equal(result.commitMessage, null);
  assert.equal(result.notice, undefined);
  assert.equal(deps.notifications.length, 0);
});

test("closeUnit: committed / isolation none", (t) => {
  const dir = createTempGitRepo(t);
  writeFileSync(join(dir, "file.txt"), "hello");
  execSync("git add file.txt", { cwd: dir });

  const deps = makeMockDeps({
    isolationMode: () => "none",
    commit: () => "Add file.txt",
  });

  const result = closeUnit(baseRequest({ basePath: dir, boundary: "milestone" }), deps);

  assert.equal(result.gitVerdict, "committed");
  assert.equal(result.commitMessage, "Add file.txt");
  assert.equal(result.notice, undefined);
  assert.equal(deps.notifications.length, 0);
});

test("closeUnit: milestone-branch / worktree isolation", (t) => {
  const dir = createTempGitRepo(t);
  const deps = makeMockDeps({
    isolationMode: () => "worktree",
    currentBranch: () => "milestone/M001",
    commit: () => "Complete M001",
  });

  const result = closeUnit(baseRequest({ basePath: dir, boundary: "milestone" }), deps);

  assert.equal(result.gitVerdict, "milestone-branch");
  assert.equal(result.commitMessage, "Complete M001");
  assert.ok(result.notice);
  assert.equal(deps.notifications.length, 1);
  assert.equal(deps.notifications[0].severity, "info");
  assert.match(deps.notifications[0].message, /Merge it to the integration branch/);
});

test("closeUnit: isolation-bypassed / worktree isolation", (t) => {
  const dir = createTempGitRepo(t);
  const deps = makeMockDeps({
    isolationMode: () => "worktree",
    currentBranch: () => "main",
    commit: () => "Complete M001",
  });

  const result = closeUnit(baseRequest({ basePath: dir, boundary: "milestone" }), deps);

  assert.equal(result.gitVerdict, "isolation-bypassed");
  assert.equal(result.commitMessage, "Complete M001");
  assert.ok(result.notice);
  assert.equal(deps.notifications.length, 1);
  assert.equal(deps.notifications[0].severity, "warning");
  assert.match(deps.notifications[0].message, /completed outside a milestone worktree\/branch/);
});

test("closeUnit: isolation-bypassed / branch isolation", (t) => {
  const dir = createTempGitRepo(t);
  const deps = makeMockDeps({
    isolationMode: () => "branch",
    currentBranch: () => "main",
    commit: () => "Complete M001",
  });

  const result = closeUnit(baseRequest({ basePath: dir, boundary: "milestone" }), deps);

  assert.equal(result.gitVerdict, "isolation-bypassed");
  assert.equal(result.commitMessage, "Complete M001");
  assert.ok(result.notice);
  assert.equal(deps.notifications.length, 1);
  assert.equal(deps.notifications[0].severity, "warning");
  assert.match(deps.notifications[0].message, /completed outside a milestone worktree\/branch/);
});

test("closeUnit: commit-failed", (t) => {
  const dir = createTempGitRepo(t);
  const deps = makeMockDeps({
    isolationMode: () => "none",
    commit: () => {
      throw new Error("simulated commit failure");
    },
  });

  const result = closeUnit(baseRequest({ basePath: dir, boundary: "milestone" }), deps);

  assert.equal(result.gitVerdict, "commit-failed");
  assert.equal(result.commitMessage, null);
  assert.ok(result.notice);
  assert.match(result.notice!, /simulated commit failure/);
  assert.equal(deps.notifications.length, 1);
  assert.equal(deps.notifications[0].severity, "error");
});

test("closeUnit: task boundary ignores isolation verdict", (t) => {
  const dir = createTempGitRepo(t);
  const deps = makeMockDeps({
    isolationMode: () => "worktree",
    currentBranch: () => "main",
    commit: () => "Complete task",
  });

  const result = closeUnit(
    baseRequest({ basePath: dir, boundary: "task", unitType: "execute-task", unitId: "M001/S01/T01" }),
    deps,
  );

  assert.equal(result.gitVerdict, "committed");
  assert.equal(result.commitMessage, "Complete task");
  assert.equal(result.notice, undefined);
  assert.equal(deps.notifications.length, 0);
});

