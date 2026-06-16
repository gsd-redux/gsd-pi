import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureClaudeCodeMcpJsonServerEnabled,
  ensureProjectWorkflowMcpConfig,
  GSD_BROWSER_MCP_SERVER_NAME,
  GSD_WORKFLOW_MCP_SERVER_NAME,
} from "../mcp-project-config.ts";

test("ensureProjectWorkflowMcpConfig creates .mcp.json with workflow and browser servers", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    assert.equal(result.status, "created");
    assert.equal(existsSync(result.configPath), true);

    const parsed = JSON.parse(readFileSync(result.configPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    const server = parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME];
    assert.ok(server, "workflow server should be written to mcpServers");
    assert.equal(typeof server?.command, "string");
    assert.equal(Array.isArray(server?.args), true);
    assert.equal(server?.env?.GSD_WORKFLOW_PROJECT_ROOT, projectRoot);
    assert.match(server?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
    assert.match(server?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
    if ((server?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "").endsWith(".ts")) {
      assert.match(server?.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
      assert.match(server?.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
    }

    const browserServer = parsed.mcpServers?.[GSD_BROWSER_MCP_SERVER_NAME];
    assert.ok(browserServer, "gsd-browser server should be written to mcpServers");
    const browserArgs = browserServer?.args ?? [];
    const mcpArgIndex = browserArgs.indexOf("mcp");
    assert.ok(mcpArgIndex >= 0, "gsd-browser args should include mcp");
    if (browserServer?.command === process.execPath) {
      assert.match(browserArgs[0] ?? "", /@opengsd[\/\\]gsd-browser[\/\\]bin[\/\\]gsd-browser/);
    } else {
      assert.equal(browserServer?.command, "gsd-browser");
      assert.equal(mcpArgIndex, 0);
    }
    assert.deepEqual(browserArgs.slice(mcpArgIndex, mcpArgIndex + 5), [
      "mcp",
      "--session",
      browserArgs[mcpArgIndex + 2],
      "--identity-scope",
      "project",
    ]);
    assert.equal(browserArgs[mcpArgIndex + 6], projectRoot);
    assert.equal((browserServer as { cwd?: string })?.cwd, projectRoot);

    const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf-8")) as {
      enabledMcpjsonServers?: string[];
    };
    assert.deepEqual(settings.enabledMcpjsonServers, [
      GSD_WORKFLOW_MCP_SERVER_NAME,
      GSD_BROWSER_MCP_SERVER_NAME,
    ]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig preserves existing mcp servers", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  const configPath = join(projectRoot, ".mcp.json");

  writeFileSync(
    configPath,
    `${JSON.stringify({
      mcpServers: {
        railway: {
          command: "npx",
          args: ["railway-mcp"],
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    assert.equal(result.status, "updated");

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    assert.deepEqual(parsed.mcpServers?.railway, {
      command: "npx",
      args: ["railway-mcp"],
    });
    assert.ok(parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME]);
    assert.ok(parsed.mcpServers?.[GSD_BROWSER_MCP_SERVER_NAME]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig uses custom workflow server name from env", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot, {
      GSD_WORKFLOW_MCP_COMMAND: "node",
      GSD_WORKFLOW_MCP_NAME: "custom-workflow",
      GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["server.js"]),
      GSD_WORKFLOW_MCP_CWD: projectRoot,
    });
    assert.equal(result.status, "created");
    assert.equal(result.serverName, "custom-workflow");

    const parsed = JSON.parse(readFileSync(result.configPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    assert.ok(parsed.mcpServers?.["custom-workflow"]);
    assert.ok(parsed.mcpServers?.[GSD_BROWSER_MCP_SERVER_NAME]);
    assert.equal(parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME], undefined);

    const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf-8")) as {
      enabledMcpjsonServers?: string[];
    };
    assert.deepEqual(settings.enabledMcpjsonServers, ["custom-workflow", GSD_BROWSER_MCP_SERVER_NAME]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig can disable the default browser MCP server", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot, {
      GSD_BROWSER_MCP_ENABLED: "0",
    });
    assert.equal(result.status, "created");
    assert.deepEqual(result.serverNames, [GSD_WORKFLOW_MCP_SERVER_NAME]);

    const parsed = JSON.parse(readFileSync(result.configPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    assert.ok(parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME]);
    assert.equal(parsed.mcpServers?.[GSD_BROWSER_MCP_SERVER_NAME], undefined);

    const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf-8")) as {
      enabledMcpjsonServers?: string[];
    };
    assert.deepEqual(settings.enabledMcpjsonServers, [GSD_WORKFLOW_MCP_SERVER_NAME]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig is idempotent when config is already current", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  try {
    const first = ensureProjectWorkflowMcpConfig(projectRoot);
    const second = ensureProjectWorkflowMcpConfig(projectRoot);

    assert.equal(first.status, "created");
    assert.equal(second.status, "unchanged");
    assert.equal(first.configPath, second.configPath);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig updates stale Claude Code MCP approval state", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");

  try {
    const first = ensureProjectWorkflowMcpConfig(projectRoot);
    assert.equal(first.status, "created");

    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        permissions: { allow: ["Bash(gh issue *)"] },
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [GSD_WORKFLOW_MCP_SERVER_NAME, GSD_BROWSER_MCP_SERVER_NAME],
      }, null, 2)}\n`,
      "utf-8",
    );

    const second = ensureProjectWorkflowMcpConfig(projectRoot);
    assert.equal(second.status, "updated");

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions?: { allow?: string[] };
      enabledMcpjsonServers?: string[];
      disabledMcpjsonServers?: string[];
    };
    assert.deepEqual(settings.permissions?.allow, ["Bash(gh issue *)"]);
    assert.deepEqual(settings.enabledMcpjsonServers, [
      GSD_WORKFLOW_MCP_SERVER_NAME,
      GSD_BROWSER_MCP_SERVER_NAME,
    ]);
    assert.deepEqual(settings.disabledMcpjsonServers, []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureClaudeCodeMcpJsonServerEnabled is idempotent", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));

  try {
    assert.equal(ensureClaudeCodeMcpJsonServerEnabled(projectRoot, "gsd-workflow"), true);
    assert.equal(ensureClaudeCodeMcpJsonServerEnabled(projectRoot, "gsd-workflow"), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
