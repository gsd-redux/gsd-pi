// gsd-pi — gsdRoot must not follow git-root from migration staging into the live .gsd (#1866)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { gsdRoot, _clearGsdRootCache } from "../paths.ts";

test("gsdRoot on .gsd-migrate-stage-* does not return the live git-root .gsd (#1866)", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-migrate-stage-probe-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init"], { cwd: root });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });
  const liveGsd = join(root, ".gsd");
  mkdirSync(liveGsd);
  writeFileSync(join(liveGsd, "PROJECT.md"), "# live\n");
  const stagingRoot = mkdtempSync(join(root, ".gsd-migrate-stage-"));
  _clearGsdRootCache();
  const result = gsdRoot(stagingRoot);
  assert.equal(result, join(stagingRoot, ".gsd"));
  assert.notEqual(result, liveGsd);
});
