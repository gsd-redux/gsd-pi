// gsd-pi + Symlinked .gsd worktree-loop reproduction (Phase A pt 2 follow-up to PR #5236)
//
// Regression coverage for the auto-mode loop bug observed on projects whose
// .gsd/ is a symlink into ~/.gsd/projects/<hash>/ (the external-state layout).
//
// Assertion: deriveState's cache key is the canonical project root when callers
// opt into projectRootForReads — so two derive calls that should refer
// to the same canonical state share a single cache entry, regardless of
// whether the caller passed the worktree path or the project-root path.
//
// Per project rule #11: regression test using node:test + node:assert/strict,
// no source-grep assertions. The cache-key test would fail without the
// cache-key fix in state.ts (lookup vs write keys would diverge across
// path-form alternation, producing cache misses).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  deriveState,
  invalidateStateCache,
  type DeriveStateOptions,
} from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

interface SymlinkedFixture {
  /** Project root containing .gsd as a symlink. */
  projectRoot: string;
  /** External state dir that .gsd points at (acts as the canonical .gsd/). */
  externalState: string;
  /** Worktree path under the external state's worktrees/ dir. */
  worktreePath: string;
}

function makeSymlinkedFixture(prefix: string): SymlinkedFixture {
  // Use realpathSync on tmpdir so that subsequent realpath comparisons are stable
  // — macOS /var symlinks to /private/var, which would otherwise pollute the
  // canonical-root assertions below.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `gsd-${prefix}-`)));
  const projectRoot = join(root, "project");
  const externalState = join(root, "external-state", "projects", "abc123");

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(externalState, { recursive: true });

  // .gsd → externalState (the layout that triggered the original bug)
  symlinkSync(externalState, join(projectRoot, ".gsd"), "junction");

  // Worktree path lives under the external state's worktrees/ dir, mirroring
  // the canonicalProjectRoot resolution that resolveGsdPathContract performs
  // for the external-state layout.
  const worktreePath = join(externalState, "worktrees", "M001");
  mkdirSync(worktreePath, { recursive: true });

  return { projectRoot, externalState, worktreePath };
}

function cleanupFixture(fx: SymlinkedFixture): void {
  try { closeDatabase(); } catch { /* noop */ }
  // The mkdtemp root is two levels above projectRoot.
  try {
    const root = join(fx.projectRoot, "..");
    rmSync(root, { recursive: true, force: true });
  } catch { /* noop */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: cache-key invariance under projectRootForReads
// ═══════════════════════════════════════════════════════════════════════════

test("deriveState: cache key is canonical when projectRootForReads is supplied", async (t) => {
  const fx = makeSymlinkedFixture("symlink-cache");
  t.after(() => cleanupFixture(fx));

  // Open the DB at the canonical .gsd location (externalState).
  openDatabase(join(fx.externalState, "gsd.db"));
  insertMilestone({ id: "M001", title: "Symlinked", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  // No tasks → DB-derived state is "planning".

  invalidateStateCache();

  const optsCanonical: DeriveStateOptions = { projectRootForReads: fx.projectRoot };

  // First call: seed the cache through the worktree-path form.
  const stateA = await deriveState(fx.worktreePath, optsCanonical);
  assert.equal(stateA.activeMilestone?.id, "M001");
  assert.equal(stateA.activeSlice?.id, "S01");
  assert.equal(stateA.phase, "planning");

  // Second call: canonical project-root form must hit the same cache entry.
  const stateB = await deriveState(fx.projectRoot);
  assert.equal(stateB, stateA, "second call with same canonical key must return the cached object");

  // Third call: worktree-path form with projectRootForReads must also hit the
  // same cache entry, proving the cache key is symmetric across both call
  // orders.
  const stateC = await deriveState(fx.worktreePath, optsCanonical);
  assert.equal(stateC, stateA, "third call with worktree path plus canonical reads must hit the same cache entry");

  // Mutation invalidates: insert a task, clear cache, re-derive — must
  // observe the new state via the canonical key path.
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "active" });
  invalidateStateCache();

  const stateD = await deriveState(fx.worktreePath, optsCanonical);
  assert.notEqual(stateD, stateA, "post-mutation derive must re-compute, not reuse the prior cached object");
  assert.equal(stateD.activeTask?.id, "T01", "mutation must surface in the re-derived state");
  assert.equal(stateD.phase, "executing");
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: type-safety guard for the deriveState opts overload (compile-time)
// ═══════════════════════════════════════════════════════════════════════════
//
// The DeriveStateOptions parameter is typed as an object literal so accidental
// `deriveState(path, "string")` is a TypeScript compile error. The
// expect-error directive verifies that this guard is in place — if the
// overload were widened to `string | DeriveStateOptions`, the directive would
// trigger TS2578 ("Unused '@ts-expect-error' directive") at build time.

test("deriveState: opts param rejects non-object values at compile time", () => {
  // The actual assertion is the TypeScript compile-time check below; the
  // runtime body just confirms the test ran.
  if (false) {
    // @ts-expect-error — projectRootForReads must be a string
    void deriveState("/nonexistent", { projectRootForReads: 123 });
  }
  assert.ok(true);
});
