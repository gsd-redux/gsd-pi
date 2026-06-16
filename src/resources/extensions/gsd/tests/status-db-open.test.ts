/**
 * Regression tests for status/quick behavior.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCoreCommand } from "../commands/handlers/core.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { buildQuickCommitInstruction } from "../quick.ts";
import { invalidateStateCache } from "../state.ts";

function createGsdProjectWithActiveMilestone(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-status-db-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Status Dashboard", status: "active", depends_on: [] });
  closeDatabase();
  return base;
}

async function withProjectCwd<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  closeDatabase();
  invalidateStateCache();
  process.chdir(base);
  try {
    return await fn();
  } finally {
    closeDatabase();
    invalidateStateCache();
    process.chdir(previous);
  }
}

describe("status command routing", () => {
  test("core handler opens the status dashboard and falls back to DB-backed text status", async () => {
    const base = createGsdProjectWithActiveMilestone();
    try {
      const notifications: Array<{ message: string; level: string }> = [];
      const ctx = {
        ui: {
          custom: async () => undefined,
          notify: (message: string, level: string) => {
            notifications.push({ message, level });
          },
        },
      };

      const handled = await withProjectCwd(base, () => handleCoreCommand("status", ctx as any));

      assert.equal(handled, true);
      assert.match(notifications[0]?.message ?? "", /GSD Status/);
      assert.match(notifications[0]?.message ?? "", /Status Dashboard/);
      assert.doesNotMatch(notifications[0]?.message ?? "", /interactive terminal/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("quick task commit instructions handle external .gsd roots without staging quick files", () => {
    const instruction = buildQuickCommitInstruction("/project", "/external/.gsd");

    assert.match(instruction, /do not stage or commit `\.gsd\/quick\/\.\.\.`/);
    assert.match(instruction, /nothing in the project repo to commit/);
  });

  test("quick task commit instructions include normal commit guidance for in-project .gsd roots", () => {
    const instruction = buildQuickCommitInstruction("/project", "/project/.gsd");

    assert.doesNotMatch(instruction, /nothing in the project repo to commit/);
    assert.match(instruction, /Commit your changes atomically/);
  });
});
