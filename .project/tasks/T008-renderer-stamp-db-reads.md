---
id: T008
title: markdown-renderer — additive DB state-version stamp on projections; re-point self-read-back merge paths to DB reads
wave: 2
deps: [T007]
status: done
agent: build_T008
commit: bb0ada2a66cfa1a04e923c0c81f4d7286f855c9a
base: 37aedafb2ab40d82c2851eb67df79f87e6e02fa7
worktree: .worktrees/gsd-path-T008
task_branch: gsd-path/T008
files:
  - src/resources/extensions/gsd/markdown-renderer.ts
  - src/resources/extensions/gsd/tests/markdown-renderer.test.ts
  - src/resources/extensions/gsd/tests/projection-fidelity.test.ts
---

# T008 — markdown-renderer: stamped byte-compatible projections + DB-read merge paths

## Context

The projection format contract is settled and FROZEN for this milestone:
files become pure, read-only projections but stay byte-compatible with the
pre-cutover format and location; changes are additive-only — a DB
state-version stamp on each projection for staleness detection (the jj
working-copy pattern). External readers (`@opengsd/mcp-server`,
`packages/daemon`, `integrations/hermes`) treat STATE.md parsing and
PLAN/SUMMARY existence as ground truth — the projection layer is a de facto
public API. `markdown-renderer.ts` currently imports `parsers-legacy` and
reads its own projections back in its merge/stale-detection paths (~lines
1084/1118/1221: roadmap checkbox parsing is commented out with a TODO, plan
checkbox parsing via `parseProjectionByIdentity` is live, and
`roadmapRenderMarksSliceDone` parses roadmap content). Post-flip the
renderer must treat the DB as the comparison source. The stale-render
composition lives in `state-reconciliation/drift/stale-render.ts` (T013's
file — do not touch it here).

## Steps

1. Read `markdown-renderer.ts` fully (note `renderAllFromDb` is the
   projection writer used by `commands-maintenance.ts` and
   `flat-phase-migration.ts`).
2. Additive stamp: append a single HTML-comment line to each rendered
   projection, exactly `<!-- gsd:state-version=<projectRevision>:<authorityEpoch> -->`,
   at a fixed position (end of file). Nothing else in the byte stream may
   change — no whitespace, ordering, or content changes. Prove
   byte-compatibility: render a fixture project before and after the change
   and assert the outputs differ ONLY by the stamp line. Values come from
   the same project revision/authority epoch used by the cutover receipt
   (T006).
3. Re-point the self-read-back paths to DB reads:
   - The live plan-checkbox stale check (~line 1118) currently parses the
     rendered PLAN file via `parseProjectionByIdentity(..., parsePlan)`;
     replace the projection parse with the equivalent DB query
     (`getSliceTasks`/`getActivePlanTasks` rows it already loads) so
     staleness is judged DB-vs-render-intent, not DB-vs-parsed-file. Keep
     the exported function signatures stable for `stale-render.ts` (T013).
   - `roadmapRenderMarksSliceDone` (~line 1221): keep the export (it
     verifies/repairs the projection after a DB write — never a decision
     source), but route its parse through the relocated parser home if T012
     has landed; if not, keep the local parse and let T012/T013 retarget
     it — do not import `parsers-legacy` in any NEW code you write.
4. Remove the `parsers-legacy` import from `markdown-renderer.ts` if step 3
   leaves it unused; the registry allowlist is reconciled centrally by T016,
   so expect `parsers-legacy-importers.test.ts`'s stale-entry check to be red
   until T016 — do not edit that test here.
5. Update `tests/markdown-renderer.test.ts` for the new behavior; write
   `tests/projection-fidelity.test.ts` — the positive post-cutover
   projection-fidelity check re-homed from the retiring gate: render a
   fixture project from DB state, assert every projection carries a stamp
   matching the DB's project revision/authority epoch, and assert a
   hand-edited projection (content mismatch) is detected as stale while a
   stamp-only difference is not treated as content drift.

## Acceptance criteria

1. Every rendered projection carries the additive
   `<!-- gsd:state-version=R:E -->` stamp; renders are otherwise
   byte-identical to pre-change output (diff test).
2. No live path in `markdown-renderer.ts` parses a projection file to make a
   merge/staleness judgment it could make from DB rows; no new
   `parsers-legacy` import.
3. `projection-fidelity.test.ts` passes: stamped projections match DB state;
   content tampering is detected.
4. `roadmapRenderMarksSliceDone` export and `renderAllFromDb` signature are
   unchanged for existing callers.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/projection-fidelity.test.ts src/resources/extensions/gsd/tests/markdown-renderer.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — coder: implemented. (1) Additive stamp: `writeAndStore` now appends
  `<!-- gsd:state-version=<revision>:<authorityEpoch> -->` at end of file via
  `stampProjectionContent`; values read from the `project_authority` singleton row
  (the row the T006 cutover receipt advances) via new exports
  `getCurrentProjectStateVersion` / `readProjectionStateVersion` /
  `stripProjectionStamp`. Strip-then-stamp keeps artifact replays byte-stable (no
  stamp accumulation); disk bytes, artifact `full_content`, and returned `content`
  are identical. Byte-compat proven by a diff test pinning the frozen pre-stamp
  roadmap byte stream + exactly one stamp line. Scope note: projections written by
  other modules (DECISIONS.md via db-writer, .planning/ via planning-writer) are
  outside this task's files list and remain unstamped. (2) Self-read-back re-point:
  the plan-checkbox stale check in `detectStaleRendersImpl` no longer parses the
  PLAN file — it compares on-disk bytes stamp-insensitively against the DB render
  intent (`planRenderIntentDrift`); added exported `detectProjectionDrift`
  (roadmap+plan, DB-vs-render-intent, stamp-only differences are not drift).
  Reasons keep the "in roadmap"/"in plan" markers stale-render.ts's repair
  dispatch keys on. Exported signatures unchanged (`detectStaleRenders`,
  `renderPlanCheckboxes`, `renderAllFromDb`, `roadmapRenderMarksSliceDone`).
  (3) `roadmapRenderMarksSliceDone`: T012 has NOT landed and `schemas/parsers.ts`
  `parseRoadmap` is not equivalent (no `done` field — it parses Slice Overview
  tables), so the existing `parsers-legacy` `parseRoadmap` import stays; no new
  `parsers-legacy` import was added (`parsePlan` import removed).
  `parsers-legacy-importers.test.ts` stays green. (4) Tests: byte-compat diff +
  byte-stable re-render tests added to markdown-renderer.test.ts; new
  projection-fidelity.test.ts (stamp on every projection matching the DB
  revision/epoch, hand-edit detected as stale, stamp-only diff not drift).
  Verify green: 29 pass / 0 fail / 10 pre-existing skips. Smoke:
  flat-phase-renderer + state-reconciliation-drift (63 pass / 0 fail),
  parsers-legacy-importers + complete-milestone-projection-stale (8 pass / 0 fail).
