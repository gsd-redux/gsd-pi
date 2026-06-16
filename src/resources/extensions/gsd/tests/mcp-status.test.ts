import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  formatMcpDiscoveryResult,
  formatMcpInitResult,
  formatMcpConnectionTestResult,
  formatMcpStatusReport,
  formatMcpServerDetail,
  hasHostMcpTool,
  handleMcpStatus,
  type McpServerStatus,
} from "../commands-mcp-status.ts";
import { clearMcpConfigCache } from "../../mcp-client/manager.ts";

// ─── formatMcpStatusReport ──────────────────────────────────────────────────

describe("formatMcpStatusReport", () => {
  test("returns no-servers message when list is empty", () => {
    const result = formatMcpStatusReport([]);
    assert.match(result, /no mcp servers configured/i);
  });

  test("lists all servers with connection status", () => {
    const servers: McpServerStatus[] = [
      { name: "railway", transport: "stdio", connected: true, toolCount: 5, error: undefined },
      { name: "linear", transport: "http", connected: false, toolCount: 0, error: undefined },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /railway/);
    assert.match(result, /linear/);
    assert.match(result, /connected/i);
    assert.match(result, /disconnected/i);
    assert.match(result, /5 tools/);
  });

  test("shows error state for servers with errors", () => {
    const servers: McpServerStatus[] = [
      { name: "broken", transport: "stdio", connected: false, toolCount: 0, error: "Connection refused" },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /error/i);
    assert.match(result, /Connection refused/);
  });

  test("shows disabled state separately from disconnected", () => {
    const servers: McpServerStatus[] = [
      { name: "disabled-server", transport: "stdio", connected: false, toolCount: 0, error: undefined, disabled: true },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /disabled-server/);
    assert.match(result, /disabled/i);
  });

  test("includes server count in header", () => {
    const servers: McpServerStatus[] = [
      { name: "a", transport: "stdio", connected: true, toolCount: 3, error: undefined },
      { name: "b", transport: "http", connected: true, toolCount: 2, error: undefined },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /2/);
  });
});

// ─── formatMcpServerDetail ──────────────────────────────────────────────────

describe("formatMcpServerDetail", () => {
  test("shows server name and transport", () => {
    const result = formatMcpServerDetail({
      name: "railway",
      transport: "stdio",
      connected: true,
      toolCount: 3,
      tools: ["railway_list_projects", "railway_deploy", "railway_logs"],
      error: undefined,
    });
    assert.match(result, /railway/);
    assert.match(result, /stdio/);
  });

  test("lists individual tools when available", () => {
    const result = formatMcpServerDetail({
      name: "railway",
      transport: "stdio",
      connected: true,
      toolCount: 2,
      tools: ["railway_list_projects", "railway_deploy"],
      error: undefined,
    });
    assert.match(result, /railway_list_projects/);
    assert.match(result, /railway_deploy/);
  });

  test("shows error message for failed servers", () => {
    const result = formatMcpServerDetail({
      name: "broken",
      transport: "stdio",
      connected: false,
      toolCount: 0,
      tools: [],
      error: "spawn ENOENT",
    });
    assert.match(result, /error/i);
    assert.match(result, /spawn ENOENT/);
  });

  test("shows disconnected status with no tools", () => {
    const result = formatMcpServerDetail({
      name: "offline",
      transport: "http",
      connected: false,
      toolCount: 0,
      tools: [],
      error: undefined,
    });
    assert.match(result, /disconnected/i);
  });

  test("shows env warnings for server detail", () => {
    const result = formatMcpServerDetail({
      name: "warned",
      transport: "http",
      connected: false,
      toolCount: 0,
      tools: [],
      error: undefined,
      envWarnings: ["headers.Authorization references unset environment variable TOKEN."],
    });
    assert.match(result, /Warnings/);
    assert.match(result, /TOKEN/);
  });
});

describe("handleMcpStatus", () => {
  test("discovers the only configured server when no server name is provided", async () => {
    const previousGsdHome = process.env.GSD_HOME;
    const originalCwd = process.cwd();
    const projectDir = mkdtempSync(join(tmpdir(), "gsd-mcp-discover-project-"));
    const gsdHomeDir = mkdtempSync(join(tmpdir(), "gsd-mcp-discover-home-"));
    try {
      process.env.GSD_HOME = gsdHomeDir;
      process.chdir(projectDir);

      const require = createRequire(import.meta.url);
      const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
      const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
      const serverPath = join(projectDir, "discover-mcp-server.mjs");
      writeFileSync(
        serverPath,
        [
          `const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
          `const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
          'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
          'server.tool("discover_tool", "Discover-visible tool", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
          'await server.connect(new StdioServerTransport());',
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        join(projectDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { "gsd-workflow": { command: process.execPath, args: [serverPath] } } }),
        "utf-8",
      );

      let message = "";
      const ctx = {
        getSystemPrompt: () => "",
        ui: {
          notify: (text: string) => {
            message = text;
          },
        },
      };

      await handleMcpStatus("discover", ctx as unknown as ExtensionCommandContext);

      assert.match(message, /MCP discovery completed for gsd-workflow/);
      assert.match(message, /discover_tool/);
      assert.doesNotMatch(message, /Usage: \/gsd mcp/);
    } finally {
      process.chdir(originalCwd);
      if (previousGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = previousGsdHome;
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(gsdHomeDir, { recursive: true, force: true });
      clearMcpConfigCache();
    }
  });
});

describe("formatMcpDiscoveryResult", () => {
  test("summarizes discovered tools", () => {
    const result = formatMcpDiscoveryResult({
      ok: true,
      server: "demo",
      transport: "stdio",
      toolCount: 1,
      tools: ["ping"],
      warnings: [],
    });
    assert.match(result, /discovery completed/i);
    assert.match(result, /ping/);
    assert.match(result, /mcp_call/);
  });

  test("summarizes discovery failures", () => {
    const result = formatMcpDiscoveryResult({
      ok: false,
      server: "demo",
      transport: "http",
      toolCount: 0,
      tools: [],
      warnings: ["url references unset environment variable TOKEN."],
      error: "bad config",
    });
    assert.match(result, /discovery failed/i);
    assert.match(result, /bad config/);
    assert.match(result, /TOKEN/);
  });
});

describe("formatMcpConnectionTestResult", () => {
  test("summarizes successful tools/list", () => {
    const result = formatMcpConnectionTestResult({
      ok: true,
      server: "demo",
      transport: "stdio",
      toolCount: 1,
      tools: ["ping"],
      warnings: [],
    });
    assert.match(result, /passed/i);
    assert.match(result, /ping/);
  });

  test("summarizes failed connection with warnings", () => {
    const result = formatMcpConnectionTestResult({
      ok: false,
      server: "demo",
      transport: "http",
      toolCount: 0,
      tools: [],
      warnings: ["url references unset environment variable TOKEN."],
      error: "bad config",
    });
    assert.match(result, /failed/i);
    assert.match(result, /bad config/);
    assert.match(result, /TOKEN/);
  });
});

describe("formatMcpInitResult", () => {
  test("shows created message with config path", () => {
    const result = formatMcpInitResult("created", "/tmp/project/.mcp.json", "/tmp/project");
    assert.match(result, /created project mcp config/i);
    assert.match(result, /\/tmp\/project\/\.mcp\.json/);
    assert.match(result, /mcp-capable clients/i);
    assert.doesNotMatch(result, /claude code/i);
  });

  test("shows unchanged message when config is current", () => {
    const result = formatMcpInitResult("unchanged", "/tmp/project/.mcp.json", "/tmp/project");
    assert.match(result, /already up to date/i);
  });
});

describe("hasHostMcpTool", () => {
  test("detects host-provided MCP tool prefix for a server", () => {
    assert.equal(hasHostMcpTool("tools: mcp__gsd-workflow__*", "gsd-workflow"), true);
  });

  test("does not match other servers", () => {
    assert.equal(hasHostMcpTool("tools: mcp__other-server__*", "gsd-workflow"), false);
  });
});
