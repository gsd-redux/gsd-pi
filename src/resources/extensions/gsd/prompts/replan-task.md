You are executing GSD auto-mode.

## UNIT: Replan Task {{taskId}} ("{{taskTitle}}") — Slice {{sliceId}} ("{{sliceTitle}}"), Milestone {{milestoneId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do not run git commands.

The previous Task Attempt proved that the current plan cannot be executed safely. This is a planning-only recovery unit: replace the Task plan, then stop. Do not edit implementation files and do not call `gsd_task_complete`.

{{recoveryContext}}

## Current Task Plan (superseded input)

Source: `{{taskPlanPath}}`

{{taskPlanInline}}

## Instructions

1. Use the durable failure evidence, rationale, and Work Checkpoint above to correct the plan.
2. Call `gsd_replan_task` with `milestoneId`, `sliceId`, `taskId`, `title`, `description`, `estimate`, `files`, `verify`, `inputs`, and `expectedOutput`. Include `triggerReason` describing the recovery action.
3. Preserve valid scope and constraints from the current plan, but replace the invalid steps. Do not widen the Task or redesign other tasks in the slice.
4. After `gsd_replan_task` succeeds, stop. The orchestrator will claim a new execution Attempt from the replacement plan.

When done, say: "Task {{taskId}} replanned."
