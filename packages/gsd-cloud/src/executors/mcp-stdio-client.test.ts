// Project/App: Open GSD
// File Purpose: Regression tests for McpStdioClient's shutdown/retry semantics —
// a persistent init failure (e.g. missing `gsd` binary) must reject instead of
// spinning forever respawning children, and a closed client must never spawn again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStdioClient } from "./mcp-stdio-client.js";

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

// A command that cannot exist on PATH, so spawn() emits 'error' and init fails.
const MISSING_BINARY = "gsd-cloud-nonexistent-binary-xyzzy";

test("ensureReady rejects (does not loop) when the binary is missing", async () => {
  const client = new McpStdioClient(MISSING_BINARY, ["--mode", "mcp"], noopLogger as never);
  await assert.rejects(client.ensureReady());
  client.close();
});

test("a failed init still resets, so a later ensureReady is a fresh attempt", async () => {
  const client = new McpStdioClient(MISSING_BINARY, ["--mode", "mcp"], noopLogger as never);
  await assert.rejects(client.ensureReady());
  // Second call must reject on its own (fresh spawn attempt), not hang.
  await assert.rejects(client.ensureReady());
  client.close();
});

test("close() permanently blocks further spawns", async () => {
  const client = new McpStdioClient(MISSING_BINARY, ["--mode", "mcp"], noopLogger as never);
  client.close();
  await assert.rejects(client.ensureReady(), /closed/i);
  await assert.rejects(client.callTool("gsd_status", {}), /closed/i);
});

test("Milestone lifecycle tool calls serialize gateway identity as private MCP metadata", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-cloud-mcp-meta-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const serverPath = join(base, "fake-mcp-server.mjs");
  writeFileSync(serverPath, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "tools/call" ? request.params : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  const client = new McpStdioClient(process.execPath, [serverPath], noopLogger as never);
  t.after(() => client.close());
  const callToolWithMeta = client.callTool.bind(client) as (
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ) => Promise<unknown>;
  const toolNames = [
    "gsd_complete_milestone",
    "gsd_milestone_complete",
    "gsd_milestone_reopen",
    "gsd_reopen_milestone",
  ];

  for (const name of toolNames) {
    const meta = { "io.opengsd/idempotency-key": `gateway-${name}` };
    const result = await callToolWithMeta(name, { milestoneId: "M001" }, meta);
    assert.deepEqual(result, {
      name,
      arguments: { milestoneId: "M001" },
      _meta: meta,
    });
  }
});
