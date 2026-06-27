import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getLedger,
  initMetrics,
  METRICS_LEDGER_KEEP_UNITS,
  resetMetrics,
  snapshotUnitMetrics,
  type MetricsLedger,
  type UnitMetrics,
} from "../metrics.js";

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-metrics-cap-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function metricsPath(base: string): string {
  return join(base, ".gsd", "metrics.json");
}

function assistantCtx(): any {
  return {
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          id: "entry-0",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            usage: {
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 150,
              cost: 0.01,
            },
          },
        },
      ],
    },
  };
}

function makeUnit(index: number, id = `M001/S01/T${String(index).padStart(4, "0")}`): UnitMetrics {
  const startedAt = 1_700_000_000_000 + index * 1000;
  return {
    type: "execute-task",
    id,
    model: "test-model",
    startedAt,
    finishedAt: startedAt + 500,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.001,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 1,
    apiRequests: 1,
  };
}

function writeLedger(base: string, units: UnitMetrics[]): void {
  const ledger: MetricsLedger = {
    version: 1,
    projectStartedAt: 1_700_000_000_000,
    units,
  };
  writeFileSync(metricsPath(base), JSON.stringify(ledger, null, 2) + "\n", "utf-8");
}

function readLedger(base: string): MetricsLedger {
  return JSON.parse(readFileSync(metricsPath(base), "utf-8")) as MetricsLedger;
}

describe("metrics ledger steady-state cap", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProjectDir();
    resetMetrics();
  });

  afterEach(() => {
    resetMetrics();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("final cap preserves newest units by finishedAt when memory lags peer writes", () => {
    // Scenario: memory loaded units 0..KEEP-1; a peer then advanced disk to
    // units PEER_OFFSET..PEER_OFFSET+KEEP-1, adding PEER_OFFSET newer entries
    // the worker has never seen.  The final keepNewestUnits call must rank by
    // finishedAt, not by insertion order (disk-first), so old memory-only units
    // do not crowd out newer on-disk peer units.
    const KEEP = METRICS_LEDGER_KEEP_UNITS;
    const PEER_OFFSET = 500;

    // Load memory with units 0..KEEP-1.
    const memUnits = Array.from({ length: KEEP }, (_, i) => makeUnit(i));
    writeLedger(projectDir, memUnits);
    initMetrics(projectDir);

    // Peer advances disk to units PEER_OFFSET..PEER_OFFSET+KEEP-1.
    const diskUnits = Array.from({ length: KEEP }, (_, i) => makeUnit(i + PEER_OFFSET));
    writeLedger(projectDir, diskUnits);

    // Trigger saveLedger.
    const unit = snapshotUnitMetrics(
      assistantCtx(),
      "execute-task",
      "M_STALE_MEM/S01/T01",
      makeUnit(PEER_OFFSET + KEEP).startedAt,
      "test-model",
    );
    assert.ok(unit, "snapshot must succeed");

    const disk = readLedger(projectDir);
    assert.equal(disk.units.length, KEEP, "disk must be capped at KEEP units");

    // A disk unit that sits in the range evicted by insertion-order cap
    // (positions 0..PEER_OFFSET-1 of the merged array) but must be kept
    // by finishedAt-ordered cap because it is newer than memory-only units.
    const diskUnitInEvictedRange = makeUnit(PEER_OFFSET + 1); // unit 501, newer than any memory-only unit
    assert.ok(
      disk.units.some((u) => u.id === diskUnitInEvictedRange.id),
      `unit ${diskUnitInEvictedRange.id} (on-disk, newer than memory-only units) must not be displaced by stale memory tail`,
    );

    // The oldest surviving memory-only unit must be evicted.
    const oldestMemOnlyUnit = makeUnit(1); // unit 1, older than all disk units (disk starts at 500)
    assert.equal(
      disk.units.some((u) => u.id === oldestMemOnlyUnit.id),
      false,
      `unit ${oldestMemOnlyUnit.id} (memory-only, older than all disk units) must be pruned`,
    );
  });

  test("pre-merge cap preserves newest on-disk units even when disk order is stale", () => {
    const KEEP = METRICS_LEDGER_KEEP_UNITS;

    // Load memory with older local units.
    const memUnits = Array.from(
      { length: KEEP },
      (_, i) => makeUnit(i, `M_MEM/S01/T${String(i).padStart(4, "0")}`),
    );
    writeLedger(projectDir, memUnits);
    initMetrics(projectDir);

    // Disk has more than KEEP entries, but its newest peer entries are at the
    // head. A tail-slice pre-cap would discard these before the merge.
    const newestPeerUnits = Array.from(
      { length: 10 },
      (_, i) => makeUnit(KEEP + i, `M_PEER/S01/T${String(i).padStart(4, "0")}`),
    );
    const olderPeerUnits = Array.from(
      { length: KEEP },
      (_, i) => makeUnit(i, `M_PEER_OLD/S01/T${String(i).padStart(4, "0")}`),
    );
    writeLedger(projectDir, [...newestPeerUnits, ...olderPeerUnits]);

    const unit = snapshotUnitMetrics(
      assistantCtx(),
      "execute-task",
      "M_STALE_DISK/S01/T01",
      makeUnit(KEEP + newestPeerUnits.length).startedAt,
      "test-model",
    );
    assert.ok(unit, "snapshot must succeed");

    const disk = readLedger(projectDir);
    assert.equal(disk.units.length, KEEP, "disk must be capped at KEEP units");
    assert.ok(
      disk.units.some((u) => u.id === newestPeerUnits[0]!.id),
      "newer on-disk head unit must survive the pre-merge cap",
    );
  });

  test("snapshot saves keep metrics.json and in-memory ledger bounded while preserving peer writes", () => {
    const historicalUnits = Array.from(
      { length: METRICS_LEDGER_KEEP_UNITS + 25 },
      (_, index) => makeUnit(index),
    );
    writeLedger(projectDir, historicalUnits);

    initMetrics(projectDir);

    const peerUnit = makeUnit(historicalUnits.length, "M998/S01/T01");
    writeLedger(projectDir, [...historicalUnits, peerUnit]);

    const newStartedAt = peerUnit.startedAt + 1000;
    const unit = snapshotUnitMetrics(
      assistantCtx(),
      "execute-task",
      "M999/S01/T01",
      newStartedAt,
      "test-model",
    );

    assert.ok(unit, "snapshot should record the new unit");

    const diskLedger = readLedger(projectDir);
    assert.equal(diskLedger.units.length, METRICS_LEDGER_KEEP_UNITS);
    assert.ok(
      diskLedger.units.some((u) => u.id === peerUnit.id),
      "peer unit written after init must survive the save merge",
    );
    assert.ok(
      diskLedger.units.some((u) => u.id === "M999/S01/T01"),
      "new unit must be persisted",
    );
    assert.equal(
      diskLedger.units.some((u) => u.id === historicalUnits[0]!.id),
      false,
      "oldest history must be pruned from disk",
    );

    const memoryLedger = getLedger();
    assert.equal(memoryLedger?.units.length, METRICS_LEDGER_KEEP_UNITS);
    assert.equal(
      memoryLedger?.units.some((u) => u.id === historicalUnits[0]!.id),
      false,
      "oldest history must be pruned from memory so the next save stays bounded",
    );
  });
});
