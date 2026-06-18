// Project/App: gsd-pi
// File Purpose: Tests for the MCP readiness preflight gate in dispatchWorkflow.

import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { _awaitWorkflowMcpReadinessForTest as awaitWorkflowMcpReadiness } from "../guided-flow.ts";
import { clearMcpConfigCache } from "../../mcp-client/manager.ts";
import { clearWorkflowMcpProbeCache } from "../workflow-mcp-readiness-cache.ts";

function makeCtx(opts: { authMode?: string; baseUrl?: string; systemPrompt?: string } = {}) {
  const { authMode = "externalCli", baseUrl = "local://pipe", systemPrompt = "" } = opts;
  return {
    model: { provider: "anthropic", baseUrl },
    modelRegistry: {
      getProviderAuthMode: mock.fn(() => authMode),
    },
    getSystemPrompt: mock.fn(() => systemPrompt),
    ui: {
      setStatus: mock.fn(),
      notify: mock.fn(),
    },
  } as any;
}

function makePi(tools: string[] | (() => string[])) {
  const getTools = typeof tools === "function" ? tools : () => tools;
  return {
    getActiveTools: getTools,
    getAllTools: () => getTools().map((name: string) => ({ name })),
  } as any;
}

describe("awaitWorkflowMcpReadiness", () => {
  test("returns null (ready) when not using MCP transport", async () => {
    clearWorkflowMcpProbeCache();
    const ctx = makeCtx({ authMode: "native", baseUrl: "https://api.anthropic.com" });
    const pi = makePi([]);
    assert.equal(await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path"), null);
  });

  test("returns null (ready) when provider has no auth mode", async () => {
    const ctx = {
      model: undefined,
      modelRegistry: { getProviderAuthMode: mock.fn(() => undefined) },
      ui: { setStatus: mock.fn(), notify: mock.fn() },
    } as any;
    const pi = makePi([]);
    assert.equal(await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path"), null);
  });

  test("returns null (ready) when MCP tools are already registered", async () => {
    const ctx = makeCtx();
    const pi = makePi(["read", "bash", "mcp__gsd-workflow__ask_user_questions", "mcp__gsd-workflow__gsd_plan_slice"]);
    assert.equal(await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path"), null);
  });

  test("returns null (ready) when host system prompt advertises workflow MCP tools", async () => {
    const originalCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
    const ctx = makeCtx({
      systemPrompt: "Available tools: read, bash, mcp__gsd-workflow__ask_user_questions",
    });
    const pi = makePi(["read", "bash"]);
    try {
      process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
      assert.equal(await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path"), null);
    } finally {
      if (originalCommand === undefined) {
        delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      } else {
        process.env.GSD_WORKFLOW_MCP_COMMAND = originalCommand;
      }
    }
  });

  test("treats a successful direct probe as readiness when session tools are absent", async () => {
    const previousGsdHome = process.env.GSD_HOME;
    const projectDir = mkdtempSync(join(tmpdir(), "gsd-guided-mcp-probe-project-"));
    const gsdHomeDir = mkdtempSync(join(tmpdir(), "gsd-guided-mcp-probe-home-"));
    try {
      process.env.GSD_HOME = gsdHomeDir;
      mkdirSync(join(projectDir, ".gsd"), { recursive: true });

      const require = createRequire(import.meta.url);
      const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
      const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
      const serverPath = join(projectDir, "fake-workflow-mcp-server.mjs");
      writeFileSync(
        serverPath,
        [
          `const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
          `const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
          'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
          'server.tool("gsd_status", "Probe-visible workflow tool", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
          'await server.connect(new StdioServerTransport());',
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        join(projectDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { "gsd-workflow": { command: process.execPath, args: [serverPath] } } }),
        "utf-8",
      );

      const ctx = makeCtx();
      const pi = makePi(["read", "bash"]);

      assert.equal(
        await awaitWorkflowMcpReadiness(pi, ctx, projectDir, { timeoutMs: 15_000, pollMs: 100 }),
        null,
      );
    } finally {
      if (previousGsdHome === undefined) {
        delete process.env.GSD_HOME;
      } else {
        process.env.GSD_HOME = previousGsdHome;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(gsdHomeDir, { recursive: true, force: true });
      clearMcpConfigCache();
    }
  });

  test("returns server and probe error when workflow MCP never becomes ready", async () => {
    const originalCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
    const ctx = makeCtx();
    const pi = makePi(["read", "bash"]);
    try {
      process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
      const failure = await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path", {
        timeoutMs: 5,
        pollMs: 1,
        probe: async () => ({
          ok: false,
          tools: [],
          serverName: "gsd-workflow",
          error: "connection refused",
        }),
      });
      assert.deepEqual(failure, { server: "gsd-workflow", error: "connection refused" });
      assert.ok(ctx.ui.setStatus.mock.calls.length >= 2);
    } finally {
      if (originalCommand === undefined) {
        delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      } else {
        process.env.GSD_WORKFLOW_MCP_COMMAND = originalCommand;
      }
    }
  });

  test("returns null (ready) when MCP tools appear during polling", async () => {
    const ctx = makeCtx();
    let callCount = 0;
    const pi = makePi(() => {
      callCount++;
      if (callCount >= 3) return ["mcp__gsd-workflow__gsd_plan_slice"];
      return ["read", "bash"];
    });
    assert.equal(await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path"), null);
    assert.ok(callCount >= 3, `expected at least 3 tool-check calls, got ${callCount}`);
    assert.ok(ctx.ui.setStatus.mock.calls.length >= 2);
  });

  test("requires the active unit's workflow tools, not just any MCP workflow tool", async () => {
    const originalCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
    const ctx = makeCtx();
    const pi = makePi(["read", "bash", "mcp__gsd-workflow__gsd_slice_complete"]);
    try {
      process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
      const failure = await awaitWorkflowMcpReadiness(pi, ctx, "/fake/path", {
        unitType: "complete-slice",
        timeoutMs: 5,
        pollMs: 1,
        probe: async () => ({
          ok: true,
          tools: ["gsd_slice_complete"],
          serverName: "gsd-workflow",
        }),
      });

      assert.deepEqual(failure, { server: "gsd-workflow" });
    } finally {
      if (originalCommand === undefined) {
        delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      } else {
        process.env.GSD_WORKFLOW_MCP_COMMAND = originalCommand;
      }
    }
  });

  test("returns null when no launch config is discoverable", async () => {
    const ctx = makeCtx();
    const pi = makePi(["read", "bash"]);
    const launch = (await import("../workflow-mcp.js")).detectWorkflowMcpLaunchConfig(process.cwd());
    if (!launch) {
      assert.equal(await awaitWorkflowMcpReadiness(pi, ctx, process.cwd()), null);
    }
    // When launch config IS found, the function would timeout (15s) — skip that path in tests.
  });
});
