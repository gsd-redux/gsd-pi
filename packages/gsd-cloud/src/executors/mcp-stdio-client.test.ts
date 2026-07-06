// Project/App: Open GSD
// File Purpose: Regression tests for McpStdioClient's shutdown/retry semantics —
// a persistent init failure (e.g. missing `gsd` binary) must reject instead of
// spinning forever respawning children, and a closed client must never spawn again.
import { test } from "node:test";
import assert from "node:assert/strict";
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
