// GSD-2 / guided-flow — regression tests for the disk/DB divergence guard
// in checkAutoStartAfterDiscuss.
//
// Background: gsd_plan_milestone can be HARD BLOCKED by the depth-verification
// gate AFTER M###-CONTEXT.md has already been written. Pre-fix,
// checkAutoStartAfterDiscuss only inspected disk artifacts and would fire the
// "Milestone X ready" success notify + startAutoDetached even though the DB
// has no milestone row. The next /gsd then read the empty DB and dropped the
// user into the "No active milestone" wizard with M### orphaned on disk.
//
// The new gate at guided-flow.ts (after the disk-existence Gate 1) requires
// getMilestone(milestoneId) to return a row with status !== "queued" when
// isDbAvailable() is true. gsd_milestone_generate_id seeds a queued row before
// planning, so a queued row alone is also insufficient — only a row that has
// progressed past queued counts as "planning succeeded".

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkAutoStartAfterDiscuss,
  setPendingAutoStart,
  clearPendingAutoStart,
} from "../guided-flow.ts";
import { openDatabase, closeDatabase, insertMilestone } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { drainLogs } from "../workflow-logger.ts";

interface MockCapture {
  notifies: Array<{ msg: string; level: string }>;
}

function mkCapture(): MockCapture {
  return { notifies: [] };
}

function mkCtx(cap: MockCapture): any {
  return {
    ui: {
      notify: (msg: string, level: string) => {
        cap.notifies.push({ msg, level });
      },
      setWidget: () => undefined,
    },
  };
}

function mkPi(): any {
  return {
    sendMessage: () => undefined,
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    on: () => undefined,
  };
}

function mkBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-check-auto-start-db-gate-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function writeContext(base: string, mid: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`),
    `# ${mid} Context\n`,
  );
}

function writeStateMd(base: string): void {
  writeFileSync(join(base, ".gsd", "STATE.md"), "# GSD State\n");
}

describe("checkAutoStartAfterDiscuss — DB-existence gate (orphaned milestone protection)", () => {
  let base: string | undefined;

  beforeEach(() => {
    clearPendingAutoStart();
  });

  afterEach(() => {
    clearPendingAutoStart();
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
      base = undefined;
    }
  });

  test("disk has CONTEXT.md but DB has no milestone row → returns false, no 'ready' notify", () => {
    base = mkBase();
    writeContext(base, "M001");
    writeStateMd(base);
    openDatabase(join(base, ".gsd", "gsd.db"));

    const cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, false, "must NOT greenlight when DB row is missing");
    assert.equal(
      cap.notifies.find((n) => /Milestone M001 ready/.test(n.msg)),
      undefined,
      "ready notify must NOT fire when DB row is missing",
    );
  });

  test("disk has CONTEXT.md and DB row is status='queued' → returns false (gsd_milestone_generate_id seed only)", () => {
    base = mkBase();
    writeContext(base, "M001");
    writeStateMd(base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", status: "queued" });

    const cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, false, "queued-only row is not enough — planning has not run");
    assert.equal(
      cap.notifies.find((n) => /Milestone M001 ready/.test(n.msg)),
      undefined,
      "ready notify must NOT fire for a queued-only row",
    );
  });

  test("disk has CONTEXT.md and DB row is status='active' → DB gate does NOT block (no warning logged)", () => {
    // Positive control: the new gate must be non-blocking when planning has
    // progressed past queued. We assert the gate-specific warning was NOT
    // logged. The function's overall return value depends on later gates and
    // is not asserted here — this test pins the DB gate's contribution only.
    base = mkBase();
    writeContext(base, "M001");
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", status: "active" });

    const cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(),
    });

    drainLogs(); // discard prior test noise
    checkAutoStartAfterDiscuss();
    const logs = drainLogs();
    const dbGateWarning = logs.find(
      (e) => e.component === "guided" && /has disk artifacts but/.test(e.message),
    );
    assert.equal(
      dbGateWarning,
      undefined,
      "DB gate must not log its blocking warning when status is active",
    );
  });

  test("no pending auto-start entry → returns false (unchanged baseline)", () => {
    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, false);
  });
});
