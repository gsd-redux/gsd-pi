---
id: T021
title: Delete ADR-046-timeboxed witnesses and unadopted import/reconcile compatibility paths (timebox-gated)
wave: 4
deps: [T009, T012]
status: done
agent: null
commit: null
base: 75397cca5
worktree: null
task_branch: fix/wave-4-legacy-path-deletion
files:
  - src/resources/extensions/gsd/tests/md-importer-adopted-authority.test.ts
  - src/resources/extensions/gsd/tests/workflow-reconcile.test.ts
  - src/resources/extensions/gsd/tests/semantic-shadow-contract.test.ts
  - src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts
  - scripts/lifecycle-shadow-no-cutover-gate.mjs
  - src/resources/extensions/gsd/md-importer.ts
  - src/resources/extensions/gsd/workflow-reconcile.ts
---

# T021 — Delete timeboxed witnesses + unadopted import/reconcile compatibility (TIMEBOX-GATED)

## Context

Gate retirement disposition class (d): the unadopted-import witness
(`md-importer-adopted-authority.test.ts` — "unadopted re-import keeps
existing checkbox completion behavior"), the unadopted-reconcile witness
(`workflow-reconcile.test.ts` — "unadopted legacy Milestone completion
remains an explicit reconciliation compatibility path"), and the frozen
cross-mode response witnesses (`semantic-shadow-contract.test.ts`,
`semantic-shadow-mode-matrix.test.ts`) are deleted on the ADR-046 timebox —
the same ruled window (2 stable releases + ≥60 days post-cutover release).
These witnesses assert legacy-wins compatibility behavior that exists only
to bridge pre-cutover projects; per AGENTS.md, removing the behavior means
removing the tests that asserted it. T009 kept them running under the
successor gate with a timebox comment; this task removes them, the
underlying compatibility code paths, and their gate entries. This task
MUST NOT land before the window elapses.

## Steps

1. Confirm the window has elapsed; record release tags/dates in the Log.
   If not elapsed, STOP.
2. Delete the four test files.
3. Remove the unadopted-import compatibility path in `md-importer.ts`
   (the branch that preserves checkbox completion for unadopted re-import)
   and the unadopted-reconcile compatibility path in
   `workflow-reconcile.ts`. Read both files first; remove ONLY the
   unadopted compatibility branches — the adopted/import path and the rest
   of the reconcile logic stay.
4. In `scripts/lifecycle-shadow-no-cutover-gate.mjs`, remove the four
   witness entries (frozen-public-response, mode-transport-matrix,
   unadopted-import, unadopted-reconcile) and their
   `ADR-046 timebox` comments; the successor gate now carries only the
   permanent lifecycle-shadow witnesses.
5. Grep for references to the deleted test files and removed branches
   across scripts/, package.json, and docs; update any that point at them.
6. `pnpm run gate:lifecycle-shadow-no-cutover` and `pnpm run test:unit`
   must be green.

## Acceptance criteria

1. The four test files are gone; the successor gate no longer references
   them and passes.
2. The unadopted import/reconcile compatibility branches are deleted from
   production code; adopted-path behavior is unchanged.
3. No dangling references to the deleted files or branches.
4. `pnpm run verify:pr` green; the Log records window-elapsed evidence.

## Verify

```bash
test ! -f src/resources/extensions/gsd/tests/md-importer-adopted-authority.test.ts && test ! -f src/resources/extensions/gsd/tests/workflow-reconcile.test.ts && test ! -f src/resources/extensions/gsd/tests/semantic-shadow-contract.test.ts && test ! -f src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts && ! grep -q "unadopted-import\|unadopted-reconcile\|frozen-public-response\|mode-transport-matrix" scripts/lifecycle-shadow-no-cutover-gate.mjs && pnpm run gate:lifecycle-shadow-no-cutover
```

## Log

- 2026-08-01 — created by planner
- 2026-08-12 — same timebox waiver as T020. Deleted the four timeboxed test files. Removed unadopted checkbox-overwrite (md-importer) and unadopted state-event replay (workflow-reconcile). Successor gate no longer lists frozen-public-response / mode-transport-matrix / unadopted-import / unadopted-reconcile. `pnpm run gate:lifecycle-shadow-no-cutover` → PASS Structural 7/7 Behavioral 11/11.
