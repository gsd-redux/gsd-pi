---
id: T016
title: Reconcile the parsers-legacy importer registry after wave-3 consumer migration
wave: 3
deps: [T010, T011, T012, T013, T014, T028]
status: done
agent: build_T016
commit: 0ea5f522702bb92347e4aa308d5ed1cf712cb624
base: c6980f0b3fc36e7e5dcc79f6dafacbd5126138e9
worktree: .worktrees/gsd-path-T016
task_branch: gsd-path/T016
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
- 2026-08-05 — planner: deps += T028. The proof shipped by T015 shows TWO remaining production importers, not one: gsd/state.ts (expected, removed by T022) and gsd/markdown-renderer.ts (unowned — T008's AC2 forbade only a NEW import, never required removing the existing one). T028 re-homes it to schemas/parsers.js. This task's expected-state list ("only gsd/state.ts") is correct only after T028 lands.
- 2026-08-06 — coder: baseline run reproduced the stale-entry failure with exactly the 15 entries named in Step 2 (md-importer, migration-auto-check, drift/roadmap, drift/sketch-flag, markdown-renderer, reactive-graph, artifact-verification, doctor, doctor-state-checks, doctor-engine-checks, workspace-index, visualizer-data, auto-prompts, commands-maintenance, github-sync/sync). Mechanical sweep of `src/resources/extensions` (same import regex, tests excluded) found exactly ONE remaining production importer: `src/resources/extensions/gsd/state.ts` — no unexpected importer, so no block. Removed all 15 stale entries; `ALLOWED_IMPORTERS` now holds only `gsd/state.ts` with a justification naming T022 as the deleting task. Updated the header comment to describe the end state (allowlist empties at T022, registry flips to the zero-production-importer invariant in T020, allowlist only ever shrinks). `BANNED_DECISION_PATHS` untouched. Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts` → `tests 3 / pass 3 / fail 0` (duration_ms 447.144292). Changed path: `src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts`.
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree):
  exit 0 — tests 3 / pass 3 / fail 0. Allowlist reconciled from 16 entries to
  the single surviving production importer `gsd/state.ts`, justification names
  T022. Diff scope check: 1 declared file plus the task file; zero paths
  outside `files`.
