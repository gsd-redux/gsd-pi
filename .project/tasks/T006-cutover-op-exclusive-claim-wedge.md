---
id: T006
title: Filesystem-state cutover via the authority-cutover op + write-side skew protections (projection-write gating, rebuild error propagation)
wave: 2
deps: [T002, T005, T024]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts
  - src/resources/extensions/gsd/migrate-external.ts
  - src/cli.ts
  - src/headless-recover.ts
  - src/resources/extensions/gsd/tests/project-authority-cutover.test.ts
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
7. Extend `src/resources/extensions/gsd/tests/project-authority-cutover.test.ts`:
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
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/project-authority-cutover.test.ts src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts src/tests/headless-recover.test.ts src/tests/graph-build-version-gate.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — re-scoped by planner (Defect B repair: T003 spike mandates projection-write version gating and rebuild-path error propagation; added src/cli.ts, src/headless-recover.ts, two test files, dep T024).
