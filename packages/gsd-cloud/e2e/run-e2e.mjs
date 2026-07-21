#!/usr/bin/env node
// Project/App: Open GSD
// File Purpose: CAGT-05 local end-to-end verification harness for the cloud agent.
//
// Exercises the full local cloud path against an in-process gateway, with no
// network access beyond 127.0.0.1:
//
//   1. Start @opengsd/cloud-mcp-gateway on an ephemeral port with a temp
//      FileAuthStore (seeded user token).
//   2. POST /pairing-codes (user bearer token) to mint a pairing code.
//   3. Run the real gsd-cloud CLI `pair` against it (temp HOME + temp config).
//   4. Run the real gsd-cloud CLI `connect --foreground` with GSD_CLOUD_PROJECTS
//      pointing at a fixture project dir (minimal .gsd) and the workflow MCP
//      command pointing at a fixture stdio server.
//   5. Assert the runtime registers (gateway registry lists the fixture project).
//   6. Drive the /mcp endpoint (Streamable HTTP): initialize, tools/list,
//      gsd_cloud_projects, and forwarded gsd_query + gsd_status tool calls.
//   7. SIGTERM the runtime, assert clean exit and registry detach, tear down.
//
// This script is intentionally NOT part of `pnpm test` (which is unit-test only).
// Run it via `pnpm --filter @opengsd/gsd-cloud run test:e2e` — that script builds
// gsd-cloud and the gateway chain first.
//
// Environment:
//   GSD_CLOUD_E2E=0|false        Skip (exit 0) — for CI jobs without a full build.
//   GSD_CLOUD_E2E_TIMEOUT_MS     Global watchdog timeout (default 120000).
//   GSD_CLOUD_E2E_GSD_CLI        Use a real gsd installation and its bundled
//                                workflow MCP server instead of the fixture.
//   GSD_CLOUD_E2E_KEEP_TMP=1     Keep the temp root for debugging (path is printed).

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(E2E_DIR, "..");
const REPO_ROOT = join(PKG_DIR, "..", "..");
const CLI_BIN = join(PKG_DIR, "bin", "gsd-cloud.js");
const CLI_DIST = join(PKG_DIR, "dist", "cli.js");
const GATEWAY_DIST = join(REPO_ROOT, "packages", "cloud-mcp-gateway", "dist", "index.js");
const FIXTURE_WORKFLOW_SERVER = join(E2E_DIR, "fixture-gsd-mcp.mjs");
const FIXTURE_MARKER = "GSD_CLOUD_E2E_FIXTURE";
const REAL_GSD_CLI = process.env.GSD_CLOUD_E2E_GSD_CLI?.trim();

const HTTP_TIMEOUT_MS = 10_000;
const PAIR_TIMEOUT_MS = 30_000;
const CONNECT_READY_TIMEOUT_MS = 45_000;
const REGISTRY_APPEAR_TIMEOUT_MS = 15_000;
const REGISTRY_DETACH_TIMEOUT_MS = 10_000;
const CHILD_STOP_TIMEOUT_MS = 15_000;

const steps = [];
let tmpRoot = "";
let gatewayServer;
let connectChild;
let connectOutput = { stdout: "", stderr: "" };

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.GSD_CLOUD_E2E === "0" || process.env.GSD_CLOUD_E2E === "false") {
    process.stdout.write("gsd-cloud e2e: SKIPPED (GSD_CLOUD_E2E is disabled)\n");
    return false;
  }

  const watchdogMs = Number(process.env.GSD_CLOUD_E2E_TIMEOUT_MS ?? 120_000);
  const watchdog = setTimeout(() => {
    failHard(`global watchdog fired after ${watchdogMs}ms`);
  }, watchdogMs);
  try {
    await runAllSteps();
  } finally {
    clearTimeout(watchdog);
  }
  return true;
}

async function runAllSteps() {
  await step("prerequisites: gsd-cloud + gateway build outputs present", checkPrereqs);

  const { createGatewayServer } = await import(pathToFileURL(GATEWAY_DIST).href);
  const userToken = `e2e-user-${randomBytes(8).toString("hex")}`;
  const userId = "e2e-user";

  const ctx = { createGatewayServer, userToken, userId };

  await step("gateway listening on ephemeral port with temp auth store", () => startGateway(ctx));
  await step("GET /healthz responds ok", () => checkHealth(ctx));
  await step("POST /pairing-codes mints a code for the user token", () => mintPairingCode(ctx));
  await step("CLI `pair` exchanges the code and writes temp config", () => runPair(ctx));
  await step("CLI `connect --foreground` establishes the runtime websocket", () => runConnect(ctx));
  await step("gateway registry lists the advertised fixture project", () => assertRegistered(ctx));
  await step("MCP initialize + tools/list over /mcp", () => assertMcpHandshake(ctx));
  await step("MCP gsd_cloud_projects returns the fixture project", () => assertCloudProjects(ctx));
  await step("MCP gsd_query is forwarded to the runtime and back", () => assertForwardedQuery(ctx));
  await step("MCP gsd_status reaches the workflow tool surface", () => assertForwardedStatus(ctx));
  await step("runtime shuts down cleanly and detaches from the registry", () => assertShutdown(ctx));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function checkPrereqs() {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`missing ${CLI_DIST} — run \`pnpm --filter @opengsd/gsd-cloud run test:e2e\` (it builds first)`);
  }
  if (!existsSync(GATEWAY_DIST)) {
    throw new Error(`missing ${GATEWAY_DIST} — run \`pnpm --filter @opengsd/gsd-cloud run test:e2e\` (it builds first)`);
  }

  tmpRoot = mkdtempSync(join(tmpdir(), "gsd-cloud-e2e-"));
  mkdirSync(join(tmpRoot, "home"), { recursive: true });

  // Fixture project with a minimal .gsd so the executor advertises a gsd marker.
  const projectDir = join(tmpRoot, "fixture-project");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(join(projectDir, ".gsd", "STATE.md"), "# State\n\nE2E fixture project.\n");
  writeFileSync(join(projectDir, ".gsd", "PROJECT.md"), "# Project\n\ngsd-cloud e2e fixture.\n");

  // The fixture must be executable regardless of how git materialized file modes.
  chmodSync(FIXTURE_WORKFLOW_SERVER, 0o755);
}

async function startGateway(ctx) {
  const authStorePath = join(tmpRoot, "gateway-auth-store.json");
  const { server, registry } = ctx.createGatewayServer({
    userToken: ctx.userToken,
    userId: ctx.userId,
    authStorePath,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || !address.port) {
    throw new Error("gateway did not bind an ephemeral port");
  }
  gatewayServer = server;
  ctx.registry = registry;
  ctx.gatewayUrl = `http://127.0.0.1:${address.port}`;
}

async function checkHealth(ctx) {
  const res = await fetch(`${ctx.gatewayUrl}/healthz`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const body = await res.json();
  if (res.status !== 200 || body.ok !== true) {
    throw new Error(`/healthz returned ${res.status}: ${JSON.stringify(body)}`);
  }
}

async function mintPairingCode(ctx) {
  const res = await fetch(`${ctx.gatewayUrl}/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.userToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await res.json();
  if (res.status !== 200 || typeof body.code !== "string" || !/^[0-9A-F]{8,}$/.test(body.code)) {
    throw new Error(`/pairing-codes returned ${res.status}: ${JSON.stringify(body)}`);
  }
  if (typeof body.expiresAt !== "number" || body.expiresAt <= Date.now()) {
    throw new Error(`pairing code expiry is not in the future: ${JSON.stringify(body)}`);
  }
  ctx.pairingCode = body.code;
}

async function runPair(ctx) {
  const configPath = join(tmpRoot, "daemon.yaml");
  ctx.configPath = configPath;
  const result = await runProcess(
    process.execPath,
    [CLI_BIN, "pair", "--gateway", ctx.gatewayUrl, "--code", ctx.pairingCode,
      "--runtime-name", "e2e-runtime", "--config", configPath],
    { env: ctx.childEnv = childEnv(), timeoutMs: PAIR_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(`pair exited ${result.code}:\n${result.stdout}\n${result.stderr}`);
  }
  if (!/paired cloud runtime rt_/.test(result.stdout)) {
    throw new Error(`pair stdout did not confirm pairing: ${result.stdout}`);
  }

  const configText = readFileSync(configPath, "utf8");
  const runtimeId = /runtime_id:\s*(\S+)/.exec(configText)?.[1];
  if (!runtimeId || !runtimeId.startsWith("rt_")) {
    throw new Error(`config missing runtime_id:\n${configText}`);
  }
  if (!configText.includes("device_token_encrypted:")) {
    throw new Error(`config missing device_token_encrypted:\n${configText}`);
  }
  ctx.runtimeId = runtimeId;
}

async function runConnect(ctx) {
  connectChild = spawn(
    process.execPath,
    [CLI_BIN, "connect", "--config", ctx.configPath, "--foreground", "--verbose"],
    { env: ctx.childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  connectChild.stdout.on("data", (chunk) => { connectOutput.stdout += chunk; });
  connectChild.stderr.on("data", (chunk) => { connectOutput.stderr += chunk; });

  const readyPattern = /connected to http:\/\/127\.0\.0\.1:\d+/;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `connect did not report ready within ${CONNECT_READY_TIMEOUT_MS}ms\n` +
        `stdout:\n${connectOutput.stdout}\nstderr:\n${connectOutput.stderr}`,
      ));
    }, CONNECT_READY_TIMEOUT_MS);
    const onData = () => {
      if (readyPattern.test(connectOutput.stdout)) { cleanup(); resolve(); }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(
        `connect exited (${code ?? "unknown"}) before connecting\n` +
        `stdout:\n${connectOutput.stdout}\nstderr:\n${connectOutput.stderr}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timer);
      connectChild.stdout.removeListener("data", onData);
      connectChild.removeListener("exit", onExit);
    };
    connectChild.stdout.on("data", onData);
    connectChild.once("exit", onExit);
  });
}

async function assertRegistered(ctx) {
  const expectedPath = realpathSync(join(tmpRoot, "fixture-project"));
  const project = await pollFor(
    () => ctx.registry.listProjects(ctx.userId)
      .find((entry) => entry.runtimeId === ctx.runtimeId),
    REGISTRY_APPEAR_TIMEOUT_MS,
    "fixture project to appear in the gateway registry",
  );
  if (project.alias !== "fixture-project") {
    throw new Error(`unexpected project alias: ${JSON.stringify(project)}`);
  }
  if (project.path !== expectedPath) {
    throw new Error(`unexpected project path ${project.path} (expected ${expectedPath})`);
  }
  if (project.online !== true) {
    throw new Error(`project is not online: ${JSON.stringify(project)}`);
  }
  if (!Array.isArray(project.markers) || !project.markers.includes("gsd")) {
    throw new Error(`project missing the gsd marker: ${JSON.stringify(project)}`);
  }
}

async function assertMcpHandshake(ctx) {
  const init = await mcpRpc(ctx, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gsd-cloud-e2e", version: "1.0.0" },
  });
  if (!init.result?.protocolVersion || init.result?.serverInfo?.name !== "gsd-cloud-gateway") {
    throw new Error(`unexpected initialize result: ${JSON.stringify(init)}`);
  }

  // Note: no notifications/initialized — the gateway creates a fresh stateless
  // MCP server per HTTP request, so the notification carries no state.
  const list = await mcpRpc(ctx, 2, "tools/list", {});
  const toolNames = (list.result?.tools ?? []).map((tool) => tool.name);
  for (const required of ["gsd_cloud_projects", "gsd_query"]) {
    if (!toolNames.includes(required)) {
      throw new Error(`tools/list missing ${required}: ${toolNames.join(", ")}`);
    }
  }
}

async function assertCloudProjects(ctx) {
  const response = await mcpRpc(ctx, 3, "tools/call", {
    name: "gsd_cloud_projects",
    arguments: {},
  });
  const text = response.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`gsd_cloud_projects returned no text content: ${JSON.stringify(response)}`);
  }
  const parsed = JSON.parse(text);
  const project = (parsed.projects ?? []).find((entry) => entry.runtimeId === ctx.runtimeId);
  if (!project || project.alias !== "fixture-project" || project.online !== true) {
    throw new Error(`fixture project missing from gsd_cloud_projects: ${text}`);
  }
}

async function assertForwardedQuery(ctx) {
  const response = await mcpRpc(ctx, 4, "tools/call", {
    name: "gsd_query",
    arguments: { query: "state", projectAlias: "fixture-project" },
  });
  const text = response.result?.content?.[0]?.text;
  const expectedPath = realpathSync(join(tmpRoot, "fixture-project"));
  if (typeof text !== "string") {
    throw new Error(`forwarded gsd_query returned no text: ${JSON.stringify(response)}`);
  }
  if (REAL_GSD_CLI) {
    const result = JSON.parse(text);
    if (result.projectDir !== expectedPath || result.query !== "state" || !result.state?.includes("E2E fixture project")) {
      throw new Error(`real workflow gsd_query response was unexpected: ${text}`);
    }
    return;
  }
  if (!text.includes(`${FIXTURE_MARKER} gsd_query ok`)) {
    throw new Error(`forwarded gsd_query did not reach the fixture: ${text}`);
  }
  if (!text.includes(`projectDir=${expectedPath}`) || !text.includes("query=state")) {
    throw new Error(`forwarded gsd_query args were not routed as expected: ${text}`);
  }
}

async function assertForwardedStatus(ctx) {
  const response = await mcpRpc(ctx, 5, "tools/call", {
    name: "gsd_status",
    arguments: { projectAlias: "fixture-project" },
  });
  const text = response.result?.content?.[0]?.text;
  const expectedPath = realpathSync(join(tmpRoot, "fixture-project"));
  if (typeof text !== "string") {
    throw new Error(`forwarded gsd_status returned no text: ${JSON.stringify(response)}`);
  }
  if (REAL_GSD_CLI) {
    // This asserts forwarding/wiring, so match the stable parts (error flag +
    // "Session not found" prefix + routed projectDir) rather than the workflow
    // server's exact wording, which can change harmlessly.
    if (!response.result?.isError || !text.startsWith("Session not found") || !text.includes(expectedPath)) {
      throw new Error(`real workflow gsd_status response was unexpected: ${JSON.stringify(response)}`);
    }
    return;
  }
  if (!text.includes(`${FIXTURE_MARKER} gsd_status ok`)) {
    throw new Error(`forwarded gsd_status did not reach the fixture: ${text}`);
  }
  if (!text.includes(`projectDir=${expectedPath}`)) {
    throw new Error(`forwarded gsd_status args were not routed as expected: ${text}`);
  }
}

async function assertShutdown(ctx) {
  connectChild.kill("SIGTERM");
  const exit = await waitForExit(connectChild, CHILD_STOP_TIMEOUT_MS);
  connectChild = undefined;
  if (exit.timedOut) {
    throw new Error(`runtime did not stop within ${CHILD_STOP_TIMEOUT_MS}ms of SIGTERM`);
  }
  if (exit.code !== 0) {
    throw new Error(
      `runtime exited with code ${exit.code} (signal ${exit.signal ?? "none"})\n` +
      `stdout:\n${connectOutput.stdout}\nstderr:\n${connectOutput.stderr}`,
    );
  }

  await pollFor(
    () => (ctx.registry.listProjects(ctx.userId).length === 0 ? true : undefined),
    REGISTRY_DETACH_TIMEOUT_MS,
    "fixture project to detach from the gateway registry",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function childEnv() {
  const env = {
    ...process.env,
    HOME: join(tmpRoot, "home"),
    // Deterministic device-token encryption key — pair and connect run as
    // separate processes and must derive the same key.
    GSD_CLOUD_TOKEN_KEY: "gsd-cloud-e2e-token-key",
    GSD_CLOUD_PROJECTS: join(tmpRoot, "fixture-project"),
  };
  if (REAL_GSD_CLI) {
    env.GSD_CLI_PATH = REAL_GSD_CLI;
    delete env.GSD_WORKFLOW_MCP_COMMAND;
    delete env.GSD_WORKFLOW_MCP_ARGS;
  } else {
    delete env.GSD_CLI_PATH;
    env.GSD_WORKFLOW_MCP_COMMAND = process.execPath;
    env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify([FIXTURE_WORKFLOW_SERVER]);
  }
  return env;
}

function runProcess(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: null, timedOut: true });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

async function pollFor(produce, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One stateless JSON-RPC call against the gateway's /mcp endpoint. */
async function mcpRpc(ctx, id, method, params) {
  const res = await fetch(`${ctx.gatewayUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.userToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`MCP ${method} returned HTTP ${res.status}: ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const messages = contentType.includes("text/event-stream")
    ? parseSseMessages(body)
    : [JSON.parse(body)];
  const match = messages.find((message) => message && message.id === id);
  if (!match) {
    throw new Error(`MCP ${method} response missing id ${id}: ${body}`);
  }
  if (match.error) {
    throw new Error(`MCP ${method} returned an error: ${JSON.stringify(match.error)}`);
  }
  return match;
}

function parseSseMessages(body) {
  const messages = [];
  let dataLines = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    } else if (line.trim() === "" && dataLines.length > 0) {
      messages.push(JSON.parse(dataLines.join("\n")));
      dataLines = [];
    }
  }
  if (dataLines.length > 0) messages.push(JSON.parse(dataLines.join("\n")));
  return messages;
}

// ---------------------------------------------------------------------------
// Reporting + teardown
// ---------------------------------------------------------------------------

async function step(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - startedAt });
    await teardown();
    process.stdout.write(`FAIL ${name} (${Date.now() - startedAt}ms)\n`);
    process.stdout.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
    printSummary(false);
    process.exit(1);
  }
  steps.push({ name, ok: true, ms: Date.now() - startedAt });
  process.stdout.write(`PASS ${name} (${Date.now() - startedAt}ms)\n`);
}

async function teardown() {
  if (connectChild) {
    connectChild.kill("SIGKILL");
    connectChild = undefined;
  }
  const server = gatewayServer;
  gatewayServer = undefined;
  if (server) {
    try { server.closeAllConnections?.(); } catch { /* best effort */ }
    await Promise.race([
      new Promise((resolve) => server.close(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (tmpRoot && process.env.GSD_CLOUD_E2E_KEEP_TMP !== "1") {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function printSummary(ok) {
  const passed = steps.filter((entry) => entry.ok).length;
  const totalMs = steps.reduce((sum, entry) => sum + entry.ms, 0);
  process.stdout.write(`\nE2E SUMMARY: ${ok ? "PASS" : "FAIL"} — ${passed}/${steps.length} steps passed in ${(totalMs / 1000).toFixed(1)}s\n`);
  if (process.env.GSD_CLOUD_E2E_KEEP_TMP === "1" && tmpRoot) {
    process.stdout.write(`temp root kept: ${tmpRoot}\n`);
  }
}

function failHard(message) {
  process.stderr.write(`gsd-cloud e2e: fatal: ${message}\n`);
  if (connectChild) connectChild.kill("SIGKILL");
  process.exit(2);
}

process.once("unhandledRejection", (err) => {
  failHard(`unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});

try {
  const ran = await main();
  await teardown();
  if (ran) printSummary(true);
  process.exit(0);
} catch (err) {
  await teardown();
  process.stderr.write(`gsd-cloud e2e: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
