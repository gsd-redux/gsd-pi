import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  gsdProjectionRoot,
  gsdRoot,
  buildFlatTaskFileName,
  milestonesDir,
  resolveGsdPathContract,
  resolveSliceFile,
  resolveTaskFile,
  resolveTaskFiles,
  taskIdFromTaskFileName,
  _clearGsdRootCache,
} from "../../paths.ts";
/** Create a tmp dir and resolve symlinks + 8.3 short names (macOS /var→/private/var, Windows RUNNER~1→runneradmin). */
function tmp(): string {
  const p = mkdtempSync(join(tmpdir(), "gsd-paths-test-"));
  try { return realpathSync.native(p); } catch { return p; }
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function initGit(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

describe('paths', () => {
  test('flat task artifacts do not duplicate a redundant slice prefix', () => {
    assert.equal(buildFlatTaskFileName('S05', 'S05-T01', 'SUMMARY'), 'S05-T01-SUMMARY.md');
    assert.equal(buildFlatTaskFileName('S05', 'T01', 'SUMMARY'), 'S05-T01-SUMMARY.md');
  });

  test('Case 1: .gsd exists at basePath — fast path', () => {
    const root = tmp();
    try {
      mkdirSync(join(root, ".gsd"));
      _clearGsdRootCache();
      const result = gsdRoot(root);
      assert.deepStrictEqual(result, join(root, ".gsd"), "fast path: returns basePath/.gsd");
    } finally { cleanup(root); }
  });

  test('Case 2: .gsd exists at git root, cwd is a subdirectory', () => {
    const root = tmp();
    try {
      initGit(root);
      mkdirSync(join(root, ".gsd"));
      const sub = join(root, "src", "deep");
      mkdirSync(sub, { recursive: true });
      _clearGsdRootCache();
      const result = gsdRoot(sub);
      assert.deepStrictEqual(result, join(root, ".gsd"), "git-root probe: finds .gsd at git root from subdirectory");
    } finally { cleanup(root); }
  });

  test('Case 3: .gsd in an ancestor — walk-up finds it', () => {
    const root = tmp();
    try {
      initGit(root);
      const project = join(root, "project");
      mkdirSync(join(project, ".gsd"), { recursive: true });
      const deep = join(project, "src", "deep");
      mkdirSync(deep, { recursive: true });
      _clearGsdRootCache();
      const result = gsdRoot(deep);
      assert.deepStrictEqual(result, join(project, ".gsd"), "walk-up: finds .gsd in ancestor when git root has none");
    } finally { cleanup(root); }
  });

  test('Case 4: .gsd nowhere — fallback returns original basePath/.gsd', () => {
    const root = tmp();
    try {
      initGit(root);
      const sub = join(root, "src");
      mkdirSync(sub, { recursive: true });
      _clearGsdRootCache();
      const result = gsdRoot(sub);
      assert.deepStrictEqual(result, join(sub, ".gsd"), "fallback: returns basePath/.gsd when .gsd not found anywhere");
    } finally { cleanup(root); }
  });

  test('Case 5: cache — second call returns same value without re-probing', () => {
    const root = tmp();
    try {
      mkdirSync(join(root, ".gsd"));
      _clearGsdRootCache();
      const first = gsdRoot(root);
      const second = gsdRoot(root);
      assert.deepStrictEqual(first, second, "cache: same result returned on second call");
      assert.ok(first === second, "cache: identity check (same string)");
    } finally { cleanup(root); }
  });

  test('Case 6: .gsd at basePath takes precedence over ancestor .gsd', () => {
    const outer = tmp();
    try {
      initGit(outer);
      mkdirSync(join(outer, ".gsd"));
      const inner = join(outer, "nested");
      mkdirSync(join(inner, ".gsd"), { recursive: true });
      _clearGsdRootCache();
      const result = gsdRoot(inner);
      assert.deepStrictEqual(result, join(inner, ".gsd"), "precedence: nearest .gsd wins over ancestor");
    } finally { cleanup(outer); }
  });

  test('Case 7: milestone artifact readers use worktree projection root', () => {
    const root = tmp();
    try {
      initGit(root);
      const projectGsd = join(root, ".gsd");
      mkdirSync(projectGsd);
      const wtRoot = join(projectGsd, "worktrees", "M001");
      const wtGsd = join(wtRoot, ".gsd");
      const tasksDir = join(wtGsd, "milestones", "M001", "slices", "S01", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(wtRoot, ".git"), `gitdir: ${join(root, ".git")}\n`, "utf-8");
      writeFileSync(join(wtGsd, "milestones", "M001", "slices", "S01", "S01-PLAN.md"), "# slice plan\n");
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "# task plan\n");

      _clearGsdRootCache();

      assert.deepStrictEqual(gsdRoot(wtRoot), projectGsd, "runtime/control root stays project .gsd");
      assert.deepStrictEqual(gsdProjectionRoot(wtRoot), wtGsd, "projection root is worktree .gsd");
      assert.deepStrictEqual(milestonesDir(wtRoot), join(wtGsd, "milestones"));
      assert.deepStrictEqual(
        resolveSliceFile(wtRoot, "M001", "S01", "PLAN"),
        join(wtGsd, "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      );
      assert.deepStrictEqual(
        resolveTaskFile(wtRoot, "M001", "S01", "T01", "PLAN"),
        join(tasksDir, "T01-PLAN.md"),
      );
    } finally { cleanup(root); }
  });

  test('Case 8: external-state worktree milestone readers use projection root', () => {
    const root = tmp();
    const originalStateDir = process.env.GSD_STATE_DIR;
    try {
      const stateDir = join(root, "state");
      process.env.GSD_STATE_DIR = stateDir;
      const projectGsd = join(stateDir, "projects", "abc123");
      const wtRoot = join(projectGsd, "worktrees", "M002");
      const wtGsd = join(wtRoot, ".gsd");
      const tasksDir = join(wtGsd, "milestones", "M002", "slices", "S01", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(wtGsd, "milestones", "M002", "slices", "S01", "S01-PLAN.md"), "# slice plan\n");
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "# task plan\n");

      _clearGsdRootCache();

      assert.deepStrictEqual(gsdRoot(wtRoot), projectGsd, "external-state control root stays project store");
      assert.deepStrictEqual(gsdProjectionRoot(wtRoot), wtGsd, "external-state projection root is worktree .gsd");
      assert.deepStrictEqual(milestonesDir(wtRoot), join(wtGsd, "milestones"));
      assert.deepStrictEqual(
        resolveSliceFile(wtRoot, "M002", "S01", "PLAN"),
        join(wtGsd, "milestones", "M002", "slices", "S01", "S01-PLAN.md"),
      );
      assert.deepStrictEqual(
        resolveTaskFile(wtRoot, "M002", "S01", "T01", "PLAN"),
        join(tasksDir, "T01-PLAN.md"),
      );
    } finally {
      if (originalStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = originalStateDir;
      cleanup(root);
    }
  });

  test('Case 9: flat-phase task SUMMARY resolves at phase root despite a stray slices/SID/ dir', () => {
    const root = tmp();
    try {
      // Hybrid flat-phase milestone: phase dir holds flat task summaries, but a
      // stray slices/S01/ folder also exists on disk. resolveSlicePath then points
      // under slices/, so layout (phases/ vs milestones/) — not slicePath===phaseDir
      // — must decide the flat-phase task summary location.
      const phaseDir = join(root, ".gsd", "phases", "01-foo");
      mkdirSync(join(phaseDir, "slices", "S01"), { recursive: true });
      const flatSummary = join(phaseDir, "S01-T01-SUMMARY.md");
      const legacyFlatSummary = join(phaseDir, "T01-SUMMARY.md");
      writeFileSync(flatSummary, "# task summary\n");
      writeFileSync(legacyFlatSummary, "# legacy task summary\n");

      _clearGsdRootCache();

      assert.deepStrictEqual(resolveTaskFiles(phaseDir, "SUMMARY").sort(), [
        "S01-T01-SUMMARY.md",
        "T01-SUMMARY.md",
      ]);
      assert.equal(taskIdFromTaskFileName("S01-T01-SUMMARY.md", "SUMMARY"), "T01");
      assert.equal(taskIdFromTaskFileName("T01-SUMMARY.md", "SUMMARY"), "T01");

      assert.deepStrictEqual(
        resolveTaskFile(root, "M001", "S01", "T01", "SUMMARY"),
        flatSummary,
        "flat-phase S01-T01-SUMMARY.md at phase root is preferred even when slices/S01/ exists",
      );

      unlinkSync(flatSummary);
      assert.deepStrictEqual(
        resolveTaskFile(root, "M001", "S01", "T01", "SUMMARY"),
        legacyFlatSummary,
        "legacy flat T01-SUMMARY.md is still found as a fallback",
      );
    } finally { cleanup(root); }
  });

  test('Case 10: resolveGsdPathContract canonicalizes a symlinked .gsd root (regression #1239)', () => {
    // WSL / external-state shape: `<projectRoot>/.gsd` is a symlink pointing at a
    // real directory on another volume. Before #1239 the DB path was built from
    // the unresolved symlink, so the workflow SQLite handle opened through a
    // move-prone path and could pick the wrong journal mode / SQLITE_READONLY_DBMOVED.
    const root = tmp();
    try {
      const realState = join(root, "real-state"); // canonical symlink target
      mkdirSync(join(realState, "milestones"), { recursive: true });
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot, { recursive: true });
      symlinkSync(realState, join(projectRoot, ".gsd"), "dir");

      _clearGsdRootCache();
      const contract = resolveGsdPathContract(projectRoot);

      const canonicalGsd = realpathSync.native(join(projectRoot, ".gsd"));
      assert.deepStrictEqual(contract.projectGsd, canonicalGsd,
        "projectGsd is the realpath'd target, not the unresolved .gsd symlink");
      assert.deepStrictEqual(contract.projectDb, join(canonicalGsd, "gsd.db"),
        "projectDb is built from the canonical .gsd root");
      assert.deepStrictEqual(contract.projectGsd, gsdProjectionRoot(projectRoot),
        "projectGsd agrees with gsdProjectionRoot on the canonical root");
      assert.notStrictEqual(contract.projectDb, join(projectRoot, ".gsd", "gsd.db"),
        "regression #1239: DB must not open through the unresolved .gsd symlink");
    } finally { cleanup(root); }
  });

  test('Case 11: resolveGsdPathContract canonicalizes the external-state worktree DB path through a symlinked store (regression #1239)', () => {
    const root = tmp();
    const originalStateDir = process.env.GSD_STATE_DIR;
    try {
      const stateDir = join(root, "state");
      process.env.GSD_STATE_DIR = stateDir;

      // The external-state project store `<state>/projects/<hash>` is itself a
      // symlink to a real directory on another volume (the WSL `.gsd` shape).
      const realProjectGsd = join(root, "real-projects", "abc123");
      mkdirSync(realProjectGsd, { recursive: true });
      mkdirSync(join(stateDir, "projects"), { recursive: true });
      const storeSymlink = join(stateDir, "projects", "abc123");
      symlinkSync(realProjectGsd, storeSymlink, "dir");

      const wtRoot = join(storeSymlink, "worktrees", "M002");
      mkdirSync(join(wtRoot, ".gsd"), { recursive: true });

      _clearGsdRootCache();
      const contract = resolveGsdPathContract(wtRoot);

      const canonicalStore = realpathSync.native(storeSymlink);
      assert.ok(contract.isWorktree, "recognized as an external-state worktree layout");
      assert.deepStrictEqual(contract.projectGsd, canonicalStore,
        "projectGsd is the realpath'd project store, not the unresolved symlink");
      assert.deepStrictEqual(contract.projectDb, join(canonicalStore, "gsd.db"),
        "projectDb is built from the canonical project store");
      assert.notStrictEqual(contract.projectDb, join(storeSymlink, "gsd.db"),
        "regression #1239: DB must not open through the unresolved external-state symlink");
    } finally {
      if (originalStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = originalStateDir;
      cleanup(root);
    }
  });

  test('Case 12: migration staging under a git repo does not resolve to the live .gsd (#1866)', (t) => {
    const root = tmp();
    t.after(() => cleanup(root));
    initGit(root);
    const liveGsd = join(root, ".gsd");
    mkdirSync(liveGsd);
    writeFileSync(join(liveGsd, "PROJECT.md"), "# live\n");
    const stagingRoot = mkdtempSync(join(root, ".gsd-migrate-stage-"));
    _clearGsdRootCache();
    const result = gsdRoot(stagingRoot);
    assert.deepStrictEqual(result, join(stagingRoot, ".gsd"), "staging probe returns stagingRoot/.gsd");
    assert.notDeepStrictEqual(result, liveGsd, "staging probe must not return the live git-root .gsd");
  });
});
