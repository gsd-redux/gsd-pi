import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ensureDbOpen } from "../bootstrap/dynamic-tools.ts";
import {
  closeDatabase,
  checkpointDatabase,
  getAllMilestones,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  getSliceTasks,
} from "../gsd-db.ts";
import {
  checkMarkdownHierarchyAgainstDb,
  countMarkdownHierarchy,
} from "../migration-auto-check.ts";
import { writeGSDDirectory } from "../migrate/writer.ts";
import type { GSDProject } from "../migrate/types.ts";

const _require = createRequire(import.meta.url);

function openRawSqliteForTest(dbPath: string): { exec(sql: string): void; close(): void } {
  try {
    const mod = _require("node:sqlite") as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };
    return new mod.DatabaseSync(dbPath);
  } catch {
    type SqliteCtor = new (path: string) => { exec(sql: string): void; close(): void };
    const mod = _require("better-sqlite3") as SqliteCtor | { default: SqliteCtor };
    const DatabaseCtor: SqliteCtor = typeof mod === "function" ? mod : mod.default;
    return new DatabaseCtor(dbPath);
  }
}

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), "gsd-migration-auto-check-"));
}

function cleanup(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function projectFixture(): GSDProject {
  return {
    projectContent: "# Legacy Project\n",
    decisionsContent: "",
    requirements: [],
    milestones: [
      {
        id: "M001",
        title: "Legacy Milestone",
        vision: "Carry forward previous work",
        successCriteria: ["Existing task is visible"],
        research: null,
        boundaryMap: [],
        slices: [
          {
            id: "S01",
            title: "Legacy Slice",
            risk: "medium",
            depends: [],
            done: false,
            demo: "Legacy slice demo",
            goal: "Legacy slice demo",
            research: null,
            summary: null,
            tasks: [
              {
                id: "T01",
                title: "Legacy Task",
                description: "Task carried from markdown",
                done: false,
                estimate: "",
                files: ["src/index.ts"],
                mustHaves: [],
                summary: null,
              },
            ],
          },
        ],
      },
    ],
  };
}

test("migration auto-check preserves empty DB and reports explicit recovery", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    assert.deepEqual(countMarkdownHierarchy(base), { milestones: 1, slices: 1, tasks: 1 });

    assert.equal(await ensureDbOpen(base), true);
    assert.equal(getAllMilestones().length, 0, "fresh authoritative DB starts empty");

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "recovery-required");
    assert.equal(result.reason, "db-empty");
    assert.deepEqual(result.afterDb, { milestones: 0, slices: 0, tasks: 0 });
    assert.equal(result.recoveryCommand, "/gsd recover --confirm");
    assert.match(result.message ?? "", /run `\/gsd recover --confirm`/);
    assert.equal(getAllMilestones().length, 0);
    assert.equal(getSliceTasks("M001", "S01").length, 0);
  } finally {
    cleanup(base);
  }
});

test("migration auto-check preserves DB on hierarchy count mismatch", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    assert.equal(await ensureDbOpen(base), true);
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Legacy Slice", status: "pending", risk: "medium", depends: [], demo: "Legacy slice demo", sequence: 1 });
    assert.equal(getSliceTasks("M001", "S01").length, 0, "test fixture simulates stale DB task count");

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "recovery-required");
    assert.equal(result.reason, "count-mismatch");
    assert.deepEqual(result.beforeDb, { milestones: 1, slices: 1, tasks: 0 });
    assert.deepEqual(result.afterDb, { milestones: 1, slices: 1, tasks: 0 });
    assert.equal(result.recoveryCommand, "/gsd recover --confirm");
    assert.equal(getSliceTasks("M001", "S01").length, 0);
  } finally {
    cleanup(base);
  }
});

test("migration auto-check leaves matching DB hierarchy alone", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    assert.equal(await ensureDbOpen(base), true);
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Legacy Slice", status: "pending", risk: "medium", depends: [], demo: "Legacy slice demo", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Legacy Task", status: "pending" });

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "none");
    assert.equal(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
    assert.deepEqual(result.afterDb, { milestones: 1, slices: 1, tasks: 1 });
  } finally {
    cleanup(base);
  }
});

test("migration auto-check flags a populated DB with missing markdown and points at rebuild (not recover)", async () => {
  const base = makeBase();
  try {
    // A project with no milestone markdown: simulate lost/empty projections
    // over a populated DB. The previous early return treated all-zero markdown
    // as 'no project' and never even opened the DB, silently hiding the rows.
    await writeGSDDirectory({ projectContent: "# P\n", decisionsContent: "", requirements: [], milestones: [] }, base);
    assert.equal(await ensureDbOpen(base), true);
    assert.deepEqual(countMarkdownHierarchy(base), { milestones: 0, slices: 0, tasks: 0 });
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Legacy Slice", status: "pending", risk: "medium", depends: [], demo: "Legacy slice demo", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Legacy Task", status: "pending" });

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "recovery-required");
    assert.equal(result.reason, "markdown-missing");
    // The DB is the richer side, so recover (md → DB) would DELETE rows. The
    // safe repair is to re-project from the DB.
    assert.equal(result.recoveryCommand, "/gsd rebuild markdown");
    assert.match(result.message ?? "", /rebuild markdown/);
    assert.match(result.message ?? "", /Do NOT run/);
    // The check must not mutate the DB.
    assert.equal(getAllMilestones().length, 1);
    assert.equal(getSliceTasks("M001", "S01").length, 1);
  } finally {
    cleanup(base);
  }
});

test("migration auto-check detects identity drift even when counts match", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base); // markdown: M001 / S01 / T01
    assert.equal(await ensureDbOpen(base), true);
    // Same cardinalities (1M/1S/1T) but a DIFFERENT slice identity (S99 vs S01).
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S99", milestoneId: "M001", title: "Other Slice", status: "pending", risk: "medium", depends: [], demo: "d", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S99", milestoneId: "M001", title: "Legacy Task", status: "pending" });

    const result = await checkMarkdownHierarchyAgainstDb(base);
    // Counts are equal on both sides, so the old count-only comparison reported
    // 'in-sync'. Identity comparison must catch the divergence instead.
    assert.equal(result.action, "recovery-required");
    assert.notEqual(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
    assert.deepEqual(result.beforeDb, { milestones: 1, slices: 1, tasks: 1 });
    // The DB holds S99 (which markdown lacks), so recover would DELETE it. Even
    // at equal counts the safe recommendation must be rebuild, not recover.
    assert.equal(result.recoveryCommand, "/gsd rebuild markdown");
    assert.match(result.message ?? "", /Do NOT run/);
  } finally {
    cleanup(base);
  }
});

test("recoverWouldDeleteDbRows flags identity drift the markdown lacks (even at equal counts)", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base); // markdown: M001 / S01 / T01
    assert.equal(await ensureDbOpen(base), true);
    // DB row identity (S99) differs from markdown (S01) at the same count.
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S99", milestoneId: "M001", title: "Other Slice", status: "pending", risk: "medium", depends: [], demo: "d", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S99", milestoneId: "M001", title: "Legacy Task", status: "pending" });

    const { recoverWouldDeleteDbRows } = await import("../migration-auto-check.ts");
    assert.equal(recoverWouldDeleteDbRows(base), true, "DB S99 is absent from markdown — recover would delete it");
  } finally {
    cleanup(base);
  }
});

test("migration auto-check canonicalizes a legacy descriptor milestone dir (no false drift)", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base); // creates .gsd/milestones/M001
    // Rename the dir to a legacy descriptor form while the DB id stays "M001".
    // scanMarkdownHierarchy must canonicalize "M001-old" → "M001" so the
    // identity sets line up with scanDbHierarchy (which uses milestone.id).
    const milestonesRoot = join(base, ".gsd", "milestones");
    renameSync(join(milestonesRoot, "M001"), join(milestonesRoot, "M001-old"));

    assert.equal(await ensureDbOpen(base), true);
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Legacy Slice", status: "pending", risk: "medium", depends: [], demo: "Legacy slice demo", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Legacy Task", status: "pending" });

    const result = await checkMarkdownHierarchyAgainstDb(base);
    // Must be in-sync: the raw dir name "M001-old" would otherwise mismatch the
    // DB id "M001" and be flagged as false drift.
    assert.equal(result.action, "none");
    assert.equal(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
    assert.deepEqual(result.beforeDb, { milestones: 1, slices: 1, tasks: 1 });
  } finally {
    cleanup(base);
  }
});

test("migration auto-check refreshes a stale open DB handle before comparing", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    assert.equal(await ensureDbOpen(base), true);
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    checkpointDatabase();

    const dbPath = join(base, ".gsd", "gsd.db");
    const replacementPath = join(base, ".gsd", "gsd-replacement.db");
    copyFileSync(dbPath, replacementPath);

    const replacement = openRawSqliteForTest(replacementPath);
    try {
      replacement.exec(`
        INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo, created_at, sequence)
        VALUES ('M001', 'S01', 'Legacy Slice', 'pending', 'medium', '[]', 'Legacy slice demo', '', 1);
        INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
        VALUES ('M001', 'S01', 'T01', 'Legacy Task', 'pending', 1);
      `);
    } finally {
      replacement.close();
    }

    const staleAdapter = _getAdapter();
    renameSync(replacementPath, dbPath);

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.notEqual(_getAdapter(), staleAdapter, "startup comparison must reopen the active DB handle");
    assert.equal(result.action, "none");
    assert.equal(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
    assert.deepEqual(result.beforeDb, { milestones: 1, slices: 1, tasks: 1 });
  } finally {
    cleanup(base);
  }
});

function writeScratchMilestoneDir(base: string, milestoneId: string, file?: string): void {
  const dir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  if (file) writeFileSync(join(dir, file), `# ${milestoneId} discussion context\n`);
}

test("migration auto-check ignores discussion-scratch milestone dirs (CONTEXT only, no DB row)", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base); // markdown: M001 / S01 / T01
    assert.equal(await ensureDbOpen(base), true);
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Legacy Slice", status: "pending", risk: "medium", depends: [], demo: "Legacy slice demo", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Legacy Task", status: "pending" });

    // Mid-discussion artifacts: dirs with no ROADMAP and no DB row. The queued
    // DB row is only inserted at discussion handoff, so these are expected to
    // be DB-less — not drift, and recover must not be recommended (it would
    // import them as ghost active milestones).
    writeScratchMilestoneDir(base, "M002", "M002-CONTEXT.md");
    writeScratchMilestoneDir(base, "M003", "M003-CONTEXT-DRAFT.md");
    writeScratchMilestoneDir(base, "M004"); // empty dir

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "none");
    assert.equal(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
  } finally {
    cleanup(base);
  }
});

test("migration auto-check stays quiet mid-first-discussion (scratch dir over empty DB)", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory({ projectContent: "# P\n", decisionsContent: "", requirements: [], milestones: [] }, base);
    assert.equal(await ensureDbOpen(base), true);
    writeScratchMilestoneDir(base, "M001", "M001-CONTEXT.md");

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "none");
    assert.equal(result.reason, "no-markdown");
  } finally {
    cleanup(base);
  }
});

test("migration auto-check still reports real drift with scratch dirs excluded from counts", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base); // markdown: M001 / S01 / T01, DB empty
    assert.equal(await ensureDbOpen(base), true);
    writeScratchMilestoneDir(base, "M002", "M002-CONTEXT.md");

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "recovery-required");
    assert.equal(result.reason, "db-empty");
    assert.equal(result.recoveryCommand, "/gsd recover --confirm");
    // The scratch dir must not inflate the reported markdown count.
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
  } finally {
    cleanup(base);
  }
});

test("migration auto-check still compares a roadmapless milestone that HAS a DB row", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory({ projectContent: "# P\n", decisionsContent: "", requirements: [], milestones: [] }, base);
    assert.equal(await ensureDbOpen(base), true);
    // Post-handoff queued milestone: CONTEXT-only dir WITH a DB row. It must
    // stay in the comparison (both sides have it → in-sync).
    insertMilestone({ id: "M001", title: "M001", status: "queued" });
    writeScratchMilestoneDir(base, "M001", "M001-CONTEXT.md");

    const result = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(result.action, "none");
    assert.equal(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 0, tasks: 0 });
  } finally {
    cleanup(base);
  }
});

test("rebuildMarkdownProjectionsFromDb realigns markdown when DB holds extra rows", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base); // markdown: M001 / S01 / T01
    assert.equal(await ensureDbOpen(base), true);
    insertMilestone({ id: "M001", title: "Legacy Milestone", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Legacy Slice",
      status: "pending",
      risk: "medium",
      depends: [],
      demo: "Legacy slice demo",
      sequence: 1,
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Legacy Task",
      status: "pending",
    });
    insertSlice({
      id: "S02",
      milestoneId: "M001",
      title: "Added in DB",
      status: "pending",
      risk: "medium",
      depends: [],
      demo: "d",
      sequence: 2,
    });
    insertTask({
      id: "T02",
      sliceId: "S02",
      milestoneId: "M001",
      title: "Added task",
      status: "pending",
    });

    const before = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(before.recoveryCommand, "/gsd rebuild markdown");

    const { rebuildMarkdownProjectionsFromDb } = await import("../commands-maintenance.ts");
    const rebuild = await rebuildMarkdownProjectionsFromDb(base);
    assert.ok(rebuild.rendered > 0, "expected markdown projections to render");

    const after = await checkMarkdownHierarchyAgainstDb(base);
    assert.equal(after.action, "none");
    assert.equal(after.reason, "in-sync");
    assert.deepEqual(after.markdown, { milestones: 1, slices: 2, tasks: 2 });
    assert.deepEqual(after.beforeDb, { milestones: 1, slices: 2, tasks: 2 });
  } finally {
    cleanup(base);
  }
});
