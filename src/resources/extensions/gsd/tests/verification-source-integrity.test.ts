import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

test("source snapshot ignores receipts/ and untracked scratch (#1819)", () => {
  const dir = makeTempRepo("gsd-source-1819-");
  try {
    writeFileSync(join(dir, "src.ts"), "export {}\n");
    git(dir, "add", "src.ts");
    git(dir, "commit", "-m", "src");

    const first = captureVerificationSourceSnapshot([{ id: "root", cwd: dir }]);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const baseline = first.snapshot.aggregateRevision;

    mkdirSync(join(dir, "receipts"), { recursive: true });
    writeFileSync(join(dir, "receipts", "receipts.jsonl"), '{"call":1}\n');
    git(dir, "add", "receipts/receipts.jsonl");
    git(dir, "commit", "-m", "receipts");
    writeFileSync(join(dir, "scratch-notes.ts"), "throw new Error('scratch')\n");

    const second = captureVerificationSourceSnapshot([{ id: "root", cwd: dir }]);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(
      second.snapshot.aggregateRevision,
      baseline,
      "receipts appends and untracked scratch must not move the source hash",
    );
  } finally {
    cleanup(dir);
  }
});
