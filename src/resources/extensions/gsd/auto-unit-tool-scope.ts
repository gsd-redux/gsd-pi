import { parseUnitId } from "./unit-id.js";

export const RUN_UAT_BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_wait_for",
  "browser_assert",
  "browser_verify",
  "browser_screenshot",
  "browser_snapshot_refs",
  "browser_find",
  "browser_get_console_logs",
  "browser_get_network_logs",
  "browser_evaluate",
  "browser_reload",
  "browser_batch",
  "browser_act",
] as const;

export const AUTO_UNIT_SCOPED_TOOLS: Record<string, readonly string[]> = {
  "research-milestone": ["gsd_summary_save", "gsd_decision_save"],
  "plan-milestone": ["gsd_plan_milestone", "gsd_decision_save", "gsd_requirement_update"],
  "discuss-milestone": [
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_requirement_save",
    "gsd_requirement_update",
    "gsd_plan_milestone",
    "gsd_milestone_generate_id",
  ],
  "discuss-slice": ["gsd_summary_save", "gsd_decision_save"],
  "validate-milestone": ["gsd_validate_milestone", "gsd_reassess_roadmap", "subagent"],
  "complete-milestone": ["gsd_complete_milestone", "subagent"],
  "research-slice": ["gsd_summary_save", "gsd_decision_save"],
  "plan-slice": ["gsd_plan_slice", "gsd_plan_task", "gsd_decision_save"],
  "refine-slice": ["gsd_plan_slice", "gsd_plan_task", "gsd_decision_save"],
  "replan-slice": ["gsd_replan_slice", "gsd_plan_task", "gsd_decision_save"],
  "complete-slice": ["gsd_slice_complete", "gsd_task_reopen", "gsd_replan_slice", "gsd_decision_save", "gsd_requirement_update", "subagent"],
  "reassess-roadmap": ["gsd_reassess_roadmap"],
  "execute-task": ["gsd_task_complete", "gsd_decision_save"],
  "execute-task-simple": ["gsd_task_complete", "gsd_decision_save"],
  "reactive-execute": ["gsd_task_complete", "gsd_decision_save"],
  "run-uat": ["gsd_summary_save", ...RUN_UAT_BROWSER_TOOL_NAMES],
  "gate-evaluate": ["gsd_save_gate_result"],
  "rewrite-docs": ["gsd_summary_save", "gsd_decision_save"],
  "workflow-preferences": ["gsd_summary_save"],
  "discuss-project": ["gsd_summary_save", "gsd_decision_save", "gsd_requirement_save"],
  "discuss-requirements": ["gsd_requirement_save", "gsd_summary_save"],
  "research-decision": ["gsd_summary_save"],
  "research-project": ["gsd_summary_save", "gsd_decision_save"],
};

const WORKFLOW_TOOL_ALIASES: Record<string, string> = {
  gsd_save_decision: "gsd_decision_save",
  gsd_update_requirement: "gsd_requirement_update",
  gsd_save_requirement: "gsd_requirement_save",
  gsd_save_summary: "gsd_summary_save",
  gsd_generate_milestone_id: "gsd_milestone_generate_id",
  gsd_milestone_plan: "gsd_plan_milestone",
  gsd_slice_plan: "gsd_plan_slice",
  gsd_task_plan: "gsd_plan_task",
  gsd_slice_replan: "gsd_replan_slice",
  gsd_complete_slice: "gsd_slice_complete",
  gsd_milestone_complete: "gsd_complete_milestone",
  gsd_milestone_validate: "gsd_validate_milestone",
  gsd_roadmap_reassess: "gsd_reassess_roadmap",
  gsd_complete_task: "gsd_task_complete",
  gsd_reopen_task: "gsd_task_reopen",
  gsd_reopen_slice: "gsd_slice_reopen",
  gsd_reopen_milestone: "gsd_milestone_reopen",
};

const EXECUTE_TASK_UNIT_TYPES = new Set([
  "execute-task",
  "execute-task-simple",
  "reactive-execute",
]);

const EXTRA_SCOPED_GSD_LIFECYCLE_TOOLS = [
  "gsd_skip_slice",
  "gsd_slice_reopen",
  "gsd_milestone_reopen",
] as const;

const SCOPED_GSD_LIFECYCLE_TOOLS = new Set(
  [
    ...Object.values(AUTO_UNIT_SCOPED_TOOLS).flat(),
    ...Object.values(WORKFLOW_TOOL_ALIASES),
    ...EXTRA_SCOPED_GSD_LIFECYCLE_TOOLS,
  ]
    .filter((tool) => tool.startsWith("gsd_"))
    .map(canonicalWorkflowToolName),
);

function stripMcpToolPrefix(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  const toolSeparator = toolName.indexOf("__", "mcp__".length);
  return toolSeparator >= 0 ? toolName.slice(toolSeparator + 2) : toolName;
}

export function canonicalWorkflowToolName(toolName: string): string {
  const base = stripMcpToolPrefix(toolName);
  return WORKFLOW_TOOL_ALIASES[base] ?? base;
}

export function isWorkflowAliasTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_TOOL_ALIASES, stripMcpToolPrefix(toolName));
}

function hardBlockReason(unitType: string, what: string): string {
  return [
    `HARD BLOCK: unit "${unitType}" is constrained by auto-unit tool scope — ${what}.`,
    "This is a mechanical phase-boundary gate. You MUST NOT proceed, retry the same call,",
    "or route around this block; the orchestrator owns phase transitions.",
  ].join(" ");
}

function allowedGsdToolsForUnit(unitType: string): string[] {
  return [...new Set(
    (AUTO_UNIT_SCOPED_TOOLS[unitType] ?? [])
      .filter((tool) => tool.startsWith("gsd_"))
      .map(canonicalWorkflowToolName),
  )].sort();
}

function isNativeWorkflowTool(toolName: string): boolean {
  return stripMcpToolPrefix(toolName) === "Workflow";
}

function readStringField(input: unknown, camel: string, snake: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record[camel] ?? record[snake];
  return typeof value === "string" ? value : undefined;
}

function shouldBlockTaskCompletionScope(
  unitType: string,
  unitId: string | undefined,
  toolName: string,
  input: unknown,
): { block: boolean; reason?: string } {
  if (!EXECUTE_TASK_UNIT_TYPES.has(unitType)) return { block: false };
  if (canonicalWorkflowToolName(toolName) !== "gsd_task_complete") return { block: false };
  if (!unitId) return { block: false };

  const expected = parseUnitId(unitId);
  if (!expected.milestone || !expected.slice || !expected.task) return { block: false };

  const actualMilestone = readStringField(input, "milestoneId", "milestone_id");
  const actualSlice = readStringField(input, "sliceId", "slice_id");
  const actualTask = readStringField(input, "taskId", "task_id");

  if (!actualMilestone || !actualSlice || !actualTask) return { block: false };
  if (
    actualMilestone === expected.milestone &&
    actualSlice === expected.slice &&
    actualTask === expected.task
  ) {
    return { block: false };
  }

  return {
    block: true,
    reason: hardBlockReason(
      unitType,
      `gsd_task_complete may only complete the active task ${expected.milestone}/${expected.slice}/${expected.task}; requested ${actualMilestone}/${actualSlice}/${actualTask}`,
    ),
  };
}

export function shouldBlockAutoUnitToolCall(
  unitType: string,
  toolName: string,
  input?: unknown,
  unitId?: string,
): { block: boolean; reason?: string } {
  const scopedTools = AUTO_UNIT_SCOPED_TOOLS[unitType];
  if (!scopedTools) return { block: false };

  if (isNativeWorkflowTool(toolName)) {
    return {
      block: true,
      reason: hardBlockReason(unitType, "native Workflow is not permitted inside a dispatched GSD auto-mode unit"),
    };
  }

  const taskScope = shouldBlockTaskCompletionScope(unitType, unitId, toolName, input);
  if (taskScope.block) return taskScope;

  const canonicalTool = canonicalWorkflowToolName(toolName);
  if (!SCOPED_GSD_LIFECYCLE_TOOLS.has(canonicalTool)) return { block: false };

  const allowedTools = allowedGsdToolsForUnit(unitType);
  if (allowedTools.includes(canonicalTool)) return { block: false };

  return {
    block: true,
    reason: hardBlockReason(
      unitType,
      `GSD lifecycle tool "${canonicalTool}" is not permitted; allowed GSD tools: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(none)"}`,
    ),
  };
}
