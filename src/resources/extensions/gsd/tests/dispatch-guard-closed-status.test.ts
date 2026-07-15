/**
 * dispatch-guard-closed-status.test.ts — #3653
 *
 * Verify that the dispatch guard treats all closed DB slice statuses as done.
 * Reconciled slices may carry statuses like "skipped" or "cancelled" which
 * are also closed — the raw check caused false dispatch blocks.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";

describe("dispatch-guard isClosedStatus migration (#3653)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-closed-"));
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "CONTEXT.md"), "# M001\n");
    openDatabase(join(base, ".gsd", "gsd.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  test("skipped prior DB slices do not block later slice dispatch", () => {
    insertMilestone({ id: "M001", title: "Milestone 1", status: "active", depends_on: [] });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Skipped Slice", status: "skipped", depends: [] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Next Slice", status: "pending", depends: [] });

    assert.equal(
      getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S02/T01"),
      null,
    );
  });

  test("DB-unavailable dispatch fails closed without trusting milestone SUMMARY", () => {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
      "# Milestone Summary\n\nCompleted.\n",
    );
    closeDatabase();

    assert.match(
      getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S02/T01") ?? "",
      /workflow DB is unavailable/,
    );
  });

  test("resolveDispatch fails closed for a concrete milestone when the DB is unavailable", async () => {
    closeDatabase();

    const result = await resolveDispatch({
      basePath: base,
      mid: "M001",
      midTitle: "Milestone 1",
      prefs: undefined,
      state: {
        activeMilestone: { id: "M001", title: "Milestone 1" },
        activeSlice: null,
        activeTask: null,
        phase: "needs-discussion",
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: [{ id: "M001", title: "Milestone 1", status: "active" }],
      },
    });

    assert.equal(result.action, "stop");
    assert.equal(result.level, "error");
    assert.match(result.reason, /workflow DB is unavailable/);
  });

  test("resolveDispatch fails closed for a concrete milestone without active state", async () => {
    closeDatabase();

    const result = await resolveDispatch({
      basePath: base,
      mid: "M001",
      midTitle: "Milestone 1",
      prefs: undefined,
      state: {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: "needs-discussion",
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: [{ id: "M001", title: "Milestone 1", status: "active" }],
      },
    });

    assert.equal(result.action, "stop");
    assert.equal(result.level, "error");
    assert.match(result.reason, /workflow DB is unavailable/);
  });

  test("resolveDispatch preserves setup behavior without a concrete milestone", async () => {
    closeDatabase();

    const result = await resolveDispatch({
      basePath: base,
      mid: "PROJECT",
      midTitle: "Project setup",
      prefs: undefined,
      state: {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: "pre-planning",
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: [],
      },
    });

    assert.doesNotMatch(result.action === "stop" ? result.reason : "", /workflow DB is unavailable/);
  });
});
