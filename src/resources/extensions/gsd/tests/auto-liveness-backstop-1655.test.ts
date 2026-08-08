// Project/App: gsd-pi
// File Purpose: ADR-047 liveness backstop regression harness (#1655) —
// deterministic trip/persistence/resume coverage against a temp DB, no LLM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
} from '../gsd-db.ts';
import {
  LIVENESS_TRIP_THRESHOLD,
  COMPLETED_NO_ADVANCE_GUARD_ID,
  acknowledgeWedge,
  formatWedgeRefusalNotice,
  formatWedgeTripNotice,
  getOpenWedge,
  guardIdFromReason,
  hashBackstopInput,
  recordNonAdvancingOutcome,
  snapshotUnitTargetRows,
  wedgeResumeCommand,
} from '../auto-liveness-backstop.ts';
import { markBlockedStopReason } from '../stop-notice.ts';
import { formatStopNoticePrefix } from '../stop-notice.ts';

const SCOPE = '/tmp/liveness-backstop-project';

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-liveness-backstop-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* Best-effort cleanup only. */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* Best-effort cleanup only. */ }
}

function sig(guardId: string, payload: string, unitId = 'M001/S01/T01') {
  return {
    scopeId: SCOPE,
    guardId,
    unitType: 'execute-task',
    unitId,
    inputPayload: payload,
  };
}

test('ADR-047: trips at 2 occurrences with identical input hash', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  const first = recordNonAdvancingOutcome(sig('drift-guard', 'verdict: fail — drift record X'));
  assert.equal(first.tripped, false);
  assert.equal(first.count, 1);
  assert.equal(getOpenWedge(SCOPE), null, 'no wedge before the threshold');

  const second = recordNonAdvancingOutcome(sig('drift-guard', 'verdict: fail — drift record X'));
  assert.equal(second.tripped, true);
  assert.equal(second.count, LIVENESS_TRIP_THRESHOLD);
  if (!second.tripped) return;
  assert.equal(second.wedge.guardId, 'drift-guard');
  assert.equal(second.wedge.unitType, 'execute-task');
  assert.equal(second.wedge.unitId, 'M001/S01/T01');
  assert.equal(second.wedge.occurrenceCount, 2);
  assert.equal(second.wedge.acknowledgedAt, null);

  const open = getOpenWedge(SCOPE);
  assert.ok(open, 'wedge record persisted');
  assert.equal(open!.wedgeId, second.wedge.wedgeId);
});

test('ADR-047: NO trip when the input hash changes — counter resets to 1', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  assert.equal(recordNonAdvancingOutcome(sig('drift-guard', 'payload A')).tripped, false);
  const changed = recordNonAdvancingOutcome(sig('drift-guard', 'payload B'));
  assert.equal(changed.tripped, false, 'changed inputs mean state advanced — no trip');
  assert.equal(changed.count, 1, 'hash change resets the counter');
  assert.equal(getOpenWedge(SCOPE), null);

  // The new hash then trips on ITS second identical occurrence.
  const retrip = recordNonAdvancingOutcome(sig('drift-guard', 'payload B'));
  assert.equal(retrip.tripped, true);
});

test('ADR-047: A-B-A-B oscillation trips — interleaving-blind counters', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  // A and B are distinct signatures (different targets) alternating —
  // the consecutive-only Rule 1 provably never fired on this shape (#1623).
  const a = () => recordNonAdvancingOutcome(sig('slice-gate', 'gate payload A', 'M001/S01'));
  const b = () => recordNonAdvancingOutcome(sig('task-guard', 'guard payload B', 'M001/S01/T01'));

  assert.equal(a().tripped, false);
  assert.equal(b().tripped, false);
  const secondA = a();
  assert.equal(secondA.tripped, true, 'interleaved B must not reset A\'s counter');
  assert.equal(secondA.count, 2);
});

test('ADR-047: counter survives a process restart (new instance over the same DB)', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  assert.equal(recordNonAdvancingOutcome(sig('resume-guard', 'stale pause pin P')).tripped, false);

  // Simulated restart: close and reopen the DB — the old in-process ring
  // reset to zero here (#1622, #1626 looped for hours); the ledger must not.
  closeDatabase();
  openDatabase(dbPath);

  const afterRestart = recordNonAdvancingOutcome(sig('resume-guard', 'stale pause pin P'));
  assert.equal(afterRestart.tripped, true, 'restart must not reset the per-signature counter');
  assert.equal(afterRestart.count, 2);
});

test('ADR-047: re-entry refusal until acknowledged resume; resume clears the counter', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  const tripped = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  // Unacknowledged wedge blocks re-entry.
  const open = getOpenWedge(SCOPE);
  assert.ok(open, 'entry gates read this record to refuse re-entry');
  assert.match(formatWedgeRefusalNotice(open!), /--resume-wedge/);

  // A restart alone changes nothing: a third identical outcome re-reports the
  // SAME wedge id instead of minting duplicates.
  const third = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(third.tripped, true);
  if (!third.tripped) return;
  assert.equal(third.wedge.wedgeId, tripped.wedge.wedgeId);

  // Unknown id is rejected.
  assert.equal(acknowledgeWedge(SCOPE, 'W-nonsense').ok, false);

  // Explicit acknowledgment clears the wedge AND that signature's counter.
  const ack = acknowledgeWedge(SCOPE, tripped.wedge.wedgeId);
  assert.equal(ack.ok, true);
  assert.equal(getOpenWedge(SCOPE), null, 'acknowledged wedge no longer blocks re-entry');

  const fresh = recordNonAdvancingOutcome(sig('verify-gate', 'failing command exit 1'));
  assert.equal(fresh.tripped, false, 'acknowledged resume cleared the counter');
  assert.equal(fresh.count, 1);
});

test('ADR-047: wedge trip notice names the guard, the wedge id, and the resume command', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  recordNonAdvancingOutcome(sig('tool-scope-guard', 'blocked tool payload'));
  const tripped = recordNonAdvancingOutcome(sig('tool-scope-guard', 'blocked tool payload'));
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) return;

  const notice = formatWedgeTripNotice(tripped.wedge);
  assert.match(notice, /tool-scope-guard/);
  assert.match(notice, new RegExp(tripped.wedge.wedgeId));
  assert.match(notice, /--resume-wedge/);
  assert.equal(wedgeResumeCommand(tripped.wedge), `/gsd auto --resume-wedge ${tripped.wedge.wedgeId}`);

  // Routed through the canonical blocked stop notice, the terminal line keeps
  // the "Auto-mode blocked" prefix the headless host (exit 10) and the
  // acceptance-bed WEDGED classifier both key on.
  const terminal = formatStopNoticePrefix(markBlockedStopReason(notice));
  assert.match(terminal, /^Auto-mode blocked — /);
});

test('ADR-047: completed-no-advance — target-row hash is stable until a target row moves', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));
  insertMilestone({ id: 'M001', title: 'T', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'S', status: 'active', depends: [] });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'task', status: 'pending' });

  const atDispatch = snapshotUnitTargetRows('execute-task', 'M001/S01/T01');
  assert.ok(atDispatch, 'snapshot available when DB rows exist');
  const unchanged = snapshotUnitTargetRows('execute-task', 'M001/S01/T01');
  assert.equal(unchanged, atDispatch, 'zero-work completion leaves the hash identical');

  // Two identical completed-no-advance outcomes trip like any other signature.
  const record = () => recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: atDispatch!,
  });
  assert.equal(record().tripped, false);
  assert.equal(record().tripped, true);

  updateTaskStatus('M001', 'S01', 'T01', 'complete');
  const afterAdvance = snapshotUnitTargetRows('execute-task', 'M001/S01/T01');
  assert.notEqual(afterAdvance, atDispatch, 'a moved target row changes the hash');
});

test('ADR-047 gap-2: occurrence counting is keyed by input hash — differing guard labels cannot split the counter', (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  // Same unit, byte-identical payload, but a display label that embeds
  // variable data (a per-occurrence path). Under a guard-keyed counter these
  // would mint fresh rows forever and never reach the threshold.
  const first = recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: 'blocked-at-tmp-run-0001',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: 'identical guard reading',
  });
  assert.equal(first.tripped, false);
  const second = recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: 'blocked-at-tmp-run-0002',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: 'identical guard reading',
  });
  assert.equal(second.tripped, true, 'identical payloads must trip regardless of guard label');
  assert.equal(second.count, 2);
  if (!second.tripped) return;
  assert.equal(second.wedge.guardId, 'blocked-at-tmp-run-0002', 'guard id is display-only metadata');

  // Acknowledgment clears the hash-keyed counter row.
  assert.equal(acknowledgeWedge(SCOPE, second.wedge.wedgeId).ok, true);
  const fresh = recordNonAdvancingOutcome({
    scopeId: SCOPE,
    guardId: 'blocked-at-tmp-run-0003',
    unitType: 'execute-task',
    unitId: 'M001/S01/T01',
    inputPayload: 'identical guard reading',
  });
  assert.equal(fresh.tripped, false);
  assert.equal(fresh.count, 1);
});

test('guardIdFromReason and hashBackstopInput are deterministic and payload-faithful', () => {
  assert.equal(
    guardIdFromReason('Pre-dispatch health gate: projection drift detected'),
    guardIdFromReason('Pre-dispatch health gate: totally different detail'),
    'guard id comes from the leading clause, not the volatile detail',
  );
  assert.notEqual(
    hashBackstopInput('verdict payload 1'),
    hashBackstopInput('verdict payload 2'),
  );
  assert.equal(hashBackstopInput('same'), hashBackstopInput('same'));
});
