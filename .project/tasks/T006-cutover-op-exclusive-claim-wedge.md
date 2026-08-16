---
id: T006
title: Filesystem-state cutover via the authority-cutover op + write-side skew protections (projection-write gating, rebuild error propagation)
wave: 2
deps: [T002, T005, T024, T025]
status: done
agent: build_T006
commit: ffc8fca6cbee8441bd5d7af4ee8d3fe96cd6f659
base: d5ad152436619cedcab1743b6b254493ac45fc60
worktree: .worktrees/gsd-path-T006
task_branch: gsd-path/T006
files:
  - src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts
  - src/resources/extensions/gsd/migrate-external.ts
  - src/cli.ts
  - src/headless-recover.ts
  - src/resources/extensions/gsd/tests/project-authority-cutover-filesystem-state.test.ts
  - src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts
  - src/tests/headless-recover.test.ts
  - src/tests/graph-build-version-gate.test.ts
---

# T006 — Cutover op + EXCLUSIVE-claim migration + wedge fix + write-side skew protections (re-scoped per T003 spike)

## Context

Migration design is settled: ride the existing machinery, build NO new
migration path. The flip is one more versioned step in the existing
`migrateSchema` chain (V46, T005) plus the existing
`project-authority-cutover-domain-operation.ts` (consent tokens,
authority-epoch checks, persisted cutover receipts, replay-safe idempotency).
Backup = the existing verified same-directory copy; rollback = restore the
verified backup; legacy user files are NEVER deleted in the same step as the
flip. The atomic flip runs inside the startup EXCLUSIVE lock window
(`acquireStartupMaintenance`, engine.ts:191-232). The T003 spike (observed
behavior: silent divergence) mandates two WRITE-side protections in addition:
(1) projection writers that bypass the DB must consult the version stamp and
refuse to write into a newer project — the spike's `gsd graph build` wrote a
new empty `.gsd/graphs/graph.json` into a v32 project with exit 0; (2)
rebuild paths must propagate the refuse-newer reason — the spike's
`gsd headless recover` failed with only a generic "failed to open or create
the GSD database". Both protections use T005's typed `SchemaTooNewError` /
`"schema-too-new"` open reason. Known wedge pattern from `migrate-external.ts`:
a failed migration leaves a partial destination (`.gsd.migrating`) that
permanently blocks retry — the cutover must clean or own partial destinations.
Gate note: this task's acceptance runs `baseline:refactor:phase0`, runnable
at clean HEAD only after T024.

## Steps

1. Read `project-authority-cutover-domain-operation.ts` in full plus
   `db/domain-operation.js` (`_executeAuthorityCutoverDomainOperation`) and
   `legacy-import-application*.ts`. Extend the existing cutover domain
   operation with the filesystem-state authority scope: after the verified
   backup and receipt flow, the op records that filesystem-state (markdown)
   authority has flipped to the DB for this project — reuse the existing
   receipt/evidence shapes (add `filesystemStateAuthority: "db"` to the
   receipt, bumping the evidence schema version constant if shape validation
   requires it). Do NOT create a second operation type or consent flow.
2. Assert at op entry that the startup EXCLUSIVE ownership state is held
   (follow how existing startup maintenance asserts ownership); fail with a
   `PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION`-class error otherwise.
3. Authority-epoch loud refusal: wrong `expectedAuthorityEpoch` or a
   conflicting idempotency key fails loudly with the existing error codes;
   re-entry with the SAME idempotency key is a no-op returning the existing
   receipt (`status: "replayed"`).
4. Wedge fix: in `migrate-external.ts` and any destination-copy path the
   cutover op uses, make partial destinations self-healing — a stale
   `.gsd.migrating` (or op-specific partial destination) not owned by a live
   process is removed or adopted on entry; a prior failed attempt never
   requires manual deletion to retry (follow the existing
   migrate-external.ts:119-120,202,256-257 patterns).
5. Projection-write version gating (spike mandate 2): in `src/cli.ts`'s
   graph subcommand (~lines 270-287), before `buildGraph`/`writeGraph` runs
   for `graph build`, open the project DB via the extension's
   `openExistingWorkflowDatabase`/`openWorkflowDatabase`; when the result is
   `"schema-too-new"` (T005), print the exact refuse-newer message to
   stderr and exit non-zero WITHOUT writing `.gsd/graphs/graph.json`.
   Read-only graph subcommands (`status`, `query`, `diff`) also warn loudly
   on schema skew but keep their read-only semantics. Missing DB keeps
   current behavior. Do not add a version constant to `packages/mcp-server`
   — the version knowledge stays in the extension; the mcp-server graph
   code is not touched.
6. Rebuild-path error propagation (spike mandate 3): in
   `src/headless-recover.ts` (~line 199), when `openWorkflowDatabase`
   returns `reason: "schema-too-new"`, forward the attached error's exact
   message (`gsd.db schema is vN, newer than ...`) in the failure output
   with a non-zero exit, replacing the generic "failed to open or create
   the GSD database" for that case only; other open failures keep the
   generic message.
7. Write NEW `src/resources/extensions/gsd/tests/project-authority-cutover-filesystem-state.test.ts`
   (this task's end-to-end coverage lives in its own file — the pre-existing
   `project-authority-cutover.test.ts` is owned by T005, which fixes its
   pin-related type error; READ it for fixture patterns but do NOT edit it):
   (a) end-to-end fixture — pre-cutover project migrates via the op inside
   the EXCLUSIVE claim (verified backup, receipt, projections, v46);
   (b) idempotent re-entry returns `status: "replayed"` and mutates nothing
   (DB hash before/after); (c) wrong-epoch and conflicting-key invocations
   fail loudly; (d) rollback: restoring the verified `gsd.db.backup-v<N>`
   returns the project to the pre-cutover schema version.
8. Write `src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts`:
   a failed migration leaves a partial destination; the next attempt
   cleans/owns it and completes without manual intervention.
9. Extend `src/tests/headless-recover.test.ts` and write
   `src/tests/graph-build-version-gate.test.ts`: newer-schema fixture —
   `gsd headless recover` exits non-zero with the exact refuse-newer
   message; `gsd graph build` exits non-zero with the exact message and
   `.gsd/graphs/graph.json` is NOT created (assert file absence);
   same-version fixtures keep current behavior.

## Acceptance criteria

1. The cutover op covers filesystem-state authority with consent, verified
   backup, receipt, replay-safe idempotent re-entry, inside the EXCLUSIVE
   claim only; a stale partial destination never blocks retry.
2. `gsd graph build` refuses to write into a newer-schema project (no
   artifact written, non-zero exit, exact message); `gsd headless recover`
   forwards the exact refuse-newer message instead of the generic one.
3. Rollback by restoring the verified backup is demonstrated in tests;
   legacy files are not deleted by the flip.
4. `pnpm run baseline:refactor:phase0` green (post-T024); single-writer
   invariant untouched; no canonical-lifecycle read-authority changes
   (D005, per T002).

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/project-authority-cutover-filesystem-state.test.ts src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts src/tests/headless-recover.test.ts src/tests/graph-build-version-gate.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — re-scoped by planner (Defect B repair: T003 spike mandates projection-write version gating and rebuild-path error propagation; added src/cli.ts, src/headless-recover.ts, two test files, dep T024).
- 2026-08-02 — planner (T024 split repair): dep T025 added — acceptance runs `baseline:refactor:phase0`, green only after T025's re-baseline.
- 2026-08-02 — planner (T005 block repair, file-ownership move): `tests/project-authority-cutover.test.ts` MOVED to T005's files — T005's V46 pin advance must fix a TS2322 at its line 93, and same-wave file sharing is disallowed. This task's Step 7 end-to-end coverage (end-to-end fixture, idempotent re-entry, epoch refusal, rollback) re-scoped into the NEW T006-owned `tests/project-authority-cutover-filesystem-state.test.ts`; Verify filename updated. No behavior/scope change beyond the test-file split; deps unchanged (T006 already depends on T005).
- 2026-08-02 — coder (build_T006): all 9 steps implemented. (1) Cutover receipt + durable event payload now record `filesystemStateAuthority: "db"`; evidence schema version NOT bumped (pre-cutover evidence shape unchanged — documented in a comment on the receipt interface). (2) Op entry asserts startup EXCLUSIVE ownership as a contention check via the database-maintenance intent (`assertStartupExclusiveOwnership`): no intent / self-owned / dead-or-reused owner → proceed; live foreign owner (or unprovable intent) → retryable `PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION` before any mutation. Contention-check design (not a hard in-claim requirement) keeps T005's bare-callers green. (3) Wrong-epoch → `..._AUTHORITY_STALE`, conflicting key → `..._REPLAY_CONFLICT`, same key → `status: "replayed"` (pre-existing, now covered end-to-end). (4) `migrateToExternalState` calls `recoverFailedMigration` at entry — stale `.gsd.migrating` self-heals (adopted when `.gsd` is missing; removed when `.gsd` is intact). (5) `src/cli.ts` graph subcommand opens the project DB via `openExistingWorkflowDatabase`: `graph build` on `schema-too-new` prints the exact SchemaTooNewError message, exits 1, writes no graph.json; `status`/`query`/`diff` warn with the exact message and stay read-only; missing DB unchanged; no version constant added to mcp-server. (6) `src/headless-recover.ts` forwards the exact refuse-newer message only for `reason: "schema-too-new"`; other open failures keep the generic message. Tests: 5 end-to-end cases in the new filesystem-state file (EXCLUSIVE-claim commit with verified `gsd.db.backup-v46`, byte-identical idempotent replay via checkpointed DB hash, loud epoch/key refusal, backup-restore rollback, live-foreign-owner contention + stale-claim retry), 2 wedge cases, 4 graph-gate subprocess cases, 1 headless-recover refuse-newer case. Verify: 27/27 PASS across the four Verify files. Regression: T005 `project-authority-cutover.test.ts` 11/11, `read-cli-schema-too-new.test.ts` 4/4, `migrate-external-worktree.test.ts` 9/9 all green. Known pre-existing (NOT this task): `legacy-import-restore-assessment.test.ts` "unsupported database schema refuses before backup inspection" fails at this wave state — it hardcodes v46 as unsupported, but T005's pin advance made SCHEMA_VERSION=46 (observed stage 'backup' vs expected 'authority'); re-baseline belongs to T024/T025, file not in this task's scope. Worktree-local builds required before tests: `pnpm run build:native:dev`, `pnpm --filter @gsd/native run build`, `build:contracts`/`build:pi-tui`/`build:pi-ai`/`build:pi-agent-core`/`build:agent-core`/`build:rpc-client`/`build:agent-modes`, and `pnpm --filter @opengsd/mcp-server build` (note: `build:pi-coding-agent` fails on a pre-existing TS private-property 'cwd' declaration conflict under this worktree's dependency resolution — not needed by these tests).
