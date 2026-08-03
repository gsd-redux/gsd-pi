---
id: T011
title: Re-point display/prompt consumers (workspace-index, visualizer-data, auto-prompts, github-sync) off parsers-legacy
wave: 3
deps: [T007]
status: in-progress
agent: build_T011
commit: null
base: 40bdcfca4d1eea63fb1eb2d3198928c73d91fd37
worktree: .worktrees/gsd-path-T011
task_branch: gsd-path/T011
files:
  - src/resources/extensions/gsd/workspace-index.ts
  - src/resources/extensions/gsd/visualizer-data.ts
  - src/resources/extensions/gsd/auto-prompts.ts
  - src/resources/extensions/github-sync/sync.ts
  - src/resources/extensions/gsd/tests/visualizer-critical-path.test.ts
  - src/resources/extensions/gsd/tests/visualizer-data.test.ts
  - src/resources/extensions/gsd/tests/visualizer-overlay.test.ts
  - src/resources/extensions/gsd/tests/visualizer-views.test.ts
  - src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts
  - src/resources/extensions/github-sync/tests/sync-source.test.ts
---

# T011 — Re-point display/prompt consumers off parsers-legacy

## Context

Disposition class (a) per T004: these are display/telemetry/prompt-context
surfaces — `workspace-index.ts` and `visualizer-data.ts` are
display/telemetry-only; `auto-prompts.ts` builds prompt context text;
`github-sync/sync.ts` is display-only GitHub issue/PR body sync (the
+1 importer pitfalls research found outside the gsd extension). None makes
dispatch/gate/completion decisions, so each can read the DB directly.
Post-cutover the DB always exists at v46; markdown-derived display fallbacks
die with the path. The registry test is reconciled by T016 — do NOT edit
`tests/parsers-legacy-importers.test.ts` here.

## Steps

1. Read each file's actual `parsers-legacy` import sites.
2. `workspace-index.ts`, `visualizer-data.ts`: replace projection parses
   with `gsd-db` queries (`db/queries.ts`); rendered display/index shapes
   must be unchanged.
3. `auto-prompts.ts`: prompt context strings now come from DB rows; the
   emitted prompt text must stay byte-identical for the same project state
   (assert in `auto-prompts-fallback.test.ts` — rename/rework its
   fallback assertions to assert DB-derived context; remove tests that
   asserted markdown-fallback prompt text).
4. `github-sync/sync.ts`: issue/PR body sync reads DB state; body rendering
   unchanged. Update `github-sync/tests/sync-source.test.ts` for DB-backed
   fixtures.
5. Update the four `visualizer-*.test.ts` files only where they asserted
   markdown-derived data; keep visual coverage intact.
6. Remove the `parsers-legacy` import from all four production files; grep
   to confirm zero remaining references.

## Acceptance criteria

1. None of the four production files imports or references `parsers-legacy`.
2. Display, index, prompt-context, and sync outputs are byte-identical for
   equivalent project state (tests prove the prompt and visualizer cases).
3. No test asserts markdown-fallback behavior for these surfaces; DB-path
   coverage is not deleted.
4. `pnpm run baseline:refactor:phase0` stays green.

## Verify

```bash
! grep -n "parsers-legacy" src/resources/extensions/gsd/workspace-index.ts src/resources/extensions/gsd/visualizer-data.ts src/resources/extensions/gsd/auto-prompts.ts src/resources/extensions/github-sync/sync.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/visualizer-data.test.ts src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts src/resources/extensions/github-sync/tests/sync-source.test.ts
```

## Log

- 2026-08-01 — created by planner
