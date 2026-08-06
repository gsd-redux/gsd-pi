---
id: T028
title: Re-home markdown-renderer's roadmap projection parse off parsers-legacy
wave: 3
deps: [T008, T012]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
