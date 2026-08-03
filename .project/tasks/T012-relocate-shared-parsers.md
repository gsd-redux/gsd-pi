---
id: T012
title: Relocate shared markdown parsers off parsers-legacy; re-point md-importer and migration-auto-check
wave: 3
deps: [T007]
status: done
agent: build_T012
commit: e6f14314bd0d5c9aa8de6a600952c2521bb74e11
base: 40bdcfca4d1eea63fb1eb2d3198928c73d91fd37
worktree: .worktrees/gsd-path-T012
task_branch: gsd-path/T012
files:
  - src/resources/extensions/gsd/md-importer.ts
  - src/resources/extensions/gsd/migration-auto-check.ts
  - src/resources/extensions/gsd/parsers-legacy.ts
  - src/resources/extensions/gsd/schemas/parsers.ts
  - src/resources/extensions/gsd/tests/parsers.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts
  - src/resources/extensions/gsd/tests/md-importer.test.ts
  - src/resources/extensions/gsd/tests/migrate-validator-parsers.test.ts
---

# T012 — Relocate shared markdown parsers; re-point the legacy-import machinery

## Context

Legacy markdown IMPORT into the DB (migrating old `~/.gsd` projects) stays
alive past the cutover — that is how pre-cutover user state migrates. What
dies is the `parsers-legacy.ts` module itself (wave-4 T020, at zero
production importers). `md-importer.ts` and `migration-auto-check.ts`
currently import `parsers-legacy` for the markdown parse functions
(`parseRoadmap`, `parsePlan`, `parseProject`, etc. — verify the exact symbol
set). `schemas/parsers.ts` already exists as the non-legacy parser home.
This task moves the symbols the importer needs into the non-legacy home so
the registry can reach zero. Read `parsers-legacy.ts` and
`schemas/parsers.ts` FIRST — do not duplicate a function that already
exists in the non-legacy home (AGENTS.md rule 8). The unadopted-import
compatibility behavior itself (`md-importer-adopted-authority.test.ts`) is
NOT touched here — its deletion is timebox-gated T021.

## Steps

1. Inventory exactly which symbols `md-importer.ts`,
   `migration-auto-check.ts`, `markdown-renderer.ts` (post-T008, if any
   remain), and the drift detectors (T013) import from `parsers-legacy.ts`.
2. For each needed symbol: if an equivalent already exists in
   `schemas/parsers.ts`, re-point the import; otherwise MOVE the function
   from `parsers-legacy.ts` to `schemas/parsers.ts` unchanged (move, not
   copy — `parsers-legacy.ts` must shrink). Keep function behavior
   byte-identical; this is a relocation, not a refactor.
3. Re-point `md-importer.ts` and `migration-auto-check.ts` to
   `schemas/parsers.ts`; remove their `parsers-legacy` imports.
4. `parsers-legacy.ts` after the moves: re-export nothing new; leave only
   the symbols still consumed by files owned by other tasks (state.ts per
   T007, drift detectors per T013) — T020 deletes the module once the
   registry shows zero. Add a header comment: `// DEPRECATED — deletion
   gated on zero production importers (T020); do not add imports.`
5. Update `tests/parsers.test.ts`,
   `tests/migrate-validator-parsers.test.ts`, `tests/md-importer.test.ts`,
   `tests/legacy-import-corpus.test.ts` for the new import homes; the
   legacy-import corpus must still pass byte-identically (the importer's
   parse behavior is unchanged by relocation).

## Acceptance criteria

1. `md-importer.ts` and `migration-auto-check.ts` have zero
   `parsers-legacy` references.
2. Every moved symbol lives exactly once, in `schemas/parsers.ts`;
   `parsers-legacy.ts` carries the DEPRECATED header.
3. `legacy-import-corpus.test.ts` passes unchanged in behavior — the
   importer still parses real legacy projects identically.
4. No function is duplicated between the two parser modules.

## Verify

```bash
! grep -n "parsers-legacy" src/resources/extensions/gsd/md-importer.ts src/resources/extensions/gsd/migration-auto-check.ts && grep -q "DEPRECATED — deletion gated on zero production importers" src/resources/extensions/gsd/parsers-legacy.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers.test.ts src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts src/resources/extensions/gsd/tests/md-importer.test.ts src/resources/extensions/gsd/tests/migrate-validator-parsers.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-03 — coder: implemented. Inventory (step 1): md-importer.ts,
  migration-auto-check.ts, markdown-renderer.ts (post-T008), and the drift
  detectors (T013) import only `parseRoadmap`/`parsePlan` from
  parsers-legacy.ts; `schemas/parsers.ts` has NO equivalent (its
  validation-flavored `parseRoadmap` returns ParsedRoadmap for
  schemas/validate.ts — not interchangeable, per T008's note), so both
  functions were MOVED (step 2) into `schemas/parsers.ts` as
  `parseLegacyRoadmap`/`parseLegacyPlan` (the `Legacy` prefix is forced by
  the export-name collision with the validation parseRoadmap; bodies are
  byte-identical, including the parse cache + clearLegacyParseCache
  registration with files.ts). parsers-legacy.ts shrank to a re-export shim
  (original names preserved for state.ts per T007, markdown-renderer per
  T008, drift detectors per T013) with the DEPRECATED header (step 4).
  md-importer.ts and migration-auto-check.ts re-pointed to
  schemas/parsers.ts via import aliases (step 3). Tests (step 5):
  parsers.test.ts and legacy-import-corpus.test.ts re-pointed;
  md-importer.test.ts and migrate-validator-parsers.test.ts needed no edit
  (no parsers-legacy references). Naming note for T013/T016: the relocated
  symbols are `parseLegacyRoadmap`/`parseLegacyPlan` in schemas/parsers.ts.
  Known cross-wave state: parsers-legacy-importers.test.ts (T016-owned) now
  fails its "no stale entries" assertion on md-importer.ts and
  migration-auto-check.ts — expected; T016 reconciles the allowlist.
  Verify: PASS — grep conditions hold; 107 tests pass / 0 fail across
  parsers, legacy-import-corpus, md-importer, migrate-validator-parsers
  (baseline was also 107/0). Smoke: roadmap-slices + markdown-renderer +
  state-reconciliation-drift + migrate-writer = 131 pass / 0 fail
  (14 pre-existing skips).
