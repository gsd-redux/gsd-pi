import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleRebuild } from "../commands-maintenance.ts";
import {
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";

type Note = { message: string; kind: string };

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-rebuild-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });
  return base;
}

function cleanup(base: string): void {
  closeDatabase();
  invalidateStateCache();
  rmSync(base, { recursive: true, force: true });
}

function makeCtx(): { ctx: any; notes: Note[] } {
  const notes: Note[] = [];
  return {
    ctx: {
      ui: {
        notify: (message: string, kind: string) => notes.push({ message, kind }),
      },
    },
    notes,
  };
}

function seedOpenTask(): void {
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "in_progress",
    risk: "low",
    depends: [],
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "pending",
  });
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out.sort();
}

test("handleRebuild quarantines stale completion projections without mutating DB state", async () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedOpenTask();

    const summaryPath = join(
      base,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md",
    );
    writeFileSync(summaryPath, "# T01 Summary\n\nDisk-only completion.\n", "utf-8");

    const { ctx, notes } = makeCtx();
    await handleRebuild(ctx, base, "markdown");

    assert.equal(existsSync(summaryPath), false, "stale SUMMARY projection should be moved aside");
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending", "DB task status remains authoritative");
    assert.equal(task?.full_summary_md, "", "disk summary must not be imported into DB");

    const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
    assert.equal(quarantined.length, 1);
    assert.match(readFileSync(quarantined[0]!, "utf-8"), /Disk-only completion/);
    assert.match(notes.at(-1)?.message ?? "", /Quarantined:\s+1/);
    assert.equal(notes.at(-1)?.kind, "success");
  } finally {
    cleanup(base);
  }
});

test("handleRebuild re-renders missing task summary projections from DB", async () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedOpenTask();
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task",
      status: "complete",
      oneLiner: "Task complete",
      narrative: "Finished through the DB.",
      verificationResult: "passed",
      fullSummaryMd: "# T01 Summary\n\nRendered from DB.\n",
    });

    const summaryPath = join(
      base,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md",
    );
    rmSync(summaryPath, { force: true });

    const { ctx, notes } = makeCtx();
    await handleRebuild(ctx, base);

    assert.equal(existsSync(summaryPath), true, "missing SUMMARY projection should be regenerated");
    assert.equal(readFileSync(summaryPath, "utf-8"), "# T01 Summary\n\nRendered from DB.\n");
    assert.match(notes.at(-1)?.message ?? "", /rebuilt markdown projections from the canonical DB/);
    assert.match(notes.at(-1)?.message ?? "", /Quarantined:\s+0/);
  } finally {
    cleanup(base);
  }
});

test("handleRebuild database target is reserved and does not import markdown", async () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedOpenTask();

    const summaryPath = join(
      base,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md",
    );
    writeFileSync(summaryPath, "# T01 Summary\n\nShould not import.\n", "utf-8");

    const { ctx, notes } = makeCtx();
    await handleRebuild(ctx, base, "database");

    assert.equal(existsSync(summaryPath), true, "reserved DB rebuild must not move projection files");
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending", "reserved DB rebuild must not mutate task status");
    assert.equal(task?.full_summary_md, "", "reserved DB rebuild must not import markdown");
    assert.match(notes.at(-1)?.message ?? "", /reserved/);
    assert.match(notes.at(-1)?.message ?? "", /\/gsd recover --confirm/);
    assert.equal(notes.at(-1)?.kind, "warning");
  } finally {
    cleanup(base);
  }
});
