// gsd-pi — Dispatch-path log coverage.
//
// `resolveDispatch` delegates to the rule registry when one is initialized
// (auto-dispatch.ts:1818-1835). If `getRegistry()` throws — e.g. the registry
// was never initialized or was reset — the catch logs a `dispatch` warning
// ("registry dispatch failed, falling back to inline rules") and falls through
// to the inline DISPATCH_RULES loop. That warning is the operator's only signal
// that dispatch silently degraded from registry-driven to inline; no test
// asserted it. This file pins it.
//
// Strategy: resetRegistry() so getRegistry() throws, then call resolveDispatch
// with a minimal no-DB context. We assert the warning lands and that the
// function still returns a DispatchAction rather than throwing (resilience).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveDispatch, DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import {
  convertDispatchRules,
  getRegistry,
  initRegistry,
  resetRegistry,
} from "../rule-registry.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

/**
 * Build a minimal DispatchContext that passes resolveDispatch's early guards
 * without a database:
 *  - isDbAvailable() is false → the closed-milestone guard is skipped.
 *  - activeMilestone is null → the activeMid/scope mismatch guards are skipped.
 * So execution reaches the registry delegation block.
 */
function makeMinimalCtx(basePath: string): DispatchContext {
  return {
    basePath,
    mid: "",
    midTitle: "Project setup",
    prefs: undefined,
    state: {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "unhandled",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
    } as unknown as DispatchContext["state"],
  };
}

test("resolveDispatch does not replay registry evaluation failures through inline rules", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-registry-error-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
    resetRegistry();
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  initRegistry([{
    name: "throws",
    when: "dispatch",
    evaluation: "first-match",
    where: async () => { throw new Error("registry evaluation failed"); },
    then: (value: unknown) => value,
  }]);

  await assert.rejects(
    resolveDispatch({
      ...makeMinimalCtx(base),
      mid: "M001",
      midTitle: "Milestone",
      state: {
        ...makeMinimalCtx(base).state,
        activeMilestone: { id: "M001", title: "Milestone" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
      },
    }),
    /registry evaluation failed/,
  );
});

test("resolveDispatch logs a dispatch warning and falls back to inline rules when the registry is uninitialized", async () => {
  // Snapshot and clear the singleton so getRegistry() throws inside resolveDispatch.
  let previousExists = false;
  try {
    getRegistry();
    previousExists = true;
  } catch {
    previousExists = false;
  }
  resetRegistry();

  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-logs-"));
  const previousStderr = setStderrLoggingEnabled(false);
  _resetLogs();
  let logs: LogEntry[] = [];
  try {
    // resolveDispatch must NOT throw — it catches the registry failure, logs,
    // and falls through to inline DISPATCH_RULES.
    const action = await resolveDispatch(makeMinimalCtx(base));
    assert.ok(action, "resolveDispatch must still return a DispatchAction after registry failure");
    logs = drainLogs();
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previousStderr);
    rmSync(base, { recursive: true, force: true });
    // Restore a usable registry for any subsequent test in the process.
    initRegistry(convertDispatchRules(DISPATCH_RULES));
    if (!previousExists) resetRegistry();
  }

  const warn = logs.find((e) => e.component === "dispatch" && e.severity === "warn");
  assert.ok(warn, "a dispatch warning must be logged when the registry is unavailable");
  assert.match(
    warn!.message,
    /registry dispatch failed, falling back to inline rules/u,
    "warning must identify the registry fallback reason",
  );
  assert.match(
    warn!.message,
    /not initialized/u,
    "warning must carry the underlying getRegistry() error detail",
  );
});
