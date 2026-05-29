// Project/App: gsd-pi
// File Purpose: Regression test — MCP server names must be injected into agent
//               context during session initialization.
//
//               When MCP servers are configured in .mcp.json or ~/.gsd/mcp.json,
//               the agent must learn about them without an explicit mcp_servers call.
//               This test guards that:
//
//               1. (Structural) The session_start handler in register-hooks.ts
//                  references MCP server enumeration.
//               2. (Behavioral) Firing session_start with configured MCP servers
//                  produces detectable MCP awareness in the resulting context.
//
//               Relates to the shell-hooks fix — SessionStart never fires (Layer 0
//               bug), but even Layer 2 session_start doesn't enumerate MCP servers.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOOKS_SOURCE = readFileSync(
  join(__dirname, "..", "bootstrap", "register-hooks.ts"),
  "utf-8",
);

// ─── Structural guard ───────────────────────────────────────────────────────

test("session_start handler references MCP server enumeration (readMcpServerConfigs or mcp-client)", () => {
  const sessionStartIdx = HOOKS_SOURCE.indexOf('"session_start"');
  assert.ok(sessionStartIdx > -1, "session_start handler must exist");

  // Find the end of the session_start handler — the next top-level pi.on
  const nextOnIdx = HOOKS_SOURCE.indexOf("pi.on(", sessionStartIdx + 1);
  assert.ok(nextOnIdx > sessionStartIdx, "session_start handler must be bounded by the next pi.on call");

  const sessionStartBody = HOOKS_SOURCE.slice(sessionStartIdx, nextOnIdx);

  // The handler must reference something from the MCP client subsystem
  // that enumerates servers. Accepted patterns:
  //   - readMcpServerConfigs (reads from all 3 tiers)
  //   - readMcpManagementStatus (full status including servers list)
  //   - mcp-client/manager (import path)
  //   - mcp-client/index (alternative import path)
  const hasMcpEnumeration =
    sessionStartBody.includes("readMcpServerConfigs") ||
    sessionStartBody.includes("readMcpManagementStatus") ||
    sessionStartBody.includes("mcp-client/manager") ||
    sessionStartBody.includes("mcp-client/index");

  assert.ok(
    hasMcpEnumeration,
    [
      "session_start handler must reference MCP server enumeration to inject",
      "server awareness into agent context. Expected one of:",
      "  - readMcpServerConfigs()",
      "  - readMcpManagementStatus()",
      "  - import from mcp-client/manager or mcp-client/index",
      "",
      "Without this, the agent starts blind to configured MCP servers.",
    ].join("\n"),
  );
});

// ─── Behavioral guard ────────────────────────────────────────────────────────

test("session_start injects MCP server names into agent context when servers are configured", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-mcp-awareness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const tempGsdHome = join(dir, "home");
  mkdirSync(tempGsdHome, { recursive: true });

  // Write global MCP config with a test server
  writeFileSync(
    join(tempGsdHome, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "test-global-server": {
          command: "node",
          args: ["echo-server.js"],
        },
      },
    }),
    "utf-8",
  );

  // Write project MCP config with another test server
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "test-project-server": {
          command: "node",
          args: ["project-echo-server.js"],
        },
      },
    }),
    "utf-8",
  );

  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(dir);
  autoSession.reset();

  t.after(() => {
    autoSession.reset();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Capture what gets injected into context
  const contextInjections: string[] = [];
  const statusMessages: Array<{ key: string; value: string }> = [];

  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<unknown> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<unknown> | void) {
      handlers.set(event, handler);
    },
  } as any;

  registerHooks(pi, []);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler must be registered");

  const ctx = {
    hasUI: true,
    cwd: dir,
    ui: {
      notify: () => {},
      setStatus: (key: string, value: string) => {
        statusMessages.push({ key, value });
      },
      setFooter: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => "test-session-id" },
    model: null,
    setCompactionThresholdOverride: () => {},
    modelRegistry: {
      setDisabledModelProviders: () => {},
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => false,
    },
  };

  await sessionStart!({}, ctx);

  // After session_start, at least one of these signals must contain MCP server names:
  // 1. A status bar entry mentioning MCP servers
  // 2. Context injection (system prompt augmentation)
  // 3. A widget with MCP info
  //
  // The structural test above ensures the code path exists. This behavioral test
  // checks that running the handler with configured servers produces detectable output.
  //
  // Currently this WILL FAIL because no MCP enumeration happens in session_start.

  const allOutput = [
    ...contextInjections,
    ...statusMessages.map((s) => `${s.key}: ${s.value}`),
  ].join(" ");

  // Check if either server name appears anywhere in the handler's observable output
  const mentionsGlobal = allOutput.includes("test-global-server");
  const mentionsProject = allOutput.includes("test-project-server");

  // If neither structural injection produced MCP names, also check that
  // setStatus was called with an MCP-related key (indicating awareness was surfaced)
  const hasMcpStatus = statusMessages.some(
    (s) => {
      const k = (s.key ?? "").toLowerCase();
      const v = (s.value ?? "").toLowerCase();
      return k.includes("mcp") || v.includes("mcp");
    },
  );

  assert.ok(
    mentionsGlobal || mentionsProject || hasMcpStatus,
    [
      "session_start must surface MCP server awareness when servers are configured.",
      "Expected at least one of:",
      "  - 'test-global-server' or 'test-project-server' in context output",
      "  - An MCP-related status entry",
      "",
      "This means the agent starts without knowing about configured MCP servers.",
      "Fix: call readMcpServerConfigs() in the session_start handler and inject",
      "the server list into the system prompt or a status indicator.",
    ].join("\n"),
  );
});

// ─── Negative behavioral guard ───────────────────────────────────────────────

test("session_start does not error when no MCP servers are configured", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-mcp-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const tempGsdHome = join(dir, "home");
  mkdirSync(tempGsdHome, { recursive: true });

  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(dir);
  autoSession.reset();

  t.after(() => {
    autoSession.reset();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<unknown> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<unknown> | void) {
      handlers.set(event, handler);
    },
  } as any;

  registerHooks(pi, []);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler must be registered");

  const ctx = {
    hasUI: true,
    cwd: dir,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setFooter: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => "test-session-id" },
    model: null,
    setCompactionThresholdOverride: () => {},
    modelRegistry: {
      setDisabledModelProviders: () => {},
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => false,
    },
  };

  // Must not throw even with zero MCP config files
  await assert.doesNotReject(
    async () => sessionStart!({}, ctx),
    "session_start must not error when no MCP servers are configured",
  );
});
