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
