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
