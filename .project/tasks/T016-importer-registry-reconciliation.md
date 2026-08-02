---
id: T016
title: Reconcile the parsers-legacy importer registry after wave-3 consumer migration
wave: 3
deps: [T010, T011, T012, T013, T014]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts
---

# T016 — Reconcile the parsers-legacy importer registry

## Context

The registry test
`src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts` is the
enforcement seam for the consumer-web migration: it hard-bans
`parsers-legacy` in decision paths, allowlists every other importer, and
fails on stale allowlist entries. Wave-3 tasks T008 (markdown-renderer),
T010, T011, T012, T013, T014 removed the import from their files; this task
is the SINGLE owner that reconciles the `ALLOWED_IMPORTERS` allowlist so
the registry reflects reality before wave 4. After this task, the only
remaining production importers should be `gsd/state.ts` (until T022
deletes `_deriveStateImpl`) and `gsd/parsers-legacy.ts`'s residual re-export
role — verify mechanically, don't assume.

## Steps

1. Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs
   --experimental-strip-types --test
   src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts` and
   record the stale-entry failures.
2. Remove from `ALLOWED_IMPORTERS` every entry whose file no longer imports
   `parsers-legacy` (expected: `gsd/markdown-renderer.ts`, `gsd/doctor.ts`,
   `gsd/doctor-state-checks.ts`, `gsd/doctor-engine-checks.ts`,
   `gsd/reactive-graph.ts`, `gsd/artifact-verification.ts`,
   `gsd/workspace-index.ts`, `gsd/visualizer-data.ts`, `gsd/auto-prompts.ts`,
   `gsd/commands-maintenance.ts`, `github-sync/sync.ts`,
   `gsd/md-importer.ts`, `gsd/migration-auto-check.ts`,
   `gsd/state-reconciliation/drift/roadmap.ts`,
   `gsd/state-reconciliation/drift/sketch-flag.ts`).
3. Keep only the entries still importing (expected: `gsd/state.ts`), each
   with its justification updated to name the deleting task (T022).
4. Update the test header comment to describe the end-state: the registry
   flips to a zero-production-importer invariant in T020.
5. If any unexpected importer remains (a wave-3 task missed one), mark the
   task BLOCKED in the Log and name the owning task — do not silently
   extend the allowlist.

## Acceptance criteria

1. The registry test is green: zero stale entries, zero unexpected
   importers, decision-path ban intact.
2. `ALLOWED_IMPORTERS` contains exactly the files that still import
   `parsers-legacy` (expected: only `gsd/state.ts`), with justifications
   naming T022.
3. The `BANNED_DECISION_PATHS` set is unchanged.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts
```

## Log

- 2026-08-01 — created by planner
