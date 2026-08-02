---
id: T026
title: Fix legacy-import restore-assessment future-schema test after the V46 pin advance (unsupported fixture moves v46→v47)
wave: 2
deps: [T005]
status: done
agent: build_T026
commit: 13e9bae14f32a5c7938c630db46fa32298ab6ecd
base: 95bc1a5d035bfb664b9553ad9996facc1b1ea9f1
worktree: .worktrees/gsd-path-T026
task_branch: gsd-path/T026
files:
  - src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts
---

# T026 — Restore-assessment unsupported-schema test realignment (T005 pin-advance fallout)

## Context

T005's V46 pin advance (integrated, commit
`92ce63b209d651772f27f4618e1a6329e222b559`) made schema 46 the CURRENT
supported schema (`SCHEMA_VERSION = 46`,
`LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 46`). One test outside T005's
expanded files list broke: in
`src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts`,
the test "unsupported database schema refuses before backup inspection"
(~line 516) simulates an unsupported future schema by inserting
`schema_version` row 46 — which is now SUPPORTED, so the assessment no
longer refuses at the `authority` stage and instead reaches the `backup`
stage (the test removes the backup ref, producing a `backup`-stage
refusal). Confirmed red at primary HEAD: 14 pass / 1 fail, `actual:
'backup'`, `expected: 'authority'`. The production code is correct — the
assessment refuses whenever observed schema ≠ `SCHEMA_VERSION`
(`legacy-import-restore-assessment.ts` `unsupportedSchemaAssessment`,
`expectedDatabaseSchemaVersion: SCHEMA_VERSION`); only the test's
future-schema simulation is stale. This mirrors the corpus realignment T005
already shipped (db-target-matrix future moved v46→v47). This file is
cross-wave shared with T014 (wave 3, layered): this task makes ONLY the
version-simulation fix; T014 retains feature ownership.

## Steps

1. In `src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts`,
   test "unsupported database schema refuses before backup inspection":
   the unsupported-schema simulation must be one version ABOVE supported,
   not a hardcoded literal that goes stale on every pin advance.
   a. Add `SCHEMA_VERSION` to the imports from `../db/engine.ts` (same
      source the assessment module itself uses).
   b. Change the INSERT from `VALUES (46, ...)` to
      `VALUES (${SCHEMA_VERSION + 1}, ...)` (use a template interpolation
      or a `const unsupportedVersion = SCHEMA_VERSION + 1;` bound
      parameter — pick ONE, matching the file's existing style).
   c. Change the assertion `observedDatabaseSchemaVersion, 46` to expect
      the same `SCHEMA_VERSION + 1` value.
   d. All other assertions in the test (`decision: "refused"`,
      `stage: "authority"`, `reasonCode: "DATABASE_SCHEMA_UNSUPPORTED"`)
      stay EXACTLY as they are — the test's intent is unchanged.
2. No other test in the file references v46/v47 (verified by grep at
   planning time: only lines 519 and 524) — do not touch anything else in
   the file, and do NOT touch the corpus fixtures (T005's, done) or any
   production file.

## Acceptance criteria

1. The test file runs 15/15 green at primary HEAD, including
   "unsupported database schema refuses before backup inspection"
   (`stage: "authority"`, `reasonCode: "DATABASE_SCHEMA_UNSUPPORTED"`,
   `observedDatabaseSchemaVersion = SCHEMA_VERSION + 1`).
2. The future-schema simulation is expressed relative to `SCHEMA_VERSION`
   so the next pin advance does not re-break it.
3. Diff touches only
   `src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts`.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts 2>&1 | tee /tmp/t026-verify.out && grep -q "# pass 15" /tmp/t026-verify.out && grep -q "# fail 0" /tmp/t026-verify.out && grep -q "SCHEMA_VERSION + 1" src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts
```

## Log

- 2026-08-02 — created by planner (T005 block-repair follow-up: one test file escaped T005's expanded files list; isolated here rather than re-opening the done T005, keeping T005's integrated commit untouched).
- 2026-08-02 — coder: imported `SCHEMA_VERSION` from `../db/engine.ts`; future-schema simulation in "unsupported database schema refuses before backup inspection" re-expressed as `SCHEMA_VERSION + 1` (INSERT via template interpolation, matching the file's existing inline-SQL style; assertion updated to the same expression). All other assertions untouched. Verify: green — 15 pass / 0 fail, `SCHEMA_VERSION + 1` present (Node 24 defaults to the spec reporter, so Verify was run with `NODE_OPTIONS="--test-reporter=tap"` to match the contract's TAP greps; semantics unchanged). Diff touches only the listed test file.
