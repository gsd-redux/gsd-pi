# Spike: pre-cutover binary vs. cut-over project fixture (mixed-version skew)

**Date:** 2026-08-02
**Task:** T003 (state-DB cutover milestone, wave 1 — risk burn-down)
**Question (from `.project/research/SYNTHESIS.md`, LOW confidence):** what does a
pre-cutover released binary actually do when it opens a project whose `gsd.db`
has been cut over by a newer binary — read-only, loud refusal, silent
divergence, or projection corruption?

## Binaries under test

| Side | Version | `SCHEMA_VERSION` |
|---|---|---|
| Pre-cutover binary | v1.11.0 (tag `v1.11.0`, commit `734909c01`, built via `pnpm install --frozen-lockfile --ignore-scripts && pnpm run build:core`) | 31 (`src/resources/extensions/gsd/db/engine.ts`) |
| Simulated post-cutover fixture | schema v32 — one version above what v1.11.0 supports, standing in for the post-cutover V46 (HEAD currently migrates to v45) | 32 |

Note on environment: the disposable worktree had to be placed in `$(mktemp -d)`
outside the repository tree. Inside `gsd-pi/.worktrees/**`, the v1.11.0 build's
TypeScript module resolution walks up to the primary checkout's
`node_modules`/`dist` and fails with cross-worktree type mismatches. The spike
worktree path is irrelevant to the results.

## Fixture construction

Throwaway script (not committed; run with the v1.11.0 build's own compiled
modules from `dist/resources/extensions/gsd/`):

1. `ensureGsdSymlink(<proj>)` — honors the ADR-002 layout:
   `<proj>/.gsd → $GSD_HOME/projects/<hash>/` plus the `.gsd-id` marker.
   (`GSD_HOME` is the v1.11.0-era env override; `GSD_STATE_DIR` does not exist
   at v1.11.0.)
2. `openWorkflowDatabase(<proj>)` — creates `gsd.db` and migrates it to v31.
3. Seeded one planned milestone (`M001`, vision set) + one slice (`S01`) + one
   task (`T01`) via direct adapter inserts using the same column lists as
   `db/writers/import-restore.ts`.
4. `renderAllFromDb(<proj>)` — rendered real markdown projections:
   `.gsd/phases/01-spike-milestone/01-ROADMAP.md` and `01-01-PLAN.md`
   (`{"rendered":3,"skipped":4,"errors":[]}`).
5. `recordSchemaVersion(db, 32)` — the same `schema_version` insert a real
   v32 migration performs, simulating the post-cutover bump.

## Probe results

All probes run with `cwd` = fixture project, `GSD_HOME` = fixture state home,
binary = `node dist/loader.js` from the v1.11.0 build.

| # | Command | Kind | Exit code | Observed behavior |
|---|---|---|---|---|
| 1 | `gsd headless query` | state read | **0** | Degraded JSON: `activeMilestone: null`, `phase: "pre-planning"`, `progress.milestones: {done:0,total:0}` — although the DB holds active M001. Carries only a generic blocker: `"DB unavailable — runtime markdown state derivation is disabled"`. No schema-version or upgrade message. |
| 2 | `gsd read progress --json --project <proj>` | state read | **0** | All-zero progress (`milestones.total: 0`, `phase: "unknown"`), `blockers: []`, `nextAction: ""`. No error, no blocker, no version hint — fully silent. |
| 3 | `gsd headless recover` | state-mutating | **1** | Fails: `[headless] recover: failed to open or create the GSD database at <proj>` — loud but generic; the underlying refuse-newer reason is swallowed. |
| 4 | `gsd graph build` | projection write | **0** | `Graph built: 0 nodes, 0 edges` — **wrote a new artifact** `.gsd/graphs/graph.json` (`{"nodes":[],"edges":[]}`) into the cut-over project without ever consulting the DB version. Existing projections untouched. |

Underlying engine behavior, probed directly via `openWorkflowDatabase`:

```
ok: false reason: open-failed
error: gsd.db schema is v32, newer than the v31 this gsd-pi supports. Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.
```

The engine-level refuse-newer floor (`migrateSchema`, engine.ts) throws exactly
the expected error — but `openWorkflowDatabase` catches it into
`{ok: false, reason: "open-failed"}`, and every CLI surface then either
degrades silently (probes 1–2), fails generically (probe 3), or never opens
the DB at all (probe 4).

## Before/after integrity (sha256)

| File | Before | After | Changed? |
|---|---|---|---|
| `gsdhome/projects/58ebc7dd8387/gsd.db` | `b4cb427a92dc7bb222749305eeb44aa4ebb3778ec984b4fad7a1c34a69649c3b` | `b4cb427a92dc7bb222749305eeb44aa4ebb3778ec984b4fad7a1c34a69649c3b` | **no** |
| `.gsd/phases/01-spike-milestone/01-ROADMAP.md` | `02a7c54fcd20f2a56f8268d3b40f3c11478fced6d7f7b68959e008d0f559c696` | `02a7c54fcd20f2a56f8268d3b40f3c11478fced6d7f7b68959e008d0f559c696` | **no** |
| `.gsd/phases/01-spike-milestone/01-01-PLAN.md` | `e43b7ae25bf23328402c58700eb94590914491fc8590904be3593009e60cadac` | `e43b7ae25bf23328402c58700eb94590914491fc8590904be3593009e60cadac` | **no** |

One new file appeared: `.gsd/graphs/graph.json` (empty graph written by probe 4).
No existing file — DB or markdown projection — was modified.

## Classification

observed behavior: silent divergence

The engine floor prevents all DB mutation and projection corruption (every
pre-existing byte survives), but the binary does **not** loudly refuse at the
surfaces automation actually consumes: state reads exit 0 while reporting a
materially wrong, empty project (an active milestone becomes invisible), and
the markdown-derived projection writer (`graph build`) happily stamps a new,
empty derived artifact into a newer project. Only the explicit rebuild path
(`headless recover`) fails, and even there the version-skew reason is lost.

## Recommendation — amend the synthesis guard

The synthesis guard (refuse-newer floor + release-note directive to upgrade
all linked worktrees together) is **confirmed at the engine level and
insufficient at the CLI surface**. Amend as follows:

1. **Read paths must refuse loudly, not degrade.** `headless query`,
   `read progress`, and every `openWorkflowDatabase` caller that today swallows
   `open-failed` must distinguish refuse-newer from other open failures and
   surface the exact `schema is vN, newer than the vM ... Update gsd-pi`
   message with a non-zero exit. An empty-state 200 is the worst possible
   answer for orchestration.
2. **Projection writers must check the version stamp.** Markdown-derived
   writers that bypass the DB (`graph build` and kin) must consult the
   `schema_version` stamp and refuse to write into a newer project.
3. **Rebuild paths must propagate the reason.** `headless recover`'s generic
   "failed to open or create the GSD database" must forward the underlying
   refuse-newer message.
4. The release-note directive ("upgrade all linked worktrees together")
   remains necessary and is now empirically justified: the skew does not
   corrupt data, but it silently blinds older binaries.

**Plan impact:** wave-2 tasks T005 (`db-version-stamps-refuse-newer`) and T006
(`cutover-op-exclusive-claim-wedge`) must be re-scoped before they start — the
refuse-newer work is not just an engine floor (it exists) but a surfacing
contract across read seams and projection writers.

Cleanup: disposable v1.11.0 worktree and all `mktemp` fixture dirs were
removed after the run.
