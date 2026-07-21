// Project/App: Open GSD
// File Purpose: Regression tests for GsdPiExecutor project routing — a bare alias
// (directory basename) shared by two advertised projects must fail loudly instead
// of silently routing cloud work to whichever entry comes first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { GsdPiExecutor, type WorkflowClientFactory } from "./gsd-pi-executor.js";
import type { McpStdioClient } from "./mcp-stdio-client.js";

// Derive the spawn-options shape from the executor's factory signature so the
// helper stays aligned with it (e.g. windowsVerbatimArguments) instead of
// re-declaring a subset that drifts and hides Windows-shim wiring.
type SpawnOptions = Parameters<WorkflowClientFactory>[3];

interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** Restore an env var, deleting it when the original was unset (assigning
 * `undefined` would otherwise coerce to the string "undefined"). */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Records how the per-project MCP client would be constructed, without spawning. */
function recordingClientFactory(sink: SpawnRecord[]): WorkflowClientFactory {
  return (command, args, _logger, options) => {
    sink.push({ command, args, options });
    return {
      callTool: async () => ({ ok: true }),
      close: () => undefined,
    } as unknown as McpStdioClient;
  };
}

const warnings: Array<{ msg: string; meta: unknown }> = [];
const logger = {
  info: () => undefined,
  warn: (msg: string, meta?: unknown) => warnings.push({ msg, meta }),
  error: () => undefined,
  debug: () => undefined,
};

function writeCliPathServer(serverPath: string): void {
  writeFileSync(
    serverPath,
    `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: {} }
    : { gsdCliPath: process.env.GSD_CLI_PATH };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`,
  );
}

test("ambiguous alias across colliding basenames rejects instead of mis-routing", async () => {
  const exec = new GsdPiExecutor(logger as never, {
    projectDirs: ["/tmp/team-a/web", "/tmp/team-b/web"],
  });
  await assert.rejects(exec.execute("gsd_status", {}, "web"), /ambiguous/i);
});

test("constructing with colliding aliases warns once", () => {
  warnings.length = 0;
  // eslint-disable-next-line no-new
  new GsdPiExecutor(logger as never, { projectDirs: ["/tmp/team-a/web", "/tmp/team-b/web"] });
  const dupWarn = warnings.filter((w) => /duplicate project alias/i.test(w.msg));
  assert.equal(dupWarn.length, 1);
});

test("missing alias with several projects rejects instead of using the first", async () => {
  const exec = new GsdPiExecutor(logger as never, {
    projectDirs: ["/tmp/alpha", "/tmp/beta"],
  });
  await assert.rejects(exec.execute("gsd_status", {}), /ambiguous/i);
});

test("an alias that is not advertised rejects", async () => {
  const exec = new GsdPiExecutor(logger as never, { projectDirs: ["/tmp/solo/app"] });
  await assert.rejects(exec.execute("gsd_status", {}, "nope"), /not advertised/i);
});

test("advertised alias is the directory basename", async () => {
  const exec = new GsdPiExecutor(logger as never, { projectDirs: ["/tmp/solo/app"] });
  const projects = await exec.advertisedProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.alias, "app");
});

test("initialization rejects a missing workflow server without an unhandled rejection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-missing-server-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });

  const childScript = `
    import { GsdPiExecutor } from ${JSON.stringify(new URL("./gsd-pi-executor.js", import.meta.url).href)};
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const executor = new GsdPiExecutor(logger, {
      gsdBinary: ${JSON.stringify(join(root, "missing-gsd"))},
      projectDirs: [${JSON.stringify(projectDir)}],
    });
    try {
      executor.initialize();
      process.exitCode = 2;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Cannot locate")) {
        process.exitCode = 3;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
  delete env.GSD_CLI_PATH;
  delete env.GSD_BIN_PATH;
  delete env.GSD_WORKFLOW_PATH;
  delete env.GSD_WORKFLOW_MCP_COMMAND;
  delete env.GSD_WORKFLOW_MCP_ARGS;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childScript],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("configured gsd binary is passed to the workflow server", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-cli-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const serverPath = join(root, "server.mjs");
  const gsdBinary = join(root, "custom", "gsd");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dirname(gsdBinary), { recursive: true });
  writeFileSync(gsdBinary, "#!/usr/bin/env node\n");
  writeCliPathServer(serverPath);

  const previousCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const previousArgs = process.env.GSD_WORKFLOW_MCP_ARGS;
  process.env.GSD_WORKFLOW_MCP_COMMAND = process.execPath;
  process.env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify([serverPath]);
  t.after(() => {
    if (previousCommand === undefined) delete process.env.GSD_WORKFLOW_MCP_COMMAND;
    else process.env.GSD_WORKFLOW_MCP_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.GSD_WORKFLOW_MCP_ARGS;
    else process.env.GSD_WORKFLOW_MCP_ARGS = previousArgs;
  });

  const executor = new GsdPiExecutor(logger as never, { gsdBinary, projectDirs: [projectDir] });
  t.after(() => executor.close());
  const result = await executor.execute("gsd_status", {});

  assert.deepEqual(result, { gsdCliPath: realpathSync(gsdBinary) });
});

test("bare gsd name is resolved before reaching the workflow server", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-bare-cli-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const npmBin = join(root, "npm");
  const serverPath = join(root, "server.mjs");
  const gsdBinary = join(npmBin, process.platform === "win32" ? "gsd.cmd" : "gsd");
  let expectedGsdCliPath = gsdBinary;
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(gsdBinary, process.platform === "win32" ? "@node %*\r\n" : "#!/bin/sh\n");
  if (process.platform === "win32") {
    expectedGsdCliPath = join(
      npmBin,
      "node_modules",
      "@opengsd",
      "gsd-pi",
      "dist",
      "loader.js",
    );
    mkdirSync(dirname(expectedGsdCliPath), { recursive: true });
    writeFileSync(expectedGsdCliPath, "#!/usr/bin/env node\n");
  } else {
    chmodSync(gsdBinary, 0o755);
  }
  writeCliPathServer(serverPath);

  const previousCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const previousArgs = process.env.GSD_WORKFLOW_MCP_ARGS;
  const previousCliPath = process.env.GSD_CLI_PATH;
  const previousPath = process.env.PATH;
  process.env.GSD_WORKFLOW_MCP_COMMAND = process.execPath;
  process.env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify([serverPath]);
  delete process.env.GSD_CLI_PATH;
  process.env.PATH = `${npmBin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousCommand === undefined) delete process.env.GSD_WORKFLOW_MCP_COMMAND;
    else process.env.GSD_WORKFLOW_MCP_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.GSD_WORKFLOW_MCP_ARGS;
    else process.env.GSD_WORKFLOW_MCP_ARGS = previousArgs;
    if (previousCliPath === undefined) delete process.env.GSD_CLI_PATH;
    else process.env.GSD_CLI_PATH = previousCliPath;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const executor = new GsdPiExecutor(logger as never, { projectDirs: [projectDir] });
  t.after(() => executor.close());
  const result = await executor.execute("gsd_status", {});

  assert.deepEqual(result, { gsdCliPath: realpathSync(expectedGsdCliPath) });
});

test("Milestone lifecycle request identity becomes private MCP metadata", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-cloud-private-identity-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }> = [];
  const executor = new GsdPiExecutor(logger as never, { projectDirs: [projectDir] });
  const internals = executor as unknown as {
    projects: Map<string, {
      alias: string;
      path: string;
      client: {
        callTool: (
          name: string,
          args: Record<string, unknown>,
          meta?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    }>;
  };
  internals.projects.set(resolve(projectDir), {
    alias: basename(projectDir),
    path: resolve(projectDir),
    client: {
      callTool: async (name, args, meta) => {
        calls.push({ name, args, meta });
        return { ok: true };
      },
    },
  });
  const executeWithRequestId = executor.execute.bind(executor) as (
    toolName: string,
    args: Record<string, unknown>,
    projectAlias?: string,
    requestId?: string,
  ) => Promise<unknown>;
  const toolNames = [
    "gsd_complete_milestone",
    "gsd_milestone_complete",
    "gsd_milestone_reopen",
    "gsd_reopen_milestone",
  ];

  for (const toolName of toolNames) {
    await executeWithRequestId(
      toolName,
      { milestoneId: "M001" },
      basename(projectDir),
      `gateway-${toolName}`,
    );
  }

  assert.deepEqual(calls, toolNames.map((name) => ({
    name,
    args: { milestoneId: "M001", projectDir: resolve(projectDir) },
    meta: { "io.opengsd/idempotency-key": `gateway-${name}` },
  })));
});

test("createProjectEntry spawns the resolved workflow server pinned to the project dir", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-cloud-wiring-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));

  const originalCmd = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const originalArgs = process.env.GSD_WORKFLOW_MCP_ARGS;
  // Pin discovery to an explicit command so the test does not depend on a real
  // installed server or PATH.
  process.env.GSD_WORKFLOW_MCP_COMMAND = "/opt/gsd/wf-server";
  process.env.GSD_WORKFLOW_MCP_ARGS = '["--stdio"]';
  t.after(() => {
    restoreEnv("GSD_WORKFLOW_MCP_COMMAND", originalCmd);
    restoreEnv("GSD_WORKFLOW_MCP_ARGS", originalArgs);
  });

  const spawned: SpawnRecord[] = [];
  const executor = new GsdPiExecutor(logger as never, {
    gsdBinary: "/usr/local/bin/gsd",
    projectDirs: [projectDir],
    clientFactory: recordingClientFactory(spawned),
  });

  await executor.execute("gsd_status", {}, basename(projectDir));

  assert.equal(spawned.length, 1);
  const call = spawned[0]!;
  assert.equal(call.command, "/opt/gsd/wf-server");
  assert.deepEqual(call.args, ["--stdio"]);
  assert.equal(call.options.cwd, resolve(projectDir));
  assert.equal(call.options.env?.GSD_PROJECT_ROOT, resolve(projectDir));
  assert.equal(call.options.env?.GSD_WORKFLOW_PROJECT_ROOT, resolve(projectDir));
  assert.equal(call.options.env?.GSD_MCP_CLIENT_MANAGED, "1");
  // gsdBinary is an absolute path, so it is propagated to the child as both
  // GSD_CLI_PATH and GSD_BIN_PATH (equivalent CLI-path overrides downstream).
  assert.equal(call.options.env?.GSD_CLI_PATH, "/usr/local/bin/gsd");
  assert.equal(call.options.env?.GSD_BIN_PATH, "/usr/local/bin/gsd");
});

test("createProjectEntry honors explicit workflow env and cwd", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-cloud-explicit-launch-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));

  const previousCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const previousEnv = process.env.GSD_WORKFLOW_MCP_ENV;
  const previousCwd = process.env.GSD_WORKFLOW_MCP_CWD;
  process.env.GSD_WORKFLOW_MCP_COMMAND = "/opt/gsd/wf-server";
  process.env.GSD_WORKFLOW_MCP_ENV = JSON.stringify({
    CUSTOM_WORKFLOW_VALUE: "preserved",
    GSD_BIN_PATH: "/opt/custom/gsd",
  });
  process.env.GSD_WORKFLOW_MCP_CWD = "/opt/workflow-cwd";
  t.after(() => {
    restoreEnv("GSD_WORKFLOW_MCP_COMMAND", previousCommand);
    restoreEnv("GSD_WORKFLOW_MCP_ENV", previousEnv);
    restoreEnv("GSD_WORKFLOW_MCP_CWD", previousCwd);
  });

  const spawned: SpawnRecord[] = [];
  const executor = new GsdPiExecutor(logger as never, {
    projectDirs: [projectDir],
    clientFactory: recordingClientFactory(spawned),
  });

  await executor.execute("gsd_status", {}, basename(projectDir));

  assert.equal(spawned[0]!.options.cwd, "/opt/workflow-cwd");
  assert.equal(spawned[0]!.options.env?.CUSTOM_WORKFLOW_VALUE, "preserved");
  assert.equal(spawned[0]!.options.env?.GSD_CLI_PATH, "/opt/custom/gsd");
  assert.equal(spawned[0]!.options.env?.GSD_BIN_PATH, "/opt/custom/gsd");
  // GSD_WORKFLOW_MCP_CWD overrides the working directory only — it must NOT leak
  // into the workflow project root, which stays pinned to the per-project path
  // so multi-project routing is preserved.
  assert.equal(spawned[0]!.options.env?.GSD_WORKFLOW_PROJECT_ROOT, resolve(projectDir));
});

test("GSD_BIN_PATH wins over the executor's default gsd PATH anchor", async (t) => {
  const preferred = mkdtempSync(join(tmpdir(), "gsd-cloud-preferred-gsd-"));
  const pathInstall = mkdtempSync(join(tmpdir(), "gsd-cloud-path-gsd-"));
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-cloud-precedence-project-"));
  t.after(() => {
    rmSync(preferred, { recursive: true, force: true });
    rmSync(pathInstall, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const preferredGsd = join(preferred, "dist", "loader.js");
  const pathGsd = join(pathInstall, "gsd");
  mkdirSync(dirname(preferredGsd), { recursive: true });
  writeFileSync(preferredGsd, "// preferred gsd\n");
  writeFileSync(pathGsd, "#!/bin/sh\n");
  chmodSync(pathGsd, 0o755);

  const previousCommand = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const previousBinPath = process.env.GSD_BIN_PATH;
  const previousCliPath = process.env.GSD_CLI_PATH;
  const previousPath = process.env.PATH;
  process.env.GSD_WORKFLOW_MCP_COMMAND = "/opt/gsd/wf-server";
  process.env.GSD_BIN_PATH = preferredGsd;
  delete process.env.GSD_CLI_PATH;
  process.env.PATH = pathInstall;
  t.after(() => {
    restoreEnv("GSD_WORKFLOW_MCP_COMMAND", previousCommand);
    restoreEnv("GSD_BIN_PATH", previousBinPath);
    restoreEnv("GSD_CLI_PATH", previousCliPath);
    restoreEnv("PATH", previousPath);
  });

  const spawned: SpawnRecord[] = [];
  const executor = new GsdPiExecutor(logger as never, {
    projectDirs: [projectDir],
    clientFactory: recordingClientFactory(spawned),
  });

  await executor.execute("gsd_status", {}, basename(projectDir));

  assert.equal(spawned[0]!.options.env?.GSD_CLI_PATH, realpathSync(preferredGsd));
  assert.equal(spawned[0]!.options.env?.GSD_BIN_PATH, realpathSync(preferredGsd));
});

test("createProjectEntry does not inject GSD_CLI_PATH for a bare gsd binary name", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-cloud-wiring-bare-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));

  const originalCmd = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const originalArgs = process.env.GSD_WORKFLOW_MCP_ARGS;
  const originalCliPath = process.env.GSD_CLI_PATH;
  const originalBinPath = process.env.GSD_BIN_PATH;
  const originalPath = process.env.PATH;
  process.env.GSD_WORKFLOW_MCP_COMMAND = "/opt/gsd/wf-server";
  delete process.env.GSD_WORKFLOW_MCP_ARGS;
  // Ensure the ambient env does not carry GSD_CLI_PATH, so the assertion proves
  // the executor did not inject the bare name.
  delete process.env.GSD_CLI_PATH;
  // Seed a stale GSD_BIN_PATH (an equivalent CLI-path override downstream) to
  // prove the executor strips it rather than letting it leak into the child.
  process.env.GSD_BIN_PATH = "/stale/daemon/gsd";
  // Point PATH at an empty dir so the bare "gsd" anchor cannot resolve to a
  // real on-disk binary — a host-installed gsd would legitimately be
  // discovered by the resolver and propagated as gsdCliPath.
  const emptyBin = mkdtempSync(join(tmpdir(), "gsd-cloud-empty-path-"));
  t.after(() => rmSync(emptyBin, { recursive: true, force: true }));
  process.env.PATH = emptyBin;
  t.after(() => {
    restoreEnv("GSD_WORKFLOW_MCP_COMMAND", originalCmd);
    restoreEnv("GSD_WORKFLOW_MCP_ARGS", originalArgs);
    restoreEnv("GSD_CLI_PATH", originalCliPath);
    restoreEnv("GSD_BIN_PATH", originalBinPath);
    restoreEnv("PATH", originalPath);
  });

  const spawned: SpawnRecord[] = [];
  const executor = new GsdPiExecutor(logger as never, {
    gsdBinary: "gsd",
    projectDirs: [projectDir],
    clientFactory: recordingClientFactory(spawned),
  });

  await executor.execute("gsd_status", {}, basename(projectDir));

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.options.env?.GSD_CLI_PATH, undefined);
  // The stale inherited GSD_BIN_PATH must be stripped alongside GSD_CLI_PATH.
  assert.equal(spawned[0]!.options.env?.GSD_BIN_PATH, undefined);
});
