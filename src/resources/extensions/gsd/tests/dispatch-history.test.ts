// gsd-pi — Dispatch History module tests (#482 / #442 deepening)
//
// Covers: canonical key building and legacy-key normalization, window
// record/evict semantics, ledger error attachment, cross-session rehydration
// from unit_dispatches (the #482 regression: a fresh history rehydrated from
// the DB must detect a re-dispatch loop that spans session restarts),
// retry-budget suppression, and clearOnRecovery.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim, markFailed, markCanceled } from "../db/unit-dispatches.ts";
import {
  buildDispatchKey,
  createDispatchHistory,
  lookupLatestLedgerError,
  normalizeDispatchKey,
  parseDispatchKey,
  STUCK_WINDOW_SIZE,
} from "../auto/dispatch-history.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-history-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

interface LedgerFixture {
  base: string;
  worker: string;
  token: number;
  claim(unitType: string, unitId: string): number;
}

function makeLedgerFixture(t: { after(fn: () => void): void }): LedgerFixture {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const worker = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(worker, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("lease claim failed");
  return {
    base,
    worker,
    token: lease.token,
    claim(unitType: string, unitId: string): number {
      const claim = recordDispatchClaim({
        traceId: `${unitType}-${unitId}-${Math.random()}`,
        workerId: worker,
        milestoneLeaseToken: lease.token,
        milestoneId: "M001",
        unitType,
        unitId,
      });
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("claim failed");
      return claim.dispatchId;
    },
  };
}

function historyFor(scopeId: string | null) {
  return createDispatchHistory({ resolveScopeId: () => scopeId });
}

// ─── Key format ──────────────────────────────────────────────────────────────

test("buildDispatchKey produces the canonical unitType:unitId format", () => {
  assert.equal(buildDispatchKey("execute-task", "M001/S01/T01"), "execute-task:M001/S01/T01");
});

test("normalizeDispatchKey converts legacy slash keys and keeps canonical keys", () => {
  assert.equal(normalizeDispatchKey("execute-task/M001/S01/T01"), "execute-task:M001/S01/T01");
  assert.equal(normalizeDispatchKey("execute-task:M001/S01/T01"), "execute-task:M001/S01/T01");
  assert.equal(normalizeDispatchKey("opaque"), "opaque");
});

test("parseDispatchKey splits canonical and legacy keys at the unit type", () => {
  assert.deepEqual(parseDispatchKey("complete-slice:M001/S01"), {
    unitType: "complete-slice",
    unitId: "M001/S01",
  });
  assert.deepEqual(parseDispatchKey("complete-slice/M001/S01"), {
    unitType: "complete-slice",
    unitId: "M001/S01",
  });
  assert.equal(parseDispatchKey("opaque"), null);
});

// ─── Window record/evict ─────────────────────────────────────────────────────

test("recordDispatch caps the window at the window size, evicting oldest-first", () => {
  const history = historyFor(null);
  for (let i = 0; i < STUCK_WINDOW_SIZE + 2; i++) {
    history.recordDispatch("execute-task", `M001/S01/T${i}`);
  }
  const window = history.getRecentWindow();
  assert.equal(window.length, STUCK_WINDOW_SIZE);
  assert.equal(window[0].key, "execute-task:M001/S01/T2");
  assert.equal(window[window.length - 1].key, `execute-task:M001/S01/T${STUCK_WINDOW_SIZE + 1}`);
});

test("countMatching counts entries for the canonical key", () => {
  const history = historyFor(null);
  history.recordDispatch("execute-task", "M001/S01/T01");
  history.recordDispatch("complete-slice", "M001/S01");
  history.recordDispatch("execute-task", "M001/S01/T01");
  assert.equal(history.countMatching("execute-task:M001/S01/T01"), 2);
  assert.equal(history.countMatching("complete-slice:M001/S01"), 1);
});

test("clearOnRecovery empties the window", () => {
  const history = historyFor(null);
  history.recordDispatch("execute-task", "M001/S01/T01");
  history.recordDispatch("execute-task", "M001/S01/T01");
  history.clearOnRecovery();
  assert.equal(history.getRecentWindow().length, 0);
  assert.equal(history.detectStuck(), null);
});

// ─── Ledger error attachment + detect-stuck delegation ──────────────────────

test("recordDispatch attaches the latest ledger error on repeats so repeat-error detection fires", (t) => {
  const f = makeLedgerFixture(t);
  const dispatchId = f.claim("execute-task", "M001/S01/T01");
  markFailed(dispatchId, { errorSummary: "boom: deterministic failure" });

  const history = historyFor(f.base);
  history.recordDispatch("execute-task", "M001/S01/T01");
  history.recordDispatch("execute-task", "M001/S01/T01");
  history.recordDispatch("execute-task", "M001/S01/T01");

  const window = history.getRecentWindow();
  // First dispatch of a unit skips the ledger lookup (zero DB cost on the
  // common path); repeats attach the latest error.
  assert.equal(window[0].error, undefined);
  assert.equal(window[1].error, "boom: deterministic failure");
  assert.equal(window[2].error, "boom: deterministic failure");
  const verdict = history.detectStuck();
  assert.equal(verdict?.stuck, true);
  assert.match(verdict?.reason ?? "", /Same error repeated/);
});

test("lookupLatestLedgerError matches the bare unit id, not the compound key", (t) => {
  const f = makeLedgerFixture(t);
  const dispatchId = f.claim("execute-task", "M001/S01/T01");
  markFailed(dispatchId, { errorSummary: "boom: deterministic failure" });

  // The ledger keys rows by the bare unit id with the unit type in its own
  // column. The shared lookup (also used by dispatch.ts's runDispatch path)
  // must use the bare id; a compound `unitType/unitId` value misses entirely,
  // which previously silently dropped repeat-error detection on that path.
  assert.equal(
    lookupLatestLedgerError("execute-task", "M001/S01/T01"),
    "boom: deterministic failure",
  );
  assert.equal(
    lookupLatestLedgerError("execute-task", "execute-task/M001/S01/T01"),
    undefined,
    "a compound key must not match the bare-id ledger row",
  );
  assert.equal(
    lookupLatestLedgerError("plan-slice", "M001/S01/T01"),
    undefined,
    "a different unit type on the same id must not be attached",
  );
});

test("recordDispatch never attaches another unit type's ledger error for the same unit id", (t) => {
  const f = makeLedgerFixture(t);
  const dispatchId = f.claim("plan-slice", "M001/S01");
  markFailed(dispatchId, { errorSummary: "boom: plan failure" });

  const history = historyFor(f.base);
  history.recordDispatch("execute-task", "M001/S01");
  history.recordDispatch("execute-task", "M001/S01");

  assert.ok(history.getRecentWindow().every((entry) => entry.error === undefined));
  assert.equal(history.detectStuck(), null);
});

test("detectStuck fires on three consecutive same-key dispatches without errors", () => {
  const history = historyFor(null);
  for (let i = 0; i < 3; i++) history.recordDispatch("plan-slice", "M001/S01");
  const verdict = history.detectStuck();
  assert.equal(verdict?.stuck, true);
  assert.match(verdict?.reason ?? "", /plan-slice:M001\/S01 derived 3 consecutive times/);
});

// ─── Retry-budget suppression ────────────────────────────────────────────────

test("a bare-id ledger row for a different unit type does not suppress the stuck verdict", (t) => {
  const f = makeLedgerFixture(t);
  // Retry backoff is open for plan-slice:M001/S01 only (bare-id ledger row).
  const dispatchId = f.claim("plan-slice", "M001/S01");
  markFailed(dispatchId, { errorSummary: "", retryAfterMs: 60_000 });

  const history = historyFor(f.base);
  for (let i = 0; i < 3; i++) history.recordDispatch("execute-task", "M001/S01");
  const verdict = history.detectStuck();
  assert.equal(verdict?.stuck, true, "another unit type's backoff must not suppress this unit");
});

test("consecutive-repeat verdict is suppressed while the retry budget drains", (t) => {
  const f = makeLedgerFixture(t);
  // markCanceled leaves error_summary null so the repeat-error rule (which is
  // never suppressed) cannot fire; the suppression target is rule 2/2b.
  const first = f.claim("plan-slice", "M001/S01");
  markCanceled(first, "retry");
  const second = f.claim("plan-slice", "M001/S01");
  markFailed(second, { errorSummary: "", retryAfterMs: 60_000 });

  const history = historyFor(f.base);
  for (let i = 0; i < 3; i++) history.recordDispatch("plan-slice", "M001/S01");
  assert.equal(history.detectStuck(), null, "stuck verdict must be suppressed inside the retry backoff window");
});

test("exhausted retry budget does not suppress the stuck verdict", (t) => {
  const f = makeLedgerFixture(t);
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const id = f.claim("plan-slice", "M001/S01");
    markCanceled(id, "retry");
    ids.push(id);
  }
  const last = f.claim("plan-slice", "M001/S01");
  // attempt_n defaults to 1 here; bump via a fresh claim is unnecessary —
  // exhaust by omitting next_run_at instead (no scheduled retry → no backoff).
  markFailed(last, { errorSummary: "" });

  const history = historyFor(f.base);
  for (let i = 0; i < 3; i++) history.recordDispatch("plan-slice", "M001/S01");
  const verdict = history.detectStuck();
  assert.equal(verdict?.stuck, true);
});

// ─── Rehydration (#482 regression) ───────────────────────────────────────────

test("rehydrate seeds the window from the ledger with normalized canonical keys", (t) => {
  const f = makeLedgerFixture(t);
  for (let i = 0; i < 2; i++) {
    const id = f.claim("execute-task", "M001/S01/T01");
    markFailed(id, { errorSummary: "" });
  }

  const history = historyFor(f.base);
  const count = history.rehydrate();
  assert.equal(count, 2);
  assert.deepEqual(
    history.getRecentWindow().map((e) => e.key),
    ["execute-task:M001/S01/T01", "execute-task:M001/S01/T01"],
  );
});

test("#482 regression: a re-dispatch loop spanning a session restart is detected as stuck", (t) => {
  const f = makeLedgerFixture(t);
  // Session 1: the same unit was dispatched twice and never made progress.
  for (let i = 0; i < 2; i++) {
    const id = f.claim("execute-task", "M001/S01/T01");
    markFailed(id, { errorSummary: "" });
  }

  // Session 2: a brand-new history (fresh orchestrator) rehydrates from the
  // ledger; the very next decision for the same unit trips the stuck verdict
  // instead of silently re-dispatching forever.
  const restarted = historyFor(f.base);
  restarted.rehydrate();
  restarted.recordDispatch("execute-task", "M001/S01/T01");
  const verdict = restarted.detectStuck();
  assert.equal(verdict?.stuck, true);
  assert.match(verdict?.reason ?? "", /execute-task:M001\/S01\/T01 derived 3 consecutive times/);
});

test("rehydrate mirrors recordDispatch error attachment so repeat-error detection fires after the next dispatch", (t) => {
  const f = makeLedgerFixture(t);
  // Session 1: two failed dispatches for the same unit, same error summary.
  for (let i = 0; i < 2; i++) {
    const id = f.claim("execute-task", "M001/S01/T01");
    markFailed(id, { errorSummary: "boom: deterministic failure" });
  }

  // Session 2: fresh history rehydrates from the ledger. Just like the live
  // recordDispatch path, the first occurrence of a unit skips the ledger
  // lookup; only repeats carry the error. So rehydration alone does not trip
  // Rule 1 — keeping the post-restart window no more aggressive than the live
  // one (Rule 1 has no retry-budget suppression).
  const restarted = historyFor(f.base);
  const count = restarted.rehydrate();
  assert.equal(count, 2);
  const window = restarted.getRecentWindow();
  assert.equal(window[0].error, undefined);
  assert.equal(window[1].error, "boom: deterministic failure");
  assert.equal(restarted.detectStuck(), null);

  // The next dispatch of the same unit attaches the error again, giving two
  // consecutive matching errors → Rule 1 fires, exactly as in the live path.
  restarted.recordDispatch("execute-task", "M001/S01/T01");
  const verdict = restarted.detectStuck();
  assert.equal(verdict?.stuck, true);
  assert.match(verdict?.reason ?? "", /Same error repeated/);
});

test("rehydrate degrades to an empty window without a scope or ledger", () => {
  const noScope = historyFor(null);
  assert.equal(noScope.rehydrate(), 0);
  assert.equal(noScope.getRecentWindow().length, 0);

  const noDb = historyFor("/nonexistent/scope");
  assert.equal(noDb.rehydrate(), 0);
  assert.equal(noDb.getRecentWindow().length, 0);
});
