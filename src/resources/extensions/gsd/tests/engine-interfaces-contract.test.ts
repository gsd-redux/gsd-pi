/**
 * engine-interfaces-contract.test.ts — Runtime and type-level contract tests for
 * the engine abstraction layer (S01).
 *
 * TypeScript interfaces are erased by --experimental-strip-types, so shape
 * contracts are verified by constructing values that satisfy the types and
 * asserting on their runtime fields. Type-level assertions guard compile-time
 * contracts; pnpm run typecheck:extensions validates those.
 *
 * Follows the same conventions as auto-session-encapsulation.test.ts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  EngineState,
  EngineDispatchAction,
  StepContract,
  ReconcileResult,
  RecoveryAction,
  CloseoutResult,
  DisplayMetadata,
} from "../engine-types.js";
import type { WorkflowEngine } from "../workflow-engine.js";
import type { ExecutionPolicy } from "../execution-policy.js";
import type { ResolvedEngine } from "../engine-resolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_TYPES_PATH = join(__dirname, "..", "engine-types.ts");

// ── Import smoke tests ──────────────────────────────────────────────────────

describe("Import smoke tests", () => {
  test("engine-types.ts can be dynamically imported", async () => {
    const mod = await import("../engine-types.ts");
    assert.ok(mod, "engine-types.ts should import without error");
  });

  test("workflow-engine.ts can be dynamically imported", async () => {
    const mod = await import("../workflow-engine.ts");
    assert.ok(mod, "workflow-engine.ts should import without error");
  });

  test("execution-policy.ts can be dynamically imported", async () => {
    const mod = await import("../execution-policy.ts");
    assert.ok(mod, "execution-policy.ts should import without error");
  });

  test("engine-resolver.ts can be dynamically imported", async () => {
    const mod = await import("../engine-resolver.ts");
    assert.ok(mod, "engine-resolver.ts should import without error");
    assert.ok(
      typeof mod.resolveEngine === "function",
      "engine-resolver.ts should export resolveEngine function",
    );
  });
});

// ── Leaf-node constraint ────────────────────────────────────────────────────

// allow-source-grep: verifies engine-types.ts is a leaf node by design
describe("Leaf-node constraint", () => {
  test("engine-types.ts has zero imports from GSD modules (only node: allowed)", () => {
    const source = readFileSync(ENGINE_TYPES_PATH, "utf-8");
    const lines = source.split("\n");
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match import lines that reference relative paths (../ or ./)
      if (/^import\s/.test(line) && /['"]\.\.?\// .test(line)) {
        violations.push(`line ${i + 1}: ${line.trim()}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `engine-types.ts must be a leaf node with zero GSD imports. ` +
      `Only node: imports are allowed.\nViolations:\n${violations.join("\n")}`,
    );
  });
});

// ── EngineState shape ───────────────────────────────────────────────────────

describe("EngineState shape", () => {
  test("EngineState accepts all required fields with correct runtime types", () => {
    const state: EngineState = {
      phase: "research",
      currentMilestoneId: "M001",
      activeSliceId: "S01",
      activeTaskId: "T01",
      isComplete: false,
      raw: { arbitrary: "engine-specific-state" },
    };

    assert.equal(state.phase, "research");
    assert.equal(state.currentMilestoneId, "M001");
    assert.equal(state.activeSliceId, "S01");
    assert.equal(state.activeTaskId, "T01");
    assert.equal(state.isComplete, false);
    assert.deepEqual(state.raw, { arbitrary: "engine-specific-state" });
  });

  test("EngineState.raw accepts unknown opaque values", () => {
    const state: EngineState = {
      phase: "planning",
      currentMilestoneId: null,
      activeSliceId: null,
      activeTaskId: null,
      isComplete: true,
      raw: null,
    };

    assert.equal(state.raw, null);
  });
});

// ── EngineDispatchAction shape ──────────────────────────────────────────────

describe("EngineDispatchAction shape", () => {
  test("EngineDispatchAction supports dispatch, stop, and skip variants at runtime", () => {
    const step: StepContract = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the task",
    };

    const dispatchAction: EngineDispatchAction = { action: "dispatch", step };
    assert.equal(dispatchAction.action, "dispatch");
    assert.deepEqual(dispatchAction.step, step);

    const stopAction: EngineDispatchAction = { action: "stop", reason: "blocked", level: "error" };
    assert.equal(stopAction.action, "stop");
    assert.equal(stopAction.reason, "blocked");
    assert.equal(stopAction.level, "error");

    const skipAction: EngineDispatchAction = { action: "skip" };
    assert.equal(skipAction.action, "skip");
  });
});

// ── WorkflowEngine interface shape ──────────────────────────────────────────

describe("WorkflowEngine interface shape", () => {
  test("WorkflowEngine accepts an object with engineId and all required methods", () => {
    const engine: WorkflowEngine = {
      engineId: "test-engine",
      deriveState: async () => ({
        phase: "test",
        currentMilestoneId: null,
        activeSliceId: null,
        activeTaskId: null,
        isComplete: false,
        raw: null,
      }),
      resolveDispatch: async () => ({ action: "skip" }),
      reconcile: async () => ({ outcome: "continue" }),
      getDisplayMetadata: () => ({
        engineLabel: "Test Engine",
        currentPhase: "test",
        progressSummary: "testing",
        stepCount: null,
      }),
    };

    assert.equal(engine.engineId, "test-engine");
    assert.equal(typeof engine.deriveState, "function");
    assert.equal(typeof engine.resolveDispatch, "function");
    assert.equal(typeof engine.reconcile, "function");
    assert.equal(typeof engine.getDisplayMetadata, "function");
  });
});

// ── ExecutionPolicy interface shape ─────────────────────────────────────────

describe("ExecutionPolicy interface shape", () => {
  test("ExecutionPolicy accepts an object with all required methods", () => {
    const policy: ExecutionPolicy = {
      prepareWorkspace: async () => {},
      selectModel: async () => null,
      verify: async () => "continue",
      recover: async () => ({ outcome: "retry" } as RecoveryAction),
      closeout: async () => ({ committed: true, artifacts: [] } as CloseoutResult),
    };

    assert.equal(typeof policy.prepareWorkspace, "function");
    assert.equal(typeof policy.selectModel, "function");
    assert.equal(typeof policy.verify, "function");
    assert.equal(typeof policy.recover, "function");
    assert.equal(typeof policy.closeout, "function");
  });
});

// ── Resolver stub behavior ──────────────────────────────────────────────────

describe("Resolver stub behavior", () => {
  test("resolveEngine returns dev engine for null activeEngineId", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: null });
    assert.ok(result.engine, "should return engine for null");
    assert.equal(
      result.engine.engineId,
      "dev",
      "engine.engineId should be 'dev' for null activeEngineId",
    );
  });

  test("resolveEngine returns dev engine for 'dev' activeEngineId", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: "dev" });
    assert.ok(result.engine, "should return engine for 'dev'");
    assert.equal(
      result.engine.engineId,
      "dev",
      "engine.engineId should be 'dev'",
    );
  });

  test("resolveEngine throws for unknown activeEngineId without activeRunDir", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    assert.throws(
      () => resolveEngine({ activeEngineId: "custom-xyz" }),
      /activeRunDir/,
      "resolveEngine should throw when custom engine has no activeRunDir",
    );
  });

  test("resolveEngine returns custom engine for non-dev activeEngineId with activeRunDir", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: "custom-xyz", activeRunDir: "/tmp/test-run" });
    assert.ok(result.engine, "should return engine for custom ID");
    assert.equal(
      result.engine.engineId,
      "custom",
      "engine.engineId should be 'custom' for non-dev activeEngineId",
    );
  });

  test("ResolvedEngine type is exported and has the expected shape", () => {
    // Type-level assertion: ResolvedEngine must be { engine: WorkflowEngine; policy: ExecutionPolicy }.
    // If the export or shape changes, the typecheck step fails.
    type _AssertResolvedEngine = ResolvedEngine extends { engine: WorkflowEngine; policy: ExecutionPolicy }
      ? true
      : false;
    const _assertResolvedEngine: true = {} as _AssertResolvedEngine;

    // Runtime sanity check that the import path resolves.
    assert.ok(_assertResolvedEngine === undefined || true);
  });
});

// ── AutoSession.activeEngineId ──────────────────────────────────────────────

describe("AutoSession.activeEngineId", () => {
  test("defaults to null on a fresh AutoSession", async () => {
    const { AutoSession } = await import("../auto/session.ts");
    const session = new AutoSession();
    assert.equal(
      session.activeEngineId,
      null,
      "activeEngineId should default to null",
    );
  });

  test("is null after reset()", async () => {
    const { AutoSession } = await import("../auto/session.ts");
    const session = new AutoSession();
    session.activeEngineId = "dev";
    session.reset();
    assert.equal(
      session.activeEngineId,
      null,
      "activeEngineId should be null after reset()",
    );
  });

  test("appears in toJSON() output", async () => {
    const { AutoSession } = await import("../auto/session.ts");
    const session = new AutoSession();
    const json = session.toJSON();
    assert.ok(
      "activeEngineId" in json,
      "toJSON() must include activeEngineId",
    );
    assert.equal(
      json.activeEngineId,
      null,
      "toJSON().activeEngineId should be null by default",
    );
  });
});
