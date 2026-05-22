/**
 * Regression test for #2473: Pre-flight CONTEXT-DRAFT warning should skip
 * completed and parked milestones.
 *
 * The pre-flight loop in auto-start.ts warns about CONTEXT-DRAFT.md files
 * so the user knows which milestones will pause for discussion. But completed
 * milestones with leftover CONTEXT-DRAFT.md files are not actionable — the
 * warning is noise.
 *
 * This test exercises the filtering logic directly: given a set of milestones
 * with CONTEXT-DRAFT files, only active/pending ones should produce warnings.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertMilestone,
  getMilestone,
} from "../gsd-db.ts";
import { resolveMilestoneFile } from "../paths.ts";
import { buildPreflightMilestoneQueueNotice } from "../auto-start.ts";

describe("pre-flight CONTEXT-DRAFT filter (#2473)", () => {
  let tmpBase: string;
  let gsd: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "gsd-preflight-draft-"));
    gsd = join(tmpBase, ".gsd");

    // Create milestone directories with CONTEXT-DRAFT files
    for (const id of ["M001", "M002", "M003"]) {
      const msDir = join(gsd, "milestones", id);
      mkdirSync(msDir, { recursive: true });
      writeFileSync(join(msDir, `${id}-CONTEXT-DRAFT.md`), `# ${id}: Draft\n`);
    }

    // Open DB and insert milestones with different statuses
    const dbPath = join(gsd, "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001", title: "Complete milestone", status: "complete" });
    insertMilestone({ id: "M002", title: "Active milestone", status: "active" });
    insertMilestone({ id: "M003", title: "Parked milestone", status: "parked" });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("completed milestone is skipped — no warning emitted", () => {
    assert.ok(isDbAvailable(), "DB should be available");
    const ms = getMilestone("M001");
    assert.equal(ms?.status, "complete");
  });

  test("parked milestone is skipped — no warning emitted", () => {
    const ms = getMilestone("M003");
    assert.equal(ms?.status, "parked");
  });

  test("active milestone with CONTEXT-DRAFT produces warning", () => {
    const ms = getMilestone("M002");
    assert.equal(ms?.status, "active");

    const draft = resolveMilestoneFile(tmpBase, "M002", "CONTEXT-DRAFT");
    assert.ok(draft, "CONTEXT-DRAFT file should be found for active milestone");
  });

  test("full pre-flight filter produces warnings only for active milestones", () => {
    const notice = buildPreflightMilestoneQueueNotice(["M001", "M002", "M003"].map((id) => ({
      id,
      status: getMilestone(id)?.status ?? null,
      hasContextDraft: !!resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT"),
    })));

    assert.equal(notice?.level, "warning");
    assert.match(
      notice?.message ?? "",
      /^Pre-flight: 1 ready milestone\. 3 milestone folders total\./,
      "folder count must not be presented as queued work",
    );
    assert.match(notice?.message ?? "", /M002/, "warning should be for the active milestone only");
    assert.doesNotMatch(notice?.message ?? "", /3 milestones queued/);
  });

  test("when DB is unavailable, all milestones with CONTEXT-DRAFT produce warnings (safe fallback)", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should be unavailable after close");

    const notice = buildPreflightMilestoneQueueNotice(["M001", "M002", "M003"].map((id) => ({
      id,
      status: null,
      hasContextDraft: !!resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT"),
    })));

    assert.equal(notice?.level, "warning");
    assert.match(notice?.message ?? "", /M001/);
    assert.match(notice?.message ?? "", /M002/);
    assert.match(notice?.message ?? "", /M003/);
    assert.match(notice?.message ?? "", /^Pre-flight: 3 ready milestones\./);
  });

  test("full-context notice distinguishes ready work from total milestone folders", () => {
    rmSync(join(gsd, "milestones", "M001", "M001-CONTEXT-DRAFT.md"), { force: true });
    rmSync(join(gsd, "milestones", "M002", "M002-CONTEXT-DRAFT.md"), { force: true });
    rmSync(join(gsd, "milestones", "M003", "M003-CONTEXT-DRAFT.md"), { force: true });

    const notice = buildPreflightMilestoneQueueNotice(["M001", "M002", "M003"].map((id) => ({
      id,
      status: getMilestone(id)?.status ?? null,
      hasContextDraft: !!resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT"),
    })));

    assert.deepEqual(notice, {
      level: "info",
      message: "Pre-flight: 1 ready milestone. 3 milestone folders total. Ready milestones have full context.",
    });
  });
});
