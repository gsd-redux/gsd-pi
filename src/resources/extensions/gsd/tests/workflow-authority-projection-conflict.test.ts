import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";
import { queryDecisionsFromMemories, queryRequirements } from "../context-store.ts";
import { deriveStateFromDb } from "../state.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

function writeProjection(root: string, path: string, content: string): void {
  const fullPath = join(root, ".gsd", path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function writeContradictoryProjections(root: string): void {
  writeProjection(
    root,
    "STATE.md",
    [
      "# GSD State",
      "",
      "**Active Milestone:** M999",
      "**Active Slice:** S99",
      "**Phase:** complete",
      "**Requirements Status:** 0 active · 1 validated",
    ].join("\n"),
  );
  writeProjection(
    root,
    "PROJECT.md",
    [
      "# Projection-only project",
      "",
      "## Milestone Sequence",
      "- [x] M001: Falsely complete",
      "- [ ] M999: Projection-only active milestone",
    ].join("\n"),
  );
  writeProjection(
    root,
    "REQUIREMENTS.md",
    [
      "# Requirements",
      "",
      "## Validated",
      "### R999 — Markdown controls workflow state",
      "- Status: validated",
      "- Primary owning slice: M999/S99",
    ].join("\n"),
  );
  writeProjection(
    root,
    "DECISIONS.md",
    [
      "# Decisions Register",
      "",
      "| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |",
      "|---|------|-------|----------|--------|-----------|------------|---------|",
      "| D999 | M999/S99 | architecture | Choose authority | Markdown is authoritative | projection conflict | No | human |",
    ].join("\n"),
  );
  writeProjection(
    root,
    "milestones/M001/M001-ROADMAP.md",
    [
      "# M001: Falsely complete",
      "",
      "## Slices",
      "- [ ] **S01: Falsely reopened** `risk:low` `depends:[]`",
      "- [x] **S02: Falsely complete** `risk:low` `depends:[]`",
    ].join("\n"),
  );
  writeProjection(
    root,
    "milestones/M001/slices/S02/S02-PLAN.md",
    [
      "# S02: Falsely complete",
      "",
      "## Tasks",
      "- [x] **T99: Projection-only task** `est:1m`",
    ].join("\n"),
  );
}

async function readDirectDbAuthoritySnapshot(fixture: WorkflowAuthorityFixture) {
  const state = await deriveStateFromDb(fixture.root);
  return {
    state: {
      phase: state.phase,
      milestone: state.activeMilestone?.id ?? null,
      slice: state.activeSlice?.id ?? null,
      task: state.activeTask?.id ?? null,
      requirements: state.requirements,
    },
    registry: state.registry.map((milestone) => ({
      id: milestone.id,
      status: milestone.status,
    })),
    slices: getMilestoneSlices(fixture.ids.milestone).map((slice) => ({
      id: slice.id,
      status: slice.status,
      depends: slice.depends,
    })),
    tasks: {
      completed: getSliceTasks(fixture.ids.milestone, fixture.ids.completedSlice).map((task) => ({
        id: task.id,
        status: task.status,
      })),
      ready: getSliceTasks(fixture.ids.milestone, fixture.ids.readySlice).map((task) => ({
        id: task.id,
        status: task.status,
      })),
    },
    requirements: queryRequirements({
      milestoneId: fixture.ids.milestone,
      sliceId: fixture.ids.readySlice,
    }).map((requirement) => ({
      id: requirement.id,
      status: requirement.status,
      owner: requirement.primary_owner,
    })),
    decisions: queryDecisionsFromMemories().map((decision) => ({
      id: decision.id,
      choice: decision.choice,
    })),
  };
}

test("direct DB authority queries ignore contradictory Markdown projections", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  fixture.reopen();
  const before = await readDirectDbAuthoritySnapshot(fixture);

  assert.deepEqual(before, {
    state: {
      phase: "executing",
      milestone: fixture.ids.milestone,
      slice: fixture.ids.readySlice,
      task: fixture.ids.readyTask,
      requirements: {
        active: 1,
        validated: 0,
        deferred: 0,
        outOfScope: 0,
        blocked: 0,
        total: 1,
      },
    },
    registry: [{ id: fixture.ids.milestone, status: "active" }],
    slices: [
      { id: fixture.ids.completedSlice, status: "complete", depends: [] },
      { id: fixture.ids.readySlice, status: "pending", depends: [fixture.ids.completedSlice] },
    ],
    tasks: {
      completed: [{ id: fixture.ids.completedTask, status: "complete" }],
      ready: [{ id: fixture.ids.readyTask, status: "pending" }],
    },
    requirements: [
      { id: fixture.ids.requirement, status: "active", owner: "M001/S02" },
    ],
    decisions: [
      { id: fixture.ids.decision, choice: "SQLite is authoritative" },
    ],
  });

  writeContradictoryProjections(fixture.root);
  fixture.reopen();

  const after = await readDirectDbAuthoritySnapshot(fixture);
  assert.deepEqual(after, before);
});
