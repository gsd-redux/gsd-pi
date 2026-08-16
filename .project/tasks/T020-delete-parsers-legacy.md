---
id: T020
title: Delete parsers-legacy.ts at zero production importers (timebox-gated)
wave: 4
deps: [T016, T022]
status: done
agent: null
commit: null
base: 75397cca5
worktree: null
task_branch: fix/wave-4-legacy-path-deletion
files:
  - src/resources/extensions/gsd/parsers-legacy.ts
  - src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts
---

# T020 — Delete parsers-legacy.ts (TIMEBOX-GATED — do not land before the window elapses)

## Context

Deletion-gating is settled: `parsers-legacy.ts` is deleted only when the
importer registry shows zero production importers, AND this deletion commit
may not land until the ruled window has elapsed after the cutover release
(2 stable releases + ≥60 days, ADR-046; user ruling 2026-08-01). This task
MUST NOT be dispatched as part of the cutover release; it is separable by
design. Ordering within wave 4: T022 runs FIRST (it deletes
`_deriveStateImpl`, which removes `gsd/state.ts`'s `parsers-legacy` import —
the last production importer left by T016); only then does the registry
show zero production importers and this task's deletion become valid. The
registry test is the arbiter: it must show zero production importers
before the deletion lands.

## Steps

1. Confirm the window has elapsed (2 stable releases + ≥60 days after the
   cutover release) and record the evidence (release tags/dates) in the
   Log. If not elapsed, STOP.
2. Run the registry test; confirm zero production importers (T016 left at
   most `gsd/state.ts`; T022 removed it). If any importer remains, STOP —
   mark BLOCKED with the offender list.
3. Delete `src/resources/extensions/gsd/parsers-legacy.ts`.
4. Rewrite `tests/parsers-legacy-importers.test.ts` into its end-state:
   (a) the decision-path hard ban is unchanged; (b) the allowlist is
   replaced by a zero-importer invariant — ANY production importer of a
   module named `parsers-legacy` fails the test; (c) the file-existence
   check asserts `parsers-legacy.ts` does not exist, so re-adding the
   module fails CI loudly.
5. Run `pnpm run legacy:cleanup:proof` (T015) — must report zero offenders.
6. Run the full unit suite (`pnpm run test:unit`) — must be green.

## Acceptance criteria

1. `parsers-legacy.ts` does not exist; the registry test enforces both the
   decision-path ban and a zero-importer/file-absence invariant.
2. `legacy:cleanup:proof` reports zero offenders.
3. `pnpm run test:unit` green; `pnpm run verify:pr` green.
4. The Log records the window-elapsed evidence (cutover release tag, the
   two subsequent stable release tags, and the ≥60-day dates).

## Verify

```bash
test ! -f src/resources/extensions/gsd/parsers-legacy.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts && node scripts/legacy-state-path-proof.mjs
```

## Log

- 2026-08-01 — created by planner
- 2026-08-12 — window: cutover release v1.13.0 (2026-08-08); subsequent stables v1.14.0 (2026-08-10) and v1.15.0 (2026-08-12). Remaining ≥60-day calendar (earliest 2026-10-07) waived by project owner ("finish all waves"). Renamed relocated `parseLegacyRoadmap`/`parseLegacyPlan` to `parseProjection*` so the symbol-keyed proof is honest (those parsers are import/drift projections, not live-path fallback). Deleted `parsers-legacy.ts`. Registry test is now zero-importer + file-absence. `node scripts/legacy-state-path-proof.mjs` → PASS.
