import test from "node:test";
import assert from "node:assert/strict";

import { executeTaskIllegalPlanToolsError } from "../execute-task-plan-tool-guard.ts";
import { getUnitToolSurfaceContract } from "../unit-tool-contracts.ts";

function task(overrides: {
  description?: string;
  files?: string[];
} = {}) {
  return {
    description: overrides.description ?? "Implement the handler and add tests.",
    files: overrides.files ?? ["src/handler.ts"],
  };
}

test("ordinary execute-task plans are not blocked", () => {
  assert.equal(executeTaskIllegalPlanToolsError(task(), "tasks[0]"), null);
  assert.equal(
    executeTaskIllegalPlanToolsError(
      task({ description: "Run checks with gsd_exec, then call gsd_task_complete." }),
      "tasks[0]",
    ),
    null,
  );
  assert.equal(
    executeTaskIllegalPlanToolsError(
      task({ description: "Implement the first task added through gsd_plan_task." }),
      "tasks[0]",
    ),
    null,
  );
});

test("plan-slice rejects tasks that name execute-task-illegal lifecycle tools (#1530)", () => {
  const requirementError = executeTaskIllegalPlanToolsError(
    task({
      description: "Terminalize R001 with gsd_requirement_update after evidence lands.",
    }),
    "tasks[0]",
  );
  assert.match(requirementError ?? "", /tasks\[0\] requires tools execute-task cannot call/);
  assert.match(requirementError ?? "", /gsd_requirement_update/);
  assert.match(requirementError ?? "", /complete-slice/);
  assert.equal(
    getUnitToolSurfaceContract("execute-task")?.allowedGsdTools.includes("gsd_requirement_update"),
    false,
  );

  const aliasError = executeTaskIllegalPlanToolsError(
    task({ description: "Call gsd_update_requirement for R001." }),
    "tasks[0]",
  );
  assert.match(aliasError ?? "", /gsd_requirement_update/);

  const statusError = executeTaskIllegalPlanToolsError(
    task({ description: "Reconcile stale success criteria via gsd_milestone_status." }),
    "tasks[0]",
  );
  assert.match(statusError ?? "", /gsd_milestone_status/);
  assert.match(statusError ?? "", /reassess-roadmap|complete-slice|plan-slice/);
});

test("plan-slice rejects files that require requirement or milestone metadata writes (#1530)", () => {
  const requirementsFile = executeTaskIllegalPlanToolsError(
    task({ files: [".gsd/REQUIREMENTS.md"] }),
    "tasks[0]",
  );
  assert.match(requirementsFile ?? "", /gsd_requirement_update/);

  const roadmapFile = executeTaskIllegalPlanToolsError(
    task({ files: ["ROADMAP.md"] }),
    "tasks[0]",
  );
  assert.match(roadmapFile ?? "", /gsd_milestone_status/);

  const projectFile = executeTaskIllegalPlanToolsError(
    task({ files: [".gsd/PROJECT.md"] }),
    "tasks[0]",
  );
  assert.match(projectFile ?? "", /gsd_milestone_status/);
});
