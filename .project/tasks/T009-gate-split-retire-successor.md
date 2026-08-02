---
id: T009
title: Split-retire the no-cutover gate — create gate:lifecycle-shadow-no-cutover and add it to verify:pr
wave: 2
deps: [T002, T007, T008, T024, T025]
status: done
agent: build_T009
commit: 3a627dd52268a3978c309bbb651ef7de2f6ec7f9
base: a41848537874f36bfb7a3b9e2d44671f83658422
worktree: .worktrees/gsd-path-T009
task_branch: gsd-path/T009
files:
  - scripts/semantic-shadow-no-cutover-gate.mjs
  - scripts/lifecycle-shadow-no-cutover-gate.mjs
  - package.json
  - src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts
---

# T009 — Split-retire gate:semantic-shadow-no-cutover; wire successor into verify:pr

## Context

Gate retirement is settled as a split-retire; NO invariant is dropped.
`scripts/semantic-shadow-no-cutover-gate.mjs` today runs 8 structural checks
(status-response-authority, parallel-eligibility-authority,
slice-dispatch-authority, dispatch-resolver-no-canonical-read,
retry-ledger-authority, state-derivation-authority,
validation-assessment-authority, closed-local-inputs) plus 16 behavioral
witnesses. Per SYNTHESIS.md the disposition is four-class: (a)
lifecycle-shadow invariants move VERBATIM into a successor gate
`gate:lifecycle-shadow-no-cutover` — D005 remains in force there (T002);
(b) filesystem-state invariants are now positive post-cutover unit checks —
already landed as `tests/derive-seam-authority.test.ts` (T007),
`tests/projection-fidelity.test.ts` (T008), and the existing
`tests/parsers-legacy-importers.test.ts` registry; (c) DB-unavailable
fail-closed witnesses and the never-promote-`omitted` rule stay as-is in the
unit tier; (d) unadopted import/reconcile and frozen cross-mode response
witnesses are deleted on the ADR-046 timebox — wave-4 task T021, NOT here;
(e) `closed-local-inputs` ports to the successor gate unchanged. The
successor gate is ADDED to `verify:pr` — strengthening it; the veto only
forbids weakening.

## Steps

1. Read `scripts/semantic-shadow-no-cutover-gate.mjs` fully (857 lines;
   exports `NO_CUTOVER_SOURCE_FILES`, `NO_CUTOVER_BEHAVIORAL_WITNESSES`,
   `analyzeNoCutoverSources`, `runSemanticShadowNoCutoverGate`).
2. Create `scripts/lifecycle-shadow-no-cutover-gate.mjs`: port the structural
   checks for lifecycle-shadow authority — status-response-authority,
   parallel-eligibility-authority, slice-dispatch-authority,
   dispatch-resolver-no-canonical-read, retry-ledger-authority,
   state-derivation-authority, validation-assessment-authority — plus
   `closed-local-inputs` (pointed at the NEW gate file itself), and the
   lifecycle behavioral witnesses: runtime-disagreement,
   resolve-dispatch-authority, state-derivation-authority,
   same-status-repair, park-unpark, discard, skipped-dispatch,
   db-unavailable-dispatch, db-unavailable-resolver,
   db-unavailable-resolver-no-active, db-unavailable-status. Keep the
   timeboxed witnesses (frozen-public-response, mode-transport-matrix,
   unadopted-import, unadopted-reconcile) in the successor gate's witness
   list with an explicit `// ADR-046 timebox: delete after 2 stable releases
   + >=60 days post-cutover release (T021)` comment — they keep running
   until T021 removes them. Reuse the old gate's analysis helpers by
   extracting them into a shared module ONLY if duplication would exceed
   ~200 lines; otherwise a self-contained successor script is preferred
   (simplicity first).
3. Retire the old gate: delete `scripts/semantic-shadow-no-cutover-gate.mjs`
   and remove the `gate:semantic-shadow-no-cutover` script from
   `package.json`. In
   `src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts`,
   remove any self-test that imports the deleted gate script; keep the
   behavioral witness tests themselves intact (the successor gate invokes
   them by title).
4. `package.json`: add `"gate:lifecycle-shadow-no-cutover": "node
   scripts/lifecycle-shadow-no-cutover-gate.mjs"` and append
   ` && pnpm run gate:lifecycle-shadow-no-cutover` to the `verify:pr`
   script. Do not remove or alter any other verify:pr component.
5. Sanity-run: `pnpm run gate:lifecycle-shadow-no-cutover` must be green at
   the task commit; the old gate name must no longer appear in package.json.

## Acceptance criteria

1. `scripts/lifecycle-shadow-no-cutover-gate.mjs` exists and passes; every
   lifecycle structural check and non-timeboxed witness from the old gate
   has a successor home — enumerate the mapping in the task Log.
2. Timeboxed witnesses still run under the successor gate, marked for T021.
3. `verify:pr` includes the successor gate and loses nothing else; the old
   gate script and its package.json entry are gone.
4. `tests/semantic-shadow-no-cutover.test.ts` no longer imports the deleted
   gate script; witness tests still pass by title.
5. `pnpm run verify:pr` green at the task commit.

## Verify

```bash
test -f scripts/lifecycle-shadow-no-cutover-gate.mjs && test ! -f scripts/semantic-shadow-no-cutover-gate.mjs && grep -q "gate:lifecycle-shadow-no-cutover" package.json && grep -q "verify:pr.*gate:lifecycle-shadow-no-cutover" package.json && pnpm run gate:lifecycle-shadow-no-cutover
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — re-scoped by planner (Defect A repair): dep T024 added — this task's Verify runs `gate:lifecycle-shadow-no-cutover` and `verify:pr`, which require the contracts redirect to execute at clean HEAD.
- 2026-08-02 — planner (T024 split repair): dep T025 added — the successor gate inherits the `discard` witness, which requires T025's native build procedure (`pnpm run build:native:dev` after install; the loader then prefers the local addon) to execute green at clean HEAD.
- 2026-08-02 — coder: split-retire complete. Created `scripts/lifecycle-shadow-no-cutover-gate.mjs` as a self-contained successor (a shared helper module would be an unlisted path, so the files list forces the self-contained option). Structural mapping (all 8 ported verbatim, `closed-local-inputs` repointed at the new gate file itself): status-response-authority, parallel-eligibility-authority, slice-dispatch-authority, dispatch-resolver-no-canonical-read, retry-ledger-authority, state-derivation-authority, validation-assessment-authority, closed-local-inputs → successor. Witness mapping: lifecycle witnesses runtime-disagreement, resolve-dispatch-authority, state-derivation-authority, same-status-repair, park-unpark, discard, skipped-dispatch, db-unavailable-dispatch, db-unavailable-resolver, db-unavailable-resolver-no-active, db-unavailable-status → successor; timeboxed witnesses frozen-public-response, mode-transport-matrix, unadopted-import, unadopted-reconcile → successor with the `// ADR-046 timebox: delete after 2 stable releases + >=60 days post-cutover release (T021)` comment on each. Retired `scripts/semantic-shadow-no-cutover-gate.mjs` (deleted) and its package.json entry; added `gate:lifecycle-shadow-no-cutover` and appended ` && pnpm run gate:lifecycle-shadow-no-cutover` to `verify:pr` (no other verify:pr component touched). In `tests/semantic-shadow-no-cutover.test.ts` removed the deleted-gate import, the two gate self-tests ("AST boundaries reject canonical response, decision, and hosted-metadata sabotage", "gate fails closed for missing witnesses and child regressions, then restores"), the now-dead `loadSource`/`pristineSources` helpers, and the unused `readFileSync` import; all five behavioral witness tests intact (gate invokes three of them by title, file runs green). Verify: PASS (static legs + `pnpm run gate:lifecycle-shadow-no-cutover` exit 0, Structural 8/8, Behavioral 15/15). Extra legs: `typecheck:extensions` PASS (after building contracts + pi-ai dist artifacts, which `build:core` supplies in verify:pr order), `test:compile` PASS. Full `verify:pr` (build:core + test:unit) not run end-to-end by coder — exceeds isolated execution budget; reviewer owns AC5 at the task commit. Flag for planner/reviewer (not a block): unlisted `scripts/m003-s07-dossier-input.ts` and `scripts/__tests__/m003-s07-dossier-input.test.ts` still import the retired gate script; unreachable by any verify:pr leg (not typechecked, not in the compiled unit globs, esbuild bundle:false compile stays green) but left dangling per the files-list boundary.
