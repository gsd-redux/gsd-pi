// Project/App: gsd-pi
// File Purpose: Canonical core session tool surface shared by auto-mode scoping and loop guards.

/** Base tools available during auto-mode execution before unit-specific GSD tools are added. */
export const MINIMAL_AUTO_BASE_TOOL_NAMES = [
  "ask_user_questions",
  "bash",
  "bg_shell",
  "edit",
  "find",
  "glob",
  "grep",
  "fetch_page",
  "search-the-web",
  "ls",
  "read",
  "subagent",
  "write",
  "ToolSearch",
] as const;

/** Tools excluded from the high per-turn loop-guard cap (strict or orchestration). */
const NON_REPEATABLE_FROM_MINIMAL_BASE = new Set<string>([
  "ask_user_questions",
  "subagent",
  "ToolSearch",
]);

/** Additional core tools not in MINIMAL_AUTO_BASE but routinely multi-called per turn. */
const EXTRA_INHERENTLY_REPEATABLE = [
  "gsd_exec",
  "gsd_plan_task",
  "multi_edit",
  "todo_write",
  "notebook_edit",
  "search_and_read",
] as const;

/** Core session tools that may be invoked many times per agent turn. */
export const INHERENTLY_REPEATABLE_TOOL_NAMES = [
  ...MINIMAL_AUTO_BASE_TOOL_NAMES.filter((name) => !NON_REPEATABLE_FROM_MINIMAL_BASE.has(name)),
  ...EXTRA_INHERENTLY_REPEATABLE,
] as const;

export const INHERENTLY_REPEATABLE_TOOL_SET = new Set<string>(INHERENTLY_REPEATABLE_TOOL_NAMES);
