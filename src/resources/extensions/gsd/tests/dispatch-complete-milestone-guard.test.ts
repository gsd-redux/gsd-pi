/**
 * dispatch-complete-milestone-guard.test.ts — #4324
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-complete-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), "# M001\n\n## Slices\n\n- [x] **S01**: Done\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "SUMMARY.md"), "# Summary\n");
  writeFileSync(join(base, "implementation.txt"), "done\n");
  return base;
}

function buildDispatchCtx(basePath: string): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Milestone One",
    state: {
      activeMilestone: { id: "M001", title: "Milestone One" },
      activeSlice: null,
      activeTask: null,
      phase: "completing-milestone",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Milestone One", status: "active" }],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    prefs: undefined,
  };
}

describe("completing-milestone dispatch guard (#4324)", () => {
  let base = "";
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "completing-milestone → complete-milestone");
  assert.ok(rule, "complete-milestone dispatch rule should exist");

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });

  test("skips complete-milestone dispatch when the DB milestone is already closed", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "skip");
  });

  test("dispatches complete-milestone when the DB milestone is still active", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(result?.unitId, "M001");
  });
});
