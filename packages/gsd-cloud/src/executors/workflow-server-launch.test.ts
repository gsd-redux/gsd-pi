// Project/App: Open GSD
// File Purpose: Regression tests for workflow MCP server discovery. The cloud
// daemon must spawn the workflow MCP server (gsd_status, gsd_roadmap, …) — not
// `gsd --mode mcp`, whose session registry never includes the workflow adapter
// surface (issue #1513: daemon session polling failed with "Unknown tool:
// gsd_status", hanging the SaaS app boot).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflowServerLaunch } from "./workflow-server-launch.js";

function makeInstalledLayout(t: test.TestContext): { packageRoot: string; gsdBinary: string; workflowCli: string } {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-workflow-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "lib", "node_modules", "@opengsd", "gsd-pi");
  const workflowCli = join(packageRoot, "packages", "mcp-server", "dist", "cli.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(join(packageRoot, "packages", "mcp-server", "dist"), { recursive: true });
  const gsdBinary = join(packageRoot, "dist", "loader.js");
  writeFileSync(gsdBinary, "// gsd loader\n");
  writeFileSync(workflowCli, "// workflow server\n");
  // realpath: discovery resolves symlinks (macOS /var → /private/var), so
  // expectations must compare against the resolved path.
  return { packageRoot, gsdBinary, workflowCli: realpathSync(workflowCli) };
}

test("discovers the workflow server beside an installed gsd binary", (t) => {
  const { gsdBinary, workflowCli } = makeInstalledLayout(t);
  const launch = resolveWorkflowServerLaunch({ gsdBinary, env: {}, lookup: () => null });
  assert.ok(launch, "expected a launch config");
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [workflowCli]);
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
  assert.deepEqual(launch, { command: "/custom/wf-server", args: ["--flag"] });
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

test(
  "resolves gsd-mcp-server via a Node PATH scan on the injected env when which/where is unavailable",
  { skip: process.platform === "win32" ? "POSIX PATH-scan fallback" : false },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-path-scan-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stub = join(dir, "gsd-mcp-server");
    writeFileSync(stub, "#!/bin/sh\n");
    // Executable bit set so the scan (which mirrors `which`'s X_OK check) accepts it.
    chmodSync(stub, 0o755);
    // The injected env's PATH holds only our temp dir, so `which` itself cannot
    // be located and execFileSync throws — forcing the default lookup's
    // Node-side scan, which must honor options.env (not process.env) and still
    // find the server file sitting on that PATH.
    const launch = resolveWorkflowServerLaunch({
      gsdBinary: join(dir, "missing", "gsd"),
      env: { PATH: dir },
    });
    assert.ok(launch, "expected a launch config");
    assert.equal(launch.command, stub);
    assert.deepEqual(launch.args, []);
  },
);

test("rejects invalid-JSON GSD_WORKFLOW_MCP_ARGS with a targeted error", (t) => {
  const { gsdBinary } = makeInstalledLayout(t);
  assert.throws(
    () =>
      resolveWorkflowServerLaunch({
        gsdBinary,
        env: {
          GSD_WORKFLOW_MCP_COMMAND: "/custom/wf-server",
          GSD_WORKFLOW_MCP_ARGS: "--flag --other",
        },
        lookup: () => null,
      }),
    /GSD_WORKFLOW_MCP_ARGS must be valid JSON/,
  );
});

test(
  "scans a Windows-style Path (not PATH) env var in the Node PATH fallback",
  { skip: process.platform === "win32" ? "POSIX PATH-scan fallback" : false },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-path-casing-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stub = join(dir, "gsd-mcp-server");
    writeFileSync(stub, "#!/bin/sh\n");
    chmodSync(stub, 0o755);
    // Only `Path` is set (no `PATH`), as Windows exposes it. With no PATH on the
    // injected env, `which` cannot be located and execFileSync throws, forcing
    // the Node-side scan, which must still find the server via the case-variant
    // fallback. No lookup is injected so the real defaultLookup runs.
    const launch = resolveWorkflowServerLaunch({
      gsdBinary: join(dir, "missing", "gsd"),
      env: { Path: dir },
    });
    assert.ok(launch, "expected a launch config");
    assert.equal(launch.command, stub);
    assert.deepEqual(launch.args, []);
  },
);

test(
  "ignores a same-named directory on PATH (searchable bit is not executability)",
  { skip: process.platform === "win32" ? "POSIX directory exec-bit semantics" : false },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-dir-decoy-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A directory named exactly like the command carries the execute
    // ("searchable") bit on POSIX; the scan must not mistake it for the binary.
    mkdirSync(join(dir, "gsd-mcp-server"));
    const launch = resolveWorkflowServerLaunch({
      gsdBinary: join(dir, "missing", "gsd"),
      env: { PATH: dir },
    });
    assert.equal(launch, null);
  },
);

test("a bare gsd name that does not resolve on PATH does not anchor discovery off cwd", (t) => {
  const fakeCwd = mkdtempSync(join(tmpdir(), "gsd-cloud-cwd-anchor-"));
  t.after(() => rmSync(fakeCwd, { recursive: true, force: true }));
  // A decoy `gsd` file plus a plausible installed layout in cwd — the trap the
  // pre-fix code would walk into via resolve("gsd") anchoring off cwd.
  mkdirSync(join(fakeCwd, "packages", "mcp-server", "dist"), { recursive: true });
  writeFileSync(join(fakeCwd, "gsd"), "// decoy launcher\n");
  writeFileSync(join(fakeCwd, "packages", "mcp-server", "dist", "cli.js"), "// decoy server\n");
  const originalCwd = process.cwd();
  process.chdir(fakeCwd);
  t.after(() => process.chdir(originalCwd));
  const launch = resolveWorkflowServerLaunch({
    gsdBinary: "gsd",
    env: {},
    // Neither the bare gsd name nor gsd-mcp-server resolves on PATH.
    lookup: () => null,
  });
  assert.equal(launch, null);
});
