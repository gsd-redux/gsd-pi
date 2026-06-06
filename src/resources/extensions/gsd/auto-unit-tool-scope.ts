import { parseUnitId } from "./unit-id.js";
import {
  AUTO_UNIT_SCOPED_TOOLS,
  getForbiddenGsdToolReason,
} from "./unit-tool-contracts.js";

export {
  AUTO_UNIT_SCOPED_TOOLS,
  RUN_UAT_BROWSER_TOOL_NAMES,
} from "./unit-tool-contracts.js";

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

// Units that OWN quality gates but close them by writing artifact sections —
// the unit's completion-tool handler (gsd_task_complete, gsd_slice_complete,
// gsd_validate_milestone) persists each verdict from the section content. The
// gsd_save_gate_result tool belongs to the separate gate-evaluate phase. A
// model in one of these units is nudged toward gsd_save_gate_result by the
// "return verdict" vocabulary in the gate guidance, but calling it here would
// double-write the exact rows the completion handler already closes. We still
// block it, but with a calm redirect (softGateToolRedirect) instead of the
// HARD BLOCK wall, since the outcome is unaffected and the correct path is
// clear. See gate-registry.ts ownerTurn fields and complete-task.ts gate close.
const SECTION_CLOSE_GATE_UNIT_TYPES = new Set([
  "execute-task",
  "execute-task-simple",
  "reactive-execute",
  "complete-slice",
  "validate-milestone",
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

export const GSD_PHASE_SCOPE_DISPLAY_REASON = "This GSD phase only allows its scoped workflow tools.";
export const GSD_SECTION_CLOSE_GATE_DISPLAY_REASON =
  "Gates here close by writing summary sections — gsd_save_gate_result isn't needed.";

type AutoUnitToolScopeResult = {
  block: boolean;
  reason?: string;
  displayReason?: string;
};

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
    `HARD BLOCK: Tool Contract failure for unit "${unitType}" — ${what}.`,
    "This is a mechanical phase-boundary gate. You MUST NOT proceed, retry the same call,",
    "or route around this block; the orchestrator owns phase transitions.",
  ].join(" ");
}

function hardBlock(unitType: string, what: string): AutoUnitToolScopeResult {
  return {
    block: true,
    reason: hardBlockReason(unitType, what),
    displayReason: GSD_PHASE_SCOPE_DISPLAY_REASON,
  };
}

// Calm, instructive block for the known-benign case: a section-close gate unit
// reaching for gsd_save_gate_result. Still blocks (calling it would double-write
// the rows the completion handler already closes) but replaces the alarming
// HARD BLOCK wall with a one-line redirect to the correct section-write path.
// The "closes its quality gates by writing summary sections" phrase is a stable
// marker registered in auto-tool-tracking.ts so this stays classified as a
// deterministic (expected, non-retryable) policy outcome, not a real error.
function softGateToolRedirect(unitType: string): AutoUnitToolScopeResult {
  return {
    block: true,
    reason: [
      `Skip this call — the "${unitType}" phase closes its quality gates by writing summary sections,`,
      "not by calling gsd_save_gate_result (that tool belongs to the gate-evaluate phase).",
      "Record each gate by filling its named section in your summary: a populated section records `pass`,",
      "an empty one records `omitted`. Then call your completion tool and the handler persists every verdict.",
      "This is expected, not an error — continue without gsd_save_gate_result.",
    ].join(" "),
    displayReason: GSD_SECTION_CLOSE_GATE_DISPLAY_REASON,
  };
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
): AutoUnitToolScopeResult {
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

  return hardBlock(
    unitType,
    `gsd_task_complete may only complete the active task ${expected.milestone}/${expected.slice}/${expected.task}; requested ${actualMilestone}/${actualSlice}/${actualTask}`,
  );
}

export function shouldBlockAutoUnitToolCall(
  unitType: string,
  toolName: string,
  input?: unknown,
  unitId?: string,
): AutoUnitToolScopeResult {
  const scopedTools = AUTO_UNIT_SCOPED_TOOLS[unitType];
  if (!scopedTools) return { block: false };

  if (isNativeWorkflowTool(toolName)) {
    return hardBlock(unitType, "native Workflow is not permitted inside a dispatched GSD auto-mode unit");
  }

  const taskScope = shouldBlockTaskCompletionScope(unitType, unitId, toolName, input);
  if (taskScope.block) return taskScope;

  const canonicalTool = canonicalWorkflowToolName(toolName);
  if (!SCOPED_GSD_LIFECYCLE_TOOLS.has(canonicalTool)) return { block: false };

  const allowedTools = allowedGsdToolsForUnit(unitType);
  if (allowedTools.includes(canonicalTool)) return { block: false };

  const forbiddenReason = getForbiddenGsdToolReason(unitType, canonicalTool);
  if (forbiddenReason) {
    return hardBlock(
      unitType,
      `GSD lifecycle tool "${canonicalTool}" is not permitted; ${forbiddenReason} Fix unit-tool-contracts.ts or the ${unitType} prompt.`,
    );
  }

  if (canonicalTool === "gsd_save_gate_result" && SECTION_CLOSE_GATE_UNIT_TYPES.has(unitType)) {
    return softGateToolRedirect(unitType);
  }

  return hardBlock(
    unitType,
    `GSD lifecycle tool "${canonicalTool}" is not permitted; allowed GSD tools: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(none)"}`,
  );
}
