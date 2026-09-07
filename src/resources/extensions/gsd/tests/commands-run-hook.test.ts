// gsd-pi — Unit tests for /gsd run-hook unit-ID validation (#2195)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleRunHook, validateRunHookUnitId } from "../commands-handlers.ts";
import { getActiveHook, resetHookState } from "../post-unit-hooks.ts";

const DOCUMENTED_UNIT_TYPES = "execute-task, plan-slice, research-milestone, complete-slice, complete-milestone";

function unknownUnitTypeMessage(unitType: string): string {
  return `Unknown unit type "${unitType}". Expected one of: ${DOCUMENTED_UNIT_TYPES}`;
}

// ─── validateRunHookUnitId ──────────────────────────────────────────────────

describe("validateRunHookUnitId", () => {
  test("milestone-scoped unit types accept classic and unique milestone IDs", () => {
    for (const unitType of ["research-milestone", "complete-milestone"]) {
      assert.equal(validateRunHookUnitId(unitType, "M001"), null, `${unitType} M001`);
      assert.equal(validateRunHookUnitId(unitType, "M001-abc123"), null, `${unitType} M001-abc123`);
    }
  });

  test("slice-scoped unit types accept milestone/slice IDs", () => {
    for (const unitType of ["plan-slice", "complete-slice"]) {
      assert.equal(validateRunHookUnitId(unitType, "M001/S01"), null, `${unitType} M001/S01`);
      assert.equal(validateRunHookUnitId(unitType, "M001-abc123/S01"), null, `${unitType} M001-abc123/S01`);
      assert.equal(validateRunHookUnitId(unitType, "M001/S123"), null, `${unitType} M001/S123 (100+ slices)`);
    }
  });

  test("execute-task accepts milestone/slice/task IDs", () => {
    assert.equal(validateRunHookUnitId("execute-task", "M001/S01/T01"), null);
    assert.equal(validateRunHookUnitId("execute-task", "M001-abc123/S01/T01"), null);
    assert.equal(validateRunHookUnitId("execute-task", "M001/S01/T100"), null);
    // Slice IDs are padStart(2) with no cap: 100+ slices yield S100+ (accepted before #2195).
    assert.equal(validateRunHookUnitId("execute-task", "M001/S123/T01"), null);
  });

  test("rejects an ID whose depth does not match the unit type and names the expected shape", () => {
    const cases: Array<[unitType: string, unitId: string, expected: string]> = [
      ["complete-milestone", "M001/S01", "M001"],
      ["complete-milestone", "M001/S01/T01", "M001"],
      ["research-milestone", "M001/S01", "M001"],
      ["plan-slice", "M001", "M001/S01"],
      ["plan-slice", "M001/S01/T01", "M001/S01"],
      ["complete-slice", "M001", "M001/S01"],
      ["execute-task", "M001", "M001/S01/T01"],
      ["execute-task", "M001/S01", "M001/S01/T01"],
    ];
    for (const [unitType, unitId, expected] of cases) {
      const error = validateRunHookUnitId(unitType, unitId);
      assert.ok(error, `${unitType} ${unitId} should be rejected`);
      assert.equal(error, `Invalid unit ID format: "${unitId}" for ${unitType}. Expected format: ${expected}`);
    }
  });

  test("rejects malformed segments", () => {
    const cases: Array<[unitType: string, unitId: string]> = [
      ["complete-milestone", ""],
      ["complete-milestone", "M1"],
      ["complete-milestone", "m001"],
      ["complete-milestone", "M001-ABC123"],
      ["complete-milestone", "M001-abc12"],
      ["complete-milestone", "M001/"],
      ["plan-slice", "M001/S1"],
      ["plan-slice", "M001/S1234"],
      ["plan-slice", "M001/s01"],
      ["execute-task", "M001/S01/T1"],
      ["execute-task", "M001/S01/T1234"],
      ["execute-task", "M001/S01/T01/extra"],
    ];
    for (const [unitType, unitId] of cases) {
      assert.ok(validateRunHookUnitId(unitType, unitId), `${unitType} "${unitId}" should be rejected`);
    }
  });

  test("rejects unit types the command does not document", () => {
    assert.equal(validateRunHookUnitId("run-uat", "M001/S01"), unknownUnitTypeMessage("run-uat"));
  });

  test("rejects unit types that only exist on Object.prototype", () => {
    for (const unitType of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      assert.equal(validateRunHookUnitId(unitType, "M001"), unknownUnitTypeMessage(unitType), unitType);
    }
  });
});

// ─── handleRunHook wiring ───────────────────────────────────────────────────

describe("handleRunHook", () => {
  type Notification = { message: string; level: string };

  // Sentinel thrown from the mock notify when the hook has been triggered. The
  // next statement in handleRunHook is dispatchHookUnit, which starts auto-mode,
  // so aborting here keeps the success path side-effect free.
  const HOOK_TRIGGERED = new Error("hook triggered — stop before dispatch");

  function setupHookProject(t: any): { ctx: any; notifications: Notification[] } {
    const prevCwd = process.cwd();
    const prevHome = process.env.GSD_HOME;
    const project = mkdtempSync(join(tmpdir(), "gsd-run-hook-"));
    const home = mkdtempSync(join(tmpdir(), "gsd-run-hook-home-"));
    t.after(() => {
      resetHookState();
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = prevHome;
      rmSync(project, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    mkdirSync(join(project, ".gsd"), { recursive: true });
    writeFileSync(
      join(project, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "version: 1",
        "post_unit_hooks:",
        "  - name: review",
        "    after: [execute-task, plan-slice, complete-milestone]",
        "    prompt: Review {milestoneId}",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = home;
    process.chdir(project);

    const notifications: Notification[] = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
          if (message.startsWith("Manually triggering hook:")) throw HOOK_TRIGGERED;
        },
      },
    };
    return { ctx, notifications };
  }

  async function runHook(t: any, args: string): Promise<Notification[]> {
    const { ctx, notifications } = setupHookProject(t);
    await handleRunHook(args, ctx, {} as any);
    return notifications;
  }

  async function assertRejectedBeforeTrigger(t: any, args: string, expectedMessage: string): Promise<void> {
    assert.deepEqual(await runHook(t, args), [{ message: expectedMessage, level: "warning" }]);
    assert.equal(getActiveHook(), null, "no hook may be triggered for a rejected invocation");
  }

  async function assertHookTriggered(t: any, args: string): Promise<void> {
    const [, unitType, unitId] = args.split(" ");
    const { ctx, notifications } = setupHookProject(t);
    await assert.rejects(handleRunHook(args, ctx, {} as any), HOOK_TRIGGERED);
    assert.deepEqual(notifications, [
      { message: `Manually triggering hook: review for ${unitType} ${unitId}`, level: "info" },
    ]);
    const active = getActiveHook();
    assert.equal(active?.hookName, "review");
    assert.equal(active?.triggerUnitType, unitType);
    assert.equal(active?.triggerUnitId, unitId);
  }

  test("triggers a milestone-scoped hook for a milestone ID", async (t) => {
    await assertHookTriggered(t, "review complete-milestone M001");
  });

  test("triggers a slice-scoped hook for a milestone/slice ID", async (t) => {
    await assertHookTriggered(t, "review plan-slice M001/S01");
  });

  test("rejects a slice ID for a milestone-scoped hook", async (t) => {
    await assertRejectedBeforeTrigger(
      t,
      "review complete-milestone M001/S01",
      'Invalid unit ID format: "M001/S01" for complete-milestone. Expected format: M001',
    );
  });

  test("rejects a milestone ID for a slice-scoped hook", async (t) => {
    await assertRejectedBeforeTrigger(
      t,
      "review plan-slice M001",
      'Invalid unit ID format: "M001" for plan-slice. Expected format: M001/S01',
    );
  });

  test("rejects a slice ID for a task-scoped hook", async (t) => {
    await assertRejectedBeforeTrigger(
      t,
      "review execute-task M001/S01",
      'Invalid unit ID format: "M001/S01" for execute-task. Expected format: M001/S01/T01',
    );
  });

  test("rejects an undocumented unit type before looking at the ID", async (t) => {
    await assertRejectedBeforeTrigger(t, "review run-uat M001/S01", unknownUnitTypeMessage("run-uat"));
  });

  test("rejects a unit type that names an Object.prototype member", async (t) => {
    await assertRejectedBeforeTrigger(t, "review constructor M001", unknownUnitTypeMessage("constructor"));
  });
});
