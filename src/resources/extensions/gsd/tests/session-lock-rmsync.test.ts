// Regression tests for #1526: rmSync no-op on lock directories must not be silent.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { removeLockDirectory, removeStaleSessionLock } from "../session-lock.ts";
import { gsdRoot } from "../paths.ts";

test("removeLockDirectory removes an empty lock directory", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-lock-rm-"));
  try {
    const lockDir = join(base, ".gsd.lock");
    mkdirSync(lockDir, { recursive: true });
    removeLockDirectory(lockDir);
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("removeLockDirectory removes a lock directory that still has contents", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-lock-rm-"));
  try {
    const lockDir = join(base, ".gsd.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "marker"), "held");
    removeLockDirectory(lockDir);
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("removeLockDirectory falls back to rmdirSync when rmSync no-ops (#1526)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-lock-rm-"));
  try {
    const lockDir = join(base, ".gsd.lock");
    mkdirSync(lockDir, { recursive: true });
    let rmdirCalled = false;
    removeLockDirectory(lockDir, {
      rmSync() {
        /* simulate Windows non-ASCII rmSync no-op */
      },
      rmdirSync(path) {
        rmdirCalled = true;
        rmSync(path, { recursive: true, force: true });
      },
      existsSync,
    });
    assert.equal(rmdirCalled, true, "rmdirSync fallback must run after rmSync no-op");
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("removeLockDirectory throws with the path when the directory still exists (#1526)", () => {
  const lockDir = "/tmp/gsd-lock-still-here.lock";
  assert.throws(
    () => removeLockDirectory(lockDir, {
      rmSync() { /* no-op */ },
      rmdirSync() { /* no-op */ },
      existsSync() { return true; },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /still exists after rmSync\/rmdirSync/);
      assert.match(error.message, new RegExp(lockDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("removeStaleSessionLock removes an orphaned lock directory", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-lock-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    const lockDir = gsdRoot(base) + ".lock";
    mkdirSync(lockDir, { recursive: true });
    assert.equal(removeStaleSessionLock(base), true);
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
