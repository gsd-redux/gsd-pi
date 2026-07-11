import assert from "node:assert/strict";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { atomicWriteAsyncWithOps, type AtomicWriteAsyncOps } from "../atomic-write.js";
import {
  getActiveSliceFromDb,
  getSlice,
  getTask,
  insertSlice,
  insertTask,
  transaction,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.js";
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

const SCENARIOS: FaultScenario[] = [
  { point: "before-transaction-commit", committed: false },
  { point: "after-db-commit-before-render", committed: true },
  { point: "during-projection-write", committed: true },
  { point: "before-independent-reopen", committed: true },
  { point: "after-independent-reopen", committed: true },
];

function seedBlockedDependentSlice(): void {
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

function projectionForCurrentAuthority(): string {
  return `S02=${getSlice("M001", "S02")?.status ?? "missing"}\n`;
}

function projectionOps(harness: WorkflowFaultHarness): AtomicWriteAsyncOps {
  return {
    async mkdir(path, options) {
      await fs.mkdir(path, options);
    },
    writeFile: fs.writeFile,
    async rename(from, to) {
      harness.hit("during-projection-write", "render-authority-projection");
      await fs.rename(from, to);
    },
    unlink: fs.unlink,
    sleep: async () => {},
    createTempPath: (filePath) => `${filePath}.tmp.fault-test`,
  };
}

async function renderProjection(
  path: string,
  harness: WorkflowFaultHarness,
): Promise<void> {
  await atomicWriteAsyncWithOps(
    path,
    projectionForCurrentAuthority(),
    "utf-8",
    projectionOps(harness),
  );
}

async function runFaultedCompletion(
  scenario: FaultScenario,
  harness: WorkflowFaultHarness,
  projectionPath: string,
  reopen: () => void,
): Promise<void> {
  transaction(() => {
    updateTaskStatus("M001", "S02", "T01", "complete", "2026-07-11T00:00:00.000Z");
    updateSliceStatus("M001", "S02", "complete", "2026-07-11T00:00:00.000Z");
    harness.hit("before-transaction-commit", "complete-dependent-slice");
  });

  harness.hit("after-db-commit-before-render", "complete-dependent-slice");
  await renderProjection(projectionPath, harness);
  harness.hit("before-independent-reopen", "complete-dependent-slice");
  reopen();
  harness.hit("after-independent-reopen", "complete-dependent-slice");
}

for (const scenario of SCENARIOS) {
  test(`database authority remains coherent at ${scenario.point}`, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => fixture.cleanup());
    seedBlockedDependentSlice();

    const projectionPath = join(fixture.root, "WORKFLOW-STATUS.md");
    const initialProjection = scenario.committed ? "S02=pending\n" : "S02=complete\n";
    writeFileSync(projectionPath, initialProjection);
    const harness = createWorkflowFaultHarness(scenario.point);

    await assert.rejects(
      runFaultedCompletion(scenario, harness, projectionPath, fixture.reopen),
      new RegExp(scenario.point),
    );
    assert.equal(harness.count(scenario.point), 1);

    fixture.reopen();
    const expectedStatus = scenario.committed ? "complete" : "pending";
    const expectedActiveSlice = scenario.committed ? "S03" : "S02";
    assert.equal(getTask("M001", "S02", "T01")?.status, expectedStatus);
    assert.equal(getSlice("M001", "S02")?.status, expectedStatus);
    assert.equal(
      getActiveSliceFromDb("M001")?.id,
      expectedActiveSlice,
      "dependency selection must follow reopened database state, not the projection",
    );
    const renderCompletedBeforeFault =
      scenario.point === "before-independent-reopen"
      || scenario.point === "after-independent-reopen";
    const expectedProjection = renderCompletedBeforeFault
      ? "S02=complete\n"
      : initialProjection;
    assert.equal(readFileSync(projectionPath, "utf-8"), expectedProjection);

    if (scenario.committed) {
      await renderProjection(projectionPath, harness);
      assert.equal(readFileSync(projectionPath, "utf-8"), "S02=complete\n");
      assert.equal(getActiveSliceFromDb("M001")?.id, "S03");
    }
  });
}
