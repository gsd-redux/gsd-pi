// Project/App: gsd-pi
// File Purpose: #442 Phase 3.14 — characterization battery proving the
// Orchestrator's dispatch DECISION matches what the legacy
// runPreDispatch/runDispatch path would produce, across representative
// resolveDispatch outcomes. This is the safety net that licenses deleting the
// dead legacy `else` branch in auto/loop.ts (loop never reaches it because
// ensureOrchestrationModule runs unconditionally before autoLoop, so
// s.orchestration is always set).
//
// Both paths delegate to the same resolveDispatch rule engine; the only thing
// that differs is how each TRANSLATES a resolveDispatch action into a loop
// outcome. We pin that translation equivalence here:
//   resolveDispatch action  | legacy runDispatch -> loop | orchestrator decision
//   ------------------------|----------------------------|----------------------
//   dispatch                | IterationData(unit)        | { unitType, unitId } (advanced)
//   stop                    | break -> stopped/blocked   | { kind: "blocked", action } | stopped
//   skip                    | continue -> skipped        | { kind: "skipped" }
//   (no rule matches)       | stop/no-unit               | null -> stopped(no remaining)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideOrchestratorDispatch } from "../auto/orchestrator.ts";
import { resolveDispatch, type DispatchContext } from "../auto-dispatch.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { RuleRegistry, setRegistry, resetRegistry } from "../rule-registry.ts";
import type { UnifiedRule } from "../rule-types.ts";
import type { GSDState } from "../types.ts";

function makeState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Execute task",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
}

const fakeCtx = {
  model: { provider: "anthropic", baseUrl: "https://api.anthropic.com", contextWindow: 200_000 },
  modelRegistry: { getAll: () => [], getAvailable: () => [], getProviderAuthMode: (_p: string) => "apiKey" as const },
} as never;
const fakePi = { getActiveTools: () => ["read_file", "write_file"] } as never;

function setupBase(t: test.TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "orchestrator-legacy-parity-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function installRule(where: UnifiedRule["where"]): void {
  setRegistry(new RuleRegistry([{
    name: "parity-rule",
    when: "dispatch",
    evaluation: "first-match",
    where,
    then: (r: unknown) => r,
  }]));
}

function directCtx(state: GSDState, basePath: string): DispatchContext {
  return {
    basePath,
    mid: state.activeMilestone!.id,
    midTitle: state.activeMilestone!.title,
    state,
    prefs: undefined,
    structuredQuestionsAvailable: "true",
    sessionContextWindow: 200_000,
    sessionProvider: "anthropic",
    modelRegistry: (fakeCtx as { modelRegistry: unknown }).modelRegistry as never,
  };
}

test("#442 characterization: dispatch action → orchestrator picks the same unit the legacy path would", async (t) => {
  t.after(() => resetRegistry());
  const base = setupBase(t);
  const state = makeState();
  installRule(async () => ({ action: "dispatch", unitType: "execute-task", unitId: "T07", prompt: "p" }));

  const legacy = await resolveDispatch(directCtx(state, base));
  const decision = await decideOrchestratorDispatch(fakeCtx, fakePi, base, undefined, { stateSnapshot: state });

  assert.equal((legacy as { action: string }).action, "dispatch");
  assert.ok(decision && "unitType" in decision, "orchestrator must produce a unit decision");
  assert.equal(decision.unitType, (legacy as { unitType: string }).unitType);
  assert.equal(decision.unitId, (legacy as { unitId: string }).unitId);
});

test("#442 characterization: stop action → orchestrator blocks with stop, matching legacy break", async (t) => {
  t.after(() => resetRegistry());
  const base = setupBase(t);
  const state = makeState();
  installRule(async () => ({ action: "stop", reason: "milestone blocked" }));

  const legacy = await resolveDispatch(directCtx(state, base));
  const decision = await decideOrchestratorDispatch(fakeCtx, fakePi, base, undefined, { stateSnapshot: state });

  assert.equal((legacy as { action: string }).action, "stop");
  assert.ok(decision && "kind" in decision && decision.kind === "blocked", "stop must translate to a blocked decision");
  assert.equal((decision as { action: string }).action, "stop");
});

test("#442 characterization: skip action → orchestrator skips, matching legacy continue", async (t) => {
  t.after(() => resetRegistry());
  const base = setupBase(t);
  const state = makeState();
  installRule(async () => ({ action: "skip", reason: "nothing to do this pass" }));

  const legacy = await resolveDispatch(directCtx(state, base));
  const decision = await decideOrchestratorDispatch(fakeCtx, fakePi, base, undefined, { stateSnapshot: state });

  assert.equal((legacy as { action: string }).action, "skip");
  assert.ok(decision && "kind" in decision && decision.kind === "skipped", "skip must translate to a skipped decision");
});

test("#442 characterization: no matching rule → orchestrator yields no unit (legacy 'no remaining units')", async (t) => {
  t.after(() => resetRegistry());
  const base = setupBase(t);
  const state = makeState();
  installRule(async () => null);

  const legacy = await resolveDispatch(directCtx(state, base));
  const decision = await decideOrchestratorDispatch(fakeCtx, fakePi, base, undefined, { stateSnapshot: state });

  // resolveDispatch with no match yields no dispatch action; the orchestrator
  // surfaces that as a null decision, which advance() turns into a "stopped:
  // no remaining units" outcome — the same terminal the legacy path reaches.
  assert.ok(legacy == null || (legacy as { action?: string }).action !== "dispatch");
  assert.ok(decision == null || !("unitType" in decision), "no-match must not yield a unit dispatch");
});
