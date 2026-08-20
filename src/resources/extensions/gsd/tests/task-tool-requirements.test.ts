// Project/App: gsd-pi
// File Purpose: Regression tests for task planning versus execute-task tool compatibility.

import assert from "node:assert/strict";
import test from "node:test";

import { validateTaskToolRequirements } from "../task-tool-requirements.ts";

test("ordinary and execute-task-owned tool requirements are compatible", () => {
  assert.equal(validateTaskToolRequirements("T01", []), null);
  assert.equal(validateTaskToolRequirements("T02", ["gsd_decision_save"]), null);
});

test("requirements must be available to every normal task execution variant", () => {
  const error = validateTaskToolRequirements("T02", ["gsd_task_recovery_resume"]);

  assert.match(error ?? "", /task T02.*gsd_task_recovery_resume.*execute-task-simple/i);
});

test("completion-owned requirement mutation is rejected with compatible owners", () => {
  const error = validateTaskToolRequirements("T03", ["gsd_requirement_update"]);

  assert.match(error ?? "", /task T03.*gsd_requirement_update.*execute-task/i);
  assert.match(error ?? "", /complete-slice.*complete-milestone/i);
});
