// Project/App: gsd-pi
// File Purpose: Tests for the flat-phase layout policy.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LAYOUT_ROOT,
  LAYOUT_SEGMENTS,
  phaseDirName,
  planFileName,
  dbPath,
  milestoneIdToPhaseNum,
  milestoneIdUniqueSuffix,
  sliceIdToPlanNum,
  derivePhaseSlug,
  canonicalPhaseDirName,
} from "../layout-policy.ts";

test("LAYOUT_ROOT is .gsd", () => {
  assert.equal(LAYOUT_ROOT, ".gsd");
});

test("LAYOUT_SEGMENTS.level1 is phases", () => {
  assert.equal(LAYOUT_SEGMENTS.level1, "phases");
});

test("phaseDirName produces NN-slug", () => {
  assert.equal(phaseDirName(1, "foundation"), "01-foundation");
  assert.equal(phaseDirName(12, "auth-system"), "12-auth-system");
});

test("planFileName produces NN-MM-SUFFIX.md", () => {
  assert.equal(planFileName(1, 1, "PLAN"), "01-01-PLAN.md");
  assert.equal(planFileName(3, 2, "SUMMARY"), "03-02-SUMMARY.md");
});

test("dbPath resolves under .gsd", () => {
  assert.equal(dbPath("/project"), "/project/.gsd/gsd.db");
});

test("milestoneIdToPhaseNum extracts the numeric portion", () => {
  assert.equal(milestoneIdToPhaseNum("M001"), 1);
  assert.equal(milestoneIdToPhaseNum("M012"), 12);
});

test("sliceIdToPlanNum extracts the numeric portion", () => {
  assert.equal(sliceIdToPlanNum("S01"), 1);
  assert.equal(sliceIdToPlanNum("S03"), 3);
  assert.equal(sliceIdToPlanNum("S1"), 1);
  assert.equal(sliceIdToPlanNum("S01-replan"), 1);
  assert.equal(sliceIdToPlanNum("S02-db-repair"), 2);
  assert.equal(sliceIdToPlanNum("s03-x"), 3);
  assert.equal(sliceIdToPlanNum("garbage"), 1);
});

test("derivePhaseSlug is stable and deterministic", () => {
  assert.equal(derivePhaseSlug("Foundation"), "foundation");
  assert.equal(derivePhaseSlug("Set Up Tooling!"), "set-up-tooling");
  assert.equal(derivePhaseSlug("auth/API layer"), "auth-api-layer");
  assert.equal(derivePhaseSlug("Foundation"), derivePhaseSlug("Foundation"));
});

test("derivePhaseSlug falls back when title is empty or punctuation-only", () => {
  assert.equal(derivePhaseSlug(""), "phase");
  assert.equal(derivePhaseSlug("---"), "phase");
});

test("milestoneIdUniqueSuffix extracts the team suffix", () => {
  assert.equal(milestoneIdUniqueSuffix("M001-abc123"), "abc123");
  assert.equal(milestoneIdUniqueSuffix("M009-obg27g"), "obg27g");
  assert.equal(milestoneIdUniqueSuffix("M001"), undefined);
  assert.equal(milestoneIdUniqueSuffix("M012"), undefined);
});

test("milestoneIdUniqueSuffix is case-insensitive like milestoneIdToPhaseNum (#1581)", () => {
  assert.equal(milestoneIdUniqueSuffix("m009-obg27g"), "obg27g");
  assert.equal(milestoneIdUniqueSuffix("M009-OBG27G"), "obg27g");
  assert.equal(milestoneIdToPhaseNum("m009-obg27g"), 9);
  assert.equal(milestoneIdUniqueSuffix("m001"), undefined);
});

test("derivePhaseSlug strips leading milestone id tokens from concatenated titles (#1581)", () => {
  assert.equal(derivePhaseSlug("M009-obg27g Web API"), "web-api");
  assert.equal(derivePhaseSlug("m009-obg27g M009-obg27g Web API"), "web-api");
  assert.equal(derivePhaseSlug("M001 Foundation"), "foundation");
});

test("derivePhaseSlug keeps an id-only title as the slug placeholder", () => {
  assert.equal(derivePhaseSlug("M001"), "m001");
  assert.equal(derivePhaseSlug("M009-obg27g"), "m009-obg27g");
});

test("canonicalPhaseDirName keeps unsuffixed id-only names as NN-mNNN", () => {
  assert.equal(canonicalPhaseDirName("M001"), "01-m001");
  assert.equal(canonicalPhaseDirName("M001", "Foundation"), "01-foundation");
});

test("canonicalPhaseDirName does not bake a team-suffix id into the slug twice (#1581)", () => {
  assert.equal(canonicalPhaseDirName("M009-obg27g", "Web API"), "09-obg27g-web-api");
  assert.equal(canonicalPhaseDirName("M009-obg27g", "M009-obg27g Web API"), "09-obg27g-web-api");
  assert.equal(canonicalPhaseDirName("M009-obg27g", "M009-obg27g"), "09-obg27g");
  assert.equal(canonicalPhaseDirName("M009-obg27g"), "09-obg27g");
});

test("canonicalPhaseDirName matches lowercase team-suffix ids to one spelling (#1581)", () => {
  assert.equal(
    canonicalPhaseDirName("m009-obg27g", "M009-obg27g Web API"),
    "09-obg27g-web-api",
  );
  assert.equal(
    canonicalPhaseDirName("m009", "m009-obg27g M009-obg27g Web API"),
    "09-web-api",
  );
});
