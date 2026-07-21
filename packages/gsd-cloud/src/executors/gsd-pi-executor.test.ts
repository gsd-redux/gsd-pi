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
import { GsdPiExecutor } from "./gsd-pi-executor.js";

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

test("missing workflow server rejects without an unhandled rejection", (t) => {
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
      await executor.execute("gsd_status", {});
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
