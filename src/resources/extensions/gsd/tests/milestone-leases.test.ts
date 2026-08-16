// gsd-pi + Milestone leases tests (Phase B coordination — fencing semantics)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  _getAdapter,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import {
  claimMilestoneLease,
  releaseMilestoneLease,
  refreshMilestoneLease,
  getMilestoneLease,
  forceReleaseLeasesForWorker,
} from "../db/milestone-leases.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-leases-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("first claim returns ok=true with token=1", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const claim = claimMilestoneLease(w1, "M001");
  assert.equal(claim.ok, true);
  if (claim.ok) {
    assert.equal(claim.token, 1, "fresh claim starts fencing token at 1");
  }

  const row = getMilestoneLease("M001");
  assert.ok(row);
  assert.equal(row!.worker_id, w1);
  assert.equal(row!.fencing_token, 1);
  assert.equal(row!.status, "held");
});

test("second claim by a different process is rejected while lease is held", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: join(base, "other-project") });
  _getAdapter()!.prepare("UPDATE workers SET pid = :pid WHERE worker_id = :worker_id")
    .run({ ":pid": process.pid + 1, ":worker_id": w2 });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  const second = claimMilestoneLease(w2, "M001");
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error, "held_by");
    assert.equal(second.byWorker, w1);
  }
});

test("claim by another worker row from the same live process is re-entrant across worktrees", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: join(base, ".gsd-worktrees", "M001") });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  const second = claimMilestoneLease(w2, "M001");
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.token, 2, "same-process re-entry increments the fencing token");
  }

  const row = getMilestoneLease("M001");
  assert.ok(row);
  assert.equal(row!.worker_id, w2);
  assert.equal(row!.fencing_token, 2);
  assert.equal(row!.status, "held");
});

test("releaseMilestoneLease frees the lease for takeover", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  if (first.ok) {
    const released = releaseMilestoneLease(w1, "M001", first.token);
    assert.equal(released, true);
  }

  // After release, w2 may take over with monotonically larger token
  const second = claimMilestoneLease(w2, "M001");
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.token, 2, "takeover increments fencing token monotonically");
  }
});

test("expired lease (TTL passed) allows takeover with token+1", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const w2 = registerAutoWorker({ projectRootRealpath: base });
  const first = claimMilestoneLease(w1, "M001");
  assert.equal(first.ok, true);

  // Force expiration by patching the row's expires_at into the past.
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE milestone_leases SET expires_at = '1970-01-01T00:00:00.000Z' WHERE milestone_id = 'M001'`,
  ).run();

  const takeover = claimMilestoneLease(w2, "M001");
  assert.equal(takeover.ok, true);
  if (takeover.ok) {
    assert.equal(takeover.token, 2);
  }
  const row = getMilestoneLease("M001");
  assert.equal(row!.worker_id, w2);
  assert.equal(row!.fencing_token, 2);
});

test("refreshMilestoneLease only succeeds with the matching fencing token", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const w1 = registerAutoWorker({ projectRootRealpath: base });
  const claim = claimMilestoneLease(w1, "M001");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  // Correct token refreshes
  assert.equal(refreshMilestoneLease(w1, "M001", claim.token), true);

  // Stale token (e.g. claim.token - 1) refuses
  assert.equal(refreshMilestoneLease(w1, "M001", claim.token - 1), false);
});

test("forceReleaseLeasesForWorker frees only the dead worker's leases, not a live peer's", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "One", status: "active" });
  insertMilestone({ id: "M002", title: "Two", status: "active" });

  // Distinct project roots → distinct processes (not re-entrant peers).
  const wA = registerAutoWorker({ projectRootRealpath: base });
  const wB = registerAutoWorker({ projectRootRealpath: join(base, "peer") });
  assert.equal(claimMilestoneLease(wA, "M001").ok, true);
  assert.equal(claimMilestoneLease(wB, "M002").ok, true);

  const freed = forceReleaseLeasesForWorker(wA);
  assert.equal(freed, 1, "exactly A's one held lease is released");

  assert.equal(getMilestoneLease("M001")!.status, "released", "A's M001 lease is released");
  const m2 = getMilestoneLease("M002")!;
  assert.equal(m2.status, "held", "B's M002 lease must stay held (no over-release)");
  assert.equal(m2.worker_id, wB);
});

test("after force release a fresh claim on the freed milestone gets a larger fencing token", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "One", status: "active" });

  const wA = registerAutoWorker({ projectRootRealpath: base });
  const wB = registerAutoWorker({ projectRootRealpath: join(base, "peer") });
  const first = claimMilestoneLease(wA, "M001");
  assert.equal(first.ok, true);
  const releasedToken = first.ok ? first.token : 0;

  assert.equal(forceReleaseLeasesForWorker(wA), 1);

  const takeover = claimMilestoneLease(wB, "M001");
  assert.equal(takeover.ok, true);
  if (takeover.ok) {
    assert.ok(takeover.token > releasedToken, "takeover token must exceed the released lease's token");
  }
  assert.equal(getMilestoneLease("M001")!.worker_id, wB);
});

test("forceReleaseLeasesForWorker returns 0 for a worker holding no leases", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "One", status: "active" });

  const wA = registerAutoWorker({ projectRootRealpath: base });
  assert.equal(forceReleaseLeasesForWorker(wA), 0);
});

test("claimMilestoneLease rethrows foreign-key failures instead of treating them as lease contention", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  assert.throws(
    () => claimMilestoneLease("missing-worker", "M001"),
    /FOREIGN KEY constraint failed/,
  );
});
