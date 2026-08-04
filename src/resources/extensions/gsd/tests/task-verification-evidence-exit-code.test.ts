// Project/App: gsd-pi
// File Purpose: Regression tests that getTaskVerificationEvidence never reports an
// unknown (NULL / non-numeric) exit_code as a passing zero (#1591).
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  transaction,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  getTaskVerificationEvidence,
} from "../gsd-db.ts";
import { hasQualifyingTaskEvidence } from "../verification-gate.ts";

const MID = "m1";
const SID = "s1";
const TID = "t1";

/** Insert an evidence row with raw column values the typed API cannot express. */
function insertRawEvidence(values: {
  command: string;
  exitCode: unknown;
  verdict: string;
  durationMs: unknown;
}): void {
  transaction(() =>
    _getAdapter()!.prepare(
      `INSERT INTO verification_evidence
         (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (:task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict, :duration_ms, :created_at)`,
    ).run({
      ":task_id": TID,
      ":slice_id": SID,
      ":milestone_id": MID,
      ":command": values.command,
      ":exit_code": values.exitCode,
      ":verdict": values.verdict,
      ":duration_ms": values.durationMs,
      ":created_at": new Date().toISOString(),
    }),
  );
}

describe("getTaskVerificationEvidence: unknown exit codes", () => {
  beforeEach(() => {
    openDatabase(":memory:");
    if (!isDbAvailable()) return;
    // verification_evidence carries foreign keys onto the engine hierarchy.
    insertMilestone({ id: MID });
    insertSlice({ id: SID, milestoneId: MID });
    insertTask({ id: TID, sliceId: SID, milestoneId: MID });
  });

  afterEach(() => {
    closeDatabase();
  });

  test("a NULL exit_code is reported as non-zero, not as a passing 0", () => {
    if (!isDbAvailable()) return; // no native driver on this host
    insertRawEvidence({ command: "pnpm test", exitCode: null, verdict: "pass", durationMs: null });

    const [evidence] = getTaskVerificationEvidence(MID, SID, TID);

    assert.notEqual(evidence.exitCode, 0);
    assert.equal(evidence.command, "pnpm test");
    // A NULL duration must be omitted rather than coerced to 0.
    assert.equal(evidence.durationMs, undefined);
  });

  test("a non-numeric exit_code is reported as non-zero", () => {
    if (!isDbAvailable()) return;
    insertRawEvidence({ command: "pnpm lint", exitCode: "unknown", verdict: "pass", durationMs: "n/a" });

    const [evidence] = getTaskVerificationEvidence(MID, SID, TID);

    assert.notEqual(evidence.exitCode, 0);
    assert.equal(evidence.durationMs, undefined);
  });

  test("evidence with an unknown exit_code does not qualify as passing", () => {
    if (!isDbAvailable()) return;
    insertRawEvidence({ command: "pnpm test", exitCode: null, verdict: "pass", durationMs: null });

    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), false);
  });

  test("a genuinely passing row still qualifies", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "pnpm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 1200,
    });

    const [evidence] = getTaskVerificationEvidence(MID, SID, TID);

    assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.durationMs, 1200);
    assert.equal(hasQualifyingTaskEvidence(getTaskVerificationEvidence(MID, SID, TID)), true);
  });

  test("one unknown exit_code disqualifies an otherwise passing evidence set", () => {
    if (!isDbAvailable()) return;
    insertVerificationEvidence({
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "pnpm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 10,
    });
    insertRawEvidence({ command: "pnpm lint", exitCode: null, verdict: "pass", durationMs: null });

    const evidence = getTaskVerificationEvidence(MID, SID, TID);

    assert.equal(evidence.length, 2);
    assert.equal(hasQualifyingTaskEvidence(evidence), false);
  });
});
