// Project/App: Open GSD
// File Purpose: Regression tests for GsdPiExecutor project routing — a bare alias
// (directory basename) shared by two advertised projects must fail loudly instead
// of silently routing cloud work to whichever entry comes first.
import { test } from "node:test";
import assert from "node:assert/strict";
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
