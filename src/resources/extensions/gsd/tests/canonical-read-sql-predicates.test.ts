import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { closeDatabase, getDb, insertRequirement, openDatabase } from "../gsd-db.ts";
import { resolveProjectRootDbPath } from "../db-workspace.ts";
import { queryDecisionsWithLimit, queryRequirementsWithLimit } from "../context-store.ts";

function createTempProject(prefix: string): string {
  const base = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanupProject(base: string): void {
  try {
    closeDatabase();
  } catch {
    // noop
  }
  rmSync(base, { recursive: true, force: true });
}

function seedRequirement(index: number, cls: string): void {
  const id = `R${String(index).padStart(4, "0")}`;
  insertRequirement({
    id,
    class: cls,
    status: "active",
    description: `Requirement ${id}`,
    why: "Regression coverage",
    source: "test",
    primary_owner: "M001/S01",
    supporting_slices: "",
    validation: "n/a",
    notes: "",
    full_content: `- [ ] **${id}: Requirement ${id}**`,
    superseded_by: null,
  });
}

function seedDecisionMemory(memoryId: string, fields: Record<string, unknown>): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, category, content, created_at, updated_at, structured_fields)
     VALUES (:id, 'architecture', :content, :created_at, :updated_at, :structured_fields)`,
  ).run({
    ":id": memoryId,
    ":content": `Decision memory ${memoryId}`,
    ":created_at": now,
    ":updated_at": now,
    ":structured_fields": JSON.stringify(fields),
  });
}

test("queryRequirementsWithLimit applies class predicate in SQL before LIMIT", () => {
  const base = createTempProject("gsd-canonical-sql-reqs");
  try {
    openDatabase(resolveProjectRootDbPath(base));

    for (let i = 1; i <= 210; i += 1) {
      seedRequirement(i, "core-capability");
    }
    for (let i = 211; i <= 240; i += 1) {
      seedRequirement(i, "constraint");
    }

    const rows = queryRequirementsWithLimit({
      class: "constraint",
      limit: 200,
    });

    assert.equal(rows.length, 30);
    assert.ok(rows.every((row) => row.class === "constraint"));
    assert.equal(rows[0]?.id, "R0211");
    assert.equal(rows[29]?.id, "R0240");
  } finally {
    cleanupProject(base);
  }
});

test("queryDecisionsWithLimit includeSuperseded=true includes superseded but excludes deleted tombstones", () => {
  const base = createTempProject("gsd-canonical-sql-decisions");
  try {
    openDatabase(resolveProjectRootDbPath(base));

    seedDecisionMemory("mem-active", {
      sourceDecisionId: "D100",
      when_context: "M001",
      scope: "architecture",
      decision: "Use architecture A",
      choice: "A",
      rationale: "active",
      revisable: "no",
      made_by: "agent",
      source: "discussion",
      superseded_by: null,
    });

    seedDecisionMemory("mem-superseded", {
      sourceDecisionId: "D101",
      when_context: "M001",
      scope: "architecture",
      decision: "Old approach",
      choice: "B",
      rationale: "superseded",
      revisable: "yes",
      made_by: "agent",
      source: "discussion",
      superseded_by: "D200",
    });

    seedDecisionMemory("mem-deleted", {
      sourceDecisionId: "D102",
      when_context: "M001",
      scope: "architecture",
      decision: "Deleted decision",
      choice: "C",
      rationale: "tombstone",
      revisable: "yes",
      made_by: "agent",
      source: "discussion",
      deleted: true,
      superseded_by: null,
    });

    const rows = queryDecisionsWithLimit({
      includeSuperseded: true,
      limit: 200,
    });
    const ids = rows.map((row) => row.id).sort();

    assert.deepEqual(ids, ["D100", "D101"]);
  } finally {
    cleanupProject(base);
  }
});
