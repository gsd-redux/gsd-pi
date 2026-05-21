// GSD-2 + Regression tests for #5945: session_start hook wipes markDepthVerified
// in auto-mode, causing discuss-milestone infinite loop.
//
// The bug: session_start unconditionally called resetWriteGateState(), clearing
// the depth-verification mark that the dispatch rule sets via markDepthVerified()
// before spawning the session. After each reset, discuss-milestone re-asked the
// depth question, found no confirmed answer, and looped forever.
//
// The fix: both session_start and session_switch cache isAutoActive() and skip
// resetWriteGateState (and clearDiscussionFlowState for session_switch) when
// auto-mode is active.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  markDepthVerified,
  isMilestoneDepthVerified,
  clearDiscussionFlowState,
} from "../bootstrap/write-gate.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-5945-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setFooter: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    setCompactionThresholdOverride: () => {},
    modelRegistry: {
      setDisabledModelProviders: () => {},
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => false,
    },
  } as any;
}

test("session_start preserves depth-gate state when auto-mode is active (#5945)", async (t) => {
  const dir = makeTempDir("start-auto");
  const originalCwd = process.cwd();
  process.chdir(dir);
  autoSession.reset();

  t.after(() => {
    autoSession.reset();
    clearDiscussionFlowState(dir);
    process.chdir(originalCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  markDepthVerified("M001", dir);
  assert.ok(isMilestoneDepthVerified("M001", dir), "precondition: M001 marked depth-verified before session_start");

  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void> | void>();
  const pi = { on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) { handlers.set(event, handler); } } as any;
  registerHooks(pi, []);

  autoSession.active = true;
  await handlers.get("session_start")!({}, makeCtx(dir));

  assert.ok(
    isMilestoneDepthVerified("M001", dir),
    "session_start must NOT call resetWriteGateState when auto-mode is active — depth mark must survive",
  );
});

test("session_start resets depth-gate state when auto-mode is inactive (non-regression)", async (t) => {
  const dir = makeTempDir("start-inactive");
  const originalCwd = process.cwd();
  process.chdir(dir);
  autoSession.reset();

  t.after(() => {
    autoSession.reset();
    clearDiscussionFlowState(dir);
    process.chdir(originalCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  markDepthVerified("M001", dir);
  assert.ok(isMilestoneDepthVerified("M001", dir), "precondition: M001 marked depth-verified before session_start");

  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void> | void>();
  const pi = { on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) { handlers.set(event, handler); } } as any;
  registerHooks(pi, []);

  autoSession.active = false;
  await handlers.get("session_start")!({}, makeCtx(dir));

  assert.equal(
    isMilestoneDepthVerified("M001", dir),
    false,
    "session_start must call resetWriteGateState when auto-mode is inactive — depth mark must be cleared",
  );
});

test("session_switch preserves depth-gate state when auto-mode is active (#5945)", async (t) => {
  const dir = makeTempDir("switch-auto");
  const originalCwd = process.cwd();
  process.chdir(dir);
  autoSession.reset();

  t.after(() => {
    autoSession.reset();
    clearDiscussionFlowState(dir);
    process.chdir(originalCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  markDepthVerified("M001", dir);
  assert.ok(isMilestoneDepthVerified("M001", dir), "precondition: M001 marked depth-verified before session_switch");

  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void> | void>();
  const pi = { on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) { handlers.set(event, handler); } } as any;
  registerHooks(pi, []);

  autoSession.active = true;
  await handlers.get("session_switch")!({ reason: "resume" }, makeCtx(dir));

  assert.ok(
    isMilestoneDepthVerified("M001", dir),
    "session_switch must NOT call resetWriteGateState or clearDiscussionFlowState when auto-mode is active — depth mark must survive",
  );
});

test("session_switch resets depth-gate state when auto-mode is inactive (non-regression)", async (t) => {
  const dir = makeTempDir("switch-inactive");
  const originalCwd = process.cwd();
  process.chdir(dir);
  autoSession.reset();

  t.after(() => {
    autoSession.reset();
    clearDiscussionFlowState(dir);
    process.chdir(originalCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  markDepthVerified("M001", dir);
  assert.ok(isMilestoneDepthVerified("M001", dir), "precondition: M001 marked depth-verified before session_switch");

  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void> | void>();
  const pi = { on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) { handlers.set(event, handler); } } as any;
  registerHooks(pi, []);

  autoSession.active = false;
  await handlers.get("session_switch")!({ reason: "resume" }, makeCtx(dir));

  assert.equal(
    isMilestoneDepthVerified("M001", dir),
    false,
    "session_switch must call resetWriteGateState when auto-mode is inactive — depth mark must be cleared",
  );
});
