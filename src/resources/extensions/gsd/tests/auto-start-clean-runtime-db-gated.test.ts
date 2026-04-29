// GSD-2 auto-start regression test: cleanStaleRuntimeUnits is DB-gated (#4663)
//
// Source-level structural check that the stale-runtime-cleanup predicate in
// auto-start.ts consults DB status when available instead of treating a
// SUMMARY-file on disk as proof of milestone completion. Pairs with #4658 /
// PR #4660 fix in auto-dispatch + auto-recovery.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { cleanStaleRuntimeUnits } from "../auto-worktree.ts";
import { extractSourceRegion } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "auto-start.ts");

describe("auto-start cleanStaleRuntimeUnits DB gating (#4663)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("imports isClosedStatus for DB-status check", () => {
    assert.match(
      source,
      /import\s*\{\s*isClosedStatus\s*\}\s*from\s*["']\.\/status-guards/,
    );
  });

  test("cleanStaleRuntimeUnits is called after openProjectDbIfPresent", () => {
    const openDbIdx = source.indexOf("await openProjectDbIfPresent(base)");
    assert.ok(openDbIdx > -1, "openProjectDbIfPresent should be called in auto-start");
    const cleanIdx = source.indexOf("cleanStaleRuntimeUnits(", openDbIdx);
    assert.ok(
      cleanIdx > -1,
      "cleanStaleRuntimeUnits must run AFTER openProjectDbIfPresent so predicate can consult DB",
    );
  });

  test("cleanStaleRuntimeUnits predicate consults DB status when available", () => {
    const cleanIdx = source.indexOf("cleanStaleRuntimeUnits(");
    assert.ok(cleanIdx > -1);
    const snippet = extractSourceRegion(source, "cleanStaleRuntimeUnits(");
    assert.match(
      snippet,
      /isDbAvailable\(\)/,
      "predicate must branch on DB availability",
    );
    assert.match(
      snippet,
      /isClosedStatus\(/,
      "predicate must check DB status via isClosedStatus",
    );
  });

  test("cleanStaleRuntimeUnits predicate still falls back to SUMMARY-file when DB unavailable", () => {
    const cleanIdx = source.indexOf("cleanStaleRuntimeUnits(");
    assert.ok(cleanIdx > -1);
    const snippet = extractSourceRegion(source, "cleanStaleRuntimeUnits(");
    assert.match(
      snippet,
      /resolveMilestoneFile\(base,\s*mid,\s*["']SUMMARY["']\)/,
      "legacy FS-fallback branch should still use SUMMARY file presence",
    );
  });

  test("cleanStaleRuntimeUnits removes legacy pseudo discuss-milestone runtime files", () => {
    const base = join(tmpdir(), `gsd-clean-runtime-${randomUUID()}`);
    const gsdRoot = join(base, ".gsd");
    const unitsDir = join(gsdRoot, "runtime", "units");
    try {
      mkdirSync(unitsDir, { recursive: true });
      const stale = join(unitsDir, "discuss-milestone-PROJECT.json");
      const valid = join(unitsDir, "discuss-milestone-M001.json");
      writeFileSync(stale, "{}\n", "utf-8");
      writeFileSync(valid, "{}\n", "utf-8");

      const cleaned = cleanStaleRuntimeUnits(gsdRoot, () => false);

      assert.equal(cleaned, 1);
      assert.equal(existsSync(stale), false);
      assert.equal(existsSync(valid), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
