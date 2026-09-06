// Project/App: gsd-pi
// File Purpose: Regression tests for user-facing milestone lease conflict notices.

import test from "node:test";
import assert from "node:assert/strict";

import { formatLeaseConflictNotice, stableClaimSignature } from "../auto/lease-conflict-notice.ts";

test("lease conflict notice explains the retry action before worker details", () => {
  const message = formatLeaseConflictNotice({
    milestoneId: "M012",
    unitType: "run-uat",
    unitId: "M012/S01",
    reason: "Milestone M012 is held by worker auto-Jeremys-MacBook-Pro-9.local-34036-ee4ef385 until 2026-05-20T18:58:59.275Z.",
    now: new Date("2026-05-20T18:58:14.275Z"),
  });

  const lines = message.split("\n");
  assert.match(lines[0] ?? "", /^Blocked: M012 is already active in another GSD worker\./);
  assert.match(lines[0] ?? "", /Retry with \/gsd auto/);
  assert.match(lines[0] ?? "", /about 45s/);
  assert.equal(lines[1], "Waiting unit: run-uat M012/S01.");
  assert.equal(lines[2], "Details: held by auto-Jeremys-MacBook-Pro-9.local-34036-ee4ef385.");
  assert.doesNotMatch(lines[0] ?? "", /auto-Jeremys/);
});

test("lease conflict notice keeps unknown reasons as details", () => {
  const message = formatLeaseConflictNotice({
    milestoneId: "M012",
    unitType: "run-uat",
    unitId: "M012/S01",
    reason: "stale_lease",
  });

  assert.match(message, /^Blocked: M012 is already active in another GSD worker\./);
  assert.match(message, /Try \/gsd status/);
  assert.match(message, /Details: stale_lease/);
});

test("stableClaimSignature strips the volatile lease expiresAt so identical rejections hash the same (Copilot #2098)", () => {
  // Two "lease still held" rejections that differ ONLY in the expiresAt
  // timestamp (advanced by a holder heartbeat) must normalize to the same
  // signature, otherwise the ADR-047 wedge never trips at occurrence 2.
  const a = "Milestone M012 is held by worker auto-host-34036-ee4ef385 until 2026-05-20T18:58:59.275Z.";
  const b = "Milestone M012 is held by worker auto-host-34036-ee4ef385 until 2026-05-20T18:59:44.900Z.";
  const sigA = stableClaimSignature(a);
  const sigB = stableClaimSignature(b);
  assert.equal(sigA, sigB);
  assert.equal(sigA, "Milestone M012 is held by worker auto-host-34036-ee4ef385");
  assert.doesNotMatch(sigA, /until|\d{4}-\d{2}-\d{2}T/);
});

test("stableClaimSignature passes non-lease reasons through unchanged", () => {
  assert.equal(stableClaimSignature("missing-worker"), "missing-worker");
  assert.equal(
    stableClaimSignature("dispatch claim skipped: stale-lease"),
    "dispatch claim skipped: stale-lease",
  );
});
