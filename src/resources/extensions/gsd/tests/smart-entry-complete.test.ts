// GSD-2 — Guided smart entry complete-state behavior tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState } from "../state.js";

function writeCompleteMilestone(base: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Complete Milestone",
      "",
      "## Slices",
      "- [x] **S01: Done slice** `risk:low` `depends:[]`",
      "  > Done.",
    ].join("\n"),
  );
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# M001 Summary\n\nComplete.");
}

test("deriveState reports the last completed milestone when all milestone slices are done", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-smart-entry-complete-"));
  try {
    writeCompleteMilestone(base);
    const state = await deriveState(base);
    assert.equal(state.phase, "complete");
    assert.equal(state.lastCompletedMilestone?.id, "M001");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
