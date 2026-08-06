---
id: T013
title: Convert drift detectors to stamped projection-reads via the relocated parsers
wave: 3
deps: [T008, T012]
status: done
agent: build_T013
commit: 242af2e9798d635d129b364c00c2ca92a146cfd8
base: 291e71c154aac359be01cc38a34dccd992ab47b4
worktree: .worktrees/gsd-path-T013
task_branch: gsd-path/T013
files:
  - src/resources/extensions/gsd/state-reconciliation/drift/roadmap.ts
  - src/resources/extensions/gsd/state-reconciliation/drift/sketch-flag.ts
  - src/resources/extensions/gsd/state-reconciliation/drift/stale-render.ts
  - src/resources/extensions/gsd/tests/roadmap-slices.test.ts
  - src/resources/extensions/gsd/tests/state-reconciliation-drift.test.ts
  - src/resources/extensions/gsd/tests/artifact-db-drift-memo.test.ts
---

# T013 — Drift detectors: stamped projection-reads via relocated parsers

## Context

Disposition class (b) per T004: drift detection COMPARES the markdown
projection against the DB by design — reading projections is legitimate
here, but post-cutover it must (1) parse via the relocated non-legacy
parser home (`schemas/parsers.ts`, moved by T012), and (2) use the additive
DB state-version stamp (`<!-- gsd:state-version=R:E -->`, added by T008) to
short-circuit staleness: a projection whose stamp matches the current DB
project revision/authority epoch is fresh without a content parse; a
missing or mismatched stamp falls back to the existing content comparison.
`roadmap.ts` compares roadmap projections against DB; `sketch-flag.ts`
reads PLAN.md tasks to distinguish a real plan from a stub before clearing
a stale `is_sketch` flag (#1287); `stale-render.ts` composes the
per-reason renderer dispatch (relocated out of markdown-renderer,
ADR-017 #5702). The registry test is reconciled by T016 — do NOT edit it.

## Steps

1. Read all three drift files and their tests.
2. Re-point every `parsers-legacy` import to `schemas/parsers.ts` (the
   symbols were moved by T012; if a needed symbol was not moved, note it in
   the Log and complete the move per T012 step 2 — but do not edit
   `parsers-legacy.ts` or `schemas/parsers.ts` beyond what T012 owns;
   instead flag the gap for T012's fix loop).
3. Stamp short-circuit: in each detector, before content comparison, read
   the projection's trailing `<!-- gsd:state-version=R:E -->` comment; if
   `R:E` equals the DB's current project revision/authority epoch, treat
   the projection as fresh and skip the content diff. Unstamped or
   mismatched projections take the existing comparison path. Keep the
   existing drift verdicts and reasons byte-identical for equivalent
   states.
4. `sketch-flag.ts`: the PLAN real-plan-vs-stub judgment is a content
   judgment — it does NOT short-circuit on stamp (a stamped PLAN can still
   be a stub); only its parser import changes.
5. Update the three test files: add stamp-short-circuit cases (stamped
   fresh projection produces no drift even with content-equivalent DB
   changes; mismatched stamp triggers the comparison path); keep existing
   unstamped-fixture coverage intact.

## Acceptance criteria

1. Zero `parsers-legacy` references in all three drift files.
2. Stamp-matching projections skip content comparison; unstamped/mismatched
   projections behave exactly as before (tests prove both).
3. `sketch-flag.ts` retains its content judgment (no stamp short-circuit)
   with a comment explaining why.
4. Drift verdicts for equivalent states are unchanged;
   `state-reconciliation-drift.test.ts` passes.

## Verify

```bash
! grep -rn "parsers-legacy" src/resources/extensions/gsd/state-reconciliation/drift/ && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/state-reconciliation-drift.test.ts src/resources/extensions/gsd/tests/roadmap-slices.test.ts src/resources/extensions/gsd/tests/artifact-db-drift-memo.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-05 — coder: implemented.
  - `drift/roadmap.ts`: import re-pointed to `../../schemas/parsers.js`
    (`parseLegacyRoadmap as parseRoadmap`); added `projectionIsStampFresh()`
    and a short-circuit in `milestoneHasDivergence` — the ROADMAP file is now
    read once, and a stamp equal to `getCurrentProjectStateVersion()` returns
    "no divergence" before `parseRoadmap` runs. Unstamped/mismatched content
    takes the untouched comparison path.
  - `drift/sketch-flag.ts`: import re-pointed to
    `parseLegacyPlan as parsePlan` from `../../schemas/parsers.js`; no stamp
    short-circuit, with a doc-comment on `sketchIsPlanned` explaining that a
    stamped stub is still a stub (content judgment, not freshness).
  - `drift/stale-render.ts`: had no `parsers-legacy` import; added
    `renderPathIsStampFresh()` and filtered stamp-fresh entries out of
    `detectStaleRenderDriftFromBasePath` (markdown-renderer.ts line ~1168
    explicitly defers this wiring to T013). Unreadable/missing paths (the
    `*.md missing` reasons) never count as fresh.
  - `tests/roadmap-slices.test.ts`: `parseRoadmap` import re-pointed to
    `../schemas/parsers.ts`.
  - `tests/state-reconciliation-drift.test.ts`: +3 tests — stamp-fresh ROADMAP
    with diverging content produces no `roadmap-divergence` and is left byte-
    identical; `999:999` stamp falls back to the comparison path and repairs;
    a state-version-stamped stub PLAN still does not clear `is_sketch`. All
    existing unstamped-fixture coverage untouched.
  - `tests/artifact-db-drift-memo.test.ts`: no change needed (no
    `parsers-legacy` import, no stamp interaction); left as-is.
  - Verify: PASS — grep found zero `parsers-legacy` matches under
    `state-reconciliation/drift/`; node:test run of the three files reported
    `tests 94 / pass 90 / fail 0 / skipped 4` (baseline before this task was
    `tests 91 / pass 87 / fail 0 / skipped 4`), exit code 0.
  - Also ran `npx tsc --noEmit -p tsconfig.extensions.json --incremental false`:
    zero errors in any touched file (the two reported errors are pre-existing
    in `tests/oauth-api-model-routing.test.ts`, untouched by this task).
- 2026-08-05 — orchestrator Verify rerun (authoritative, isolated worktree):
  exit 0 — zero `parsers-legacy` matches under state-reconciliation/drift/;
  tests 94 / pass 90 / fail 0 / skipped 4. Diff scope check: 5 declared files
  plus the task file; zero paths outside `files`.
