---
id: T033
title: Re-key the legacy static proof and importer registry on parser symbols, not the module specifier
wave: 3
deps: [T015, T016, T028]
status: in-progress
agent: build_T033
commit: null
base: ac2717d34ed47a0170d8f1c767eea555daeb2fb9
worktree: .worktrees/gsd-path-T033
task_branch: gsd-path/T033
files:
  - scripts/legacy-state-path-proof.mjs
  - src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts
  - src/tests/legacy-cleanup-gate.test.ts
---

# T033 — Make the proof measure legacy parsing, not import paths

## Context

Fix task from wave-3 review cycle 1 (`.project/review/wave-3.cycle1.md`,
cross-cutting warnings). This is the review's highest-value finding and it
changes what this milestone can honestly claim. Verbatim:

> **The static proof and the importer registry both key on the `parsers-legacy`
> specifier, which wave 3 emptied by renaming the import path.** Seven production
> modules still parse legacy markdown via byte-identical functions at
> `schemas/parsers.js`. After T022, `legacy:cleanup:proof` will report zero
> offenders while the legacy read path is still in production use — INTENT success
> criterion 3 would be satisfied by a rename. Decide before wave 4 whether the
> proof must key on symbols.

> The registry now reads `parseLegacyRoadmap`/`parseLegacyPlan` or
> `schemas/parsers.js`'s legacy exports, not the shim's filename. This is the
> single largest gap between what a wave-3 Verify proves and what its criterion is
> read to claim.

USER RULING 2026-08-06: re-key on symbols. The gate going red again with ~7
offenders is the honest state, and T020's deletion gate becoming genuinely
unreachable until those modules are addressed was accepted explicitly at
decision time.

## Steps

1. Read the T015 and T016 sections plus the cross-cutting warnings in the review.
2. `legacy-state-path-proof.mjs`: key detection on the legacy parser SYMBOLS
   (`parseLegacyRoadmap`, `parseLegacyPlan`, and any other legacy export of
   `schemas/parsers.js` that parses projection markdown as a data source), not on
   the `parsers-legacy` module specifier. Keep specifier detection as an
   additional signal — a module importing the shim is still an offender.
3. Fix the two scanner defects the reviewer found while you are in the file:
   side-effect imports (`import './parsers-legacy.js';`, no `from`) and
   specifier-on-its-own-line forms are missed; block comments produce false
   positives.
4. Report the offender set accurately: expect roughly seven production modules.
   Do NOT add allowlist entries to make it green — a red proof is the correct
   output of this task.
5. `parsers-legacy-importers.test.ts`: apply the same symbol-keyed rule so the
   registry and the proof agree. The allowlist may grow to match reality; each
   entry needs a justification naming the task that will retire it, or `none`
   if unowned.
6. Update `legacy-cleanup-gate.test.ts` expectations to the symbol-keyed
   behaviour. Do not weaken the gate.

## Acceptance criteria

1. The proof reports a module as an offender when it parses legacy projection
   markdown via the relocated symbols, regardless of import path.
2. Side-effect and own-line import forms are detected; block comments no longer
   produce false positives.
3. Proof and registry agree on the offender set; the registry's entries each
   carry a justification or an explicit `none`.
4. The proof exits non-zero with the real offender list — greenness is NOT a
   criterion of this task.
5. Tests green.

## Verify

```bash
grep -q "parseLegacyRoadmap" scripts/legacy-state-path-proof.mjs && grep -q "parseLegacyPlan" scripts/legacy-state-path-proof.mjs && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts src/tests/legacy-cleanup-gate.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 1 (cross-cutting warning 1); user ruled re-key on symbols, accepting that the gate goes red and T020 becomes unreachable until the seven modules are addressed
