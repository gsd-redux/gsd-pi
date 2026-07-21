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

test("discovers the installed workflow server from GSD_BIN_PATH", (t) => {
  const { gsdBinary, workflowCli } = makeInstalledLayout(t);
  const launch = resolveWorkflowServerLaunch({
    env: { GSD_BIN_PATH: gsdBinary },
    lookup: () => null,
  });

  assert.deepEqual(launch, {
    command: process.execPath,
    args: [workflowCli],
    gsdCliPath: realpathSync(gsdBinary),
  });
});

test("discovers the installed workflow server from GSD_WORKFLOW_PATH", (t) => {
  const { gsdBinary, workflowCli } = makeInstalledLayout(t);
  const workflowPath = join(dirname(dirname(gsdBinary)), "GSD-WORKFLOW.md");
  writeFileSync(workflowPath, "# GSD Workflow\n");
  const launch = resolveWorkflowServerLaunch({
    env: { GSD_WORKFLOW_PATH: workflowPath },
    lookup: () => null,
  });

  assert.deepEqual(launch, {
    command: process.execPath,
    args: [workflowCli],
  });
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

test("explicit workflow server env and cwd are carried into the launch", () => {
  const launch = resolveWorkflowServerLaunch({
    env: {
      GSD_WORKFLOW_MCP_COMMAND: "/custom/wf-server",
      GSD_WORKFLOW_MCP_ENV: JSON.stringify({
        FOO: "bar",
        GSD_BIN_PATH: "/custom/gsd",
        GSD_WORKFLOW_PROJECT_ROOT: "/custom/project",
      }),
      GSD_WORKFLOW_MCP_CWD: "/custom/cwd",
    },
    lookup: () => null,
  });

  assert.deepEqual(launch, {
    command: "/custom/wf-server",
    args: [],
    cwd: "/custom/cwd",
    env: {
      FOO: "bar",
      GSD_CLI_PATH: "/custom/gsd",
      GSD_BIN_PATH: "/custom/gsd",
      GSD_WORKFLOW_PROJECT_ROOT: "/custom/project",
    },
    gsdCliPath: "/custom/gsd",
  });
});

test("GSD_WORKFLOW_MCP_CWD sets cwd only and never becomes the workflow project root", () => {
  const launch = resolveWorkflowServerLaunch({
    env: {
      GSD_WORKFLOW_MCP_COMMAND: "/custom/wf-server",
      GSD_WORKFLOW_MCP_CWD: "/custom/cwd",
    },
    lookup: () => null,
  });
  // cwd honors the override, but no project root is inferred from it — otherwise
  // a single cwd override would pin every memoized per-project child to one root.
  assert.equal(launch?.cwd, "/custom/cwd");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, undefined);
});

test("preserves relative explicit workflow server commands for the project cwd", () => {
  const launch = resolveWorkflowServerLaunch({
    env: {
      GSD_WORKFLOW_MCP_COMMAND: "./scripts/workflow-server",
      GSD_WORKFLOW_MCP_ARGS: '["--flag"]',
    },
    lookup: () => null,
  });
  assert.deepEqual(launch, {
    command: "./scripts/workflow-server",
    args: ["--flag"],
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
  const extensionlessShim = join(npmBin, "gsd");
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
  writeFileSync(extensionlessShim, "#!/bin/sh\n");
  writeFileSync(gsdBinary, "@node node_modules/@opengsd/gsd-pi/dist/loader.js %*\r\n");
  writeFileSync(gsdLoader, "// gsd loader\n");
  writeFileSync(workflowCli, "// workflow server\n");

  const launch = resolveWorkflowServerLaunch({
    gsdBinary: "gsd",
    env: {},
    lookup: (command) =>
      command === "gsd" ? `${extensionlessShim}\r\n${gsdBinary}\r\n` : null,
    platform: "win32",
  });

  assert.ok(launch, "expected a launch config");
  assert.deepEqual(launch.args, [realpathSync(workflowCli)]);
  assert.equal(launch.gsdCliPath, realpathSync(gsdLoader));

  const extensionlessLaunch = resolveWorkflowServerLaunch({
    gsdBinary: extensionlessShim,
    env: {},
    lookup: () => null,
    platform: "win32",
  });
  assert.ok(extensionlessLaunch, "expected a launch config from the extensionless shim");
  assert.deepEqual(extensionlessLaunch.args, [realpathSync(workflowCli)]);
  assert.equal(extensionlessLaunch.gsdCliPath, realpathSync(gsdLoader));
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

test("resolves a Windows workflow server PATH shim to its JavaScript entrypoint", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-windows-server-shim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npmBin = join(root, "npm");
  const extensionlessShim = join(npmBin, "gsd-mcp-server");
  const commandShim = join(npmBin, "gsd-mcp-server.cmd");
  const entrypoint = join(
    npmBin,
    "node_modules",
    "@opengsd",
    "mcp-server",
    "bin",
    "gsd-mcp-server.js",
  );
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(extensionlessShim, "#!/bin/sh\n");
  writeFileSync(commandShim, "@node node_modules/@opengsd/mcp-server/bin/gsd-mcp-server.js %*\r\n");
  writeFileSync(entrypoint, "// workflow server entrypoint\n");

  const launch = resolveWorkflowServerLaunch({
    gsdBinary: join(root, "missing-gsd"),
    env: {},
    lookup: (command) =>
      command === "gsd-mcp-server"
        ? `${extensionlessShim}\r\n${commandShim}\r\n`
        : null,
    platform: "win32",
  });

  assert.deepEqual(launch, {
    command: process.execPath,
    args: [realpathSync(entrypoint)],
  });

  const explicitLaunch = resolveWorkflowServerLaunch({
    gsdBinary: join(root, "missing-gsd"),
    env: {
      GSD_WORKFLOW_MCP_COMMAND: commandShim,
      GSD_WORKFLOW_MCP_ARGS: '["--probe"]',
    },
    lookup: () => null,
    platform: "win32",
  });
  assert.deepEqual(explicitLaunch, {
    command: process.execPath,
    args: [realpathSync(entrypoint), "--probe"],
  });
});

test("wraps nonstandard Windows workflow server shims with native interpreters", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-windows-server-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commandShim = join(root, "custom-server.cmd");
  const powershellShim = join(root, "custom-server.ps1");
  writeFileSync(commandShim, "@custom-workflow-server %*\r\n");
  writeFileSync(powershellShim, "& custom-workflow-server @args\r\n");

  const commandLaunch = resolveWorkflowServerLaunch({
    gsdBinary: join(root, "missing-gsd"),
    env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    lookup: (command) => (command === "gsd-mcp-server" ? commandShim : null),
    platform: "win32",
  });
  assert.deepEqual(commandLaunch, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", `"${realpathSync(commandShim)}"`],
    windowsVerbatimArguments: true,
  });

  const powershellLaunch = resolveWorkflowServerLaunch({
    gsdBinary: join(root, "missing-gsd"),
    env: {
      GSD_WORKFLOW_MCP_COMMAND: powershellShim,
      GSD_WORKFLOW_MCP_ARGS: '["--probe"]',
    },
    lookup: () => null,
    platform: "win32",
  });
  assert.deepEqual(powershellLaunch, {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      realpathSync(powershellShim),
      "--probe",
    ],
  });
});

test("does not replace an explicit custom wrapper beside the workflow package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-custom-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const customWrapper = join(root, "custom-wrapper.cmd");
  const entrypoint = join(
    root,
    "node_modules",
    "@opengsd",
    "mcp-server",
    "bin",
    "gsd-mcp-server.js",
  );
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(customWrapper, "@custom-workflow-server %*\r\n");
  writeFileSync(entrypoint, "// workflow server entrypoint\n");

  const launch = resolveWorkflowServerLaunch({
    env: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      GSD_WORKFLOW_MCP_COMMAND: customWrapper,
      GSD_WORKFLOW_MCP_ARGS: '["--probe"]',
    },
    lookup: () => null,
    platform: "win32",
  });

  assert.deepEqual(launch, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `"${realpathSync(customWrapper)} ^\"--probe^\""`,
    ],
    windowsVerbatimArguments: true,
  });
});

test("double-escapes metacharacter arguments for spaced node_modules bin shims", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd cloud cmd fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commandShim = join(root, "node_modules", ".bin", "custom server.cmd");
  mkdirSync(dirname(commandShim), { recursive: true });
  writeFileSync(commandShim, "@custom-workflow-server %*\r\n");

  const launch = resolveWorkflowServerLaunch({
    env: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      GSD_WORKFLOW_MCP_COMMAND: commandShim,
      GSD_WORKFLOW_MCP_ARGS: '["left & right"]',
    },
    lookup: () => null,
    platform: "win32",
  });
  const escapedCommand = realpathSync(commandShim).replace(/ /g, "^ ");

  assert.deepEqual(launch, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `"${escapedCommand} ^^^\"left^^^ ^^^&^^^ right^^^\""`,
    ],
    windowsVerbatimArguments: true,
  });
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

test("coerces non-string GSD_WORKFLOW_MCP_ARGS entries to strings instead of throwing", (t) => {
  const { gsdBinary } = makeInstalledLayout(t);
  // Numbers/booleans are accepted and String()-coerced, matching the extension's
  // detectWorkflowMcpLaunchConfig contract, rather than rejected.
  const launch = resolveWorkflowServerLaunch({
    gsdBinary,
    env: {
      GSD_WORKFLOW_MCP_COMMAND: "/custom/wf-server",
      GSD_WORKFLOW_MCP_ARGS: '["--port", 8080, true]',
    },
    lookup: () => null,
  });
  assert.ok(launch, "expected a launch config");
  assert.deepEqual(launch.args, ["--port", "8080", "true"]);
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
    // The resolver canonicalizes on-disk commands via realpathSync, so compare
    // against the realpath (macOS tmpdir is a /private symlink).
    assert.equal(launch.command, realpathSync(stub));
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
    // The resolver canonicalizes on-disk commands via realpathSync, so compare
    // against the realpath (macOS tmpdir is a /private symlink).
    assert.equal(launch.command, realpathSync(stub));
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
