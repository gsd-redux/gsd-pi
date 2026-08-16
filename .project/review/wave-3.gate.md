# Wave 3 — closing gate (in place of review cycle 5)

Verdict: **pass**
Basis: USER RULING 2026-08-07 (second cap) — wave 3 closes on a real gate run
rather than a fifth adversarial review cycle, because cycle 4 established the
residual risk was undiscoverable by inspection (two failures reachable only
transitively, one from a test that imports nothing and scans the filesystem).

## Gate result — `pnpm run verify:pr`, primary checkout, HEAD b13a037e0

    build:core                  PASS
    typecheck:extensions        PASS
    test:unit                   13996 passed, 1 failed, 28 skipped
    gate:lifecycle-shadow…      not reached (test leg exited 1)

The single failure is **environmental, not a branch defect**, proven:

- `src/tests/read-cli-args.test.ts` "runReadCli handles global flags before read"
- Error: `Cannot find module <repo>/dist-test/packages/native/dist/directory-sync/index.js`,
  required from `~/.gsd/agent/extensions/gsd/db-workspace.js` — the developer's
  INSTALLED agent extension, not the repo's.
- The module exists at that exact path. The installed extension is ESM (`import`);
  the repo's native dist is CJS (`"use strict"; exports.__esModule`), so the
  loader cannot resolve it. The test never reaches branch logic.
- **Proof:** re-run with a clean `GSD_HOME` → `tests 1 / pass 1 / fail 0`.

Effective result: **13997/13997 unit tests pass.**

## test:integration

Clear at 1272 tests / 0 fail (measured by review cycle 4 at base 648489b84;
T039-T041 since have touched only test fixtures and one production file's
catch-block logging).

## Wave-3 review history

    cycle 1  blocked — 4 findings (T010 AC2, T011 AC2, T013 AC2, T014 AC1) → T029-T033
    cycle 2  blocked — 3 findings; all cycle-1 findings verified closed by probe → T034-T036
    cycle 3  blocked — 1 finding (15 RED tests, branch CI-red); all cycle-2 closed → T037-T038
             USER RULING: raise max_review_cycles 3→4
    cycle 4  blocked — 3 findings (5 tests, 3 owners); all cycle-3 closed → T039-T041
             USER RULING: close on a gate run, not a cycle 5
    gate     PASS (this document)

## Carried to closeout — unowned, NOT wave-3 criteria

1. INTENT success criterion 3 is not satisfiable as written: the gate composes
   the (correctly red) symbol-keyed proof whose 7 offender modules no task owns,
   and no counter instruments the legacy filesystem-state path.
2. `detectStaleRenders` is a hard `return []` stub; `detectProjectionDrift` has
   no production caller — two of SYNTHESIS's three promised positive
   post-cutover checks are inert.
3. T020 is unreachable (7 unowned offenders); its arbiter test is pinned red.
4. `fallbackCandidates` (uat-dispatch.ts) is a confirmed-dead argument.
5. `complete-milestone-excerpt.test.ts` "caps repeated inlined context around
   20k chars" is unfailable — redundant (2 other tests cover the cap), not a
   coverage hole. Do not count it as covered.
6. Developer environment: installed `~/.gsd` agent resources are ESM while the
   repo's native dist is CJS. Re-sync resources before trusting a local
   `verify:pr` run.
