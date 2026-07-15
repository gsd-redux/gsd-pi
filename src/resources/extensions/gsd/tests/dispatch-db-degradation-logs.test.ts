// gsd-pi — Dispatch DB-degradation log coverage.
//
// `hasMilestonePassedDiscuss` (auto-dispatch.ts:397) queries the slices table to
// decide whether a milestone has progressed past discuss. When the DB is
// available but the query throws (corrupt schema, dropped table, locked DB),
// the catch (auto-dispatch.ts:407) logs a `dispatch` warning and falls back to
// the filesystem. That warning is the operator's only signal that dispatch
// silently degraded to filesystem heuristics; no test asserted it. This file
// triggers it by opening a DB, seeding a milestone, then dropping the slices
// table so getMilestoneSlices() throws inside the rule's DB branch.
//
// Companion to dispatch-logs.test.ts (registry fallback :1834).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveDispatch, DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";
import { convertDispatchRules, initRegistry, getRegistry, resetRegistry } from "../rule-registry.ts";

function makeExecutingState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Degraded" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  } as GSDState;
}

test("resolveDispatch fails closed when the DB slices query throws", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-db-degrade-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  // Snapshot + (re)initialize the registry so resolveDispatch uses the inline
  // rule set, then restore the prior state afterwards.
  let previousExists = false;
  try { getRegistry(); previousExists = true; } catch { previousExists = false; }
  initRegistry(convertDispatchRules(DISPATCH_RULES));

  const previousStderr = setStderrLoggingEnabled(false);
  let logs: LogEntry[] = [];
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Degraded", status: "active" });
    // Break the slices table so getMilestoneSlices("M001") throws inside the
    // DB branch of hasMilestonePassedDispatch → :407 warning.
    _getAdapter()!.exec("DROP TABLE slices");

    const ctx: DispatchContext = {
      basePath: base,
      mid: "M001",
      midTitle: "Degraded",
      state: makeExecutingState(),
      prefs: undefined,
    };

    await assert.rejects(resolveDispatch(ctx), /no such table: slices/i);
    logs = drainLogs();
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previousStderr);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
    // Restore registry state for subsequent tests.
    initRegistry(convertDispatchRules(DISPATCH_RULES));
    if (!previousExists) resetRegistry();
    void t;
  }

  assert.equal(
    logs.some((entry) => /falling back to filesystem/u.test(entry.message)),
    false,
    "DB query failure must not authorize a filesystem routing fallback",
  );
});
