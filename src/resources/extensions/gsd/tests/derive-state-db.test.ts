// Project/App: GSD-2
// File Purpose: Verifies DB-authoritative deriveState behavior after markdown fallback removal.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState, invalidateStateCache } from "../state.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-derive-db-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

describe("derive-state-db", () => {
  test("deriveState refuses markdown derivation even when legacy fallback env var is set", async () => {
    const base = createFixtureBase();
    const prev = process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK;
    try {
      process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "1";
      writeFile(base, "milestones/M001/M001-CONTEXT.md", "# M001: Legacy\n");
      writeFile(base, "milestones/M001/M001-ROADMAP.md", "# M001\n\n## Slices\n\n- [ ] **S01: Slice** `risk:low` `depends:[]`\n");

      closeDatabase();
      assert.equal(isDbAvailable(), false, "DB is unavailable");

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "pre-planning");
      assert.equal(state.activeMilestone, null);
      assert.equal(state.activeSlice, null);
      assert.equal(state.activeTask, null);
      assert.ok(
        state.blockers.some((blocker) => blocker.includes("DB unavailable")),
        "blocker explains unavailable DB",
      );
      assert.match(state.nextAction, /\/gsd migrate/);
    } finally {
      if (prev === undefined) delete process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK;
      else process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = prev;
      cleanup(base);
    }
  });

  test("deriveState treats an empty open DB as authoritative over markdown projections", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-CONTEXT.md", "# M001: Legacy\n");
      writeFile(base, "milestones/M001/M001-ROADMAP.md", "# M001\n\n## Slices\n\n- [ ] **S01: Slice** `risk:low` `depends:[]`\n");

      openDatabase(":memory:");
      assert.equal(isDbAvailable(), true, "DB is available");

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "pre-planning");
      assert.equal(state.activeMilestone, null);
      assert.deepEqual(state.registry, []);
      assert.deepEqual(state.blockers, []);
    } finally {
      cleanup(base);
    }
  });

  test("deriveState reads executable workflow state from DB rows", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "DB Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "DB Slice", status: "active", risk: "low", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "DB Task", status: "pending" });

      invalidateStateCache();
      const state = await deriveState(base);

      assert.equal(state.phase, "executing");
      assert.equal(state.activeMilestone?.id, "M001");
      assert.equal(state.activeSlice?.id, "S01");
      assert.equal(state.activeTask?.id, "T01");
      assert.deepEqual(state.progress?.tasks, { done: 0, total: 1 });
    } finally {
      cleanup(base);
    }
  });
});
