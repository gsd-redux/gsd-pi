// GSD-2 / unit-runtime — true cross-process concurrency test for the
// per-record advisory lock. Spawns N tsx children in parallel, each
// performing one read-modify-write increment. If the lock works, the
// final progressCount equals N (no lost writes from interleaved RMW).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readUnitRuntimeRecord } from "../unit-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "unit-runtime-concurrent-incrementer.ts");

function runChild(base: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "tsx", fixture, base], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

describe("unit-runtime per-record lock — true concurrency", () => {
  test("N parallel writers preserve every increment", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-runtime-concurrency-"));
    mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });

    const N = 8;
    try {
      const codes = await Promise.all(Array.from({ length: N }, () => runChild(base)));
      assert.ok(codes.every((c) => c === 0), `all ${N} children exited 0 (got ${codes.join(",")})`);

      const record = readUnitRuntimeRecord(base, "execute-task", "M001/S01/T01");
      assert.ok(record !== null, "record exists after concurrent writes");
      assert.equal(
        record!.progressCount,
        N,
        `expected progressCount=${N} but saw ${record!.progressCount} — lost writes from interleaved RMW`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
