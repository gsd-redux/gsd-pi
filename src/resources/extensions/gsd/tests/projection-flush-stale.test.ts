// Project/App: gsd-pi
// File Purpose: Projection flush delivery diagnostics remain visible to mutation callers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { flushWorkflowProjections } from "../projection-flush.ts";
import { renderAllProjections } from "../workflow-projections.ts";

test("projection flush reports a swallowed readable-state obstruction as stale", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-flush-stale-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Projection delivery", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Report stale projections",
    status: "active",
  });
  mkdirSync(join(base, ".gsd", "STATE.md"));

  assert.deepEqual(await renderAllProjections(base, "M001"), { stale: true });
  assert.deepEqual(await flushWorkflowProjections(base, { milestoneId: "M001" }), {
    milestoneId: "M001",
    stale: true,
  });
});
