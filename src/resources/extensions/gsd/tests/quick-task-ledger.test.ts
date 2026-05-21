// Project/App: GSD-2
// File Purpose: Regression tests for DB-backed quick-task planning history.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase } from "../gsd-db.ts";
import { queryQuickTasks } from "../context-store.ts";
import { importCompletedQuickTasks, quickTaskStatusFromSummary, recordQuickTaskCompletion } from "../quick-task-ledger.ts";

describe("quick-task ledger", () => {
  afterEach(() => closeDatabase());

  test("imports only quick directories with completion summaries", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-quick-ledger-"));
    try {
      mkdirSync(join(base, ".gsd", "quick", "1-add-dark-mode"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "quick", "1-add-dark-mode", "1-SUMMARY.md"),
        "# Quick Task: add dark mode\n\n## What Changed\n- Added dark mode.\n",
        "utf-8",
      );
      mkdirSync(join(base, ".gsd", "quick", "2-half-started"), { recursive: true });

      assert.equal(importCompletedQuickTasks(base), 1);
      const rows = queryQuickTasks();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].description, "add dark mode");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("records already-resolved quick tasks without treating them as failed", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-quick-ledger-"));
    try {
      mkdirSync(join(base, ".gsd"), { recursive: true });
      assert.equal(quickTaskStatusFromSummary("Already resolved — no changes needed."), "already-resolved");
      const recorded = recordQuickTaskCompletion(base, {
        id: "CAP-1",
        origin: "capture",
        description: "fix dark mode toggle",
        status: "already-resolved",
        captureId: "CAP-1",
        fullSummaryMd: "Already resolved — no changes needed.",
      });
      assert.equal(recorded, true);
      assert.equal(queryQuickTasks()[0].status, "already-resolved");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
