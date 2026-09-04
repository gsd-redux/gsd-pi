// Project/App: gsd-pi
// File Purpose: Regression test for #2128 — pushIndented must not emit
// indent-only (trailing whitespace) lines for blank description lines.
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderPlanFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(descriptionLines: string[] = [
  "First paragraph of the task.",
  "",
  "Second paragraph of the task.",
]): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-ws-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
    planning: {
      description: descriptionLines.join("\n"),
    },
  });
  tmpDirs.push(base);
  return base;
}

describe("markdown-renderer whitespace (#2128)", () => {
  afterEach(() => {
    closeDatabase();
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    tmpDirs.length = 0;
  });

  test("plan <tasks> block keeps blank description lines truly empty", async () => {
    const base = makeTmp();
    const result = await renderPlanFromDb(base, "M001", "S01");
    const lines = result.content.split("\n");

    const whitespaceOnly = lines.filter((line) => /^\s+$/.test(line));
    assert.deepEqual(whitespaceOnly, [], "no rendered line may be whitespace-only");

    const first = lines.indexOf("  First paragraph of the task.");
    const second = lines.indexOf("  Second paragraph of the task.");
    assert.notEqual(first, -1, "indented first paragraph must survive");
    assert.notEqual(second, -1, "indented second paragraph must survive");
    assert.equal(second - first, 2, "exactly one blank separator line between paragraphs");
    assert.equal(lines[first + 1], "", "paragraph-break line must be empty, not indent-only");
  });

  test("whitespace-only and CRLF blank separators render truly empty", async () => {
    const base = makeTmp([
      "Para A.",
      "   ",
      "\r",
      "Para B.",
    ]);
    const result = await renderPlanFromDb(base, "M001", "S01");
    const lines = result.content.split("\n");

    const whitespaceOnly = lines.filter((line) => /^\s+$/.test(line));
    assert.deepEqual(whitespaceOnly, [], "space-only and \\r-only separators must not emit trailing whitespace");

    const first = lines.indexOf("  Para A.");
    const second = lines.indexOf("  Para B.");
    assert.notEqual(first, -1, "indented Para A must survive");
    assert.notEqual(second, -1, "indented Para B must survive");
    assert.equal(second - first, 3, "two blank separators between the paragraphs");
    assert.deepEqual(lines.slice(first + 1, second), ["", ""], "every separator line must be truly empty");
  });
});
