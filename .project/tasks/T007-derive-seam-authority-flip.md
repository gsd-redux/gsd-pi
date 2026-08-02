---
id: T007
title: Flip read authority at the derive seam — markdown fallback unreachable on the live path
wave: 2
deps: [T001, T006, T024, T025]
status: done
agent: build_T007
commit: 6da17d40acfdecf9562bc72a9640f37cfbacaac6
base: 95bc1a5d035bfb664b9553ad9996facc1b1ea9f1
worktree: .worktrees/gsd-path-T007
task_branch: gsd-path/T007
files:
  - src/resources/extensions/gsd/state.ts
  - src/resources/extensions/gsd/state/derive/from-db.ts
  - src/resources/extensions/gsd/tests/derive-state-db.test.ts
  - src/resources/extensions/gsd/tests/single-writer-invariant.test.ts
  - src/resources/extensions/gsd/tests/bootstrap-derive-state-db-open.test.ts
  - src/resources/extensions/gsd/tests/derive-seam-authority.test.ts
---

# T007 — Flip read authority at the derive seam

## Context

`src/resources/extensions/gsd/state.ts` currently dispatches on
`isDbAvailable()`: DB-backed projects use `deriveStateFromDb`
(`state/derive/from-db.ts`); `_deriveStateImpl` (state.ts:298) is the legacy
filesystem fallback with zero production callers on the live path — pitfalls
evidence confirms the live derive seam already refuses markdown fallback.
This task makes the flip real at the seam: after the cutover (T006), the
live runtime path derives state from the DB, files are read-only
projections, and DB-unavailable fails closed (via `buildDbUnavailableState`
in `state/derive/db-open.ts` — which is owned by T005: T005 made the
version-skew case throw `SchemaTooNewError` loudly while genuine
unavailability keeps the degraded fail-closed path; do NOT edit db-open.ts
here). `_deriveStateImpl` itself is NOT deleted here — that is
timebox-gated wave-4 task T022. This
task also removes `state.ts`'s own import of `parsers-legacy` if the
post-flip seam no longer needs it (check what `_deriveStateImpl`'s remaining
pre-migration role requires; the import leaves only if no live symbol needs
it — otherwise leave the import for T022). Do NOT touch canonical-lifecycle
read authority (D005): `from-db.ts`'s `handleAllSlicesDone` and the
`resolveMilestoneValidationVerdict` import policy are pinned by the gate and
keep their current behavior.

## Steps

1. Read `state.ts` (especially lines 1-80 and 290-340) and
   `state/derive/from-db.ts` fully; read `state/derive/db-open.ts` for
   context but do NOT modify it (T005 owns it — including the
   schema-too-new throw you will build on).
2. Make the post-cutover dispatch unconditional: when a project DB exists at
   schema v46 with the filesystem-state cutover receipt (from T006), state
   derivation MUST go through `deriveStateFromDb`; the `_deriveStateImpl`
   fallback branch is never taken on the live path. Keep the existing
   fail-closed `buildDbUnavailableState` behavior for genuinely unavailable
   DBs — no silent markdown reads anywhere in the dispatch; version-skew
   already throws loudly via T005's `SchemaTooNewError`.
3. Keep `_deriveStateImpl` exported (deletion is T022) but add a
   `GSD_ALLOW_LEGACY_DERIVE`-style guard ONLY if an existing test requires
   calling it directly; prefer updating those tests to construct a
   pre-migration fixture instead. Do not add telemetry counters of any kind
   (the no-counter decision is settled).
4. Update `tests/derive-state-db.test.ts`,
   `tests/single-writer-invariant.test.ts`, and
   `tests/bootstrap-derive-state-db-open.test.ts` for the flipped dispatch;
   remove or invert any assertion that the live path falls back to markdown
   (AGENTS.md: tests asserting removed behavior are removed or updated).
5. Write `tests/derive-seam-authority.test.ts` — the positive post-cutover
   DB-authority check re-homed from the retiring gate: (a) with a cut-over
   fixture project, `deriveState` output is derived from DB rows (mutate a
   markdown projection on disk, re-derive, assert the output is unchanged);
   (b) with the DB unavailable, the seam fails closed via
   `buildDbUnavailableState` and never reads projections as authority;
   (c) projections on disk are not opened for parsing on the live derive
   path (spy/stub the filesystem read of STATE.md or assert via the
   single-writer fixture instrumentation used by sibling tests).

## Acceptance criteria

1. Post-cutover, the live derive path is DB-authoritative: editing a
   projection file on disk does not change derived state (test proves it).
2. DB-unavailable still fails closed; no markdown read path is reachable
   from the live dispatch.
3. `single-writer-invariant.test.ts` passes unweakened; no changes to
   `handleAllSlicesDone` behavior or the validation-verdict authority.
4. No `markdownFallbackUsed` or similar counter is added anywhere.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-seam-authority.test.ts src/resources/extensions/gsd/tests/derive-state-db.test.ts src/resources/extensions/gsd/tests/single-writer-invariant.test.ts src/resources/extensions/gsd/tests/bootstrap-derive-state-db-open.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — re-scoped by planner (Defect B repair): `state/derive/db-open.ts` moved to T005's file scope (typed schema-too-new throw lives there); dep T024 added.
- 2026-08-02 — planner (T024 split repair): dep T025 added — acceptance runs `baseline:refactor:phase0`, green only after T025's re-baseline.
- 2026-08-02 — coder: audit confirmed the flip was already mechanical at the seam — `state/derive/index.ts` (outside task file scope) dispatches unconditionally to `deriveStateFromDb` when the DB is available and fails closed via `buildDbUnavailableState` otherwise; `_deriveStateImpl` has zero live-path callers. No functional change required in `state.ts`/`from-db.ts`: updated stale comments to record the flipped authority (parsers-legacy import stays — `_deriveStateImpl` and `getActiveMilestoneId`'s pre-migration branch still need it; deletion is T022). Audited the three existing test files: no assertion of live-path markdown fallback exists (already fail-closed, baseline 45/45 green), so they are unchanged per surgical-change rule. Wrote `tests/derive-seam-authority.test.ts` re-homing the positive post-cutover check: (a) on-disk DB fixture — editing STATE.md/ROADMAP/PLAN projections leaves derived state byte-identical; (b) DB-unavailable fails closed and ignores a STATE.md claiming active work; (c) fs read spy proves no markdown projection (STATE/ROADMAP/PLAN/SUMMARY/CONTEXT/REQUIREMENTS) is opened on the live derive path (DECISIONS.md seam-owned enrichment excluded deliberately). No counters added; `handleAllSlicesDone`/`resolveMilestoneValidationVerdict` untouched. Verify: 48 pass, 0 fail (45 baseline + 3 new). Pre-existing stale-native-addon warning at base; does not affect this verify.
