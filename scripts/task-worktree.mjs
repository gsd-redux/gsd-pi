#!/usr/bin/env node
// Project/App: GSD-2
// File Purpose: Create per-task worktrees and maintain a stable live integration worktree.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_BASE_REMOTE = process.env.GSD_TASK_BASE_REMOTE || "upstream";
const DEFAULT_BASE_BRANCH = process.env.GSD_TASK_BASE_BRANCH || "main";
const DEFAULT_PUSH_REMOTE = process.env.GSD_TASK_PUSH_REMOTE || "origin";
const LIVE_BRANCH = process.env.GSD_LIVE_BRANCH || "local/live-main";
const LIVE_WORKTREE = process.env.GSD_LIVE_WORKTREE || ".worktrees/live-main";
const DEFAULT_VERIFY_COMMANDS = [
  "npm run build",
  "npm run typecheck:extensions",
  "npm run test:unit",
];

function usage(exitCode = 0) {
  const text = `
Usage:
  node scripts/task-worktree.mjs start <slug> [type]
  node scripts/task-worktree.mjs live [branch ...] [--no-verify] [--verify-cmd <cmd> ...]
  node scripts/task-worktree.mjs test-main [branch ...] [--no-verify] [--verify-cmd <cmd> ...]

Commands:
  start      Create .worktrees/<slug> on <type>/<slug>, based on ${DEFAULT_BASE_REMOTE}/${DEFAULT_BASE_BRANCH}.
  live       Create/update ${LIVE_WORKTREE}, merge task branches, and run verification.
  test-main  Alias for live.

Fork workflow:
  Base task branches on ${DEFAULT_BASE_REMOTE}/${DEFAULT_BASE_BRANCH}.
  Push task branches to your fork remote, usually ${DEFAULT_PUSH_REMOTE}.
  Open PRs against gsd-build/gsd-2, not the ${LIVE_BRANCH} branch.

Examples:
  node scripts/task-worktree.mjs start milestone-completion-totals fix
  node scripts/task-worktree.mjs live fix/milestone-completion-totals
  GSD_TASK_PUSH_REMOTE=prfork node scripts/task-worktree.mjs start token-rollup fix
`;
  console.log(text.trim());
  process.exit(exitCode);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    ...options,
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function runShell(command, cwd) {
  const shell = process.env.SHELL || "/bin/sh";
  run(shell, ["-lc", command], { cwd });
}

function assertSlug(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
    console.error("Slug must use letters, numbers, dot, underscore, or hyphen.");
    process.exit(1);
  }
}

function branchExists(branch) {
  return output("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== "";
}

function pathExists(path) {
  return existsSync(resolve(path));
}

function fetchBase() {
  run("git", ["fetch", DEFAULT_BASE_REMOTE, DEFAULT_BASE_BRANCH]);
}

function start(args) {
  const [slug, type = "fix"] = args;
  assertSlug(slug);
  assertSlug(type);

  const branch = `${type}/${slug}`;
  const path = `.worktrees/${slug}`;

  fetchBase();

  if (branchExists(branch)) {
    console.error(`Branch already exists: ${branch}`);
    process.exit(1);
  }
  if (pathExists(path)) {
    console.error(`Worktree path already exists: ${path}`);
    process.exit(1);
  }

  run("git", ["worktree", "add", "-b", branch, path, `${DEFAULT_BASE_REMOTE}/${DEFAULT_BASE_BRANCH}`]);

  console.log("");
  console.log(`Task worktree: ${path}`);
  console.log(`Task branch:   ${branch}`);
  console.log(`Base:          ${DEFAULT_BASE_REMOTE}/${DEFAULT_BASE_BRANCH}`);
  console.log(`Push remote:   ${DEFAULT_PUSH_REMOTE}`);
  console.log("");
  console.log(`Next: cd ${path}`);
}

function parseLiveArgs(args) {
  const branches = [];
  const verifyCommands = [];
  let verify = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-verify") {
      verify = false;
    } else if (arg === "--verify-cmd") {
      const cmd = args[++i];
      if (!cmd) {
        console.error("--verify-cmd requires a command string.");
        process.exit(1);
      }
      verifyCommands.push(cmd);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    } else {
      branches.push(arg);
    }
  }

  return {
    branches,
    verify,
    verifyCommands: verifyCommands.length > 0 ? verifyCommands : DEFAULT_VERIFY_COMMANDS,
  };
}

function assertCleanWorktree(path) {
  const status = output("git", ["status", "--porcelain"], { cwd: path });
  if (status) {
    console.error(`${path} has uncommitted changes. Commit/stash them before refreshing live-main.`);
    process.exit(1);
  }
}

function ensureLiveWorktree() {
  fetchBase();

  if (!pathExists(LIVE_WORKTREE)) {
    if (branchExists(LIVE_BRANCH)) {
      run("git", ["worktree", "add", LIVE_WORKTREE, LIVE_BRANCH]);
    } else {
      run("git", ["worktree", "add", "-b", LIVE_BRANCH, LIVE_WORKTREE, `${DEFAULT_BASE_REMOTE}/${DEFAULT_BASE_BRANCH}`]);
    }
  }

  assertCleanWorktree(LIVE_WORKTREE);
  run("git", ["fetch", DEFAULT_BASE_REMOTE, DEFAULT_BASE_BRANCH], { cwd: LIVE_WORKTREE });
  run("git", ["reset", "--hard", `${DEFAULT_BASE_REMOTE}/${DEFAULT_BASE_BRANCH}`], { cwd: LIVE_WORKTREE });

  return LIVE_WORKTREE;
}

function live(args) {
  const { branches, verify, verifyCommands } = parseLiveArgs(args);
  const path = ensureLiveWorktree();

  for (const branch of branches) {
    if (!branchExists(branch)) {
      console.error(`Task branch does not exist locally: ${branch}`);
      process.exit(1);
    }
    run("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: path });
  }

  if (verify) {
    for (const command of verifyCommands) {
      runShell(command, path);
    }
  }

  console.log("");
  console.log(`Live integration worktree: ${path}`);
  console.log(`Merged task branches:      ${branches.length > 0 ? branches.join(", ") : "(none)"}`);
  console.log(`Live branch:               ${LIVE_BRANCH}`);
  console.log(`Run dev from anywhere:     gsd-dev`);
  console.log(`Run build:                 cd ${path} && npm run build`);
  console.log(`Do not push ${LIVE_BRANCH}.`);
}

const [command, ...args] = process.argv.slice(2);

if (!command || command === "-h" || command === "--help") usage();
if (command === "start") start(args);
else if (command === "live" || command === "test-main") live(args);
else usage(1);
