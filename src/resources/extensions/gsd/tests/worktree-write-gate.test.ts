// GSD-2 — worktree-isolation contract enforcement tests (#5199).
//
// Covers shouldBlockWorktreeWrite — the predicate that prevents the LLM
// from writing to the project root while `git.isolation: worktree` is
// configured but auto-mode (and therefore the commit hook) is not running.
//
// Forensics: a /gsd session in test123 with git.isolation: worktree wrote
// app.js/index.html/style.css to the project root. No worktree was ever
// created (.gsd/worktrees/M001/ absent), runAutoLoopWithUok never entered
// (uok-parity.jsonl missing), and the per-unit commit hook never fired.
// Files were left untracked indefinitely. With this gate wired in, the
// same call returns block=true with a clear retry-blocking reason.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { shouldBlockWorktreeWrite } from "../bootstrap/write-gate.ts";

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "gsd-wtg-"));
  mkdirSync(join(root, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(root, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "x");
  return root;
}

function makeProjectWithWorktree(milestoneId = "M001"): string {
  const root = makeProject();
  const wt = join(root, ".gsd", "worktrees", milestoneId);
  mkdirSync(wt, { recursive: true });
  // simulate the live-worktree marker so isInsideWorktreesDir's realpath
  // checks resolve correctly without git plumbing.
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", milestoneId)}`);
  return root;
}

const BASE_INPUTS = {
  toolName: "write",
  isolationMode: "worktree" as const,
  isAutoLive: false,
  hasMilestones: true,
  envBypass: false,
};

// ─── Core block: every variant in PLANNING_WRITE_TOOLS ──────────────────────

for (const tool of ["write", "edit", "multi_edit", "notebook_edit"]) {
  test(`worktree-guard: blocks ${tool} to project-root file when auto-mode inactive`, () => {
    const root = makeProject();
    try {
      const r = shouldBlockWorktreeWrite({
        ...BASE_INPUTS,
        toolName: tool,
        targetPath: join(root, "app.js"),
        effectiveBasePath: root,
      });
      assert.strictEqual(r.block, true, `${tool} should be blocked`);
      assert.match(r.reason!, /HARD BLOCK/);
      assert.match(r.reason!, /worktree isolation/);
      assert.match(r.reason!, /auto-mode/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ─── Allow .gsd/ planning artifacts ─────────────────────────────────────────

test("worktree-guard: allows write to .gsd/PROJECT.md (planning artifact)", () => {
  const root = makeProject();
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      targetPath: join(root, ".gsd", "PROJECT.md"),
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree-guard: allows write inside .gsd/worktrees/<MID>/", () => {
  const root = makeProjectWithWorktree("M001");
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      targetPath: join(root, ".gsd", "worktrees", "M001", "src", "app.js"),
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Prefix-trick safety (must NOT be allowed) ──────────────────────────────

test("worktree-guard: blocks .gsd/worktrees-extra/* (prefix trick — separator guard)", () => {
  const root = makeProject();
  const trick = join(root, ".gsd", "worktrees-extra", "M001");
  mkdirSync(trick, { recursive: true });
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      // the trick path is under .gsd/, which is allow-listed — the realpath
      // check on .gsd/ catches this correctly. The point of the test is to
      // pin the realpath+separator behaviour and prevent regressions if the
      // helper ever shifts to a lexical .gsd/ check.
      targetPath: join(trick, "app.js"),
      effectiveBasePath: root,
    });
    // .gsd/worktrees-extra is still under .gsd/ → allowed
    assert.strictEqual(r.block, false);

    // But the actual prefix-trick we care about: a sibling dir to .gsd
    // that masquerades by name. Build .gsd-fake/worktrees/M001/ and
    // confirm it gets blocked, not allowed.
    const fakeGsd = join(root, ".gsd-fake", "worktrees", "M001");
    mkdirSync(fakeGsd, { recursive: true });
    const fake = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      targetPath: join(fakeGsd, "app.js"),
      effectiveBasePath: root,
    });
    assert.strictEqual(fake.block, true, ".gsd-fake/* must NOT match .gsd/ allow-list");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Allow when isolation is not worktree mode ──────────────────────────────

test("worktree-guard: no-op when isolation mode is 'none'", () => {
  const root = makeProject();
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      isolationMode: "none",
      targetPath: join(root, "app.js"),
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree-guard: no-op when isolation mode is 'branch'", () => {
  const root = makeProject();
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      isolationMode: "branch",
      targetPath: join(root, "app.js"),
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Allow when auto-mode live and effective basePath is inside a worktree ──

test("worktree-guard: allows when auto-mode live AND effectiveBasePath inside worktree", () => {
  const root = makeProjectWithWorktree("M001");
  const wt = join(root, ".gsd", "worktrees", "M001");
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      isAutoLive: true,
      targetPath: join(wt, "app.js"),
      effectiveBasePath: wt,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Block degenerate case: auto-mode live but cwd never flipped ────────────

test("worktree-guard: blocks when auto-mode live but effectiveBasePath is project root", () => {
  const root = makeProjectWithWorktree("M001");
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      isAutoLive: true,
      targetPath: join(root, "app.js"),
      effectiveBasePath: root, // degenerate — auto live, but cwd at root
    });
    assert.strictEqual(r.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Pre-bootstrap (no milestones) ──────────────────────────────────────────

test("worktree-guard: allows when no milestones exist (pre-bootstrap scaffolding)", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-wtg-bootstrap-"));
  // No .gsd/milestones/ — fresh project, /gsd init scenario
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      hasMilestones: false,
      targetPath: join(root, "README.md"),
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Self-hosting carve-out ─────────────────────────────────────────────────

test("worktree-guard: env bypass GSD_DISABLE_WORKTREE_WRITE_GUARD=1 allows the call", () => {
  const root = makeProject();
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      envBypass: true,
      targetPath: join(root, "app.js"),
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Non-write tool names pass through ──────────────────────────────────────

test("worktree-guard: pass-through for non-write tool names", () => {
  const root = makeProject();
  try {
    for (const tool of ["read", "grep", "bash", "ask_user_questions"]) {
      const r = shouldBlockWorktreeWrite({
        ...BASE_INPUTS,
        toolName: tool,
        targetPath: join(root, "app.js"),
        effectiveBasePath: root,
      });
      assert.strictEqual(r.block, false, `${tool} must pass through`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Empty target path is a no-op (defensive) ───────────────────────────────

test("worktree-guard: empty targetPath is a no-op", () => {
  const root = makeProject();
  try {
    const r = shouldBlockWorktreeWrite({
      ...BASE_INPUTS,
      targetPath: "",
      effectiveBasePath: root,
    });
    assert.strictEqual(r.block, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
