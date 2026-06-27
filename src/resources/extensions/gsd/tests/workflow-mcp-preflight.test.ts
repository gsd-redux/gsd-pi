// Project/App: gsd-pi
// File Purpose: Regression coverage for workflow MCP preflight probing before Claude Code starts a model turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { awaitWorkflowMcpToolRegistration } from "../tool-surface-readiness.ts";
import { clearWorkflowMcpProbeCache } from "../workflow-mcp-readiness-cache.ts";

const SERVER = "gsd-workflow";

test("preflight uses inline workflow MCP config when no project config is persisted", async () => {
  clearWorkflowMcpProbeCache();
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "workflow-mcp-inline-preflight-")));
  try {
    const require = createRequire(import.meta.url);
    const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
    const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
    const serverPath = join(projectRoot, "fake-workflow-mcp-server.mjs");
    writeFileSync(
      serverPath,
      [
        `const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
        `const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
        'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
        'server.tool("gsd_plan_slice", "Plan slice", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
        'server.tool("gsd_reassess_roadmap", "Reassess roadmap", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
        'await server.connect(new StdioServerTransport());',
      ].join("\n"),
      "utf-8",
    );

    const error = await awaitWorkflowMcpToolRegistration({
      unitType: "plan-slice",
      workflowServerName: SERVER,
      projectRoot,
      timeoutMs: 10_000,
      pollMs: 1,
      workflowServerConfig: { command: process.execPath, args: [serverPath] },
    });

    assert.equal(error, null);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("preflight reuses one inline stdio MCP child while polling incomplete tool registration", async () => {
  clearWorkflowMcpProbeCache();
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "workflow-mcp-reuse-preflight-")));
  try {
    const require = createRequire(import.meta.url);
    const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
    const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
    const spawnCountPath = join(projectRoot, "spawn-count.txt");
    const serverPath = join(projectRoot, "incomplete-workflow-mcp-server.mjs");
    writeFileSync(
      serverPath,
      [
        'const { appendFileSync } = await import("node:fs");',
        `appendFileSync(${JSON.stringify(spawnCountPath)}, "spawn\\n");`,
        `const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
        `const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
        'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
        'server.tool("gsd_uat_result_save", "Save UAT result", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
        'await server.connect(new StdioServerTransport());',
      ].join("\n"),
      "utf-8",
    );

    const error = await awaitWorkflowMcpToolRegistration({
      unitType: "run-uat",
      workflowServerName: SERVER,
      projectRoot,
      timeoutMs: 1_000,
      pollMs: 10,
      workflowServerConfig: { command: process.execPath, args: [serverPath] },
    });

    assert.ok(error);
    assert.match(error, /did not register required tools before session start/);
    const spawnCount = readFileSync(spawnCountPath, "utf-8").trim().split("\n").filter(Boolean).length;
    assert.equal(spawnCount, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("preflight timeout includes the last probe error", async () => {
  clearWorkflowMcpProbeCache();
  const error = await awaitWorkflowMcpToolRegistration({
    unitType: "run-uat",
    workflowServerName: SERVER,
    projectRoot: "/tmp/project",
    timeoutMs: 5,
    pollMs: 1,
    probe: async () => ({ ok: false, tools: [], error: "Unknown MCP server." }),
  });

  assert.ok(error);
  assert.match(error, /last probe error: Unknown MCP server\./);
});

test("preflight timeout does not report stale error when a later probe connects without error", async () => {
  clearWorkflowMcpProbeCache();
  let call = 0;
  // First call throws a connection error; subsequent calls return a successful
  // connection with no error but without the required tools (server connected,
  // tools not yet registered).
  const probe = async (): Promise<{ ok: boolean; tools: string[]; error?: string }> => {
    if (call++ === 0) throw new Error("Unknown MCP server.");
    return { ok: false, tools: [], error: undefined };
  };

  const error = await awaitWorkflowMcpToolRegistration({
    unitType: "run-uat",
    workflowServerName: SERVER,
    projectRoot: "/tmp/project",
    timeoutMs: 20,
    pollMs: 1,
    probe,
  });

  assert.ok(error);
  // The stale connection-failure error should have been cleared once the later
  // probe returned a result without an error field.
  assert.doesNotMatch(error, /last probe error/);
});
