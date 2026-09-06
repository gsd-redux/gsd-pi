// Project/App: gsd-pi
// File Purpose: Canonical findMilestoneIds flat-phase directory normalization (#1773).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findMilestoneIds } from "../milestone-ids.ts";

test("flat-phase NN-slug directories resolve to canonical M-form IDs (#1773)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-id-resolution-"));
  try {
    const phases = join(base, ".gsd", "phases");
    mkdirSync(join(phases, "01-minimal-python-hello-world"), { recursive: true });
    mkdirSync(join(phases, "12-another-phase"), { recursive: true });

    assert.deepEqual(findMilestoneIds(base), ["M001", "M012"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unique ids sharing the same milestone id resolve to distinct milestones", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-id-resolution-"));
  try {
    const phases = join(base, ".gsd", "phases");
    const dirA = join(phases, "05-gv3j8m-milestone-A");
    const dirB = join(phases, "05-hxpveq-milestone-B");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "05-ROADMAP.md"), "# M005-gv3j8m: Milestone A\n");
    writeFileSync(join(dirB, "05-ROADMAP.md"), "# M005-hxpveq: Milestone B\n");

    const ids = findMilestoneIds(base);
    assert.ok(ids.includes("M005-gv3j8m"), "first suffixed milestone keeps its own suffix");
    assert.ok(ids.includes("M005-hxpveq"), "second suffixed milestone is not collapsed into the first");
    assert.equal(ids.length, 2, "both milestones are discovered as distinct entries");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a name with 6-char suffix does not get misread as a unique id", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-id-resolution-"));
  try {
    const phases = join(base, ".gsd", "phases");
    mkdirSync(join(phases, "16-queued-milestone"), { recursive: true });

    assert.deepEqual(findMilestoneIds(base), ["M016"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("legacy M-form and bare numeric directory names keep their exact behavior", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-id-resolution-"));
  try {
    const legacy = join(base, ".gsd", "milestones");
    mkdirSync(join(legacy, "M002"), { recursive: true });
    writeFileSync(join(legacy, "M002", "M002-ROADMAP.md"), "# M002\n");
    mkdirSync(join(legacy, "M001-abc123"), { recursive: true });
    mkdirSync(join(legacy, "15"), { recursive: true });

    const ids = findMilestoneIds(base);
    assert.ok(ids.includes("M002"));
    assert.ok(ids.includes("M001-abc123"));
    assert.ok(ids.includes("15"), "bare numeric legacy dirs stay raw");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
