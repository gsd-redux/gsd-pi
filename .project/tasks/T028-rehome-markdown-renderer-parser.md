---
id: T028
title: Re-home markdown-renderer's roadmap projection parse off parsers-legacy
wave: 3
deps: [T008, T012]
status: done
agent: build_T028
commit: ec2e3b67668ff6401d6015a486a90b2ce8464fc6
base: 178a59ea9b258f3ae17a285c08b7a2ccdc1ba0aa
worktree: .worktrees/gsd-path-T028
task_branch: gsd-path/T028
files:
  - src/resources/extensions/gsd/markdown-renderer.ts
  - src/resources/extensions/gsd/tests/markdown-renderer.test.ts
---

# T028 — Re-home markdown-renderer's roadmap projection parse

## Context

Plan defect found during wave-3 integration (2026-08-05), after T010 and T013
landed. `scripts/legacy-state-path-proof.mjs` (shipped by T015) reports the
production `parsers-legacy` importers are down from 9 to **2**:

- `gsd/state.ts:25` — expected; T022 removes it with `_deriveStateImpl`.
- `gsd/markdown-renderer.ts:52` — **unowned by any task**.

T016's contract asserts the remaining importer set should be *only*
`gsd/state.ts` (its Step 3 and its expected-state list), and T020's deletion
gate requires zero production importers. Neither can be satisfied while
markdown-renderer still imports the shim, and no task owns removing it.

Why the gap exists: T008 (wave 2, done) owned `markdown-renderer.ts`, but its
AC2 only forbade adding a *new* `parsers-legacy` import — it never required
removing the existing one. T008 therefore passed correctly against its own
contract; the removal was simply never assigned. This is a planning omission,
not a T008 defect, and T008 is not reopened.

Two live call sites remain, both parsing a roadmap projection as a
*projection* (content validation), not as authority:

- `:1233` — `parseProjectionByIdentity(roadmapPath, parseRoadmap)`
- `:1345` — `roadmapRenderMarksSliceDone(roadmapContent, sliceId)`, which
  takes markdown content by parameter and whose export and signature T008's
  AC4 deliberately froze for existing callers.

So this is the same disposition already applied three times in this milestone
(T010's plan-milestone parse, T012, T013): **re-home the import, do not delete
the parse.** Deleting it would require changing a frozen export and would
remove content validation that nothing else performs.

## Steps

1. Replace the `parsers-legacy` import at `:52` with `parseLegacyRoadmap` from
   `./schemas/parsers.js` (T012's landed parser home — byte-identical to
   `parseRoadmap`; `parsers-legacy.ts` is a deprecated re-export shim).
2. Update both call sites (`:1233`, `:1345`) to the re-homed name. Do not
   change parse semantics, the `roadmapRenderMarksSliceDone` signature, or the
   `renderAllFromDb` signature — T008 AC4 froze both for existing callers.
3. Update `markdown-renderer.test.ts` only where it names the old import path;
   do not rewrite tests wholesale or weaken existing coverage.

## Acceptance criteria

1. `markdown-renderer.ts` contains zero `parsers-legacy` references and parses
   via `parseLegacyRoadmap` from `./schemas/parsers.js`.
2. `roadmapRenderMarksSliceDone` and `renderAllFromDb` keep their exports and
   signatures; projection render output is byte-identical (no stamp or content
   change).
3. `markdown-renderer.test.ts` and `projection-fidelity.test.ts` stay green.
4. `node scripts/legacy-state-path-proof.mjs` lists `gsd/state.ts` as the sole
   remaining production importer.

## Verify

```bash
! grep -n "parsers-legacy" src/resources/extensions/gsd/markdown-renderer.ts && grep -q "parseLegacyRoadmap" src/resources/extensions/gsd/markdown-renderer.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/projection-fidelity.test.ts && node scripts/legacy-state-path-proof.mjs 2>&1 | grep -c "parsersLegacyImporter" | grep -q "^1$"
```

## Log

- 2026-08-05 — created by planner (documented plan-defect repair during wave-3
  integration; blocks T016's expected-state assertions and T020's zero-importer
  deletion gate)
- 2026-08-06 — coder: re-homed the import at `markdown-renderer.ts:52` from
  `./parsers-legacy.js` to `parseLegacyRoadmap` from `./schemas/parsers.js`.
  Updated both call sites (`:1233` inside the commented-out roadmap-checkbox
  block, `:1345` in `roadmapRenderMarksSliceDone`) plus the two prose comments
  that named `parsers-legacy`, so the file now has zero references. Parse
  semantics unchanged (`parsers-legacy.parseRoadmap` was already a re-export of
  `parseLegacyRoadmap`); `roadmapRenderMarksSliceDone` and `renderAllFromDb`
  exports and signatures untouched. In `markdown-renderer.test.ts` only the
  import path changed: `parseLegacyRoadmap as parseRoadmap` /
  `parseLegacyPlan as parsePlan` from `../schemas/parsers.ts`, keeping the
  local names so no assertion or coverage changed.
  Note: `parseLegacyRoadmap` was imported by its own name (not aliased to
  `parseRoadmap`) because `schemas/parsers.ts` also exports an unrelated
  `parseRoadmap` returning `ParsedRoadmap`.
  Verify: PASS (exit 0) — no `parsers-legacy` match in markdown-renderer.ts,
  `parseLegacyRoadmap` present, `node --test markdown-renderer.test.ts
  projection-fidelity.test.ts` → tests 39 / pass 29 / fail 0 / skipped 10, and
  `legacy-state-path-proof.mjs` reports exactly 1 `parsersLegacyImporter`
  (`gsd/state.ts`).
  Observation (out of scope, no action taken): `tests/parsers-legacy-importers.test.ts`
  third case "allowlist has no stale entries" was already failing on this base
  (its ALLOWED_IMPORTERS lists ~19 modules while only 2 still import the shim);
  this change adds `gsd/markdown-renderer.ts` to that pre-existing stale set.
  That file is not in this task's `files` and T020 owns the shim deletion.
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree):
  exit 0 — zero `parsers-legacy` refs in markdown-renderer.ts,
  `parseLegacyRoadmap` present, tests 39 / pass 29 / fail 0 / skipped 10, and
  legacy-state-path-proof.mjs reports exactly 1 remaining production importer
  (gsd/state.ts). Diff scope check: 2 declared files plus the task file; zero
  paths outside `files`.
