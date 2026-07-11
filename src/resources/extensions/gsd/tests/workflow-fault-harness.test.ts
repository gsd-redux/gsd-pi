import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowFaultHarness,
  type WorkflowFaultPoint,
} from "./workflow-fault-harness.js";

test("fault harness throws once at the armed named boundary", () => {
  const harness = createWorkflowFaultHarness("after-db-commit-before-render");

  harness.hit("before-transaction-commit", "complete-task");
  assert.throws(
    () => harness.hit("after-db-commit-before-render", "complete-task"),
    /complete-task.*after-db-commit-before-render.*hit 1/,
  );

  assert.equal(harness.count("before-transaction-commit"), 1);
  assert.equal(harness.count("after-db-commit-before-render"), 1);
});

test("fault harness automatically disarms after its first matching hit", () => {
  const point: WorkflowFaultPoint = "during-projection-write";
  const harness = createWorkflowFaultHarness(point);

  assert.throws(() => harness.hit(point, "complete-slice"));
  assert.doesNotThrow(() => harness.hit(point, "complete-slice"));
  assert.equal(harness.count(point), 2);
});

test("fault harness instances never share armed state or counts", () => {
  const first = createWorkflowFaultHarness("before-independent-reopen");
  const second = createWorkflowFaultHarness("before-independent-reopen");

  assert.throws(() => first.hit("before-independent-reopen", "resume"));
  assert.equal(first.count("before-independent-reopen"), 1);
  assert.equal(second.count("before-independent-reopen"), 0);
  assert.throws(() => second.hit("before-independent-reopen", "resume"));
});
