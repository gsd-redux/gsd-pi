# Intent — gsd-pi

<!-- Written by $gsd-path-grill. Every downstream agent reads this first.
     Constraints and vetoes here override everything downstream. -->

## Summary

The gsd-pi state layer has been running in "semantic shadow" mode: the DB-authoritative model exists alongside the legacy filesystem-state path, guarded by a gate (`semantic-shadow-no-cutover`) whose entire invariant is that cutover has NOT happened. This milestone finishes the job: it flips project state to DB-authoritative with files as pure projections, proves via telemetry and tests that the legacy path is unused, and deletes it. The milestone is done when the no-cutover gate is retired (its invariants re-homed), `legacy:cleanup:gate`/`legacy:cleanup:evidence` pass green, and `baseline:refactor:gate` plus the full unit suite and `verify:pr` are green at the cutover commit. The Phase 5 DB split and extension modularization are explicitly NOT part of this milestone.

## Problem

The long-running state-DB refactor is stuck mid-flight. Two state paths coexist (legacy filesystem + DB-authoritative shadow), invariants are encoded as gate scripts that presume no cutover, and every change near state/projection/legacy surfaces carries double-path complexity and drift risk. This hurts the gsd-pi maintainers (nearly all recent commits are maintenance/fix density on the gsd extension) and slows every downstream change; end users are affected only transitively through stalled simplification.

## Users

- Primary: gsd-pi maintainers/contributors — highly technical, working in this repo daily; they use the gate scripts, baselines, and `verify:pr` as their safety net.
- Secondary: end users of the published `@opengsd/gsd-pi` CLI (v1.11.0 on npm) — the cutover must migrate their existing `~/.gsd` project state transparently; they never interact with the state layer directly.

## Success criteria

<!-- Observable statements. The final review checks these one by one. -->
1. Project state is DB-authoritative on the live path: the single-writer-invariant and derive-state-db tests pass against the real runtime path, not a shadow; files are read-only projections of DB state.
2. `gate:semantic-shadow-no-cutover` is retired or inverted; every invariant it protected (single writer, projection fidelity) has an explicit post-cutover home as a runnable check.
3. `legacy:cleanup:gate` and `legacy:cleanup:evidence` pass green — telemetry/tests demonstrate the legacy filesystem-state path is unused before its removal.
4. The legacy filesystem-state read/write path is deleted (not just bypassed).
5. `baseline:refactor:gate`, the full unit suite, and `pnpm run verify:pr` are green at the cutover commit, with `verify:pr` unweakened.

## Scope: in

- Flip project-state reads/writes to the DB-authoritative model in `src/resources/extensions/gsd` (files become pure projections).
- Migration of existing end-user `~/.gsd` project state: idempotent, backed up, rollback-safe.
- Evidence-gated removal of the legacy filesystem-state path (`legacy:cleanup:evidence` → `legacy:cleanup:gate` → delete).
- Retire/invert `gate:semantic-shadow-no-cutover`; re-home its invariants as post-cutover checks.
- Any test, fixture, and doc updates strictly required by the above (including removing/updating tests that asserted the old dual-path behavior).

## Scope: out (vetoes)

<!-- Hard constraints. Nothing in research, plans, or tasks may include these. -->
- Phase 5 DB split (`gsd-db.ts` monolith → modules) — user confirmed 2026-08-01: "yes" to keeping it a separate milestone.
- Legacy remote-product cleanup was separately sequenced and has since completed; it is not part of this state-layer milestone.
- Extension modularization (`src/resources/extensions/` → `extensions/*`) — separate queued workstream.
- Killing other scaffolding (`packages/db`) — not this milestone.
- Do not break the single-writer DB invariant (user-confirmed protected behavior, enforced by existing tests).
- Do not weaken `pnpm run verify:pr` or the enforced coverage floors as a way to get green.
- No DI containers, framework swaps, or cosmetic refactors (VISION.md standing policy).

## Constraints

- TypeScript pnpm monorepo; product logic concentrated in `src/resources/extensions/gsd` (1106 test files); Conventional Commits plus repo `no-mistakes(scope):` prefix per AGENTS.md.
- Existing gate/baseline scripts are binding constraints: `baseline:refactor:gate`, `baseline:refactor:phase0`, `legacy:cleanup:gate`, `legacy:cleanup:evidence`.
- End-user state lives outside the repo (`~/.gsd/projects/...`, per ADR-002) — migration touches live user data and must be idempotent and rollback-safe.
- AGENTS.md rules apply: honor CONTRIBUTING.md, clean branch from HEAD, test-writer skill with code changes, remove/update tests that asserted removed behavior, no full-repo suite on every tiny edit.
- Multi-worktree development is the norm in this repo (dozens of linked worktrees); concurrent-writer behavior must stay correct.

## Current state (brownfield only)

- **What exists**: Actively shipped pnpm monorepo (`@opengsd/gsd-pi` v1.11.0 on npm); product logic is the bundled `src/resources/extensions/gsd` extension (29 MB, 2214 files, 100+ `db-*-schema.ts` modules) over a vendored upstream `packages/` pi runtime; typecheck clean at HEAD (ade9db0e4). Both migrations — DB-authoritative state and extension modularization — are incomplete.
- **Must not break**: single-writer DB invariant; file projections keep rendering for anything that reads them; `verify:pr` strength; upstream-tracking vendored boundary (`verify:pi-boundary`, `verify:pi-patches`).
- **Doc-vs-code rulings** (recorded in DOCS-AUDIT.md `## User rulings`, 2026-08-01): vendored upstream `packages/pi-*` docs → accept-drift (overlay policy); `docs/dev/ci-cd-pipeline.md` → fix-doc (document manual publish); ADR-004/-009/-011/-013/-036 status labels → fix-doc (downgrade to reality); pi.opengsd.net configurator → verified live.
- **Ground truth**: `.project/research/evidence-codebase.md`, `.project/research/DOCS-AUDIT.md`

## Risks

<!-- What the user is most unsure about. Research prioritizes these. -->
- Hidden readers: anything reading projected state files as if authoritative (other extensions, external tools, user scripts) breaks silently at cutover — research must enumerate every read path.
- Thin telemetry: the proof that the legacy path is unused may be mush if usage data is sparse (user-flagged, 2026-08-01).
- Live-data migration: existing `~/.gsd` project state must migrate idempotently with backup and rollback; a bad migration corrupts real user projects.
- Downgrade story: if a cutover release is rolled back, the old binary must not strand DB-authored state unreadable.
- Concurrent writers: multiple worktrees/sessions writing project state during and after cutover must not violate the single-writer invariant.
- Gate retirement: inverting `semantic-shadow-no-cutover` must not silently drop the invariants it protects.

## Open questions

<!-- Unresolved at grill end. Tags: RESEARCH (research phase answers it),
     NEEDS-USER (a human decision, surface at next checkpoint). -->
- [RESEARCH] Complete inventory of legacy filesystem-state read paths, including external/tooling readers of projected files.
- [RESEARCH] What telemetry exists today to prove legacy-path usage is zero, and is it sufficient or must evidence collection be added first?
- [RESEARCH] Migration design for existing `~/.gsd` state: backup format, idempotency key, rollback procedure, downgrade compatibility window.
- [RESEARCH] Which invariants `semantic-shadow-no-cutover` protects and where each one lives post-cutover.
- [RESEARCH] Current phase status of the long-running refactor plan-of-plans relative to this milestone (what is already done vs. assumed done).
- [NEEDS-USER] Rollback tolerance: how many released versions must a downgrade stay readable for? — RULED 2026-08-01 ("your lean"): 2 stable releases + ≥60 days (ADR-046 window); recorded in SYNTHESIS.md ## User rulings

## Corrections

<!-- Verbatim user corrections from playback and later phases. Append-only.
     These are the highest-signal intent data in the file. -->
- 2026-08-01: "finish the state-DB cutover, modularize extensions, ship cloud phase N, kill dead scaffolding" — narrowed in round 2 to: "state-DB cutover"
- 2026-08-01: "gsd-cloud in this repo should be considered dead for now we need to plan to clean all old code out"
- 2026-08-01: "none" (no frozen surfaces — state-DB refactor and extension modularization may both be touched as needed, though modularization stays out of scope)
- 2026-08-10: The separately scoped unused legacy Cloud v1 cleanup completed. The 2026-08-01 quotes above are retained as provenance and no longer describe current scope.
