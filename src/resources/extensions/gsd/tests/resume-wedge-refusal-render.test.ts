// #2219 — a refused `/gsd auto --resume-wedge <id>` acknowledgment must fire
// through the pre-bootstrap ctx.ui.notify channel (the same channel as the
// open-wedge and PID-conflict entry refusals). When the ack runs after
// bootstrap has taken over the session, the slash-command notify surface only
// persists to notifications.jsonl and nothing renders — the command looks like
// a hang. These tests pin the ordering: the refusal is observed BEFORE any
// bootstrap side effect (no worker row, no bootstrap notification).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { startAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  _getAdapter,
} from "../gsd-db.ts";
import {
  COMPLETED_NO_ADVANCE_GUARD_ID,
  getOpenWedge,
  recordNonAdvancingOutcome,
  snapshotUnitTargetRows,
} from "../auto-liveness-backstop.ts";
import { normalizeRealPath } from "../paths.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-resume-wedge-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* best-effort */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Mint an open completed-no-advance wedge for complete-slice M001/S01 whose
 * originating guard still blocks (the target rows never move).
 */
function tripBlockingWedge(base: string): string {
  const snapshot = snapshotUnitTargetRows("complete-slice", "M001/S01");
  assert.ok(snapshot.ok && snapshot.hash, "target-row snapshot requires fixture rows");
  const record = () => recordNonAdvancingOutcome({
    scopeId: normalizeRealPath(base),
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
    unitType: "complete-slice",
    unitId: "M001/S01",
    inputPayload: snapshot.hash!,
  });
  assert.equal(record().tripped, false);
  const tripped = record();
  assert.equal(tripped.tripped, true);
  if (!tripped.tripped) throw new Error("wedge must trip");
  return tripped.wedge.wedgeId;
}

test("refused --resume-wedge acknowledgment notifies before any bootstrap side effect", async (t) => {
  const base = makeTmpBase();
  const priorProjectId = process.env.GSD_PROJECT_ID;
  // Bootstrap tripwire: if bootstrap ever runs, this invalid id makes it emit
  // a distinctive error and bail before any deep work (same pattern as
  // interrupted-session-auto.test.ts).
  process.env.GSD_PROJECT_ID = "invalid project id";
  t.after(() => {
    if (priorProjectId === undefined) delete process.env.GSD_PROJECT_ID;
    else process.env.GSD_PROJECT_ID = priorProjectId;
    autoSession.reset();
    cleanup(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test slice", status: "active", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "task", status: "pending" });

  const wedgeId = tripBlockingWedge(base);
  const scopeId = normalizeRealPath(base);

  const notifications: string[] = [];
  const ctx = {
    ui: {
      notify: (message: string) => notifications.push(message),
    },
    sessionManager: {
      getSessionId: () => "resume-wedge-refusal-test",
    },
    modelRegistry: {
      getAvailable: () => [],
      isProviderRequestReady: () => false,
    },
    model: undefined,
  } as unknown as Parameters<typeof startAuto>[0];
  const pi = {
    getThinkingLevel: () => "off",
  } as unknown as Parameters<typeof startAuto>[1];

  await startAuto(ctx, pi, base, false, { resumeWedgeId: wedgeId });

  // The refusal is rendered through notify — naming the wedge and the guard.
  const refusal = notifications.find((message) =>
    message.includes(`Cannot acknowledge wedge ${wedgeId}`)
    && message.includes("originating guard completed-no-advance still blocks"),
  );
  assert.ok(refusal, `refusal must be notified, got: ${JSON.stringify(notifications)}`);
  assert.match(refusal, /state did not advance for complete-slice M001\/S01/);

  // The refusal fires BEFORE any session bootstrap: the bootstrap tripwire
  // never fires and no worker row is registered.
  assert.equal(
    notifications.some((message) => message.includes("GSD_PROJECT_ID must contain only")),
    false,
    "bootstrap must not run before the wedge acknowledgment refusal",
  );
  const workerRows = _getAdapter()!.prepare("SELECT COUNT(*) AS n FROM workers").get() as { n: number };
  assert.equal(workerRows.n, 0, "no worker may be registered when the ack is refused");

  // A refused acknowledgment leaves the wedge open (ADR-047 §5).
  const open = getOpenWedge(scopeId);
  assert.ok(open.ok && open.wedge, "refused wedge stays open");
  if (open.ok && open.wedge) {
    assert.equal(open.wedge.wedgeId, wedgeId);
    assert.equal(open.wedge.acknowledgedAt, null);
  }
});
