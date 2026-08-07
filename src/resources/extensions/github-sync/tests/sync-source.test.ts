import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadMilestoneSyncData,
  loadSliceSyncData,
  shouldCreateSlicePrForSyncEvent,
} from "../sync.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../../gsd/gsd-db.ts";

test("slice plan sync records issues without creating a draft PR", () => {
	assert.equal(shouldCreateSlicePrForSyncEvent("plan-slice", { slice_prs: true }), false);
	assert.equal(shouldCreateSlicePrForSyncEvent("research-slice", { slice_prs: true }), false);
});

test("slice completion creates the PR only after slice work is complete", () => {
	assert.equal(shouldCreateSlicePrForSyncEvent("complete-slice", { slice_prs: true }), true);
	assert.equal(shouldCreateSlicePrForSyncEvent("complete-slice", {}), true);
	assert.equal(shouldCreateSlicePrForSyncEvent("complete-slice", { slice_prs: false }), false);
});

// Post-cutover sync body data is sourced from DB rows, not roadmap/plan
// markdown. These fixtures seed the DB and pin the loaded shapes.

function seedDb(base: string): void {
	mkdirSync(join(base, ".gsd"), { recursive: true });
	openDatabase(join(base, ".gsd", "gsd.db"));
}

test("loadMilestoneSyncData reads title, vision, criteria, and slices from DB rows", (t) => {
	const tmp = mkdtempSync(join(tmpdir(), "gsd-sync-ms-data-"));
	t.after(() => {
		closeDatabase();
		rmSync(tmp, { recursive: true, force: true });
	});
	seedDb(tmp);
	insertMilestone({
		id: "M001",
		title: "M001: Platform",
		status: "active",
		planning: { vision: "Ship the platform", successCriteria: ["works", "tested"] },
	});
	insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "pending", sequence: 1 });
	insertSlice({ milestoneId: "M001", id: "S02", title: "Build", status: "pending", sequence: 2 });

	assert.deepEqual(loadMilestoneSyncData("M001"), {
		title: "M001: Platform",
		vision: "Ship the platform",
		successCriteria: ["works", "tested"],
		slices: [
			{ id: "S01", title: "Foundation" },
			{ id: "S02", title: "Build" },
		],
	});
});

test("loadMilestoneSyncData returns null for an unknown milestone", (t) => {
	const tmp = mkdtempSync(join(tmpdir(), "gsd-sync-ms-missing-"));
	t.after(() => {
		closeDatabase();
		rmSync(tmp, { recursive: true, force: true });
	});
	seedDb(tmp);

	assert.equal(loadMilestoneSyncData("M404"), null);
});

test("loadSliceSyncData reads goal, must-haves, demo, and tasks from DB rows", (t) => {
	const tmp = mkdtempSync(join(tmpdir(), "gsd-sync-slice-data-"));
	t.after(() => {
		closeDatabase();
		rmSync(tmp, { recursive: true, force: true });
	});
	seedDb(tmp);
	insertMilestone({ id: "M001", title: "M001: Platform", status: "active" });
	insertSlice({
		milestoneId: "M001",
		id: "S01",
		title: "Foundation",
		status: "pending",
		sequence: 1,
		demo: "It boots",
		planning: { goal: "Lay the foundation", successCriteria: "- Renders\n- Syncs" },
	});
	insertTask({
		milestoneId: "M001",
		sliceId: "S01",
		id: "T01",
		title: "Render data",
		sequence: 1,
		planning: { description: "Render the rows", files: ["src/a.ts"], verify: "pnpm test" },
	});
	insertTask({
		milestoneId: "M001",
		sliceId: "S01",
		id: "T02",
		title: "Sync data",
		sequence: 2,
		planning: { description: "Sync the rows" },
	});

	assert.deepEqual(loadSliceSyncData("M001", "S01"), {
		title: "Foundation",
		goal: "Lay the foundation",
		mustHaves: ["Renders", "Syncs"],
		demo: "It boots",
		tasks: [
			{ id: "T01", title: "Render data", description: "Render the rows", files: ["src/a.ts"], verify: "pnpm test" },
			{ id: "T02", title: "Sync data", description: "Sync the rows" },
		],
	});
});

test("loadSliceSyncData returns null for an unknown slice", (t) => {
	const tmp = mkdtempSync(join(tmpdir(), "gsd-sync-slice-missing-"));
	t.after(() => {
		closeDatabase();
		rmSync(tmp, { recursive: true, force: true });
	});
	seedDb(tmp);
	insertMilestone({ id: "M001", title: "M001: Platform", status: "active" });

	assert.equal(loadSliceSyncData("M001", "S99"), null);
});
