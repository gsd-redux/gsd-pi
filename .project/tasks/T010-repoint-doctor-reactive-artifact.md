---
id: T010
title: Re-point doctor, reactive-graph, and artifact-verification consumers of parsers-legacy to DB reads
wave: 3
deps: [T007, T012]
status: pending
agent: build_T010
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/doctor-state-checks.ts
  - src/resources/extensions/gsd/doctor-engine-checks.ts
  - src/resources/extensions/gsd/reactive-graph.ts
  - src/resources/extensions/gsd/artifact-verification.ts
  - src/resources/extensions/gsd/tests/doctor-empty-worktree.test.ts
  - src/resources/extensions/gsd/tests/doctor-fix-flag.test.ts
  - src/resources/extensions/gsd/tests/doctor-forensics-db-open-regression.test.ts
  - src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts
  - src/resources/extensions/gsd/tests/doctor-git-checks-terminal.test.ts
  - src/resources/extensions/gsd/tests/doctor-heal-fixable-warnings.test.ts
  - src/resources/extensions/gsd/tests/doctor-history-public-api.test.ts
  - src/resources/extensions/gsd/tests/doctor-orphan-milestone-4996.test.ts
  - src/resources/extensions/gsd/tests/doctor-providers.test.ts
  - src/resources/extensions/gsd/tests/doctor-runtime-checks.test.ts
  - src/resources/extensions/gsd/tests/doctor-scope-db-unavailable.test.ts
  - src/resources/extensions/gsd/tests/doctor-workspace.test.ts
  - src/resources/extensions/gsd/tests/reactive-graph.test.ts
  - src/resources/extensions/gsd/tests/dispatch-reactive-logs.test.ts
  - src/resources/extensions/gsd/tests/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/integration/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/plan-milestone-artifact-verification.test.ts
  - src/resources/extensions/gsd/tests/sidecar-artifact-verification.test.ts
  - src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts
  - src/resources/extensions/gsd/auto-recovery.ts
---

# T010 — Re-point doctor / reactive-graph / artifact-verification to DB reads

## Context

Disposition class (a) per T004's inventory: these diagnostics/recovery
consumers re-point to DB-backed reads; their legacy markdown fallback
branches die with the path (class c). Post-cutover the project DB always
exists at schema v46, so "DB has no rows, parse the markdown instead" is a
dead branch. Specific current roles (from the importer-registry allowlist):
`doctor.ts` + `doctor-state-checks.ts` are diagnostics-only;
`doctor-engine-checks.ts` compares PLAN.md task checkboxes against DB
status; `reactive-graph.ts` has an explicit degraded-mode fallback when the
DB has no task rows (warns on use); `artifact-verification.ts` holds
recovery-path pre-migration/DB-unavailable fallback branches
(`verifyExpectedArtifact` extracted from auto-recovery.ts). The registry
test (`tests/parsers-legacy-importers.test.ts`) is reconciled by T016 — do
NOT edit it here; expect its stale-entry check to be red until then.

**T012 has LANDED** (commit `e6f14314bd0d5c9aa8de6a600952c2521bb74e11`):
`parseRoadmap`/`parsePlan` now live byte-identically in
`src/resources/extensions/gsd/schemas/parsers.ts` as
`parseLegacyRoadmap`/`parseLegacyPlan`, and `parsers-legacy.ts` is a
DEPRECATED re-export shim ("do not add imports"; deletion gated on zero
production importers in T020). The relocation EXISTS — do not re-plan it.
This resolves the original Step-3 blocker: `doctor-engine-checks.ts`
re-points its projection parse to `schemas/parsers.ts` in this task, so
AC1's zero-`parsers-legacy` grep holds for all five files.

## Steps

1. Read each target file's actual `parsers-legacy` import sites (not just the
   allowlist comments).
2. `doctor.ts`, `doctor-state-checks.ts`: replace projection parses with the
   equivalent `gsd-db` query functions (`db/queries.ts`, e.g.
   `getMilestoneSliceSummaries`); diagnostics output shape must stay
   byte-identical.
3. `doctor-engine-checks.ts`: the PLAN-checkbox-vs-DB comparison reads the
   stamped projection as a *projection* (display compare), not as authority —
   re-point its parse from `parsePlan` (the deprecated `parsers-legacy`
   shim, imported at :31, used at :149) to `parseLegacyPlan` from
   `./schemas/parsers.js` (T012's landed parser home). Adjust the import
   and the call site; keep `parseRoadmapSlices` from `./roadmap-slices.js`
   (:30) as-is — it is not a parsers-legacy import. Do not add a new
   `parsers-legacy` import anywhere.
4. `reactive-graph.ts`: delete the degraded-mode markdown fallback branch;
   DB-with-no-task-rows now yields an empty graph with the existing warning,
   never a markdown parse. Update `reactive-graph.test.ts` /
   `dispatch-reactive-logs.test.ts` accordingly.
5. `artifact-verification.ts`: delete the pre-migration/DB-unavailable
   fallback branches; verification reads the DB. **Deleting a fallback must
   never convert a verify-fail into a verify-pass** — SYNTHESIS (c) keeps the
   DB-unavailable fail-closed witnesses as-is in the unit tier, so each
   deleted branch fails closed instead:
   - complete-slice (:529-545): today `getSlice` returning null falls to the
     `else if (!isDbAvailable())` roadmap parse. Deleting that branch alone
     makes the `dbSlice === null` case fall through to `return true` — a
     silent pass. Replace it with an explicit fail-closed: when the DB is
     unavailable (or the slice row is absent), `logWarning("recovery", ...)`
     naming DB unavailability and `return false`.
   - parallel-research (:337-338): re-pointing the roadmap parse to
     `getMilestoneSlices` yields `[]` when the DB is unavailable, so the loop
     never runs and verification returns true — same silent pass. Fail closed
     the same way before the loop.
   - plan-milestone (:515): this roadmap parse validates the *artifact's own
     content*, not authority — keep it and re-home it to
     `parseLegacyRoadmap` from `./schemas/parsers.js`. The
     `_setRoadmapParserFnForTests` seam (artifact-verification.ts:80,
     re-exported at auto-recovery.ts:93) therefore SURVIVES for this parse;
     delete it only if the re-homing leaves it genuinely unused, and update
     the auto-recovery.ts re-export in the same commit if so.
   Update `auto-recovery.test.ts`, `integration/auto-recovery.test.ts`,
   `plan-milestone-artifact-verification.test.ts`,
   `sidecar-artifact-verification.test.ts` — remove or invert assertions of
   markdown-fallback behavior (AGENTS.md: tests asserting removed behavior
   are removed or updated); keep DB-path coverage intact.
5b. `recovery-verify-logs.test.ts`: the two witnesses at :352 and :375
   (complete-slice legacy-roadmap-parse failure, parallel-research parse
   throw) pin behavior Step 5 removes, so they are re-expressed, NOT deleted —
   their guarantee (verification fails closed and logs a recovery warning) is
   exactly what SYNTHESIS (c) preserves. This fixture base carries no
   `gsd.db`, so `isDbAvailable()` is already false without any seam: drop the
   `_setRoadmapParserFnForTests` injection from these two and assert the same
   `result === false` plus a recovery log, now naming DB unavailability rather
   than a parse failure. The third witness (:404, plan-milestone) keeps its
   seam per Step 5. Every other test in this file is untouched — confirm the
   file is green at base (14/14) before and after.
6. Update the twelve `doctor-*.test.ts` files only where they asserted
   fallback/markdown-derived behavior; do not rewrite tests wholesale.
7. Remove the `parsers-legacy` import from each of the five production files
   once unused. Grep each file to confirm zero remaining references.

## Acceptance criteria

1. None of the five production files imports or references `parsers-legacy`;
   `doctor-engine-checks.ts` parses via `parseLegacyPlan` from
   `./schemas/parsers.js`.
2. No markdown-fallback branch remains in reactive-graph or
   artifact-verification; doctor surfaces produce identical output from DB
   reads.
3. Updated tests pass; no test asserts the removed fallback behavior; DB-path
   coverage is not deleted.
4. `pnpm run baseline:refactor:phase0` stays green.
5. No deleted fallback turns a verify-fail into a verify-pass: with the DB
   unavailable, complete-slice and parallel-research verification return
   `false` and log a `recovery` warning. `recovery-verify-logs.test.ts` is
   green with all three witnesses present (two re-expressed against
   DB-unavailability, one keeping the parser seam) — the file's test count
   does not drop.

## Verify

```bash
! grep -n "parsers-legacy" src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/doctor-state-checks.ts src/resources/extensions/gsd/doctor-engine-checks.ts src/resources/extensions/gsd/reactive-graph.ts src/resources/extensions/gsd/artifact-verification.ts && grep -q "parseLegacyPlan" src/resources/extensions/gsd/doctor-engine-checks.ts && grep -q "schemas/parsers" src/resources/extensions/gsd/doctor-engine-checks.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/reactive-graph.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/doctor-runtime-checks.test.ts src/resources/extensions/gsd/tests/doctor-workspace.test.ts src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — BLOCKED by coder (plan defect): Step 3 contradicts Acceptance
- 2026-08-02 — orchestrator: block accepted as documented plan defect (no production diff; nothing rejected). Worktree .worktrees/gsd-path-T010 RETAINED clean at base 40bdcfca4d1eea63fb1eb2d3198928c73d91fd37 on branch gsd-path/T010. T012 landed the relocated parsers (parseLegacyPlan/parseLegacyRoadmap in schemas/parsers.ts) — planner re-scopes T010 against that landed state before redispatch.
- 2026-08-03 — planner (block repair): re-scoped Step 3 against T012's landed reality (commit e6f14314 — parseRoadmap/parsePlan now byte-identical in schemas/parsers.ts as parseLegacyRoadmap/parseLegacyPlan; parsers-legacy.ts is a deprecated re-export shim). doctor-engine-checks.ts re-points its projection parse (:31 import, :149 call) to parseLegacyPlan from ./schemas/parsers.js, resolving the Step-3-vs-AC1 contradiction; AC1 and Verify gained parseLegacyPlan/schemas-parsers greps. Other consumers (doctor.ts, doctor-state-checks.ts, reactive-graph.ts, artifact-verification.ts) unchanged — T012's diff did not alter their picture. Deps [T007]→[T007, T012]; status blocked→pending; agent build_T010 kept; base/worktree/task_branch nulled for re-record at dispatch (orchestrator rebases branch gsd-path/T010 onto the new primary HEAD, retained worktree reused, same procedure as T005's repair).
- 2026-08-03 — BLOCKED by coder (plan defect, second): Step 5's
  deletions/re-points in artifact-verification.ts break pinned tests in
  `src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts`, which is
  NOT in this task's `files` list and is owned by no other task (grep of
  `.project/tasks/`: zero hits). Confirmed green at base (14/14 pass). Two of
  its tests assert exactly the behavior Step 5 removes, via the
  `_setRoadmapParserFnForTests` seam (re-exported through auto-recovery.ts:93,
  also unlisted):
  1. "complete-slice verify logs a recovery warning when the legacy roadmap
     parse fails" — requires the complete-slice `else if (!isDbAvailable())`
     roadmap-parse fallback (artifact-verification.ts:532-545). Deleting it:
     `getSlice` returns null when the DB is unavailable (db/queries.ts:177),
     so verification falls through to `return true`; the test asserts
     `result === false` plus a /roadmap parse failed/ recovery log containing
     the injected "forced legacy roadmap parse failure" message. FAIL.
  2. "parallel-research verify logs a recovery warning when the roadmap parse
     throws" — requires the research-slice/parallel-research roadmap parse
     (artifact-verification.ts:338). Re-pointing to DB reads per Step 5:
     `getMilestoneSlices` returns [] when the DB is unavailable
     (db/queries.ts:682), so the loop never runs and verification returns
     true; the test asserts `result === false` plus /forced parallel-research
     parse failure/. FAIL.
  The third seam test (plan-milestone :515) can survive — the roadmap content
  parse there validates the artifact itself and can be re-homed to
  schemas/parsers.js — but 1 and 2 cannot. Step 5's enumerated test files to
  update (auto-recovery, integration/auto-recovery, plan-milestone-artifact-
  verification, sidecar-artifact-verification) omit recovery-verify-logs.
  Per AGENTS.md, tests asserting removed behavior must be removed or updated,
  but this file is outside my allowed paths: completion needs an unlisted
  path. Suggested planner fix: add
  `src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts` to T010's
  `files` list (the :622 and :522 seam tests then get removed/rewritten with
  the branches they pin), or narrow Step 5 to spare the complete-slice
  DB-unavailable branch and the parallel-research roadmap parse. No
  production or test files were edited; only pnpm install +
  build:native:dev were run in the worktree.
- 2026-08-05 — planner (block repair, second): resolved against SYNTHESIS
  § gate disposition clause (c) — "DB-unavailable fail-closed witnesses and
  the never-promote-`omitted` rule keep as-is in the unit tier". The coder's
  finding is upheld and is sharper than either suggested fix: deleting the
  two branches does not merely break pinned tests, it converts verify-fail
  into verify-pass (complete-slice falls through to `return true` when
  `getSlice` is null; parallel-research's loop never runs when
  `getMilestoneSlices` is `[]`). Deleting the witnesses would therefore have
  buried a silent-pass regression, so option A (delete) is rejected as
  contradicting (c), and option B (spare the legacy branches) is rejected as
  contradicting T007's landed authority flip. Step 5 now requires each
  deleted fallback to fail closed, new Step 5b re-expresses the two witnesses
  against DB-unavailability (the fixture base has no gsd.db, so no seam is
  needed), and the plan-milestone content parse plus its
  `_setRoadmapParserFnForTests` seam survive, re-homed to schemas/parsers.js.
  files += recovery-verify-logs.test.ts (owned by no other task) and
  auto-recovery.ts (the seam's re-export site, in case re-homing retires it);
  neither overlaps a pending wave-3 task. AC5 added; Verify runs
  recovery-verify-logs.test.ts. status blocked→pending; agent build_T010
  kept; base/worktree/task_branch nulled for re-record at dispatch (retained
  clean worktree reused, same procedure as the first repair). User ruling
  2026-08-05: repair T010 in place rather than splitting or deferring to T015.
