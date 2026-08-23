/**
 * GSD dashboard overlay dialog chrome tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { GSDDashboardOverlay } from "../dashboard-overlay.ts";
import type { UnitMetrics } from "../metrics.ts";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";
import { autoSession, getAutoRuntimeSnapshot } from "../auto-runtime-state.ts";
import {
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
  updateMilestoneStatus,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("GSDDashboardOverlay renders inside the shared full border", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const lines = overlay.render(100);
  assertFullOuterBorder(lines, 100);
  assert.match(lines[0] ?? "", /^╭─ GSD Dashboard /);
  assert.ok(lines.some((line) => line.startsWith("│")), "body rows should have side borders");
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
});

test("GSDDashboardOverlay reuses metrics aggregations until the unit count changes", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const firstUnits = [makeUnit("M001/S001/T001", 0.25)];
  const firstMetrics = (overlay as any).ensureMetricsCache(firstUnits);

  overlay.invalidate();

  const sameCountUnits = [makeUnit("M001/S001/T002", 0.5)];
  const sameCountMetrics = (overlay as any).ensureMetricsCache(sameCountUnits);
  assert.equal(sameCountMetrics, firstMetrics, "same unit count should reuse cached metrics");
  assert.equal(sameCountMetrics.totals.cost, 0.25);

  const increasedCountMetrics = (overlay as any).ensureMetricsCache([
    ...sameCountUnits,
    makeUnit("M001/S001/T003", 0.75),
  ]);
  assert.notEqual(increasedCountMetrics, firstMetrics, "changed unit count should recompute metrics");
  assert.equal(increasedCountMetrics.totals.units, 2);
  assert.equal(increasedCountMetrics.totals.cost, 1.25);
});

test("GSDDashboardOverlay non-identity refresh avoids reparsing preferences", async (t) => {
  const basePath = join(
    tmpdir(),
    `gsd-dashboard-overlay-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = basePath;
  autoSession.autoStartTime = Date.now() - 1000;
  autoSession.setCurrentUnit({
    type: "execute-task",
    id: "M001/S001/T001",
    startedAt: Date.now() - 500,
  });

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => {
    overlay.dispose();
    autoSession.reset();
    rmSync(basePath, { recursive: true, force: true });
  });

  (overlay as any).loadedDashboardIdentity = (overlay as any).computeDashboardIdentity(getAutoRuntimeSnapshot());
  mkdirSync(join(basePath, ".gsd", "PREFERENCES.md"));

  await assert.doesNotReject(
    () => (overlay as any).refreshDashboard(false),
    "unchanged overlay identity should not call getAutoDashboardData or read preferences",
  );
});

test("GSDDashboardOverlay refreshes completed DB lifecycle state when runtime identity is unchanged", async (t) => {
  const basePath = join(
    tmpdir(),
    `gsd-dashboard-overlay-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Lifecycle refresh", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Only slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Only task", status: "pending" });

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = basePath;
  autoSession.autoStartTime = Date.now() - 1000;
  autoSession.setCurrentUnit({
    type: "evaluating-gates",
    id: "M001/S01",
    startedAt: Date.now() - 500,
  });

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => {
    overlay.dispose();
    autoSession.reset();
    invalidateStateCache();
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  await (overlay as any).refreshInFlight;
  const initialView = (overlay as any).milestoneData;
  assert.equal(initialView.phase, "executing");
  assert.deepEqual(initialView.progress.milestones, { done: 0, total: 1 });
  assert.equal(initialView.slices[0].active, true);
  assert.equal(initialView.slices[0].tasks[0].active, true);
  assert.match(overlay.render(140).join("\n"), /Now: evaluating-gates M001\/S01/);

  const runtimeBefore = getAutoRuntimeSnapshot();
  const loadedIdentityBefore = (overlay as any).loadedDashboardIdentity;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.complete",
    idempotencyKey: "dashboard-overlay/milestone-complete",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, () => {
    const completedAt = new Date().toISOString();
    updateTaskStatus("M001", "S01", "T01", "complete", completedAt);
    updateSliceStatus("M001", "S01", "complete", completedAt);
    updateMilestoneStatus("M001", "complete", completedAt);
    return {
      events: [{
        eventType: "milestone.completed",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/dashboard-overlay/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  invalidateStateCache();

  assert.deepEqual(getAutoRuntimeSnapshot(), runtimeBefore, "lifecycle completion must not change runtime identity");
  await (overlay as any).refreshDashboard(false);

  const completedView = (overlay as any).milestoneData;
  assert.notEqual((overlay as any).loadedDashboardIdentity, loadedIdentityBefore);
  assert.equal(completedView.phase, "complete");
  assert.deepEqual(completedView.progress.milestones, { done: 1, total: 1 });
  assert.equal(completedView.slices[0].done, true);
  assert.equal(completedView.slices[0].active, false);
  assert.deepEqual(completedView.slices[0].tasks, []);
  assert.equal((overlay as any).dashData.currentUnit, null);

  await (overlay as any).refreshDashboard(false);
  assert.equal((overlay as any).dashData.currentUnit, null, "volatile refresh must not restore the stale unit");
  const rendered = overlay.render(140).join("\n");
  assert.match(rendered, /Phase: complete/);
  assert.match(rendered, /Milestones.*100%/);
  assert.doesNotMatch(rendered, /evaluating-gates M001\/S01/);
});

test("GSDDashboardOverlay render and scroll do not run environment doctor subprocesses", (t) => {
  const basePath = join(
    tmpdir(),
    `gsd-dashboard-overlay-env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const shimDir = join(
    tmpdir(),
    `gsd-dashboard-overlay-shim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(basePath, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(basePath, "package.json"), JSON.stringify({ engines: { node: ">=22.0.0" } }));

  const posixNodeShim = join(shimDir, "node");
  writeFileSync(posixNodeShim, "#!/bin/sh\nsleep 1\nexit 1\n");
  chmodSync(posixNodeShim, 0o755);
  writeFileSync(join(shimDir, "node.cmd"), "@echo off\r\nping -n 2 127.0.0.1 > nul\r\nexit /b 1\r\n");

  const originalPath = process.env.PATH;
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  overlay.dispose();

  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(basePath, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  (overlay as any).loading = false;
  (overlay as any).milestoneData = null;
  (overlay as any).dashData = {
    ...(overlay as any).dashData,
    basePath,
  };

  process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ""}`;
  const start = performance.now();
  overlay.render(100);
  overlay.handleInput("j");
  overlay.render(100);
  const elapsed = performance.now() - start;

  assert.ok(
    elapsed < 500,
    `rendering and scrolling should not wait for environment subprocesses, took ${Math.round(elapsed)}ms`,
  );
});

function makeUnit(id: string, cost: number): UnitMetrics {
  return {
    type: "execute-task",
    id,
    model: "claude-sonnet-4.5",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 10,
      total: 185,
    },
    cost,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 1,
  };
}
