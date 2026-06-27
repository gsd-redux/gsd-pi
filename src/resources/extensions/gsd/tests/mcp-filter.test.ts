import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverBrowserMcpServerName, discoverMcpServerNames, discoverWorkflowMcpServerName, computeMcpDisallowedTools } from "../mcp-filter.ts";
import type { ClaudeCodeMcpConfig } from "../preferences-types.ts";

// ─── discoverMcpServerNames ────────────────────────────────────────────────

describe("discoverMcpServerNames", () => {
  it("reads server names from .mcp.json mcpServers keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "server-a": {}, "server-b": {} } }),
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result.sort(), ["server-a", "server-b"]);
  });

  it("returns [] when .mcp.json does not exist (ENOENT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, []);
  });

  it("returns [] when .mcp.json has no mcpServers key", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ version: 1 }));
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, []);
  });

  it("reads from both .mcp.json and .claude/settings.json, deduplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "server-a": {}, "shared": {} } }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "server-b": {}, "shared": {} } }),
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result.sort(), ["server-a", "server-b", "shared"]);
  });

  it("reads from .claude/settings.local.json for Claude Code project-local servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify({ mcpServers: { "local-server": {}, "shared": {} } }),
    );
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "project-server": {}, "shared": {} } }),
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result.sort(), ["local-server", "project-server", "shared"]);
  });

  it("handles .claude/settings.json missing gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "only-server": {} } }),
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, ["only-server"]);
  });

  it("discovers workflow server names by config signature", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "custom-workflow": {
            command: "node",
            args: ["custom-cli.js"],
            env: { GSD_WORKFLOW_PROJECT_ROOT: dir },
          },
          unrelated: { command: "npx", args: ["other"] },
        },
      }),
    );
    assert.equal(discoverWorkflowMcpServerName(dir), "custom-workflow");
  });

  it("discovers gsd-browser server names by config signature", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "browser-uat": {
            command: "gsd-browser",
            args: ["mcp"],
          },
          unrelated: { command: "npx", args: ["other"] },
        },
      }),
    );
    assert.equal(discoverBrowserMcpServerName(dir), "browser-uat");
  });

  it("invalidates cached project MCP config when .mcp.json changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-cache-test-"));
    const configPath = join(dir, ".mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "server-a": {} } }));
    assert.deepEqual(discoverMcpServerNames(dir), ["server-a"]);

    writeFileSync(configPath, JSON.stringify({ mcpServers: { "server-b": {} } }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(configPath, later, later);

    assert.deepEqual(discoverMcpServerNames(dir), ["server-b"]);
  });

  it("reuses parsed project MCP config across discovery helpers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-cache-test-"));
    const claudeDir = join(dir, ".claude");
    const mcpJsonPath = join(dir, ".mcp.json");
    const settingsPath = join(claudeDir, "settings.json");
    const localSettingsPath = join(claudeDir, "settings.local.json");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      mcpJsonPath,
      JSON.stringify({
        mcpServers: {
          "custom-workflow": {
            command: "node",
            args: ["custom-cli.js"],
            env: { GSD_WORKFLOW_PROJECT_ROOT: dir },
          },
        },
      }),
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { "browser-uat": { command: "gsd-browser", args: ["mcp"] } } }),
    );
    writeFileSync(
      localSettingsPath,
      JSON.stringify({ mcpServers: { "local-server": { command: "npx", args: ["local"] } } }),
    );

    const trackedPaths = new Set([mcpJsonPath, settingsPath, localSettingsPath]);
    const readCounts = new Map<string, number>();
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const path = args[0];
      if (typeof path === "string" && trackedPaths.has(path)) {
        readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();

    try {
      const mcpFilter = await import(`../mcp-filter.ts?cache-test=${Date.now()}`);
      const discovered = mcpFilter.discoverMcpServerNames(dir);
      const workflowName = mcpFilter.discoverWorkflowMcpServerName(dir);
      const browserName = mcpFilter.discoverBrowserMcpServerName(dir);

      assert.deepEqual(discovered.sort(), ["browser-uat", "custom-workflow", "local-server"]);
      assert.equal(workflowName, "custom-workflow");
      assert.equal(browserName, "browser-uat");
      assert.deepEqual(
        [mcpJsonPath, settingsPath, localSettingsPath].map((path) => readCounts.get(path) ?? 0),
        [1, 1, 1],
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
  });
});

// ─── computeMcpDisallowedTools ─────────────────────────────────────────────

describe("computeMcpDisallowedTools", () => {
  it("returns [] when mcpConfig is undefined (no filtering)", () => {
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      undefined,
      ["server-a", "server-b"],
      "gsd-workflow",
    );
    assert.deepEqual(result, []);
  });

  it("returns [] when no model prefix matches any config key", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-opus-4-7",
      config,
      ["server-a", "server-b"],
      "gsd-workflow",
    );
    assert.deepEqual(result, []);
  });

  it("allowlist-only: blocks all discovered servers not in allowed_servers (R002)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow",
    );
    assert.deepEqual(result.sort(), ["mcp__server-b__*", "mcp__server-c__*"]);
  });

  it("blocklist-only: blocks only servers in blocked_servers (R002)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { blocked_servers: ["server-b"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow",
    );
    assert.deepEqual(result, ["mcp__server-b__*"]);
  });

  it("both lists: allowlist applies first, then blocklist removes; blocklist wins on overlap (R002)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": {
          allowed_servers: ["server-a", "server-b"],
          blocked_servers: ["server-b"],
        },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow",
    );
    // server-c blocked by allowlist, server-b blocked by blocklist (wins over allowlist)
    assert.deepEqual(result.sort(), ["mcp__server-b__*", "mcp__server-c__*"]);
  });

  it("gsd-workflow implicitly allowed even when not in allowlist (R003)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b"],
      "gsd-workflow",
    );
    assert.ok(!result.includes("mcp__gsd-workflow__*"), "gsd-workflow must not be blocked");
    assert.deepEqual(result, ["mcp__server-b__*"]);
  });

  it("gsd-workflow blocked when explicitly in blocked_servers (R003 override)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { blocked_servers: ["gsd-workflow"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a"],
      "gsd-workflow",
    );
    assert.ok(result.includes("mcp__gsd-workflow__*"), "gsd-workflow must be blocked");
  });

  it("returns mcp__<name>__* pattern format for each blocked server (R006)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { blocked_servers: ["my-server", "other-server"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["my-server", "other-server"],
      "gsd-workflow",
    );
    assert.deepEqual(result.sort(), ["mcp__my-server__*", "mcp__other-server__*"]);
  });
});

// ─── Integration: empirical tool-count reduction ───────────────────────────

describe("integration: empirical tool-count reduction", () => {
  it("disallowedTools count equals discovered minus allowed (5 servers, 1 allowed → 4 blocked)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-integration-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "server-alpha": {},
          "server-beta": {},
          "server-gamma": {},
          "server-delta": {},
          "server-epsilon": {},
        },
      }),
    );

    const discovered = discoverMcpServerNames(dir);
    assert.equal(discovered.length, 5, "fixture must have 5 servers");

    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "test-model": { allowed_servers: ["server-alpha"] },
      },
    };

    const disallowedTools = computeMcpDisallowedTools(
      "test-model",
      config,
      discovered,
      "gsd-workflow",
    );

    // 5 discovered - 1 allowed = 4 blocked
    assert.equal(disallowedTools.length, 4, "4 servers must be blocked");

    // The allowed server must NOT be in disallowedTools
    assert.ok(
      !disallowedTools.includes("mcp__server-alpha__*"),
      "server-alpha (allowed) must not be blocked",
    );

    // Each blocked server must produce the correct pattern
    assert.deepEqual(disallowedTools.sort(), [
      "mcp__server-beta__*",
      "mcp__server-delta__*",
      "mcp__server-epsilon__*",
      "mcp__server-gamma__*",
    ]);
  });

  it("negative: empty .mcp.json → disallowedTools empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-integration-empty-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({}));

    const discovered = discoverMcpServerNames(dir);
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "test-model": { allowed_servers: ["server-alpha"] },
      },
    };

    const disallowedTools = computeMcpDisallowedTools(
      "test-model",
      config,
      discovered,
      "gsd-workflow",
    );

    assert.deepEqual(disallowedTools, [], "no servers discovered → nothing to block");
  });

  it("negative: model ID matches no per_model key → disallowedTools empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-integration-nomatch-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "server-a": {}, "server-b": {}, "server-c": {} },
      }),
    );

    const discovered = discoverMcpServerNames(dir);
    assert.equal(discovered.length, 3);

    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };

    // "gpt-4o" doesn't match "claude-haiku" prefix → no filtering
    const disallowedTools = computeMcpDisallowedTools(
      "gpt-4o",
      config,
      discovered,
      "gsd-workflow",
    );

    assert.deepEqual(disallowedTools, [], "unmatched model must produce no blocks");
  });
});
