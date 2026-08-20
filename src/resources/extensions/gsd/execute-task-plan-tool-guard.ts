// Reject plan-slice/plan-task work that execute-task cannot call.

import { FRAMEWORK_METADATA_DIRS } from "./paths.js";
import {
  EXECUTE_TASK_UNIT_TYPES,
  KNOWN_UNIT_TYPES,
} from "./unit-registry.js";
import { getUnitToolSurfaceContract } from "./unit-tool-contracts.js";
import { canonicalWorkflowSurfaceToolName } from "./workflow-tool-surface.js";

const EXECUTE_TASK_UNIT_TYPE = "execute-task";
const GSD_TOOL_NAME_RE = /\b(?:mcp__[a-z0-9_-]+__)?gsd_[a-z0-9_]+/gi;
/** Lifecycle tools execute-task cannot call. Mentions of planner tools like gsd_plan_task are not task requirements. */
const EXECUTE_TASK_ILLEGAL_LIFECYCLE_TOOLS = new Set([
  "gsd_requirement_update",
  "gsd_milestone_status",
]);
const REQUIREMENTS_BASENAME_RE = /^REQUIREMENTS\.md$/i;
const ROADMAP_BASENAME_RE = /^ROADMAP\.md$/i;
const MILESTONE_METADATA_BASENAME_RE = /^(PROJECT|CONTEXT)\.md$/i;
const MILESTONE_ARTIFACT_BASENAME_RE = /^M\d+-(ROADMAP|CONTEXT|PROJECT)\.md$/i;

export interface ExecuteTaskPlanToolFields {
  description: string;
  files: readonly string[];
}

function allowedExecuteTaskTools(): Set<string> | null {
  const allowed = getUnitToolSurfaceContract(EXECUTE_TASK_UNIT_TYPE)?.allowedGsdTools;
  if (!allowed) return null;
  return new Set(allowed);
}

function ownerUnitsForTool(tool: string): string[] {
  return KNOWN_UNIT_TYPES.filter((unitType) => {
    if (EXECUTE_TASK_UNIT_TYPES.has(unitType)) return false;
    const allowed = getUnitToolSurfaceContract(unitType)?.allowedGsdTools ?? [];
    return (allowed as readonly string[]).includes(tool);
  });
}

function extractNamedGsdTools(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(GSD_TOOL_NAME_RE)) {
    const canonical = canonicalWorkflowSurfaceToolName(match[0]);
    if (canonical.startsWith("gsd_")) found.add(canonical);
  }
  return [...found];
}

function normalizePlannedPath(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

function isFrameworkMetadataPath(normalized: string): boolean {
  return FRAMEWORK_METADATA_DIRS.some((dir) =>
    normalized.split("/").some((segment) => segment.toLowerCase() === dir),
  );
}

function toolsImpliedByPlannedFile(file: string): string[] {
  const normalized = normalizePlannedPath(file);
  if (!normalized) return [];
  const basename = normalized.split("/").pop() ?? "";
  if (REQUIREMENTS_BASENAME_RE.test(basename)) return ["gsd_requirement_update"];
  if (ROADMAP_BASENAME_RE.test(basename)) return ["gsd_milestone_status"];
  if (MILESTONE_ARTIFACT_BASENAME_RE.test(basename)) return ["gsd_milestone_status"];
  if (isFrameworkMetadataPath(normalized) && MILESTONE_METADATA_BASENAME_RE.test(basename)) {
    return ["gsd_milestone_status"];
  }
  return [];
}

function collectRequiredTools(task: ExecuteTaskPlanToolFields): string[] {
  const required = new Set<string>();
  const consider = (name: string) => {
    if (EXECUTE_TASK_ILLEGAL_LIFECYCLE_TOOLS.has(name)) required.add(name);
  };
  for (const name of extractNamedGsdTools(task.description)) consider(name);
  for (const file of task.files) {
    for (const name of extractNamedGsdTools(file)) consider(name);
    for (const implied of toolsImpliedByPlannedFile(file)) consider(implied);
  }
  return [...required];
}

function formatIllegalTool(tool: string): string {
  const owners = ownerUnitsForTool(tool);
  if (owners.length === 0) {
    return `${tool} (no owning unit — remove this mutation from the execute-task plan)`;
  }
  return `${tool} (owned by ${owners.join(", ")})`;
}

/**
 * Planner-visible error when a planned task needs lifecycle tools execute-task cannot call.
 * Fail closed for requirement/milestone mutations named in files or description.
 */
export function executeTaskIllegalPlanToolsError(
  task: ExecuteTaskPlanToolFields,
  label: string,
): string | null {
  const required = collectRequiredTools(task);
  if (required.length === 0) return null;

  const allowed = allowedExecuteTaskTools();
  const illegal = allowed
    ? required.filter((tool) => !allowed.has(tool)).sort()
    : [...required].sort();
  if (illegal.length === 0) return null;

  const details = illegal.map(formatIllegalTool).join("; ");
  return `${label} requires tools execute-task cannot call: ${details}`;
}
