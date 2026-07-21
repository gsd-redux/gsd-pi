// Project/App: Open GSD
// File Purpose: Regression tests for workflow MCP server discovery. The cloud
// daemon must spawn the workflow MCP server (gsd_status, gsd_roadmap, …) — not
// `gsd --mode mcp`, whose session registry never includes the workflow adapter
// surface (issue #1513: daemon session polling failed with "Unknown tool:
// gsd_status", hanging the SaaS app boot).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveWorkflowServerLaunch } from "./workflow-server-launch.js";

function makeInstalledLayout(t: test.TestContext): { gsdBinary: string; workflowCli: string } {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-workflow-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "lib", "node_modules", "@opengsd", "gsd-pi");
  const workflowCli = join(packageRoot, "packages", "mcp-server", "dist", "cli.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(join(packageRoot, "packages", "mcp-server", "dist"), { recursive: true });
  const gsdBinary = join(packageRoot, "dist", "loader.js");
  writeFileSync(gsdBinary, "// gsd loader\n");
  writeFileSync(workflowCli, "// workflow server\n");
  return { gsdBinary, workflowCli: realpathSync(workflowCli) };
}

test("discovers the workflow server beside an installed gsd binary", (t) => {
  const { gsdBinary, workflowCli } = makeInstalledLayout(t);
  const launch = resolveWorkflowServerLaunch({ gsdBinary, env: {}, lookup: () => null });
  assert.ok(launch, "expected a launch config");
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [workflowCli]);
  assert.equal(launch.gsdCliPath, realpathSync(gsdBinary));
});

test("explicit GSD_WORKFLOW_MCP_COMMAND wins over discovery", (t) => {
  const { gsdBinary } = makeInstalledLayout(t);
  const launch = resolveWorkflowServerLaunch({
    gsdBinary,
    env: {
      GSD_WORKFLOW_MCP_COMMAND: "/custom/wf-server",
      GSD_WORKFLOW_MCP_ARGS: '["--flag"]',
    },
    lookup: () => null,
  });
  assert.deepEqual(launch, {
    command: "/custom/wf-server",
    args: ["--flag"],
    gsdCliPath: realpathSync(gsdBinary),
  });
});

test("bare gsd binary name resolves through PATH lookup before walking ancestors", (t) => {
  const { gsdBinary, workflowCli } = makeInstalledLayout(t);
  const launch = resolveWorkflowServerLaunch({
    gsdBinary: "gsd",
    env: {},
    lookup: (cmd) => (cmd === "gsd" ? gsdBinary : null),
  });
  assert.ok(launch, "expected a launch config");
  assert.deepEqual(launch.args, [workflowCli]);
  assert.equal(launch.gsdCliPath, realpathSync(gsdBinary));
});

test("discovers the installed workflow server from a Windows npm command shim", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-windows-shim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npmBin = join(root, "npm");
  const gsdBinary = join(npmBin, "gsd.cmd");
  const gsdLoader = join(
    npmBin,
    "node_modules",
    "@opengsd",
    "gsd-pi",
    "dist",
    "loader.js",
  );
  const workflowCli = join(
    npmBin,
    "node_modules",
    "@opengsd",
    "gsd-pi",
    "packages",
    "mcp-server",
    "dist",
    "cli.js",
  );
  mkdirSync(dirname(gsdLoader), { recursive: true });
  mkdirSync(dirname(workflowCli), { recursive: true });
  writeFileSync(gsdBinary, "@node node_modules/@opengsd/gsd-pi/dist/loader.js %*\r\n");
  writeFileSync(gsdLoader, "// gsd loader\n");
  writeFileSync(workflowCli, "// workflow server\n");

  const launch = resolveWorkflowServerLaunch({
    gsdBinary: "gsd",
    env: {},
    lookup: (command) => (command === "gsd" ? gsdBinary : null),
  });

  assert.ok(launch, "expected a launch config");
  assert.deepEqual(launch.args, [realpathSync(workflowCli)]);
  assert.equal(launch.gsdCliPath, realpathSync(gsdLoader));
});

test("falls back to gsd-mcp-server on PATH when no installed layout matches", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-no-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launch = resolveWorkflowServerLaunch({
    gsdBinary: join(root, "gsd"),
    env: {},
    lookup: (cmd) => (cmd === "gsd-mcp-server" ? "/usr/local/bin/gsd-mcp-server" : null),
  });
  assert.deepEqual(launch, { command: "/usr/local/bin/gsd-mcp-server", args: [] });
});

test("returns null when no workflow server can be located", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-nothing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launch = resolveWorkflowServerLaunch({
    gsdBinary: join(root, "gsd"),
    env: {},
    lookup: () => null,
  });
  assert.equal(launch, null);
});

test("rejects malformed GSD_WORKFLOW_MCP_ARGS loudly", (t) => {
  const { gsdBinary } = makeInstalledLayout(t);
  assert.throws(
    () =>
      resolveWorkflowServerLaunch({
        gsdBinary,
        env: {
          GSD_WORKFLOW_MCP_COMMAND: "/custom/wf-server",
          GSD_WORKFLOW_MCP_ARGS: '{"not":"an array"}',
        },
        lookup: () => null,
      }),
    /GSD_WORKFLOW_MCP_ARGS/,
  );
});
