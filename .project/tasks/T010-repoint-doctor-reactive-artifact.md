---
id: T010
title: Re-point doctor, reactive-graph, and artifact-verification consumers of parsers-legacy to DB reads
wave: 3
deps: [T007]
status: in-progress
agent: build_T010
commit: null
base: 40bdcfca4d1eea63fb1eb2d3198928c73d91fd37
worktree: .worktrees/gsd-path-T010
task_branch: gsd-path/T010
files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/doctor-state-checks.ts
  - src/resources/extensions/gsd/doctor-engine-checks.ts
  - src/resources/extensions/gsd/reactive-graph.ts
  - src/resources/extensions/gsd/artifact-verification.ts
  - src/resources/extensions/gsd/tests/doctor-empty-worktree.test.ts
  - src/resources/extensions/gsd/tests/doctor-fix-flag.test.ts
  - src/resources/extensions/gsd/tests/doctor-forensics-db-open-regression.test.ts
  - src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts
  - src/resources/extensions/gsd/tests/doctor-git-checks-terminal.test.ts
  - src/resources/extensions/gsd/tests/doctor-heal-fixable-warnings.test.ts
  - src/resources/extensions/gsd/tests/doctor-history-public-api.test.ts
  - src/resources/extensions/gsd/tests/doctor-orphan-milestone-4996.test.ts
  - src/resources/extensions/gsd/tests/doctor-providers.test.ts
  - src/resources/extensions/gsd/tests/doctor-runtime-checks.test.ts
  - src/resources/extensions/gsd/tests/doctor-scope-db-unavailable.test.ts
  - src/resources/extensions/gsd/tests/doctor-workspace.test.ts
  - src/resources/extensions/gsd/tests/reactive-graph.test.ts
  - src/resources/extensions/gsd/tests/dispatch-reactive-logs.test.ts
  - src/resources/extensions/gsd/tests/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/integration/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/plan-milestone-artifact-verification.test.ts
  - src/resources/extensions/gsd/tests/sidecar-artifact-verification.test.ts
---

# T010 — Re-point doctor / reactive-graph / artifact-verification to DB reads

## Context

Disposition class (a) per T004's inventory: these diagnostics/recovery
consumers re-point to DB-backed reads; their legacy markdown fallback
branches die with the path (class c). Post-cutover the project DB always
exists at schema v46, so "DB has no rows, parse the markdown instead" is a
dead branch. Specific current roles (from the importer-registry allowlist):
`doctor.ts` + `doctor-state-checks.ts` are diagnostics-only;
`doctor-engine-checks.ts` compares PLAN.md task checkboxes against DB
status; `reactive-graph.ts` has an explicit degraded-mode fallback when the
DB has no task rows (warns on use); `artifact-verification.ts` holds
recovery-path pre-migration/DB-unavailable fallback branches
(`verifyExpectedArtifact` extracted from auto-recovery.ts). The registry
test (`tests/parsers-legacy-importers.test.ts`) is reconciled by T016 — do
NOT edit it here; expect its stale-entry check to be red until then.

## Steps

1. Read each target file's actual `parsers-legacy` import sites (not just the
   allowlist comments).
2. `doctor.ts`, `doctor-state-checks.ts`: replace projection parses with the
   equivalent `gsd-db` query functions (`db/queries.ts`, e.g.
   `getMilestoneSliceSummaries`); diagnostics output shape must stay
   byte-identical.
3. `doctor-engine-checks.ts`: the PLAN-checkbox-vs-DB comparison reads the
   stamped projection as a *projection* (display compare), not as authority —
   re-point its parse to the relocated parser home IF T012 has landed;
   otherwise keep its existing parse and let T012/T013 retarget. Do not add
   a new `parsers-legacy` import anywhere.
4. `reactive-graph.ts`: delete the degraded-mode markdown fallback branch;
   DB-with-no-task-rows now yields an empty graph with the existing warning,
   never a markdown parse. Update `reactive-graph.test.ts` /
   `dispatch-reactive-logs.test.ts` accordingly.
5. `artifact-verification.ts`: delete the pre-migration/DB-unavailable
   fallback branches; verification reads the DB. Update
   `auto-recovery.test.ts`, `integration/auto-recovery.test.ts`,
   `plan-milestone-artifact-verification.test.ts`,
   `sidecar-artifact-verification.test.ts` — remove or invert assertions of
   markdown-fallback behavior (AGENTS.md: tests asserting removed behavior
   are removed or updated); keep DB-path coverage intact.
6. Update the twelve `doctor-*.test.ts` files only where they asserted
   fallback/markdown-derived behavior; do not rewrite tests wholesale.
7. Remove the `parsers-legacy` import from each of the five production files
   once unused. Grep each file to confirm zero remaining references.

## Acceptance criteria

1. None of the five production files imports or references `parsers-legacy`.
2. No markdown-fallback branch remains in reactive-graph or
   artifact-verification; doctor surfaces produce identical output from DB
   reads.
3. Updated tests pass; no test asserts the removed fallback behavior; DB-path
   coverage is not deleted.
4. `pnpm run baseline:refactor:phase0` stays green.

## Verify

```bash
! grep -n "parsers-legacy" src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/doctor-state-checks.ts src/resources/extensions/gsd/doctor-engine-checks.ts src/resources/extensions/gsd/reactive-graph.ts src/resources/extensions/gsd/artifact-verification.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/reactive-graph.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/doctor-runtime-checks.test.ts src/resources/extensions/gsd/tests/doctor-workspace.test.ts
```

## Log

- 2026-08-01 — created by planner
