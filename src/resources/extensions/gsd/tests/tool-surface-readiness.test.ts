// Project/App: gsd-pi
// File Purpose: Contract coverage for the Tool Surface Readiness gate and its recovery classification.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { getToolSurfaceReadinessError, awaitWorkflowMcpToolRegistration } from "../tool-surface-readiness.ts";
import { clearWorkflowMcpProbeCache, recordWorkflowMcpProbe } from "../workflow-mcp-readiness-cache.ts";
import { isToolUnavailableError } from "../auto-tool-tracking.ts";
import { classifyError, isTransient } from "../error-classifier.ts";
import { toMcpToolName } from "../mcp-tool-name.ts";
import { classifyFailure } from "../recovery-classification.ts";

const SERVER = "gsd-workflow";

function prefixed(tool: string): string {
  return toMcpToolName(SERVER, tool);
}

const RUN_UAT_TOOLS = [
  "gsd_uat_exec",
  "gsd_uat_result_save",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_journal_query",
];

describe("getToolSurfaceReadinessError", () => {
  test("returns null when no unit type or no workflow server is in play", () => {
    const observation = { tools: [], mcpServers: [] };
    assert.equal(
      getToolSurfaceReadinessError({ unitType: undefined, workflowServerName: SERVER, observation }),
      null,
    );
    assert.equal(
      getToolSurfaceReadinessError({ unitType: "run-uat", workflowServerName: undefined, observation }),
      null,
    );
  });

  test("returns null for units with no required workflow tools", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "rewrite-docs",
      workflowServerName: SERVER,
      observation: { tools: [], mcpServers: [{ name: SERVER, status: "failed" }] },
    });
    assert.equal(error, null);
  });

  test("returns an error when the expected workflow server is absent from the init surface", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: "other-server", status: "connected" }] },
    });
    assert.ok(error, "expected a readiness error when the workflow server is absent");
    assert.match(error, /workflow tool surface not ready for run-uat/);
    assert.match(error, /absent from the init surface/);
    assert.match(error, /gsd_uat_exec/);
  });

  test("still blocks pending init when required tools are absent from the live surface", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "pending" }] },
    });
    assert.ok(error);
    assert.match(error!, /status is "pending"/);
    assert.match(error!, /gsd_uat_exec/);
  });

  test("accepts pending server status when the live init surface already contains every required tool", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: [
          prefixed("gsd_uat_exec"),
          prefixed("gsd_uat_result_save"),
          prefixed("gsd_resume"),
          prefixed("gsd_milestone_status"),
          prefixed("gsd_journal_query"),
        ],
        mcpServers: [{ name: SERVER, status: "pending" }],
      },
    });
    assert.equal(error, null);
  });

  test("does not accept a pending live init surface just because a probe cache covers required tools", () => {
    clearWorkflowMcpProbeCache();
    const projectRoot = "/tmp/project-discuss-probe";
    recordWorkflowMcpProbe(projectRoot, SERVER, [
      "ask_user_questions",
      "gsd_summary_save",
      "gsd_requirement_save",
      "gsd_requirement_update",
      "gsd_plan_milestone",
      "gsd_milestone_generate_id",
    ]);

    const error = getToolSurfaceReadinessError({
      unitType: "discuss-milestone",
      workflowServerName: SERVER,
      projectRoot,
      observation: {
        tools: [],
        mcpServers: [{ name: SERVER, status: "pending" }],
      },
    });

    assert.ok(error, "expected live init tools to be authoritative over direct probe cache");
    assert.match(error, /status is "pending"/);
    assert.match(error, /ask_user_questions/);
  });

  test("pending server status reports only required tools missing from the live init surface", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: [
          prefixed("gsd_uat_result_save"),
          prefixed("gsd_resume"),
          prefixed("gsd_milestone_status"),
          prefixed("gsd_journal_query"),
        ],
        mcpServers: [{ name: SERVER, status: "pending" }],
      },
    });
    assert.ok(error, "expected a readiness error while gsd_uat_exec is still absent");
    assert.match(error, /status is "pending"/);
    assert.match(error, /gsd_uat_exec/);
    assert.doesNotMatch(error, /gsd_uat_result_save/);
  });

  test("returns null when all required tools are registered under the MCP prefix", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: ["read", ...RUN_UAT_TOOLS.map(prefixed)],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.equal(error, null);
  });

  test("reports the failed server as terminal", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "failed" }] },
    });
    assert.ok(error, "expected a readiness error");
    assert.match(error, /workflow tool surface not ready for run-uat/);
    assert.match(error, /terminal/);
  });

  test("reports terminal status even when required tools are already on the init surface", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: RUN_UAT_TOOLS.map(prefixed),
        mcpServers: [{ name: SERVER, status: "failed" }],
      },
    });
    assert.ok(error, "expected a readiness error despite tools on the surface");
    assert.match(error, /terminal/);
    assert.match(error, /gsd_uat_exec/);
  });

  test("aborts on needs-auth (terminal — cannot self-heal)", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "needs-auth" }] },
    });
    assert.ok(error, "expected a readiness error for needs-auth");
    assert.match(error, /terminal/);
  });

  test("aborts on disabled (terminal — cannot self-heal)", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "disabled" }] },
    });
    assert.ok(error, "expected a readiness error for disabled");
    assert.match(error, /terminal/);
  });

  test("reports partially-registered surfaces even when the server says connected", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: [prefixed("gsd_uat_exec")],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.ok(error, "expected a readiness error");
    assert.match(error, /connected but has not registered/);
    assert.match(error, /gsd_uat_result_save/);
    assert.doesNotMatch(error, /gsd_uat_exec,/);
  });

  test("reports the screenshot case: result save registered but UAT exec missing", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: [
          prefixed("gsd_uat_result_save"),
          prefixed("gsd_resume"),
          prefixed("gsd_milestone_status"),
          prefixed("gsd_journal_query"),
        ],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.ok(error, "expected a readiness error when gsd_uat_exec is absent");
    assert.match(error, /connected but has not registered/);
    assert.match(error, /gsd_uat_exec/);
    assert.doesNotMatch(error, /gsd_uat_result_save/);
  });
});

describe("awaitWorkflowMcpToolRegistration", () => {
  test("does not skip live probe when cache already covers required tools", async () => {
    clearWorkflowMcpProbeCache();
    const { recordWorkflowMcpProbe } = await import("../workflow-mcp-readiness-cache.ts");
    recordWorkflowMcpProbe("/tmp/project-cache-hit", SERVER, RUN_UAT_TOOLS);

    let probeCalls = 0;
    const error = await awaitWorkflowMcpToolRegistration({
      unitType: "run-uat",
      workflowServerName: SERVER,
      projectRoot: "/tmp/project-cache-hit",
      timeoutMs: 1,
      pollMs: 1,
      probe: async () => {
        probeCalls += 1;
        return { ok: true, tools: RUN_UAT_TOOLS };
      },
    });
    assert.equal(error, null);
    assert.ok(probeCalls > 0, "preflight must probe the live MCP server even when cache is warm");
  });

  test("resolves when probe reports required tools", async () => {
    clearWorkflowMcpProbeCache();
    const error = await awaitWorkflowMcpToolRegistration({
      unitType: "run-uat",
      workflowServerName: SERVER,
      projectRoot: "/tmp/project",
      timeoutMs: 1_000,
      pollMs: 1,
      probe: async () => ({
        ok: true,
        tools: RUN_UAT_TOOLS,
      }),
    });
    assert.equal(error, null);
  });

  test("times out when required tools never register", async () => {
    clearWorkflowMcpProbeCache();
    const error = await awaitWorkflowMcpToolRegistration({
      unitType: "run-uat",
      workflowServerName: SERVER,
      projectRoot: "/tmp/project",
      timeoutMs: 5,
      pollMs: 1,
      probe: async () => ({ ok: true, tools: ["gsd_uat_result_save"] }),
    });
    assert.ok(error);
    assert.match(error!, /did not register required tools before session start/);
  });

  test("aborts while waiting for workflow MCP tools", async () => {
    clearWorkflowMcpProbeCache();
    const controller = new AbortController();
    let probeCount = 0;
    const wait = awaitWorkflowMcpToolRegistration({
      unitType: "run-uat",
      workflowServerName: SERVER,
      projectRoot: "/tmp/project-abort",
      timeoutMs: 10_000,
      pollMs: 10_000,
      signal: controller.signal,
      probe: async () => {
        probeCount += 1;
        return { ok: true, tools: ["gsd_uat_result_save"] };
      },
    });

    controller.abort();

    await assert.rejects(wait, /AbortError/);
    assert.equal(probeCount, 1);
  });
});

describe("readiness error classification contract", () => {
  const readinessError = getToolSurfaceReadinessError({
    unitType: "run-uat",
    workflowServerName: SERVER,
    observation: { tools: [], mcpServers: [{ name: SERVER, status: "failed" }] },
  })!;

  test("auto-tool-tracking treats the readiness error as tool-unavailable", () => {
    assert.equal(isToolUnavailableError(readinessError), true);
  });

  test("error-classifier treats the readiness error as transient", () => {
    const cls = classifyError(`Claude Code error: ${readinessError}`);
    assert.equal(isTransient(cls), true);
  });

  test("Recovery Classification maps the readiness error to tool-unavailable → retry", () => {
    const recovery = classifyFailure({ error: new Error(readinessError), unitType: "run-uat", unitId: "M001" });
    assert.equal(recovery.failureKind, "tool-unavailable");
    assert.equal(recovery.action, "retry");
    assert.equal(recovery.exitReason, "tool-unavailable");
  });
});
