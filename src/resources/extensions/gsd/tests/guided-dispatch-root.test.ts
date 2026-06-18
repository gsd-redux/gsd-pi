// gsd-pi — Guided workflow dispatch project-root tests.
// Verifies smart entry dispatch uses the explicit project root instead of cwd.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _dispatchWorkflowForTest,
  resolveGuidedDispatchProjectRoot,
} from "../guided-flow.ts";
import { getRequiredWorkflowToolsForUnit } from "../unit-tool-contracts.ts";

test("guided dispatch falls back to cwd only when no project root is supplied", () => {
  const cwd = process.cwd();
  assert.equal(resolveGuidedDispatchProjectRoot(), cwd);
  assert.equal(resolveGuidedDispatchProjectRoot("/tmp/explicit-root"), "/tmp/explicit-root");
});

test("guided dispatch passes the explicit project root through model and compatibility checks", async () => {
  const explicitRoot = mkdtempSync(join(tmpdir(), "gsd-guided-root-explicit-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "gsd-guided-root-cwd-"));
  const workflowPath = join(explicitRoot, "GSD-WORKFLOW.md");
  const originalWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const originalCwd = process.cwd();
  const seen = {
    prefsRoot: "",
    modelRoot: "",
    compatibilityRoot: "",
    sent: false,
  };

  const ctx = {
    model: { provider: "local-provider" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
    },
    ui: {
      notify: () => {},
    },
  };

  const pi = {
    getActiveTools: () => ["gsd_plan_slice"],
    setActiveTools: () => {},
    sendMessage: () => {
      seen.sent = true;
    },
  };

  try {
    writeFileSync(workflowPath, "# Workflow\n", "utf-8");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    process.chdir(otherRoot);

    await _dispatchWorkflowForTest(
      pi as any,
      "Plan the slice.",
      "gsd-run",
      ctx as any,
      "plan-slice",
      {
        basePath: explicitRoot,
        deps: {
          loadPreferences: (projectRoot?: string) => {
            seen.prefsRoot = projectRoot ?? "";
            return { preferences: {} } as any;
          },
          selectModel: async (
            _ctx: unknown,
            _pi: unknown,
            _unitType: string,
            _unitId: string,
            projectRoot: string,
          ) => {
            seen.modelRoot = projectRoot;
            return { routing: null, appliedModel: null };
          },
          getDispatchReadinessError: (input: { projectRoot?: string }) => {
            seen.compatibilityRoot = input.projectRoot ?? "";
            return null;
          },
        },
      },
    );

    assert.equal(seen.prefsRoot, explicitRoot);
    assert.equal(seen.modelRoot, explicitRoot);
    assert.equal(seen.compatibilityRoot, explicitRoot);
    assert.equal(seen.sent, true);
  } finally {
    process.chdir(originalCwd);
    if (originalWorkflowPath === undefined) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = originalWorkflowPath;
    }
    rmSync(explicitRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("guided dispatch accepts workflow MCP tools absent from parent active tool surface", async () => {
  const explicitRoot = mkdtempSync(join(tmpdir(), "gsd-guided-mcp-surface-"));
  const workflowPath = join(explicitRoot, "GSD-WORKFLOW.md");
  const originalWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const originalMcpCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const notifications: string[] = [];
  let sent = false;

  const ctx = {
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
    modelRegistry: {
      getProviderAuthMode: () => "externalCli",
    },
    ui: {
      setStatus: () => {},
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };

  let activeTools = [
    "ScheduleWakeup",
    "ToolSearch",
    "ask_user_questions",
    "bash",
    "read",
    "write",
  ];

  // The workflow MCP server registers its tools out of band, so the unit's
  // required workflow tools show up in the registered tool snapshot
  // (getAllTools) under the MCP server prefix without ever entering the parent
  // session's active tool surface (getActiveTools). This is exactly the shape
  // the readiness gate must accept. Derive the surface from the unit contract
  // so this test stays correct if discuss-milestone's required tools change.
  const registeredTools = [
    ...activeTools,
    ...getRequiredWorkflowToolsForUnit("discuss-milestone").map(
      (tool) => `mcp__gsd-workflow__${tool}`,
    ),
  ];

  const pi = {
    getActiveTools: () => [...activeTools],
    getAllTools: () => registeredTools.map((name) => ({ name })),
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
    sendMessage: () => {
      sent = true;
    },
  };

  try {
    writeFileSync(workflowPath, "# Workflow\n", "utf-8");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    process.env.GSD_WORKFLOW_MCP_COMMAND = "node";

    await _dispatchWorkflowForTest(
      pi as any,
      "Discuss the milestone.",
      "gsd-discuss",
      ctx as any,
      "discuss-milestone",
      {
        basePath: explicitRoot,
        deps: {
          loadPreferences: () => ({ preferences: {} }) as any,
          selectModel: (async () => ({
            routing: null,
            appliedModel: {
              provider: "claude-code",
              id: "claude-opus-4-8",
              baseUrl: "local://claude-code",
            },
          })) as any,
        },
      },
    );

    assert.equal(sent, true);
    assert.equal(
      notifications.some((message) => message.includes("cannot run guided flow")),
      false,
    );
  } finally {
    if (originalWorkflowPath === undefined) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = originalWorkflowPath;
    }
    if (originalMcpCommand === undefined) {
      delete process.env.GSD_WORKFLOW_MCP_COMMAND;
    } else {
      process.env.GSD_WORKFLOW_MCP_COMMAND = originalMcpCommand;
    }
    rmSync(explicitRoot, { recursive: true, force: true });
  }
});
