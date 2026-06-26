import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { clearPathCache, _clearGsdRootCache, isLegacyMilestonesLayout, milestonesDir } from "../paths.ts";

test("worktree artifact resolution falls back to project .gsd artifacts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-auto-artifact-")));
  try {
    const projectGsd = join(root, ".gsd");
    const wtRoot = join(projectGsd, "worktrees", "M001");
    const wtGsd = join(wtRoot, ".gsd");
    const projectMilestoneDir = join(projectGsd, "milestones", "M001");
    const projectSliceDir = join(projectMilestoneDir, "slices", "S01");

    mkdirSync(projectSliceDir, { recursive: true });
    mkdirSync(wtGsd, { recursive: true });
    writeFileSync(join(projectMilestoneDir, "M001-ROADMAP.md"), "# roadmap\n");
    writeFileSync(join(projectSliceDir, "S01-PLAN.md"), "# plan\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      resolveExpectedArtifactPath("plan-milestone", "M001", wtRoot),
      join(projectMilestoneDir, "M001-ROADMAP.md"),
    );
    assert.equal(
      resolveExpectedArtifactPath("plan-slice", "M001/S01", wtRoot),
      join(projectSliceDir, "S01-PLAN.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #852 follow-up: metadata-only milestones/<MID>/ must not flip the layout ──
//
// git-service.ts creates milestones/<MID>/ to store <MID>-META.json (the
// integration-branch metadata) even in flat-phase projects. Before this fix,
// the existence of that dir made layout detection conclude "legacy", so
// verification resolved the CONTEXT/ROADMAP to milestones/<MID>/<MID>-CONTEXT.md
// (which doesn't exist in a flat-phase project) instead of phases/NN-slug/ —
// trapping the unit in a finalize-retry loop. A milestones/<MID>/ dir holding
// only *-META.json must NOT count as a real legacy milestone.

test("metadata-only milestones/<MID>/ does not flip layout to legacy (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-pollution-")));
  try {
    const gsd = join(root, ".gsd");
    // Flat-phase layout: phases/15-m015/ with real content.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# context\n");

    // Pollution: git-service.ts creates milestones/M015/ for META.json only.
    const metaDir = join(gsd, "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');

    _clearGsdRootCache();
    clearPathCache();

    // The metadata-only dir must NOT make this look like a legacy project.
    assert.equal(isLegacyMilestonesLayout(root), false, "metadata-only milestones dir must not flip layout");
    assert.ok(milestonesDir(root).endsWith(join(".gsd", "phases")), "milestonesDir resolves to phases/ not milestones/");

    // And the discuss-milestone CONTEXT artifact must resolve to the flat-phase path.
    assert.equal(
      resolveExpectedArtifactPath("discuss-milestone", "M015", root),
      join(phaseDir, "15-CONTEXT.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("milestones/<MID>/ with only META.json + subdir does not flip layout to legacy", () => {
  // Regression for the Cursor Bugbot finding: a flat-phase project whose
  // milestones/<MID>/ contains only *-META.json plus an empty subdirectory
  // (e.g. slices/) must NOT be treated as a content-bearing legacy milestone.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-subdir-")));
  try {
    const gsd = join(root, ".gsd");
    // Flat-phase layout: phases/01-m001/ with real content.
    const phaseDir = join(gsd, "phases", "01-m001");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-CONTEXT.md"), "# context\n");

    // Pollution: milestones/M001/ has a META file + a bare subdirectory.
    const metaDir = join(gsd, "milestones", "M001");
    mkdirSync(join(metaDir, "slices"), { recursive: true });
    writeFileSync(join(metaDir, "M001-META.json"), '{"branch":"milestone/M001"}');

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      isLegacyMilestonesLayout(root),
      false,
      "META-only + subdir milestones dir must not flip layout",
    );
    assert.ok(
      milestonesDir(root).endsWith(join(".gsd", "phases")),
      "milestonesDir resolves to phases/ not milestones/",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("milestones/<MID>/ with non-empty slices/ subdir is detected as legacy (no files in milestone root)", () => {
  // The common real-legacy fixture pattern: milestones/M001/slices/S01/ with no
  // file directly in milestones/M001/.  The non-empty slices/ subdir must still
  // trigger legacy detection so artifact resolution stays on the milestones/ path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-legacy-subdir-")));
  try {
    const legacyDir = join(root, ".gsd", "milestones", "M001");
    mkdirSync(join(legacyDir, "slices", "S01", "tasks"), { recursive: true });

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      isLegacyMilestonesLayout(root),
      true,
      "non-empty slices/ subdir must still detect as legacy",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("content-bearing milestones/<MID>/ still resolves to legacy (#852 regression guard)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-legacy-real-")));
  try {
    // Legacy layout: milestones/M001/ with real content (not just META).
    const legacyDir = join(root, ".gsd", "milestones", "M001");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "M001-CONTEXT.md"), "# context\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(isLegacyMilestonesLayout(root), true, "content-bearing milestones dir is legacy");
    assert.equal(
      resolveExpectedArtifactPath("discuss-milestone", "M001", root),
      join(legacyDir, "M001-CONTEXT.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #852 follow-up: the EXACT failure path that survived #858 ────────────────
//
// #858 fixed legacyMilestonesHasSubdirs/resolvePhaseDir/resolveMilestonePath in
// paths.ts, but resolveMilestoneArtifactPath (auto-artifact-paths.ts:35) has an
// EARLY-RETURN legacy check via resolveProjectMilestonePath that bypassed all of
// those. With a flat-phase project + a META-only milestones/M015/ dir (created
// by git-service.ts), the early-return resolved CONTEXT to
// milestones/M015/M015-CONTEXT.md (never exists) instead of
// phases/15-m015/15-CONTEXT.md — reproducing the production loop:
//   verify-fail discuss-milestone M015: existsSync false for
//     .../milestones/M015/M015-CONTEXT.md
// This test guards the project-root legacy lookup, not just paths.ts.

test("resolveProjectMilestonePath ignores META-only dir: flat-phase wins (#852 follow-up to #858)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-bypass-")));
  try {
    const gsd = join(root, ".gsd");

    // Flat-phase layout: phases/15-m015/ with real CONTEXT content.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    // Pollution: git-service.ts:450 created milestones/M015/ for META only.
    // This is the dir that previously flipped the early-return to legacy.
    const metaDir = join(gsd, "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("discuss-milestone", "M015", root);

    // MUST resolve to the flat-phase path, NOT the legacy META-only path.
    assert.equal(
      resolved,
      join(phaseDir, "15-CONTEXT.md"),
      "META-only milestones/M015/ must not produce the legacy path; flat-phase wins",
    );
    // Explicitly assert the bug does NOT reproduce — the legacy path is wrong.
    assert.notEqual(
      resolved,
      join(metaDir, "M015-CONTEXT.md"),
      "must NOT resolve to the legacy milestones/M015/M015-CONTEXT.md path",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectMilestonePath ignores META-only dir even when phases/ has no matching dir yet", () => {
  // The worktree/early-run edge case: phases/ doesn't exist yet (or doesn't have
  // 15-m015/), but milestones/M015/ exists with only META. The resolver must
  // return null (file genuinely not found yet) rather than the wrong legacy
  // path — so the caller reports a clear "missing" instead of looping on a
  // path that will never exist.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-no-phase-")));
  try {
    const metaDir = join(root, ".gsd", "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');
    // Note: no phases/ dir at all.

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("discuss-milestone", "M015", root);
    // Must not produce the legacy path; null or a non-legacy path is correct.
    assert.ok(
      resolved === null || !resolved.includes(join("milestones", "M015")),
      `META-only dir with no phases/ must not resolve to legacy; got: ${resolved}`,
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #852: flat-phase dir must get flat-phase filename, not legacy ─────────────
//
// The most insidious variant: resolveProjectedMilestonePath found the correct
// flat-phase directory (phases/15-m015/), but the old code at line 37 built
// the LEGACY filename (M015-CONTEXT.md) unconditionally — producing
// existsSync-false for phases/15-m015/M015-CONTEXT.md. The file is named
// 15-CONTEXT.md. This test guards the layout-aware filename for ALL branches.

test("flat-phase worktree dir resolves to 15-CONTEXT.md not M015-CONTEXT.md (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-filename-layout-")));
  try {
    const gsd = join(root, ".gsd");
    // Flat-phase layout: phases/15-m015/ with the correctly-named file.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("discuss-milestone", "M015", root);

    // MUST use the flat-phase filename, not the legacy one.
    assert.equal(
      resolved,
      join(phaseDir, "15-CONTEXT.md"),
      "flat-phase dir must use 15-CONTEXT.md (phase-number prefix)",
    );
    assert.notEqual(
      resolved,
      join(phaseDir, "M015-CONTEXT.md"),
      "must NOT use M015-CONTEXT.md (legacy milestone-id prefix) for a flat-phase dir",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat-phase project-root dir resolves to 15-ROADMAP.md not M015-ROADMAP.md (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-filename-roadmap-")));
  try {
    const gsd = join(root, ".gsd");
    const phaseDir = join(gsd, "phases", "16-m016");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "16-ROADMAP.md"), "# M016 roadmap\n");

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("plan-milestone", "M016", root);
    assert.equal(
      resolved,
      join(phaseDir, "16-ROADMAP.md"),
      "flat-phase dir must use 16-ROADMAP.md (phase-number prefix)",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Bugbot c5ee8eba: canonical worktree + project-root legacy dir ─────────────
//
// On a canonical worktree (<project>/.gsd-worktrees/M001/):
//   - legacyMilestonesDir(base) uses gsdProjectionRoot → <project>/.gsd-worktrees/M001/.gsd/milestones
//   - resolveProjectMilestonePath(base) uses gsdRoot → <project>/.gsd/milestones/M001/
//
// These are different paths. When there is no flat-phase dir in the worktree
// but a legacy milestones/<MID>/ dir exists at the project root, the old code
// compared the project-root dir against the worktree legacyBase — a mismatch
// — so isLegacy was false and the flat-phase filename "01-ROADMAP.md" was
// built instead of "M001-ROADMAP.md". The file-not-found loop follows.

test("canonical worktree + project-root legacy dir produces legacy filename (#bugbot c5ee8eba)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-canonical-wt-legacy-")));
  try {
    // Project-root legacy milestone dir with some content (not just META).
    const projectLegacyDir = join(root, ".gsd", "milestones", "M001");
    mkdirSync(projectLegacyDir, { recursive: true });
    // Write CONTEXT but NOT ROADMAP — forces the dir-resolution cold path for ROADMAP.
    writeFileSync(join(projectLegacyDir, "M001-CONTEXT.md"), "# M001 context\n");

    // Canonical worktree: <project>/.gsd-worktrees/M001/.gsd/ (no phases dir).
    const wtRoot = join(root, ".gsd-worktrees", "M001");
    mkdirSync(join(wtRoot, ".gsd"), { recursive: true });

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("plan-milestone", "M001", wtRoot);

    // Must use the legacy milestone-id prefix (M001-ROADMAP.md), not the
    // flat-phase phase-number prefix (01-ROADMAP.md).
    assert.equal(
      resolved,
      join(projectLegacyDir, "M001-ROADMAP.md"),
      "canonical worktree + project-root legacy dir must use M001-ROADMAP.md",
    );
    assert.notEqual(
      resolved,
      join(projectLegacyDir, "01-ROADMAP.md"),
      "must NOT produce flat-phase filename 01-ROADMAP.md for a legacy milestones/ dir",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});
