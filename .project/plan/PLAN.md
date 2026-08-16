# Plan — gsd-pi state-DB cutover

<!-- Written by the planner role. Executed wave-by-wave by $gsd-path-build. -->

Milestone: state-DB cutover in `src/resources/extensions/gsd` — DB-authoritative
project state, files as pure projections, evidence-gated legacy-path deletion.
Hard vetoes honored throughout: no DB split, no separately sequenced product cleanup, no extension
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

- max_review_cycles: 4 (closed)   <!-- USER RULING 2026-08-07, second cap: do NOT run a cycle 5. Cycle 4 established the remaining risk is undiscoverable by review-style inspection (two failures reachable only transitively, one from a test that imports nothing and scans the filesystem). Wave 3 closes on a REAL GATE RUN instead: verify:pr + test:integration executed OUTSIDE .worktrees/ (build:core cannot resolve inside a nested worktree). Fix tasks T039-T041 first. -->

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

Goal: one project, end to end: the gates execute at clean HEAD (T024
contracts redirect) and are verified green (T025 re-baseline — they were
unrunnable pre-repair, Defect A); a fixture `~/.gsd` project is
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
| T024 | Redirect @opengsd/contracts to source in both test tiers so the gates' full test bodies execute at clean HEAD (redirect ONLY — gates need not be green) | — | src/resources/extensions/gsd/tests/dist-redirect.mjs, scripts/dist-test-resolve.mjs, .project/plan/wave1-gate-baseline.md |
| T025 | Re-baseline the gates: resolve the prompt-golden Phase-2 red leg and the discard-witness native-lock red leg (native build step + loader local-addon preference) | T024 | src/tests/fixtures/prompt-golden-fixtures.ts, src/tests/prompt-golden-fixtures.test.ts, src/resources/extensions/gsd/auto-prompts.ts, packages/native/src/native.ts, src/resources/extensions/gsd/managed-projection-history.ts, src/resources/extensions/gsd/tests/park-milestone.test.ts, .project/plan/wave2-gate-baseline.md |
| T005 | Stamp gsd.db (application_id, user_version, V46); typed refuse-newer surfaced at the DB-open seam and state reads; legacy-import schema pin + corpus realigned to V46 | T001, T003, T024, T025 | src/resources/extensions/gsd/db/engine.ts, db-workspace.ts, state/derive/db-open.ts, src/headless-query.ts, src/read-cli.ts, legacy-import-contract.ts, legacy-import-surfaces.ts, legacy-import corpus fixtures, tests |
| T006 | Filesystem-state cutover via the authority-cutover op: EXCLUSIVE-claim migration, idempotent re-entry, authority-epoch loud refusal, partial-destination wedge fix, projection-write version gating, rebuild error propagation | T002, T005, T024, T025 | src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts, migrate-external.ts, src/cli.ts, src/headless-recover.ts, tests |
| T007 | Flip read authority at the derive seam; markdown fallback unreachable on the live path | T001, T006, T024, T025 | src/resources/extensions/gsd/state.ts, src/resources/extensions/gsd/state/derive/from-db.ts, tests |
| T008 | markdown-renderer: additive DB state-version stamp on projections; re-point self-read-back merge paths to DB reads | T007 | src/resources/extensions/gsd/markdown-renderer.ts, tests |
| T009 | Split-retire the no-cutover gate: create gate:lifecycle-shadow-no-cutover and add it to verify:pr | T002, T007, T008, T024, T025 | scripts/semantic-shadow-no-cutover-gate.mjs, scripts/lifecycle-shadow-no-cutover-gate.mjs, package.json, tests/semantic-shadow-no-cutover.test.ts |
| T026 | Fix restore-assessment unsupported-schema test after the V46 pin advance (future-schema simulation moves off v46, expressed as SCHEMA_VERSION + 1) | T005 | src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts |
| T027 | Realign stale schema-version literals and stamp-era byte expectations so verify:pr's test:unit leg is green at HEAD (review cycle-1 T009F1, carries T009 AC5) | T005, T008 | src/resources/extensions/gsd/tests/db-authority-recovery-schema.test.ts, db-lifecycle-foundation.test.ts, db-milestone-reopen-schema.test.ts, db-milestone-completion-schema.test.ts, gsd-rebuild.test.ts, migrate-safety-audit.test.ts |

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
| T010 | Re-point doctor, reactive-graph, and artifact-verification consumers to DB reads | T007, T012 | src/resources/extensions/gsd/doctor*.ts, reactive-graph.ts, artifact-verification.ts, tests |
| T011 | Re-point display/prompt consumers (workspace-index, visualizer-data, auto-prompts, github-sync) | T007 | src/resources/extensions/gsd/workspace-index.ts, visualizer-data.ts, auto-prompts.ts, src/resources/extensions/github-sync/sync.ts, tests |
| T012 | Relocate shared markdown parsers off parsers-legacy; re-point md-importer and migration-auto-check | T007 | src/resources/extensions/gsd/md-importer.ts, migration-auto-check.ts, parsers-legacy.ts, schemas/parsers.ts, tests |
| T013 | Convert drift detectors to stamped projection-reads via relocated parsers | T008, T012 | src/resources/extensions/gsd/state-reconciliation/drift/*, tests |
| T014 | Ship the explicit backup-restore command; re-point commands-maintenance | T006 | src/resources/extensions/gsd/commands-maintenance.ts, legacy-import-restore-assessment.ts, tests |
| T015 | Fail-closed legacy:cleanup:evidence redesign + static no-caller/no-importer proof | T002, T007 | scripts/legacy-cleanup-evidence.mjs, scripts/legacy-cleanup-gate.mjs, scripts/legacy-state-path-proof.mjs, src/tests/legacy-cleanup-*.test.ts, package.json |
| T028 | Re-home markdown-renderer's roadmap projection parse off parsers-legacy | T008, T012 | src/resources/extensions/gsd/markdown-renderer.ts, tests/markdown-renderer.test.ts |
| T029 | Close the two surviving fail-open DB-unavailable branches in artifact-verification | T010 | src/resources/extensions/gsd/artifact-verification.ts, tests/recovery-verify-logs.test.ts, tests/integration/idle-recovery.test.ts |
| T030 | Fix the closed-status predicate in auto-prompts so run-uat and reassess still dispatch | T011 | src/resources/extensions/gsd/auto-prompts.ts, tests/auto-prompts-fallback.test.ts |
| T031 | Revert the unsound drift stamp short-circuit; delete the test pinning its silent pass | T013 | src/resources/extensions/gsd/state-reconciliation/drift/roadmap.ts, drift/stale-render.ts, tests/state-reconciliation-drift.test.ts |
| T032 | Route the shipped backup-restore command so /gsd db restore-backup is reachable | T014 | src/resources/extensions/gsd/commands/handlers/ops.ts, commands/catalog.ts, tests/db-restore-backup-routing.test.ts |
| T033 | Re-key the legacy static proof and importer registry on parser symbols | T015, T016, T028 | scripts/legacy-state-path-proof.mjs, tests/parsers-legacy-importers.test.ts, src/tests/legacy-cleanup-gate.test.ts |
| T034 | Repair the reassess/UAT dispatch tests T011 broke; restore the #1112 cache-race guard | T011, T030 | src/resources/extensions/gsd/tests/reassess-detection.test.ts, tests/uat-dispatch.test.ts, auto-prompts.ts |
| T035 | Fix the help-menu coverage regression from the db subcommand registration | T032 | src/resources/extensions/gsd/commands/core.ts, tests/help-menu-coverage.test.ts |
| T036 | Retire the obsolete execute-task checkbox and sibling-dir guards | T029 | src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts, artifact-verification.ts, docs/dev/state-db-cutover-milestone-decision.md |
| T037 | Reseed the workspace-index contract tests T011 broke | T011 | src/tests/integration/web-state-surfaces-contract.test.ts |
| T038 | Reseed the four auto-prompts test files T011 broke (14 RED) | T011, T030, T034 | src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts, integration/run-uat.test.ts, complete-milestone-excerpt.test.ts, right-sized-workflow-prompts.test.ts |
| T039 | Reseed the two transitively-reached run-uat tests T011 broke | T011, T038 | src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts, run-uat-replay-cap.test.ts |
| T040 | Resolve the #4289 stuck-recovery test against the fail-closed complete-milestone path | T029, T036 | src/resources/extensions/gsd/tests/journal-integration.test.ts, docs/dev/state-db-cutover-milestone-decision.md |
| T041 | Replace the ten silent catch blocks T014 added to commands-maintenance | T014, T032 | src/resources/extensions/gsd/commands-maintenance.ts |
| T016 | Reconcile the parsers-legacy importer registry after wave-3 migration | T010, T011, T012, T013, T014, T028 | src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts |
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

- T024→T025 is the gate-unblock chain and the first wave-2 layers: T024 lands
  the `@opengsd/contracts` source redirect so the gates' test bodies EXECUTE
  (its Verify asserts execution, not greenness); T025 resolves the two
  surviving true-baseline red legs and records `VERDICT: BASELINE GREEN` in
  `.project/plan/wave2-gate-baseline.md`. T005, T006, T007, and T009 depend
  on both explicitly (their acceptance/Verify run `baseline:refactor:phase0`,
  the successor gate, or `verify:pr`); T008 inherits transitively via T007;
  waves 3–4 inherit transitively (T023's full-gate closeout reaches T025 via
  every wave-2/3 chain).
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
- T005 also owns the legacy-import schema-pin advance
  (`LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION` 45→46) and the corpus
  realignment: the V44→V45 precedent (`9c338846f`) landed pin + corpus regen +
  test updates in a single commit, and the pin's literal type cannot compile
  against `SCHEMA_VERSION = 46` otherwise. `tests/legacy-import-corpus.test.ts`
  is cross-wave shared with T012 (wave 3, layered — T005 makes the version
  bump only). `tests/project-authority-cutover.test.ts` moved from T006 to
  T005 (same-wave sharing disallowed; T005 fixes its pin-related TS2322), and
  T006's end-to-end coverage lives in its new own file
  `tests/project-authority-cutover-filesystem-state.test.ts`.
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
- 2026-08-02 — **T024 block + split** (evidence: T024 task Log — coder
  narrative + orchestrator rejection record; `.project/plan/wave1-gate-baseline.md`):
  the contracts redirect worked (ERR_MODULE_NOT_FOUND eliminated; gate runs
  34 tests; witnesses 2/15 → 14/15 executing) but T024's Verify bundled a
  gate-green leg that cannot pass because the TRUE baseline is red for two
  pre-existing, redirect-unrelated reasons. Repair: **T024 re-scoped to the
  redirect ONLY** — its Verify proves ERR_MODULE_NOT_FOUND is eliminated and
  the previously-dead tests/witnesses EXECUTE, not that gates are green
  (frontmatter reset to pending/null; blocked-history Log preserved; the
  validated implementation approach kept verbatim). New task **T025**
  (wave 2, deps [T024]) owns the two red legs: (1) prompt-golden Phase-2
  reduction assertion (9454/15400, needs ≤9240) — diagnose stale reference
  (suspect: prompt-compression commit 331cee83a) vs genuine regression vs
  test-logic defect, resolve exactly one with evidence visible in diff + Log,
  never touching the 0.6 factor or weakening `verify:pr`; (2) `discard`
  witness native-lock failure — root cause CONFIRMED environmental by planner
  investigation: the pinned `@opengsd/engine-darwin-arm64` v1.11.0 binary
  loads but lacks `ProjectionRootIdentityLock` (added to the Rust engine
  after the pin; CI documents this skew and builds from source with
  `GSD_NATIVE_PREFER_LOCAL=1`), and `packages/native/src/native.ts` tries the
  stale npm package first so it never reaches local builds — T025 makes the
  loader prefer a present local addon and adds the documented
  `pnpm run build:native:dev` step to the gate procedure (no package.json or
  gate-script changes, keeping T025's files disjoint from T009/T024). Final
  green re-run recorded in `.project/plan/wave2-gate-baseline.md` (owned by
  T025). T005/T006/T007/T009 now depend on T025 as well as T024; T015's Log
  notes the `legacy:cleanup:evidence` fabrication path becomes reachable once
  the gates pass (already scoped for T015's fail-closed redesign).
- 2026-08-02 — **T005 block + expansion** (evidence: T005 task Log — coder
  block report + orchestrator acceptance): Steps 1–6 landed green in the
  retained worktree (task Verify 14/14, `baseline:refactor:phase0` 140/140)
  but acceptance #4 was unsatisfiable — `SCHEMA_VERSION = 46` collides with
  `LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 45 as const`
  (`legacy-import-contract.ts:90`, not in T005's files), producing TS2322 in
  five unlisted test files plus runtime "legacy import Preview requires
  database schema 45" failures. Repair: **T005 expanded in place** (same id,
  same base `c3ed1ff…`, retained worktree `.worktrees/gsd-path-T005`,
  status blocked→pending) rather than a companion task — the pin semantic is
  part of the same cutover-stamp concern, the resume is one continued agent
  run, and precedent `9c338846f` landed pin + corpus regen + tests in one
  commit. T005 gains: the pin advance (`legacy-import-contract.ts`,
  `legacy-import-surfaces.ts` scenario rename), corpus realignment
  (historical-v45 / current-v46 / future-v47, binaries rebuilt via the
  extension's own stamp-only V45→V46 migration), the five TS2322 test fixes,
  and the precedent-implicated version-sensitive legacy-import tests;
  acceptance gains typecheck-clean (#6) and corpus-realigned (#7).
  `tests/project-authority-cutover.test.ts` moved from T006 to T005
  (same-wave sharing disallowed); T006's Step 7 coverage re-scoped into its
  new own file `tests/project-authority-cutover-filesystem-state.test.ts`.
  `tests/single-writer-invariant.test.ts` (T007) hard-excluded — stamp-only
  V46 adds no schema file. T001–T004, T024, T025 (done) untouched; all other
  task ids and deps unchanged.
- 2026-08-02 — **T005 pin-advance fallout: new T026** (evidence: red test at
  primary HEAD after T005 integrated as `92ce63b2` —
  `tests/legacy-import-restore-assessment.test.ts` "unsupported database
  schema refuses before backup inspection", 14 pass / 1 fail, `actual:
  'backup'`, `expected: 'authority'`): the test simulated an unsupported
  future schema by inserting `schema_version` 46, which the V46 pin advance
  made SUPPORTED (the assessment refuses only when observed ≠
  `SCHEMA_VERSION`; production code correct, fixture stale). One file escaped
  T005's expanded files list. Repair: new wave-2 task **T026** (deps [T005])
  owns only that test file (cross-wave shared with T014, wave 3, layered —
  T026 makes the version-simulation fix only) and re-expresses the
  unsupported version as `SCHEMA_VERSION + 1` so the next pin advance cannot
  re-break it; no corpus fixture needed (the case is stamped inline via
  SQL). T005's integrated commit is untouched; all other task ids/deps
  unchanged.
- 2026-08-02 — **Wave-2 review cycle 1 blocked → new T027** (evidence:
  `.project/review/wave-2.cycle1.md` — T009 AC5 `verify:pr` green fails on
  deterministically red tests, all confirmed NOT caused by T009's diff;
  attribution re-run at T008's base `37aedafb`): T005's V46 bump left stale
  `SCHEMA_VERSION, 45` literals (`db-authority-recovery-schema.test.ts`,
  `db-lifecycle-foundation.test.ts`); T008's projection stamp left
  unstamped-byte expectations (`gsd-rebuild.test.ts`) and a
  canonical-representation conflict (`migrate-safety-audit.test.ts`).
  Repair: new wave-2 task **T027** (deps [T005, T008]) carries T009 AC5 and
  the T026 fix pattern (version expectations `SCHEMA_VERSION`-relative;
  stamp-aware byte expectations; semantically honest audit reconciliation —
  never weakening `migrate/audit.js`). Planner pre-sweep at HEAD extended
  the review's 4-file enumeration to 6 (added
  `db-milestone-reopen-schema.test.ts:218`,
  `db-milestone-completion-schema.test.ts:176` — confirmed red via source
  runner, 26/3), verified all six files UNOWNED by any task, and found no
  further unstamped exact-byte projection assertions; the sweep step +
  ownership-block rule are explicit in the contract. T009's other ACs all
  passed review; T021 inherits the review's dangling-import warning
  (`scripts/m003-s07-dossier-input.ts` + test import the deleted
  `semantic-shadow-no-cutover-gate.mjs` — unreachable by verify:pr, crash
  if run; fits T021's retirement scope).
- 2026-08-03 — **T010 block resolved: re-scoped to T012's landed reality**
  (evidence: T010 task Log block record; T012 commit
  `e6f14314bd0d5c9aa8de6a600952c2521bb74e11`): T010's Step 3 "otherwise keep
  its existing parse" branch contradicted AC1's zero-`parsers-legacy` grep
  for `doctor-engine-checks.ts` because no relocated parser home exported
  `parsePlan` at T010's base. T012 landed the relocation byte-identically
  (`parseLegacyRoadmap`/`parseLegacyPlan` in `schemas/parsers.ts`;
  `parsers-legacy.ts` now a deprecated re-export shim). Repair: T010 Step 3
  re-scoped — `doctor-engine-checks.ts` re-points its projection parse
  (:31 import, :149 call) to `parseLegacyPlan` from `./schemas/parsers.js`;
  Context records the landed state; AC1/Verify gained
  `parseLegacyPlan`/`schemas/parsers` greps; other four consumers
  unchanged. T010 deps [T007]→[T007, T012]; status blocked→pending; agent
  build_T010 kept; base/worktree/task_branch nulled — orchestrator rebases
  branch `gsd-path/T010` onto the new primary HEAD and redispatches into
  the retained clean worktree (same procedure as the T005 repair). Files
  list unchanged, so wave-3 overlap picture is untouched.
