import test from "node:test";
import assert from "node:assert/strict";

import { getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";
import { queryDecisionsFromMemories, queryRequirements } from "../context-store.ts";
import { deriveStateFromDb } from "../state.ts";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

test("workflow authority fixture seeds a reopenable DB-backed workflow", async () => {
  const fixture = await createWorkflowAuthorityFixture();
  try {
    fixture.reopen();

    const state = await deriveStateFromDb(fixture.root);
    const slices = getMilestoneSlices(fixture.ids.milestone);
    const readyTasks = getSliceTasks(fixture.ids.milestone, fixture.ids.readySlice);
    const requirements = queryRequirements({
      milestoneId: fixture.ids.milestone,
      sliceId: fixture.ids.readySlice,
    });
    const decisions = queryDecisionsFromMemories({ milestoneId: fixture.ids.milestone });

    assert.equal(state.phase, "executing");
    assert.equal(state.activeMilestone?.id, fixture.ids.milestone);
    assert.equal(state.activeSlice?.id, fixture.ids.readySlice);
    assert.equal(state.activeTask?.id, fixture.ids.readyTask);
    assert.deepEqual(
      slices.map((slice) => ({ id: slice.id, status: slice.status, depends: slice.depends })),
      [
        { id: fixture.ids.completedSlice, status: "complete", depends: [] },
        { id: fixture.ids.readySlice, status: "pending", depends: [fixture.ids.completedSlice] },
      ],
    );
    assert.deepEqual(
      readyTasks.map((task) => ({ id: task.id, status: task.status })),
      [{ id: fixture.ids.readyTask, status: "pending" }],
    );
    assert.ok(state.requirements);
    assert.equal(state.requirements.active, 1);
    assert.equal(state.requirements.total, 1);
    assert.deepEqual(requirements.map((requirement) => requirement.id), [fixture.ids.requirement]);
    assert.deepEqual(decisions.map((decision) => decision.id), [fixture.ids.decision]);
  } finally {
    fixture.cleanup();
  }
});
