// Project/App: gsd-pi
// File Purpose: Tests for shared workflow MCP probe cache.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  cachedWorkflowMcpCoversRequired,
  clearWorkflowMcpProbeCache,
  getCachedWorkflowMcpProbe,
  probeAndCacheWorkflowMcp,
  recordWorkflowMcpProbe,
  beginWorkflowMcpSdkSession,
  endWorkflowMcpSdkSession,
  warmWorkflowMcpProbeInBackground,
} from "../workflow-mcp-readiness-cache.ts";

describe("workflow-mcp-readiness-cache", () => {
  test("returns cached probe without reconnecting", async () => {
    clearWorkflowMcpProbeCache();
    const projectRoot = "/tmp/gsd-cache-project";
    recordWorkflowMcpProbe(projectRoot, "gsd-workflow", ["gsd_status", "gsd_plan_slice"]);

    const result = await probeAndCacheWorkflowMcp(projectRoot, { timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, ["gsd_status", "gsd_plan_slice"]);
    assert.equal(result.serverName, "gsd-workflow");
  });

  test("cachedWorkflowMcpCoversRequired matches required workflow tools", () => {
    clearWorkflowMcpProbeCache();
    const projectRoot = "/tmp/gsd-cache-required";
    recordWorkflowMcpProbe(projectRoot, "gsd-workflow", ["gsd_plan_slice", "gsd_milestone_status"]);

    assert.equal(
      cachedWorkflowMcpCoversRequired(projectRoot, "gsd-workflow", ["gsd_plan_slice"]),
      true,
    );
    assert.equal(
      cachedWorkflowMcpCoversRequired(projectRoot, "gsd-workflow", ["gsd_uat_exec"]),
      false,
    );
    assert.equal(getCachedWorkflowMcpProbe(projectRoot)?.serverName, "gsd-workflow");
  });

  test("warmWorkflowMcpProbeInBackground is suppressed during active SDK sessions", async () => {
    clearWorkflowMcpProbeCache();
    beginWorkflowMcpSdkSession();
    try {
      const projectRoot = "/tmp/gsd-sdk-session-guard";
      warmWorkflowMcpProbeInBackground(projectRoot);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(getCachedWorkflowMcpProbe(projectRoot), null);
    } finally {
      endWorkflowMcpSdkSession();
    }
  });

  test("warmWorkflowMcpProbeInBackground uses project root without double cache-keying", async () => {
    clearWorkflowMcpProbeCache();
    const projectRoot = "/tmp/gsd-warm-cache-key";
    recordWorkflowMcpProbe(projectRoot, "gsd-workflow", ["gsd_status", "gsd_plan_slice"]);
    warmWorkflowMcpProbeInBackground(projectRoot);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getCachedWorkflowMcpProbe(projectRoot)?.serverName, "gsd-workflow");
  });

  test("probeAndCacheWorkflowMcp reads project .mcp.json when no env launch config exists", async () => {
    clearWorkflowMcpProbeCache();
    const previousGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-cache-project-"));
    const gsdHomeDir = mkdtempSync(join(tmpdir(), "gsd-mcp-cache-home-"));
    try {
      process.env.GSD_HOME = gsdHomeDir;
      mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

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
          'server.tool("ask_user_questions", "Ask questions", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
          'await server.connect(new StdioServerTransport());',
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        join(projectRoot, ".mcp.json"),
        JSON.stringify({ mcpServers: { "gsd-workflow": { command: process.execPath, args: [serverPath] } } }),
        "utf-8",
      );

      const result = await probeAndCacheWorkflowMcp(projectRoot, { timeoutMs: 5_000 });

      assert.equal(result.ok, true);
      assert.equal(result.serverName, "gsd-workflow");
      assert.deepEqual(result.tools, ["ask_user_questions"]);
      assert.deepEqual(getCachedWorkflowMcpProbe(projectRoot)?.tools, ["ask_user_questions"]);
    } finally {
      if (previousGsdHome === undefined) {
        delete process.env.GSD_HOME;
      } else {
        process.env.GSD_HOME = previousGsdHome;
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(gsdHomeDir, { recursive: true, force: true });
    }
  });
});
