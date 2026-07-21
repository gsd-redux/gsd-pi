// Project/App: Open GSD
// File Purpose: Regression tests for GsdPiExecutor project routing — a bare alias
// (directory basename) shared by two advertised projects must fail loudly instead
// of silently routing cloud work to whichever entry comes first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { GsdPiExecutor } from "./gsd-pi-executor.js";
import type { McpStdioClient } from "./mcp-stdio-client.js";

interface SpawnRecord {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
}

/** Restore an env var, deleting it when the original was unset (assigning
 * `undefined` would otherwise coerce to the string "undefined"). */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Records how the per-project MCP client would be constructed, without spawning. */
function recordingClientFactory(sink: SpawnRecord[]) {
  return (
    command: string,
    args: string[],
    _logger: unknown,
    options: { env?: NodeJS.ProcessEnv; cwd?: string },
  ): McpStdioClient => {
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
  // gsdBinary is an absolute path, so it is propagated to the child.
  assert.equal(call.options.env?.GSD_CLI_PATH, "/usr/local/bin/gsd");
});

test("createProjectEntry does not inject GSD_CLI_PATH for a bare gsd binary name", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-cloud-wiring-bare-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));

  const originalCmd = process.env.GSD_WORKFLOW_MCP_COMMAND;
  const originalArgs = process.env.GSD_WORKFLOW_MCP_ARGS;
  const originalCliPath = process.env.GSD_CLI_PATH;
  process.env.GSD_WORKFLOW_MCP_COMMAND = "/opt/gsd/wf-server";
  delete process.env.GSD_WORKFLOW_MCP_ARGS;
  // Ensure the ambient env does not carry GSD_CLI_PATH, so the assertion proves
  // the executor did not inject the bare name.
  delete process.env.GSD_CLI_PATH;
  t.after(() => {
    restoreEnv("GSD_WORKFLOW_MCP_COMMAND", originalCmd);
    restoreEnv("GSD_WORKFLOW_MCP_ARGS", originalArgs);
    restoreEnv("GSD_CLI_PATH", originalCliPath);
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
});
