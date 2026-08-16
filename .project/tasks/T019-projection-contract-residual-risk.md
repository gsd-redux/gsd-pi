---
id: T019
title: Freeze projection format; document projections as de facto public API; record accepted residual risks
wave: 3
deps: [T002, T003, T008]
status: done
agent: build_T019
commit: c48bb87d174a3b74bbed9e1c14579f348d8fe697
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
- 2026-08-02 — coder (build_T019): both docs written, no code touched.
  (1) New `docs/dev/state-db-cutover-projection-contract.md` with five
  sections: §1 read-only-projection rule (writers through DB, readers not
  authority, drift heals by re-render; `write-intercept.ts` blocks direct
  STATE.md/gsd.db writes); §2 frozen inventory built from the actual
  renderer/path code, not assumed — `GSD_ROOT_FILES` (`paths.ts:352`) for the
  eight `.gsd/` root files plus legacy lowercase names, and a two-layout table
  (flat-phase `phases/NN-slug/NN-ROADMAP.md`, `NN-MM-PLAN.md`,
  `NN-MM-<TYPE>.md`, `SID-TID-SUMMARY.md` vs legacy
  `milestones/MID/…/slices/SID/…/tasks/TID-SUMMARY.md`), naming derived from
  `layout-policy.ts` `phaseDirName`/`planFileName` and
  `paths.ts` `targetMilestoneFile`/`targetSliceFile`/`targetTaskFile`, with
  the ten `writeAndStore` render entry points listed; §3 stamp contract —
  exact `<!-- gsd:state-version=<projectRevision>:<authorityEpoch> -->`, EOF
  position, canonical regex, `project_authority` singleton source with the
  `0:0` fallback, strip-then-stamp byte stability, ignore-safe reader rule
  (HTML comment; strip via `stripProjectionStamp` before any content diff),
  and the stamp-insensitive drift rule; §4 de facto public API + "future
  versioning requires its own milestone"; §5 the three external reader
  surfaces with line-level evidence (`mcp-server/src/server.ts:278,308,1486`;
  `daemon/src/local-tool-executor.ts:285,322`;
  `integrations/hermes/docs/setup.md:35,235` + its `.gsd/STATE.md` fixture).
  (2) Accuracy correction worth flagging for the reviewer: the task Context
  lists STATE.md in the stamped inventory, but STATE.md is written by
  `workflow-projections.ts:renderStateProjection` via `atomicWriteSync`, NOT
  through `markdown-renderer.ts:writeAndStore`, so it is unstamped — as are
  DECISIONS.md and `.planning/` (consistent with T008's own scope note). §2.1
  and §3.4 record this explicitly so readers treat "no stamp" as normal rather
  than as tampering; STATE.md remains in the frozen inventory, just not in the
  stamped subset. No contradiction with an acceptance criterion — AC1 asks for
  the inventory and the stamp format, both present.
  (3) Appended `## Accepted residual risks` to
  `docs/dev/state-db-cutover-milestone-decision.md` (before the gate-retirement
  section) with all four risks — R1 no field telemetry (static proofs +
  fail-closed shims, explicitly "mitigation, not proof"); R2 unobservable
  out-of-repo readers (byte-compatible freeze; residual exposure limited to
  markdown *writers*); R3 T003's observed skew behavior recorded as observed —
  silent divergence, not corruption, with the four probe outcomes and the
  upgrade-all-linked-worktrees release-note directive; R4 hermes coupling depth
  unverified, moot under the freeze, reopened by any future format-versioning
  milestone — plus a closing `### Downgrade window` subsection.
  (4) Both docs quote ADR-046 verbatim ("two stable releases and at least 60
  days, whichever is longer, beginning when Import Preview and Import
  Application ship", `ADR-046.md:257-258`) and restate the ruling as
  2 stable releases + ≥60 days (ADR-046 window, user ruling 2026-08-01).
  Verify: the five-clause grep chain ran in the worktree, exit 0.
  Changed paths: `docs/dev/state-db-cutover-projection-contract.md` (new),
  `docs/dev/state-db-cutover-milestone-decision.md`, this Log.
- 2026-08-05 — orchestrator Verify rerun (authoritative, isolated worktree):
  exit 0 — all five clauses present (stamp format, de-facto-public-API clause,
  accepted-residual-risks section, and both ADR-046 window terms). Diff scope
  check: 2 declared files (one new, docs/dev/state-db-cutover-projection-
  contract.md) plus the task file; zero paths outside `files`.
