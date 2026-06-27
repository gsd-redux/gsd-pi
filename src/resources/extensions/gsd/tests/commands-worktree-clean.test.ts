import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatCleanKeepReason,
  handleWorktree,
  type WorktreeStatus,
} from "../commands-worktree.ts";
import { withCommandCwd } from "../commands/context.ts";
import { createWorktree } from "../worktree-manager.ts";
import {
  disableDebug,
  enableDebug,
  getDebugCounters,
} from "../debug-logger.ts";

function mkStatus(over: Partial<WorktreeStatus>): WorktreeStatus {
  const name = over.name ?? "feat-x";
  return {
    name,
    path: `/repo/.gsd/worktrees/${name}`,
    branch: `gsd/${name}`,
    exists: true,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    uncommitted: false,
    commits: 0,
    ...over,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-worktree-command-"));
  git(base, ["init", "-b", "main"]);
  git(base, ["config", "user.name", "Test User"]);
  git(base, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "chore: init"]);
  return base;
}

function createCommittedWorktree(base: string, name: string): void {
  const wt = createWorktree(base, name);
  writeFileSync(join(wt.path, `${name}.txt`), `${name}\n`, "utf-8");
  git(wt.path, ["add", "."]);
  git(wt.path, ["commit", "-m", `feat: ${name}`]);
}

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
}

test("clean keep reason shows uncommitted-only worktrees clearly", () => {
  const reason = formatCleanKeepReason(mkStatus({ uncommitted: true }));
  assert.equal(reason, "uncommitted changes");
});

test("clean keep reason includes uncommitted context with changed files", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 2, uncommitted: true }));
  assert.equal(reason, "2 changed files, uncommitted");
});

test("clean keep reason flags missing directory with prune hint", () => {
  const reason = formatCleanKeepReason(mkStatus({ exists: false }));
  assert.equal(reason, "directory missing — run 'git worktree prune' to unregister");
});

test("clean keep reason reports changed files without uncommitted suffix", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 2, uncommitted: false }));
  assert.equal(reason, "2 changed files");
});

test("clean keep reason uses singular form for a single changed file", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 1, uncommitted: false }));
  assert.equal(reason, "1 changed file");
});

test("worktree list detects main branch once for the command", async (t) => {
  if (process.env.GSD_ENABLE_NATIVE_GSD_GIT === "1") {
    t.skip("git invocation regression is specific to the CLI fallback path");
    return;
  }

  const base = makeRepo();
  try {
    createCommittedWorktree(base, "feature-a");
    createCommittedWorktree(base, "feature-b");

    const ctx = createMockCtx();
    enableDebug(base);
    try {
      await withCommandCwd(base, async () => {
        await handleWorktree("list", ctx as any);
      });

      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0].message, /Worktrees — 2/);
      assert.equal(getDebugCounters().gitInvocations, 12);
    } finally {
      disableDebug();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
