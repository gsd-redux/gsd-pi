import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { CompleteSliceParams } from "../types.js";
import {
  closeDatabase,
  getSlice,
  getTask,
  insertSlice,
  insertTask,
  updateTaskStatus,
} from "../gsd-db.js";
import { relSliceFile } from "../paths.js";
import { handleCompleteSlice } from "../tools/complete-slice.js";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.js";
import {
  createWorkflowFaultHarness,
  type WorkflowFaultHarness,
  type WorkflowFaultPoint,
} from "./workflow-fault-harness.js";

interface FaultScenario {
  point: WorkflowFaultPoint;
  committed: boolean;
}

interface AuthoritySnapshot {
  pid: number;
  taskStatus: string | null;
  sliceStatus: string | null;
  activeSlice: string | null;
}

const SCENARIOS: FaultScenario[] = [
  { point: "before-transaction-commit", committed: false },
  { point: "after-db-commit-before-render", committed: true },
  { point: "during-projection-write", committed: true },
  { point: "before-independent-reopen", committed: true },
  { point: "after-independent-reopen", committed: true },
];

const COMPLETE_SLICE_PARAMS: CompleteSliceParams = {
  milestoneId: "M001",
  sliceId: "S02",
  sliceTitle: "Ready dependent slice",
  oneLiner: "Complete the dependent slice",
  narrative: "The database records the completed slice before projections are refreshed.",
  verification: "The focused authority matrix passed.",
  uatContent: "## UAT Type\n\n- UAT mode: runtime-executable\n\n## Result\n\nPassed.",
};

function seedCompletionBoundary(): void {
  updateTaskStatus("M001", "S02", "T01", "complete", "2026-07-11T00:00:00.000Z");
  insertSlice({
    id: "S03",
    milestoneId: "M001",
    title: "Blocked dependent slice",
    status: "pending",
    depends: ["S02"],
    sequence: 3,
  });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S03",
    title: "Blocked task",
    status: "pending",
    sequence: 1,
  });
}

function writeProjection(root: string, relativePath: string, content: string): void {
  const path = join(root, ".gsd", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeContradictoryProjection(root: string, committed: boolean): void {
  const s02Checked = committed ? " " : "x";
  const s03Checked = committed ? "x" : " ";
  writeProjection(
    root,
    "milestones/M001/M001-ROADMAP.md",
    [
      "# M001: Contradictory projection",
      "",
      "## Slices",
      "- [x] **S01: Completed prerequisite** `risk:low` `depends:[]`",
      `- [${s02Checked}] **S02: Ready dependent slice** \`risk:medium\` \`depends:[S01]\``,
      `- [${s03Checked}] **S03: Blocked dependent slice** \`risk:low\` \`depends:[S02]\``,
    ].join("\n"),
  );
  writeProjection(
    root,
    "STATE.md",
    [
      "# GSD State",
      "",
      `**Active Slice:** ${committed ? "S02" : "S03"}`,
      "**Phase:** executing",
    ].join("\n"),
  );
}

function armProductionFault(
  point: WorkflowFaultPoint,
  harness: WorkflowFaultHarness,
  root: string,
): void {
  if (point === "before-transaction-commit") {
    harness.armDatabaseAbort("status", "NEW.status = 'complete' AND OLD.status <> 'complete'");
  } else if (point === "after-db-commit-before-render") {
    harness.armDatabaseAbort("full_summary_md", "NEW.full_summary_md IS NOT OLD.full_summary_md");
  } else if (point === "during-projection-write") {
    const summaryPath = join(root, relSliceFile(root, "M001", "S02", "SUMMARY"));
    harness.obstructProjection(summaryPath);
  }
}

function runAuthorityProcess(
  root: string,
  dbPath: string,
  faultPoint?: WorkflowFaultPoint,
): SpawnSyncReturns<string> {
  const resolver = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");
  const databaseModule = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts")).href;
  const stateModule = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/state.ts")).href;
  const faultHarnessModule = pathToFileURL(join(
    process.cwd(),
    "src/resources/extensions/gsd/tests/workflow-fault-harness.ts",
  )).href;
  const script = `
    const [
      { openDatabase, closeDatabase, getSlice, getTask },
      { deriveStateFromDb },
      { createWorkflowFaultHarness },
    ] = await Promise.all([
      import(${JSON.stringify(databaseModule)}),
      import(${JSON.stringify(stateModule)}),
      import(${JSON.stringify(faultHarnessModule)}),
    ]);
    const [root, dbPath, faultPoint] = process.argv.slice(-3);
    if (!openDatabase(dbPath)) throw new Error("fresh process could not open workflow database");
    if (faultPoint) {
      process.stderr.write("DATABASE_OPENED_BEFORE_FAULT=" + process.pid + "\\n");
      createWorkflowFaultHarness(faultPoint).hit(faultPoint, "fresh-process-reopen");
    }
    const state = await deriveStateFromDb(root);
    const snapshot = {
      pid: process.pid,
      taskStatus: getTask("M001", "S02", "T01")?.status ?? null,
      sliceStatus: getSlice("M001", "S02")?.status ?? null,
      activeSlice: state.activeSlice?.id ?? null,
    };
    closeDatabase();
    process.stdout.write("AUTHORITY_SNAPSHOT=" + JSON.stringify(snapshot) + "\\n");
  `;
  return spawnSync(
    process.execPath,
    [
      "--import",
      resolver,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
      root,
      dbPath,
      faultPoint ?? "",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function readAuthorityInFreshProcess(root: string, dbPath: string): AuthoritySnapshot {
  const child = runAuthorityProcess(root, dbPath);

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split("\n").find((entry) => entry.startsWith("AUTHORITY_SNAPSHOT="));
  assert.ok(line, `fresh process did not return an authority snapshot: ${child.stdout}`);
  return JSON.parse(line.slice("AUTHORITY_SNAPSHOT=".length)) as AuthoritySnapshot;
}

for (const scenario of SCENARIOS) {
  test(`database authority remains coherent at ${scenario.point}`, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => fixture.cleanup());
    seedCompletionBoundary();
    const harness = createWorkflowFaultHarness(scenario.point);
    armProductionFault(scenario.point, harness, fixture.root);

    let completionError: unknown;
    let completionStale = false;
    try {
      const result = await handleCompleteSlice(COMPLETE_SLICE_PARAMS, fixture.root);
      assert.ok(!("error" in result), "production completion must reach its mutation boundary");
      completionStale = result.stale === true;
      harness.hit("before-independent-reopen", "complete-dependent-slice");
    } catch (error) {
      completionError = error;
    }

    if (scenario.point === "during-projection-write") {
      assert.equal(completionStale, true, "the production renderer must surface a stale projection");
    } else if (scenario.point === "after-independent-reopen") {
      assert.equal(completionError, undefined, "completion must succeed before the reopen fault");
      assert.equal(completionStale, false, "completion must not be stale before the reopen fault");
    } else {
      assert.match(String(completionError), new RegExp(scenario.point));
    }

    writeContradictoryProjection(fixture.root, scenario.committed);
    closeDatabase();
    if (scenario.point === "after-independent-reopen") {
      const faultedChild = runAuthorityProcess(fixture.root, fixture.dbPath, scenario.point);
      assert.notEqual(faultedChild.status, 0, "fresh process must fault after opening the database");
      assert.match(faultedChild.stderr, /DATABASE_OPENED_BEFORE_FAULT=/);
      assert.match(faultedChild.stderr, /after-independent-reopen/);
    }
    const snapshot = readAuthorityInFreshProcess(fixture.root, fixture.dbPath);
    fixture.reopen();

    const expectedStatus = scenario.committed ? "complete" : "pending";
    const { pid, ...authority } = snapshot;
    assert.notEqual(pid, process.pid, "authority must be verified by another process");
    assert.deepEqual(authority, {
      taskStatus: "complete",
      sliceStatus: expectedStatus,
      activeSlice: scenario.committed ? "S03" : "S02",
    });
    assert.equal(getTask("M001", "S02", "T01")?.status, "complete");
    assert.equal(getSlice("M001", "S02")?.status, expectedStatus);
  });
}
