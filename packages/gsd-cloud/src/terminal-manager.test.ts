import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureNodePtySpawnHelperExecutable } from "./terminal-manager.js";

test("terminal manager repairs non-executable node-pty spawn helper", {
  skip: process.platform === "win32",
}, () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "gsd-node-pty-"));
  const prebuildRoot = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`);
  const helperPath = join(prebuildRoot, "spawn-helper");

  try {
    mkdirSync(prebuildRoot, { recursive: true });
    writeFileSync(helperPath, "helper", { mode: 0o644 });
    chmodSync(helperPath, 0o644);

    ensureNodePtySpawnHelperExecutable(packageRoot);

    assert.notEqual(
      statSync(helperPath).mode & 0o111,
      0,
      "spawn-helper must be executable before node-pty tries to launch it",
    );
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});
