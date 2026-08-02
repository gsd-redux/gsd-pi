# Plan — gsd-pi state-DB cutover

<!-- Written by the planner role. Executed wave-by-wave by $gsd-path-build. -->

Milestone: state-DB cutover in `src/resources/extensions/gsd` — DB-authoritative
project state, files as pure projections, evidence-gated legacy-path deletion.
Hard vetoes honored throughout: no DB split, no gsd-cloud cleanup, no extension
modularization, no DI/framework swaps, single-writer invariant holds,
`verify:pr` is never weakened (the successor gate ADDS to it).

Ruled downgrade window: 2 stable releases + ≥60 days (ADR-046; user ruling
2026-08-01). The explicit backup-restore command ships in this milestone
(T014). **Timebox-gated deletions are separable**: wave 4 (T020–T022) contains
every deletion that may not land until the window elapses after the cutover
release; waves 1–3 ship the cutover itself. Wave 4 tasks carry an explicit
"do not land before the window elapses" gate in their acceptance criteria.

Project verify: `pnpm run verify:pr`

## Config

- max_review_cycles: 3   <!-- review→fix→re-review loops per wave before escalating -->

## Wave 1 — risk burn-down

Goal: prove or falsify every plan-invalidating assumption before any code
changes: (a) the four gates are actually green at clean HEAD (their green
status is 2026-05-04 doc-claimed only), (b) none of the T07 deferred blockers
blocks filesystem-state deletion, (c) the observed behavior of a pre-cutover
binary on a cut-over project is known, not inferred, (d) the complete
parsers-legacy importer union is inventoried with per-consumer dispositions.
If T001 shows any gate red at HEAD, the plan re-baselines before wave 2. If
T002 finds a blocker touching filesystem-state deletion, scope changes. All
four tasks write docs only; no production code moves in wave 1.

| Task | Title | Deps | Files |
|------|-------|------|-------|
| T001 | Re-run all four gates at clean HEAD and record evidence | — | .project/plan/wave1-gate-baseline.md |
| T002 | Map T07 blockers; write D005 supersede-for-filesystem-state-only decision doc | — | docs/dev/state-db-cutover-milestone-decision.md |
| T003 | Spike: pre-cutover binary vs. cut-over project fixture | — | docs/dev/state-db-cutover-mixed-version-spike.md |
| T004 | Authoritative parsers-legacy importer union inventory with dispositions | — | docs/dev/state-db-cutover-parsers-legacy-inventory.md |

## Wave 2 — walking skeleton

Goal: one project, end to end: the gates execute green at clean HEAD (T024 —
they were unrunnable pre-repair, Defect A); a fixture `~/.gsd` project is
migrated via the existing authority-cutover domain op inside the startup
EXCLUSIVE claim (verified backup + receipt + idempotent re-entry as no-op);
refuse-newer is a typed error surfaced loudly at state reads, projection
writers, and rebuild paths (T003 spike mandates, Defect B); `deriveState`
serves the real runtime path from the DB with files rendered as stamped
read-only projections; `markdown-renderer.ts` stops reading its own
projections back through parsers-legacy; rollback is demonstrated by restoring
the verified backup; the successor gate `gate:lifecycle-shadow-no-cutover`
exists and is wired into `verify:pr` (strengthening it). No canonical-lifecycle
changes anywhere in this wave.

| Task | Title | Deps | Files |
|------|-------|------|-------|
| T024 | Unblock gates at clean HEAD: redirect @opengsd/contracts to source in both test tiers, re-run the T001 baseline | — | src/resources/extensions/gsd/tests/dist-redirect.mjs, scripts/dist-test-resolve.mjs, .project/plan/wave1-gate-baseline.md |
| T005 | Stamp gsd.db (application_id, user_version, V46); typed refuse-newer surfaced at the DB-open seam and state reads | T001, T003, T024 | src/resources/extensions/gsd/db/engine.ts, db-workspace.ts, state/derive/db-open.ts, src/headless-query.ts, src/read-cli.ts, tests |
| T006 | Filesystem-state cutover via the authority-cutover op: EXCLUSIVE-claim migration, idempotent re-entry, authority-epoch loud refusal, partial-destination wedge fix, projection-write version gating, rebuild error propagation | T002, T005, T024 | src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts, migrate-external.ts, src/cli.ts, src/headless-recover.ts, tests |
| T007 | Flip read authority at the derive seam; markdown fallback unreachable on the live path | T001, T006, T024 | src/resources/extensions/gsd/state.ts, src/resources/extensions/gsd/state/derive/from-db.ts, tests |
| T008 | markdown-renderer: additive DB state-version stamp on projections; re-point self-read-back merge paths to DB reads | T007 | src/resources/extensions/gsd/markdown-renderer.ts, tests |
| T009 | Split-retire the no-cutover gate: create gate:lifecycle-shadow-no-cutover and add it to verify:pr | T002, T007, T008, T024 | scripts/semantic-shadow-no-cutover-gate.mjs, scripts/lifecycle-shadow-no-cutover-gate.mjs, package.json, tests/semantic-shadow-no-cutover.test.ts |

## Wave 3 — consumers, evidence, command, docs

Goal: drive the parsers-legacy importer registry to zero production importers
(per T004 dispositions), redesign `legacy:cleanup:evidence` to fail closed with
a static no-caller/no-importer proof (NO `markdownFallbackUsed` counter is
built), ship the explicit backup-restore command, freeze and document the
projection format as a de facto public API, and land the six user-accepted
fix-doc items. Nothing in this wave deletes `parsers-legacy.ts`,
`_deriveStateImpl`, or any timeboxed witness — those are wave 4.

| Task | Title | Deps | Files |
|------|-------|------|-------|
| T010 | Re-point doctor, reactive-graph, and artifact-verification consumers to DB reads | T007 | src/resources/extensions/gsd/doctor*.ts, reactive-graph.ts, artifact-verification.ts, tests |
| T011 | Re-point display/prompt consumers (workspace-index, visualizer-data, auto-prompts, github-sync) | T007 | src/resources/extensions/gsd/workspace-index.ts, visualizer-data.ts, auto-prompts.ts, src/resources/extensions/github-sync/sync.ts, tests |
| T012 | Relocate shared markdown parsers off parsers-legacy; re-point md-importer and migration-auto-check | T007 | src/resources/extensions/gsd/md-importer.ts, migration-auto-check.ts, parsers-legacy.ts, schemas/parsers.ts, tests |
| T013 | Convert drift detectors to stamped projection-reads via relocated parsers | T008, T012 | src/resources/extensions/gsd/state-reconciliation/drift/*, tests |
| T014 | Ship the explicit backup-restore command; re-point commands-maintenance | T006 | src/resources/extensions/gsd/commands-maintenance.ts, legacy-import-restore-assessment.ts, tests |
| T015 | Fail-closed legacy:cleanup:evidence redesign + static no-caller/no-importer proof | T002, T007 | scripts/legacy-cleanup-evidence.mjs, scripts/legacy-cleanup-gate.mjs, scripts/legacy-state-path-proof.mjs, src/tests/legacy-cleanup-*.test.ts, package.json |
| T016 | Reconcile the parsers-legacy importer registry after wave-3 migration | T010, T011, T012, T013, T014 | src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts |
| T017 | Rewrite docs/dev/ci-cd-pipeline.md to document the manual npm-publish.yml reality | — | docs/dev/ci-cd-pipeline.md |
| T018 | Downgrade ADR-004/-009/-011/-013/-036 status labels to audit-verified reality | — | docs/dev/ADR-004-*, ADR-009-*, ADR-011-*, ADR-013-*, ADR-036-* |
| T019 | Freeze projection format; document projections as de facto public API; record accepted residual risks | T002, T003, T008 | docs/dev/state-db-cutover-projection-contract.md, docs/dev/state-db-cutover-milestone-decision.md |

## Wave 4 — timebox-gated deletions (separable) and closeout

Goal: evidence-gated deletion of the legacy filesystem-state path. T020–T022
are the ONLY tasks containing deletions that are gated on the ruled window
(2 stable releases + ≥60 days after the cutover release, per ADR-046 and the
2026-08-01 user ruling): they MUST NOT land as part of the cutover release and
are dispatched separately once the window elapses. T023 closes the milestone
after them. If the window has not elapsed when wave 3 completes, stop after
wave 3 and report; wave 4 waits.

| Task | Title | Deps | Files |
|------|-------|------|-------|
| T020 | Delete parsers-legacy.ts at zero production importers (timebox-gated) | T016, T022 | src/resources/extensions/gsd/parsers-legacy.ts, tests/parsers-legacy-importers.test.ts |
| T021 | Delete ADR-046-timeboxed witnesses and unadopted import/reconcile compatibility paths (timebox-gated) | T009, T012 | tests/md-importer-adopted-authority.test.ts, tests/workflow-reconcile.test.ts, tests/semantic-shadow-contract.test.ts, tests/semantic-shadow-mode-matrix.test.ts, scripts/lifecycle-shadow-no-cutover-gate.mjs, md-importer.ts, workflow-reconcile.ts |
| T022 | Delete _deriveStateImpl and legacy markdown-fallback remnants, gated on fail-closed evidence (timebox-gated) | T015, T016 | src/resources/extensions/gsd/state.ts, tests |
| T023 | Milestone closeout: full gate suite green at the cutover commit; status docs updated | T017, T018, T019, T020, T021, T022 | docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md, CONTEXT.md, docs/dev/state-db-cutover-milestone-decision.md |

## Dependency notes

- T024 has no deps and is the first wave-2 layer: every gate- or test-tier
  Verify in waves 2+ requires the `@opengsd/contracts` source redirect it
  lands. T005, T006, T007, and T009 carry the dep explicitly (their
  acceptance/Verify run `baseline:refactor:phase0`, the successor gate, or
  `verify:pr`); T008 inherits it transitively via T007.
- T005→T006→T007→T008 is the skeleton spine: schema stamps land first so any
  binary new enough to check refuses loudly on skew; the cutover op rides the
  existing `migrateSchema` chain and `project-authority-cutover-domain-operation.ts`
  machinery (no new migration path); the derive-seam flip only happens once the
  cutover op can migrate a real project; the renderer stamp/re-point only makes
  sense post-flip.
- Defect B split (T003 spike mandates): T005 owns the read side (typed
  `SchemaTooNewError`, `"schema-too-new"` open reason, loud state reads via
  `headless-query`/`read-cli`, and `state/derive/db-open.ts` — moved out of
  T007's scope); T006 owns the write side (projection-write version gating in
  `src/cli.ts` graph build, refuse-newer propagation in
  `src/headless-recover.ts`). T006 depends on T005 because both protections
  consume T005's typed error/reason.
- T009 depends on T007+T008 because the successor gate's positive post-cutover
  checks (DB-authority at the derive seam, projection fidelity against stamped
  projections) must exist before the old gate's invariants are re-homed.
- T013 depends on T012 because drift detectors re-point to the relocated parser
  home created by T012; both are wave 3 with disjoint files (layered).
- T016 is the single wave-3 owner of the importer-registry test; consumer tasks
  (T010–T014) remove imports, T016 reconciles the allowlist. This avoids four
  same-wave tasks editing one file.
- T020 (wave 4) requires the registry at zero, which only happens once T022
  deletes `_deriveStateImpl` (the last production importer, via `state.ts`);
  hence the wave-4 layer order is T022 → T020 → T021/T023. T016 reconciled
  the registry in wave 3 so T022 starts from a known-clean baseline.
- T022 is the final code deletion and is gated on T015's fail-closed evidence
  pipeline, matching the evidence-gated sequence `legacy:cleanup:evidence` →
  `legacy:cleanup:gate` → delete.
- T017/T018/T019 are doc-only and dependency-light by design; they sit in wave
  3 so the 60-day timebox on wave 4 never delays documentation fixes.
- Out-of-repo readers behind the `.gsd → ~/.gsd/projects/<hash>/` symlink are
  unobservable; the accepted residual risk (projection format frozen
  byte-compatible, documented as de facto public API) is recorded by T019.

## Repair log

- 2026-08-02 — **Defect A repair** (evidence: `.project/plan/wave1-gate-baseline.md`,
  VERDICT BASELINE RED): `baseline:refactor:gate`, `baseline:refactor:phase0`,
  and `gate:semantic-shadow-no-cutover` were unrunnable at clean HEAD —
  `@opengsd/contracts` was never redirected to source by either test-tier
  resolve hook and its `dist/` is never present at clean HEAD; 13 of 15
  behavioral witnesses and all four phase-0 files never executed, so true gate
  status was undetermined. Repair: new wave-2 task **T024** (deps []) extends
  `src/resources/extensions/gsd/tests/dist-redirect.mjs` and
  `scripts/dist-test-resolve.mjs` to cover `@opengsd/contracts` (matching the
  existing `@gsd/*` redirect convention) and re-runs the T001 baseline before
  any cutover code lands; if the re-run is RED for non-contracts reasons the
  wave stops and re-baselines. T005/T006/T007/T009 now depend on T024.
- 2026-08-02 — **Defect B repair** (evidence:
  `docs/dev/state-db-cutover-mixed-version-spike.md`, observed behavior:
  silent divergence): the engine refuse-newer floor exists but is swallowed at
  CLI surfaces — state reads exited 0 with wrong/empty state, `graph build`
  wrote a new empty projection into a newer project, `headless recover` failed
  generically. Repair: **T005 re-scoped** to the read side — typed
  `SchemaTooNewError`, `"schema-too-new"` open reason in `db-workspace.ts`,
  loud propagation in `state/derive/db-open.ts` (moved from T007's scope), and
  non-zero exits with the exact message in `headless-query.ts`/`read-cli.ts`;
  **T006 re-scoped** to the write side — projection-write version gating in
  `src/cli.ts` graph build and refuse-newer propagation in
  `headless-recover.ts`. Both stay within the settled refuse-newer guard
  decision (floor kept, message unchanged, no silent downgrade path) and the
  ADR-046 downgrade window; the release-note directive (upgrade all linked
  worktrees together) remains necessary and is now empirically justified.
  T001–T004 (done) unchanged; all other task ids and deps unchanged.
