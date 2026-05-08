/**
 * Regression test for #3869: normal post-unit flow should rebuild STATE.md
 * before syncing worktree state back to the project root.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoSession } from "../auto/session.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";

test("postUnitPreVerification rebuilds STATE.md after a completed unit", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-state-"));
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# Roadmap\n\n## Slices\n\n- [ ] **S01: Discussed slice** `risk:low` `depends:[]`\n",
    );
    writeFileSync(join(sliceDir, "S01-CONTEXT.md"), "# Slice Context\n\nReady.\n");

    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.currentMilestoneId = "M001";
    s.currentUnit = { type: "discuss-slice", id: "M001/S01", startedAt: Date.now() };

    const result = await postUnitPreVerification({
      s,
      ctx: { ui: { notify() {} } } as any,
      pi: {} as any,
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => {},
      updateProgressWidget: () => {},
    }, { skipSettleDelay: true, skipWorktreeSync: true });

    assert.equal(result, "continue");
    const statePath = join(base, ".gsd", "STATE.md");
    assert.equal(existsSync(statePath), true);
    assert.ok(readFileSync(statePath, "utf-8").includes("M001"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
