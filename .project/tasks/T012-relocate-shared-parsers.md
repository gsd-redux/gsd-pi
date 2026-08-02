---
id: T012
title: Relocate shared markdown parsers off parsers-legacy; re-point md-importer and migration-auto-check
wave: 3
deps: [T007]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
