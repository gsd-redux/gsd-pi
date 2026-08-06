---
id: T019
title: Freeze projection format; document projections as de facto public API; record accepted residual risks
wave: 3
deps: [T002, T003, T008]
status: in-progress
agent: build_T019
commit: null
base: 291e71c154aac359be01cc38a34dccd992ab47b4
worktree: .worktrees/gsd-path-T019
task_branch: gsd-path/T019
files:
  - docs/dev/state-db-cutover-projection-contract.md
  - docs/dev/state-db-cutover-milestone-decision.md
---

# T019 — Projection contract doc + residual-risk record

## Context

The projection layer is a de facto public API: `@opengsd/mcp-server`
readers, `packages/daemon`, and `integrations/hermes` treat STATE.md
parsing and PLAN/SUMMARY existence as ground truth, and the
`.gsd → ~/.gsd/projects/<hash>/` symlink means the full reader set is
unobservable from the repo. The format is FROZEN for this milestone
(SYNTHESIS.md): byte-compatible with pre-cutover, additive-only
(`<!-- gsd:state-version=R:E -->` stamp, landed in T008). Residual risks to
record honestly (synthesis: "do not promise proof that cannot exist"): no
field telemetry for the installed base; the unobservable out-of-repo reader
set; mixed-version worktree skew bounded by the downgrade window plus a
release-note directive to upgrade all linked worktrees together (T003
recorded the observed skew behavior).

## Steps

1. Write `docs/dev/state-db-cutover-projection-contract.md`: (a) the
   projection files are read-only projections of DB state — writers MUST
   go through the DB, readers MUST NOT treat projections as authority;
   (b) the frozen format inventory — which files exist (STATE.md, PLAN,
   SUMMARY, ROADMAP, etc. per the actual renderer), their locations, and
   the byte-compatibility commitment for this milestone; (c) the additive
   stamp contract: exact format `<!-- gsd:state-version=<projectRevision>:<authorityEpoch> -->`
   at end of file, how readers should treat it (ignore-safe), how drift
   detection uses it; (d) the explicit statement that this layer is a de
   facto public API and any future versioning requires its own milestone;
   (e) the known external reader surfaces
   (`@opengsd/mcp-server`, `packages/daemon`, `integrations/hermes`).
2. Append to `docs/dev/state-db-cutover-milestone-decision.md` (created by
   T002) a `## Accepted residual risks` section: no field telemetry for
   the installed base (static proof + fail-closed shims instead);
   unobservable out-of-repo readers (mitigated by the byte-compatible
   freeze); T003's observed mixed-version skew behavior and its bounded
   residual risk with the upgrade-all-worktrees release-note directive;
   hermes (Python) coupling depth unverified — accepted because the
   format freeze makes it moot for this milestone.
3. Both docs must state the downgrade window verbatim: 2 stable releases +
   ≥60 days (ADR-046 window, user ruling 2026-08-01).

## Acceptance criteria

1. The contract doc names the stamp format exactly, the frozen file
   inventory, the read-only-projection rule, and the three external reader
   surfaces.
2. The decision doc's `## Accepted residual risks` section records all
   four residual risks with their mitigations.
3. Both docs cite the downgrade window verbatim.

## Verify

```bash
grep -q "gsd:state-version=" docs/dev/state-db-cutover-projection-contract.md && grep -q "de facto public API" docs/dev/state-db-cutover-projection-contract.md && grep -q "## Accepted residual risks" docs/dev/state-db-cutover-milestone-decision.md && grep -q "2 stable releases" docs/dev/state-db-cutover-milestone-decision.md && grep -q "60 days" docs/dev/state-db-cutover-milestone-decision.md
```

## Log

- 2026-08-01 — created by planner
