// Project/App: gsd-pi
// File Purpose: Tests for opt-in GSD tool surface reduction.

import assert from "node:assert/strict";
import test from "node:test";

import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";
import { buildMinimalAutoGsdToolSet, buildMinimalGsdToolSet, buildMinimalGsdWorkflowToolSet, buildRequestScopedGsdToolSet, MINIMAL_AUTO_BASE_TOOL_NAMES, MINIMAL_GSD_TOOL_NAMES, requestHasGsdCustomType, restoreGsdWorkflowTools, scopeGsdWorkflowToolsForDispatch } from "../bootstrap/register-hooks.ts";
import { applyUnitSkillVisibility } from "../skill-scope.ts";

test("buildMinimalGsdToolSet preserves non-GSD tools and replaces broad GSD surface", () => {
  const result = buildMinimalGsdToolSet([
    "bash",
    "read",
    "browser_open",
    "gsd_plan_milestone",
    "gsd_task_complete",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "capture_thought",
    "gsd_graph",
  ]);

  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_open"));
  for (const toolName of MINIMAL_GSD_TOOL_NAMES) {
    assert.ok(result.includes(toolName), `expected ${toolName}`);
  }
  assert.ok(!result.includes("gsd_plan_milestone"));
  assert.ok(!result.includes("gsd_task_complete"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildMinimalGsdToolSet deduplicates preserved and minimal tools", () => {
  const result = buildMinimalGsdToolSet(["bash", "bash", "memory_query"]);

  assert.deepEqual(result.filter((toolName) => toolName === "bash"), ["bash"]);
  assert.deepEqual(result.filter((toolName) => toolName === "memory_query"), ["memory_query"]);
});

test("buildMinimalGsdToolSet does not reintroduce provider-filtered GSD tools", () => {
  const result = buildMinimalGsdToolSet(["bash", "read", "memory_query"]);

  assert.deepEqual(result, ["bash", "read", "memory_query", "ToolSearch"]);
  assert.ok(!result.includes("gsd_exec"));
});

test("buildMinimalGsdToolSet always preserves ToolSearch shim", () => {
  const result = buildMinimalGsdToolSet(["bash", "read"]);
  assert.ok(result.includes("ToolSearch"));
});

test("requestHasGsdCustomType detects GSD-driven requests (drives interactive default scoping)", () => {
  // Plain interactive chat → no gsd-* customType → scoped to the minimal set.
  assert.equal(requestHasGsdCustomType(undefined), false);
  assert.equal(requestHasGsdCustomType([]), false);
  assert.equal(requestHasGsdCustomType([{ customType: "user" }, {}]), false);
  // GSD workflow commands carry a gsd-* customType → keep their full surface.
  assert.equal(requestHasGsdCustomType([{ customType: "gsd-quick-task" }]), true);
  assert.equal(requestHasGsdCustomType([{}, { customType: "gsd-workflow-template" }]), true);
  assert.equal(requestHasGsdCustomType([{ customType: "gsd-run" }]), true);
});

test("buildMinimalAutoGsdToolSet keeps unit-specific completion tools without aliases", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "read",
    "lsp",
    "browser_click",
    "gsd_task_complete",
    "gsd_complete_task",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_slice_complete",
    "gsd_complete_slice",
    "memory_query",
    "capture_thought",
  ], "execute-task");

  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("memory_query"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("browser_click"));
  assert.ok(!result.includes("gsd_complete_task"));
  assert.ok(!result.includes("gsd_slice_complete"));
  assert.ok(!result.includes("gsd_complete_slice"));
});

test("buildMinimalAutoGsdToolSet re-resolves run-uat browser tools from the registry when dropped from the active set", () => {
  // B2 drops the browser surface from the advertised interactive set, but the
  // tools stay registered. run-uat must still get them: resolution reads the
  // full registry, not just the (browser-stripped) active set.
  const active = ["ask_user_questions", "bash", "read", "gsd_summary_save"];
  const registered = [
    ...active,
    "browser_navigate",
    "browser_click",
    "browser_snapshot_refs",
    "gsd_exec",
  ];
  const result = buildMinimalAutoGsdToolSet(active, "run-uat", registered);
  assert.ok(result.includes("browser_navigate"), "run-uat needs browser_navigate");
  assert.ok(result.includes("browser_click"), "run-uat needs browser_click");
  assert.ok(result.includes("gsd_summary_save"));
});

test("buildMinimalAutoGsdToolSet keeps only the auto base non-GSD tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "browser_wait_for",
    "edit",
    "find",
    "glob",
    "grep",
    "fetch_page",
    "search-the-web",
    "lsp",
    "ls",
    "mac_find",
    "read",
    "subagent",
    "write",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "capture_thought",
  ], "execute-task");

  for (const toolName of MINIMAL_AUTO_BASE_TOOL_NAMES) {
    assert.ok(result.includes(toolName), `expected ${toolName}`);
  }
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("mac_find"));
  assert.ok(result.includes("subagent"));
});

test("buildMinimalAutoGsdToolSet re-injects registered base tools filtered from the active set", () => {
  const registered = [
    "bash",
    "read",
    "grep",
    "find",
    "fetch_page",
    "search-the-web",
    "gsd_task_complete",
    "memory_query",
  ];
  const result = buildMinimalAutoGsdToolSet(
    ["bash", "read", "gsd_task_complete", "memory_query"],
    "execute-task",
    registered,
  );

  assert.ok(result.includes("grep"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("fetch_page"));
  assert.ok(result.includes("search-the-web"));
});

test("buildMinimalAutoGsdToolSet preserves browser tools for run-uat", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_assert",
    "browser_screenshot",
    "browser_wait_for",
    "gsd_summary_save",
    "gsd_task_complete",
    "memory_query",
    "capture_thought",
  ], "run-uat");

  assert.ok(result.includes("browser_navigate"));
  assert.ok(result.includes("browser_click"));
  assert.ok(result.includes("browser_type"));
  assert.ok(result.includes("browser_assert"));
  assert.ok(result.includes("browser_screenshot"));
  assert.ok(result.includes("browser_wait_for"));
  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_task_complete"));
});

test("buildMinimalAutoGsdToolSet prefers MCP browser tools for run-uat when available", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "browser_navigate",
    "browser_click",
    "mcp__gsd-browser__browser_navigate",
    "mcp__gsd-browser__browser_click",
    "gsd_summary_save",
  ], "run-uat");

  assert.ok(result.includes("mcp__gsd-browser__browser_navigate"));
  assert.ok(result.includes("mcp__gsd-browser__browser_click"));
  assert.ok(!result.includes("browser_navigate"));
  assert.ok(!result.includes("browser_click"));
});

test("buildMinimalAutoGsdToolSet includes discuss-slice persistence tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_plan_slice",
    "gsd_task_complete",
    "memory_query",
    "capture_thought",
  ], "discuss-slice");

  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(result.includes("gsd_decision_save"));
  assert.ok(!result.includes("gsd_plan_slice"));
  assert.ok(!result.includes("gsd_task_complete"));
});

test("buildMinimalAutoGsdToolSet includes closeout tool for complete-slice", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "subagent",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_task_complete",
    "gsd_task_reopen",
    "gsd_replan_slice",
    "gsd_slice_complete",
    "gsd_complete_slice",
    "memory_query",
    "capture_thought",
  ], "complete-slice");

  assert.ok(result.includes("gsd_slice_complete"));
  assert.ok(result.includes("gsd_task_reopen"));
  assert.ok(result.includes("gsd_replan_slice"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("capture_thought"));
  assert.ok(!result.includes("gsd_task_complete"));
  assert.ok(!result.includes("gsd_complete_slice"));
});

test("buildMinimalAutoGsdToolSet preserves workflow MCP-namespaced closeout tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_task_reopen",
    "mcp__gsd-workflow__gsd_replan_slice",
    "mcp__gsd-workflow__gsd_slice_complete",
    "mcp__gsd-workflow__gsd_complete_slice",
    "mcp__gsd-workflow__gsd_exec",
    "mcp__gsd-workflow__memory_query",
    "mcp__gsd-workflow__capture_thought",
  ], "complete-slice");

  assert.ok(result.includes("mcp__gsd-workflow__gsd_task_reopen"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_replan_slice"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_slice_complete"));
  assert.ok(!result.includes("mcp__gsd-workflow__gsd_complete_slice"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_exec"));
  assert.ok(result.includes("mcp__gsd-workflow__memory_query"));
  assert.ok(result.includes("mcp__gsd-workflow__capture_thought"));
});

test("buildMinimalAutoGsdToolSet covers execute-task-simple", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_task_complete",
    "gsd_decision_save",
    "gsd_plan_task",
    "memory_query",
    "capture_thought",
  ], "execute-task-simple");

  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_decision_save"));
  assert.ok(!result.includes("gsd_plan_task"));
});

test("buildMinimalGsdWorkflowToolSet keeps workflow GSD tools but drops broad non-GSD tools", () => {
  const result = buildMinimalGsdWorkflowToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "browser_wait_for",
    "edit",
    "lsp",
    "mac_find",
    "read",
    "subagent",
    "write",
    "gsd_plan_milestone",
    "gsd_complete_milestone",
    "gsd_task_complete",
    "gsd_summary_save",
    "memory_query",
    "capture_thought",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_graph",
  ]);

  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("bg_shell"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("write"));
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(result.includes("gsd_complete_milestone"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("mac_find"));
  assert.ok(result.includes("subagent"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildMinimalGsdWorkflowToolSet pulls investigation tools from registered names", () => {
  const result = buildMinimalGsdWorkflowToolSet(
    ["bash", "read", "write", "gsd_summary_save"],
    ["bash", "read", "write", "grep", "find", "ls", "gsd_summary_save"],
  );

  assert.ok(result.includes("grep"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("ls"));
});

test("buildRequestScopedGsdToolSet keeps grep for guided discuss-milestone requests", () => {
  const result = buildRequestScopedGsdToolSet(
    ["bash", "read", "write", "gsd_summary_save"],
    [{ customType: "gsd-discuss" }],
    ["bash", "read", "write", "grep", "find", "ls", "gsd_summary_save", "gsd_requirement_update"],
    "discuss-milestone",
  );

  assert.ok(result?.includes("grep"));
  assert.ok(result?.includes("gsd_requirement_update"));
  assert.ok(!result?.includes("gsd_task_complete"));
});

test("buildRequestScopedGsdToolSet scopes queued workflow custom-message requests", () => {
  const result = buildRequestScopedGsdToolSet([
    "ask_user_questions",
    "bash",
    "browser_wait_for",
    "lsp",
    "read",
    "write",
    "gsd_plan_milestone",
    "gsd_complete_milestone",
    "gsd_task_complete",
    "gsd_graph",
    "memory_query",
    "capture_thought",
  ], [{ customType: "gsd-run" }, { customType: "gsd-memory" }]);

  assert.ok(result);
  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("write"));
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(result.includes("gsd_complete_milestone"));
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildRequestScopedGsdToolSet ignores stale workflow messages outside the current request tail", () => {
  assert.equal(buildRequestScopedGsdToolSet(["bash", "gsd_plan_milestone"], []), undefined);
});

test("discuss-milestone dispatch keeps required headless milestone tools after two-stage scoping", () => {
  let activeTools = [
    "ask_user_questions",
    "bash",
    "read",
    "write",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_requirement_save",
    "gsd_requirement_update",
    "gsd_plan_milestone",
    "gsd_milestone_generate_id",
    "gsd_complete_milestone",
    "gsd_task_complete",
  ];

  activeTools = activeTools.filter((toolName) =>
    !toolName.startsWith("gsd_") ||
    DISCUSS_TOOLS_ALLOWLIST.includes(toolName)
  );

  scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
  }, "discuss-milestone");

  assert.ok(activeTools.includes("ask_user_questions"));
  assert.ok(activeTools.includes("gsd_summary_save"));
  assert.ok(activeTools.includes("gsd_requirement_save"));
  assert.ok(activeTools.includes("gsd_requirement_update"));
  assert.ok(activeTools.includes("gsd_plan_milestone"));
  assert.ok(activeTools.includes("gsd_milestone_generate_id"));
  assert.ok(!activeTools.includes("gsd_task_complete"));
  assert.ok(!activeTools.includes("gsd_complete_milestone"));
});

test("scopeGsdWorkflowToolsForDispatch applies and restores per-unit skill visibility", () => {
  const calls: Array<{ kind: "tools" | "skills"; value: string[] | undefined }> = [];
  let activeTools = [
    "bash",
    "read",
    "lsp",
    "gsd_plan_milestone",
    "gsd_decision_save",
    "memory_query",
    "capture_thought",
  ];
  let visibleSkills: string[] | undefined = ["previous-skill"];

  const state = scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = names;
      calls.push({ kind: "tools", value: names });
    },
    getVisibleSkills: () => visibleSkills,
    setVisibleSkills: (names) => {
      visibleSkills = names;
      calls.push({ kind: "skills", value: names });
    },
  }, "plan-milestone");

  assert.ok(state);
  assert.deepEqual(visibleSkills, [
    "write-milestone-brief",
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "write-docs",
    "api-design",
    "tdd",
    "verify-before-complete",
  ]);
  assert.ok(!activeTools.includes("lsp"));

  restoreGsdWorkflowTools({
    setActiveTools: (names) => {
      activeTools = names;
      calls.push({ kind: "tools", value: names });
    },
    setVisibleSkills: (names) => {
      visibleSkills = names;
      calls.push({ kind: "skills", value: names });
    },
  }, state);

  assert.deepEqual(activeTools, [
    "bash",
    "read",
    "lsp",
    "gsd_plan_milestone",
    "gsd_decision_save",
    "memory_query",
    "capture_thought",
  ]);
  assert.deepEqual(visibleSkills, ["previous-skill"]);
  assert.equal(calls.filter((call) => call.kind === "skills").length, 2);
});

test("applyUnitSkillVisibility sets manifest or clears for wildcard", () => {
  const calls: Array<string[] | undefined> = [];
  applyUnitSkillVisibility({
    setVisibleSkills: (names) => {
      calls.push(names);
    },
  }, "plan-milestone");
  assert.ok(Array.isArray(calls[0]));
  assert.ok(calls[0]!.includes("tdd"));

  applyUnitSkillVisibility({
    setVisibleSkills: (names) => {
      calls.push(names);
    },
  }, "execute-task");
  assert.equal(calls[1], undefined);
});
