---
id: T031
title: Revert the unsound drift stamp short-circuit and delete the test pinning its silent pass
wave: 3
deps: [T013]
status: in-progress
agent: build_T031
commit: null
base: ac2717d34ed47a0170d8f1c767eea555daeb2fb9
worktree: .worktrees/gsd-path-T031
task_branch: gsd-path/T031
files:
  - src/resources/extensions/gsd/state-reconciliation/drift/roadmap.ts
  - src/resources/extensions/gsd/state-reconciliation/drift/stale-render.ts
  - src/resources/extensions/gsd/tests/state-reconciliation-drift.test.ts
---

# T031 — Revert the stamp short-circuit (user ruling 2026-08-06)

## Context

Fix task from wave-3 review cycle 1 (`.project/review/wave-3.cycle1.md`, T013
section). Verbatim failed criterion:

> ❌ AC2 — the stamp short-circuit is unsound: the only production writer of
> `project_authority.revision` is the CAS at `db/domain-operation.ts:1176`, and
> slice mutations don't go through it, so a stale ROADMAP keeps a matching stamp
> and divergence is declared absent. The new test at
> `state-reconciliation-drift.test.ts:1671-1735` deliberately writes a diverging
> fixture, forges a current stamp, and asserts no drift — pinning the silent pass.
> It also directly contradicts the invariant T008 stated at
> `markdown-renderer.ts:1160-1166`. Separately, the `stale-render.ts` filter runs
> over `detectStaleRenders`, which is a hard `return []` stub.

A test that forges a stamp to assert no-drift is the same anti-pattern as the
`idle-recovery` "lenient" test T010 inverted: a silent pass pinned as intended
behaviour.

USER RULING 2026-08-06: revert the short-circuit and delete the pinning test.
Rationale recorded at decision time: it is the smallest correct change, it
loses only an optimisation, and T013's real deliverable — the drift detectors
re-homed off `parsers-legacy` — survives untouched. The alternative (making
slice mutations bump `project_authority.revision`) was rejected as too large a
write-path change to make mid-wave with the wave already blocked.

## Steps

1. Read the T013 section of the review in full.
2. `drift/roadmap.ts` and `drift/stale-render.ts`: remove the
   `getCurrentProjectStateVersion()` stamp fast-path so both detectors go back
   to content comparison unconditionally. Keep the `schemas/parsers.js` imports
   T013 landed — the re-homing is correct and is NOT reverted.
3. Delete the test at `state-reconciliation-drift.test.ts:1671-1735` that forges
   a current stamp on a diverging fixture and asserts no drift. Do not replace
   it with a weaker assertion; the behaviour it pinned is a defect.
4. Leave `detectStaleRenders`'s `return []` stub alone — it is pre-existing and
   out of scope here; the review records it separately for closeout.

## Acceptance criteria

1. Neither detector short-circuits on a state-version stamp; both compare
   content on every call.
2. The forged-stamp no-drift test is gone; no remaining test asserts that a
   diverging projection with a current stamp is drift-free.
3. The `parsers-legacy` → `schemas/parsers.js` re-homing from T013 is intact
   (zero `parsers-legacy` references under `state-reconciliation/drift/`).
4. `state-reconciliation-drift.test.ts` and `roadmap-slices.test.ts` green.

## Verify

```bash
! grep -rn "parsers-legacy" src/resources/extensions/gsd/state-reconciliation/drift/ && ! grep -rn "getCurrentProjectStateVersion" src/resources/extensions/gsd/state-reconciliation/drift/ && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/state-reconciliation-drift.test.ts src/resources/extensions/gsd/tests/roadmap-slices.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 1 (T013 AC2 failure); user ruled revert-and-delete over root-cause revision bump
