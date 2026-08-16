import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { buildSliceFileName, resolveSliceFile, targetSliceFile, _clearGsdRootCache } from "../paths.ts";

test("suffixed slice IDs produce distinct plan files at all three call sites (#1664)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-suffix-"));
  try {
    _clearGsdRootCache();
    const phaseDir = join(base, ".gsd", "phases", "01-suffix");
    mkdirSync(phaseDir, { recursive: true });

    assert.equal(buildSliceFileName("S01-replan", "PLAN"), "01-PLAN.md");
    assert.equal(buildSliceFileName("S02-db-repair", "PLAN"), "02-PLAN.md");
    assert.notEqual(
      buildSliceFileName("S01-replan", "PLAN"),
      buildSliceFileName("S02-db-repair", "PLAN"),
    );

    const first = targetSliceFile(base, "M001", "S01-replan", "PLAN", "suffix");
    const second = targetSliceFile(base, "M001", "S02-db-repair", "PLAN", "suffix");
    assert.notEqual(first, second);
    assert.match(first, /01-01-PLAN\.md$/);
    assert.match(second, /01-02-PLAN\.md$/);

    writeFileSync(first, "# S01-replan\n");
    writeFileSync(second, "# S02-db-repair\n");
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);
    assert.equal(resolveSliceFile(base, "M001", "S01-replan", "PLAN"), first);
    assert.equal(resolveSliceFile(base, "M001", "S02-db-repair", "PLAN"), second);
  } finally {
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});
