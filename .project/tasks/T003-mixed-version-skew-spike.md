---
id: T003
title: "Spike: run a pre-cutover binary against a cut-over project fixture and record observed behavior"
wave: 1
deps: []
status: done
agent: build_T003
commit: 2946a0f7ef6a433641b6e33c9c94a46aeb8ab0d9
base: 254f51d046caa5863956f350210749b6daab680c
worktree: .worktrees/gsd-path-T003
task_branch: gsd-path/T003
files:
  - docs/dev/state-db-cutover-mixed-version-spike.md
---

# T003 — Spike: pre-cutover binary vs. cut-over project fixture

## Context

SYNTHESIS.md rates the mixed-version concurrent-writer decision LOW
confidence: the skew scenario (a pre-cutover released binary opening a
project whose `gsd.db` has been cut over by a newer binary) is inferred, not
tested. Multi-worktree development is the norm in this repo (dozens of linked
worktrees per INTENT.md constraints), so the scenario is realistic. The
expected mechanism: the cutover rides the `migrateSchema` chain
(`src/resources/extensions/gsd/db/engine.ts`, `SCHEMA_VERSION = 45`), so a
cut-over project's DB carries a schema version the old binary refuses with
`gsd.db schema is vN, newer than the vM this gsd-pi supports`
(engine.ts:455-460). This spike verifies that expectation empirically and
records what actually happens — read-only, loud refusal, silent divergence,
or projection corruption. No production code changes; all work happens in
disposable worktrees and temp dirs.

## Steps

1. In a disposable git worktree (`.worktrees/spike-mixed-version`), check out
   the latest released tag (v1.11.0) and build it
   (`pnpm install --frozen-lockfile --ignore-scripts && pnpm run build:core`).
2. Create a fixture project in `$(mktemp -d)`: a minimal git repo with a
   `~/.gsd`-style project state dir. At current HEAD, use the existing test
   helpers (see `src/resources/extensions/gsd/tests/project-authority-cutover.test.ts`
   and `tests/migrate-external-worktree.test.ts` for fixture patterns) to
   produce a `gsd.db` whose `schema_version` is one version ABOVE what the
   v1.11.0 binary supports (simulating the post-cutover V46), plus rendered
   markdown projections. A small throwaway script is fine; do NOT commit it.
3. Point the v1.11.0 binary at the fixture project (honor the
   `.gsd → ~/.gsd/projects/<hash>/` symlink layout per ADR-002) and attempt,
   in order: `gsd` status/state read, a state-mutating command (e.g. milestone
   status), and a render/projection write. Record exact stdout/stderr and
   exit codes for each.
4. Inspect the fixture afterwards: is `gsd.db` unchanged (sha256 before/after)?
   Are the markdown projections unchanged? Classify observed behavior as
   exactly one of: `loud refusal`, `read-only`, `silent divergence`,
   `corrupts projections`, or `other (describe)`.
5. Write `docs/dev/state-db-cutover-mixed-version-spike.md` with: both binary
   versions, fixture construction summary, per-command transcript excerpts,
   before/after hashes, the classification line
   `observed behavior: <classification>`, and a recommendation confirming or
   amending the synthesis guard (refuse-newer floor + release-note directive
   to upgrade all linked worktrees together). Delete the disposable worktree
   and temp dirs.

## Acceptance criteria

1. `docs/dev/state-db-cutover-mixed-version-spike.md` exists with a line
   matching `observed behavior: (loud refusal|read-only|silent divergence|corrupts projections|other)`.
2. The report includes before/after sha256 of `gsd.db` and of at least one
   projection file, and per-command exit codes.
3. If observed behavior is `silent divergence` or `corrupts projections`, the
   report names the guard change required and the task Log marks the plan
   assumption amended (wave-2 tasks T005/T006 must be re-scoped before they
   start).
4. No committed files other than the spike report; no disposable worktrees
   left behind.

## Verify

```bash
grep -qE "observed behavior: (loud refusal|read-only|silent divergence|corrupts projections|other)" docs/dev/state-db-cutover-mixed-version-spike.md && grep -qi "sha256" docs/dev/state-db-cutover-mixed-version-spike.md
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — coder: spike executed. Built v1.11.0 (SCHEMA_VERSION 31) in a
  disposable worktree (relocated to `$(mktemp -d)` — inside `gsd-pi/.worktrees/**`
  the build's module resolution leaks into the primary checkout's `dist` and
  fails; documented in the report). Fixture project at schema v32 built with
  v1.11.0's own compiled modules (ADR-002 symlink layout, seeded M001/S01/T01,
  rendered ROADMAP + PLAN projections, `recordSchemaVersion(db, 32)`).
  Probes: `headless query` exit 0 with degraded empty state (active milestone
  invisible, generic "DB unavailable" blocker); `read progress --json` exit 0
  all-zero, no error at all; `headless recover` exit 1 with generic
  "failed to open" (refuse-newer reason swallowed); `graph build` exit 0 and
  WROTE a new empty `.gsd/graphs/graph.json` without consulting the DB version.
  sha256 before/after identical for `gsd.db` and both projections; only the
  new graph.json appeared. Engine floor confirmed via direct probe
  (`gsd.db schema is v32, newer than the v31 this gsd-pi supports`).
  Classification: **silent divergence** (reads exit 0 with wrong state;
  projection writer bypasses the floor; only the rebuild path fails, quietly
  generic). Report: `docs/dev/state-db-cutover-mixed-version-spike.md`.
  PLAN ASSUMPTION AMENDED per acceptance criterion 3: the refuse-newer floor
  exists at engine level but is not surfaced — wave-2 tasks T005/T006 must be
  re-scoped before they start to cover read-seam surfacing, projection-write
  version gating, and error propagation on rebuild paths.
  Verify: PASS. Disposable worktree and temp dirs removed; no committed files
  other than the spike report.
