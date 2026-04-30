// GSD-2 / commands/context.ts — withCommandCwd async isolation tests
//
// Regression for the concurrency bug where commandCwdOverride was a
// module-level singleton: two overlapping withCommandCwd calls interleaved
// across an await boundary would trample each other's override. Switched
// to AsyncLocalStorage so each async chain sees its own value.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withCommandCwd, projectRoot } from "../commands/context.ts";

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("withCommandCwd async isolation", () => {
  test("two interleaved calls see their own cwd across awaits", async () => {
    const a = mkdtempSync(join(tmpdir(), "gsd-cwd-iso-a-"));
    const b = mkdtempSync(join(tmpdir(), "gsd-cwd-iso-b-"));
    try {
      const observe = async (expected: string): Promise<string[]> => {
        const seen: string[] = [];
        seen.push(projectRoot());
        await tick();
        seen.push(projectRoot());
        await tick();
        seen.push(projectRoot());
        assert.ok(seen.every((s) => s === expected), `expected all ${expected}, saw ${seen.join(",")}`);
        return seen;
      };

      const [ra, rb] = await Promise.all([
        withCommandCwd(a, () => observe(a)),
        withCommandCwd(b, () => observe(b)),
      ]);

      assert.equal(ra.length, 3);
      assert.equal(rb.length, 3);
      assert.ok(ra.every((s) => s === a));
      assert.ok(rb.every((s) => s === b));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("override is cleared once the wrapped call resolves", async () => {
    const a = mkdtempSync(join(tmpdir(), "gsd-cwd-iso-clear-"));
    try {
      let inside = "";
      await withCommandCwd(a, async () => {
        inside = projectRoot();
      });
      assert.equal(inside, a, "inner call sees the override");
      // outside the wrapper, override is gone — projectRoot falls back to
      // process.cwd(), which here is the repo root, not `a`
      assert.notEqual(projectRoot(), a, "override does not leak past withCommandCwd");
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
});
