---
id: T027
title: Realign stale schema-version literals and stamp-era byte expectations so verify:pr's test:unit leg is green at HEAD (wave-2 review cycle-1 T009F1)
wave: 2
deps: [T005, T008]
status: in-progress
agent: build_T027
commit: null
base: 8560139d8d932d3a32837b78324335124f77e282
worktree: .worktrees/gsd-path-T027
task_branch: gsd-path/T027
files:
  - src/resources/extensions/gsd/tests/db-authority-recovery-schema.test.ts
  - src/resources/extensions/gsd/tests/db-lifecycle-foundation.test.ts
  - src/resources/extensions/gsd/tests/db-milestone-reopen-schema.test.ts
  - src/resources/extensions/gsd/tests/db-milestone-completion-schema.test.ts
  - src/resources/extensions/gsd/tests/gsd-rebuild.test.ts
  - src/resources/extensions/gsd/tests/migrate-safety-audit.test.ts
---

# T027 — test:unit-leg realignment (carries T009 AC5; review cycle-1 fix T009F1)

## Context

Wave-2 review cycle 1 (`.project/review/wave-2.cycle1.md`) verdict: **blocked**
on exactly one finding — T009 AC5 ("`pnpm run verify:pr` green at the task
commit") fails because `test:unit` has deterministically red tests at HEAD,
all confirmed NOT caused by T009's diff (they fail identically at its base;
attribution confirmed by re-runs at T008's base `37aedafb`). Observed
evidence, verbatim from the review:

- `db-authority-recovery-schema.test.ts:256` — "a fresh v45 database exposes
  the minimum authority recovery receipts" and "a genuine v44 migration backs
  up, rolls back on fault, and retries without data loss"
  (`assert.equal(SCHEMA_VERSION, 45)` vs 46 — T005 V46 fallout; file unowned
  by any wave-2 task).
- `db-lifecycle-foundation.test.ts:501` — "v40 upgrade authorizes Slice
  cancellation in both Attempt settlement triggers" (expects
  `databaseSchemaVersion`/`runtimeSchemaVersion` 45, got 46 — same T005
  fallout; sibling v42/v43 tests in this file also fail 46!==45 under
  full-run load, passing in isolation).
- `gsd-rebuild.test.ts:160` — "handleRebuild re-renders missing task summary
  projections from DB" (expects unstamped bytes
  `# T01 Summary\n\nRendered from DB.\n`, actual carries
  `<!-- gsd:state-version=0:0 -->` — T008 stamp fallout; green at T008's
  base, confirmed).
- `migrate-safety-audit.test.ts:4560` — "managed-output history removes
  artifacts rendered between migration attempts" ("conflicting canonical
  projection representations at milestones/M001/M001-CONTEXT.md",
  `migrate/audit.js:299` — T008 stamp-era fallout; green at T008's base,
  confirmed).

Planner sweep at HEAD (2026-08-02) found the review's enumeration incomplete
— two more files red in the same defect class (confirmed red at HEAD via the
source runner, 26 pass / 3 fail across the pair; likely masked as
native-lock noise in the reviewer's compiled-tier chunks):
`db-milestone-reopen-schema.test.ts:218` ("a genuine v43 database gains
hierarchy reopen authorization on upgrade") and
`db-milestone-completion-schema.test.ts:176` ("v43 authorizes only
milestone.complete for Milestone ready-to-completed") + one sibling ("a
genuine v42 database gains the narrow Milestone completion authorization on
upgrade") — all `assert.equal(SCHEMA_VERSION, 45)` /
`assert.equal(schemaVersion(db), 45)` literals. All six files are UNOWNED by
any task (checked against every task files list). Root cause is the repeat
offender the review flagged: T005's V46 bump and T008's projection stamp
changed repo-wide semantics faster than the stale-literal inventory tracked.
Fix pattern is the settled T026 one: express version expectations relative
to `SCHEMA_VERSION`, never as literals that re-stale on the next bump.

## Steps

1. `db-authority-recovery-schema.test.ts` (:256, :501): the tests assert a
   FRESH/migrated database's receipts — the intent is "at the CURRENT
   schema", not "at v45". Replace `assert.equal(SCHEMA_VERSION, 45)` guards
   and any paired `schemaVersion(db), 45` expectations with
   `SCHEMA_VERSION`-relative assertions (`schemaVersion(db) === SCHEMA_VERSION`;
   delete bare `SCHEMA_VERSION === <literal>` guards that assert nothing
   about behavior, or convert them to a comment). Leave
   `base_database_schema_version: 45` at :152 alone IF its test is green —
   evaluate whether it constructs a deliberately-historical fixture (keep)
   or a stale current-schema assumption (make relative); record the decision
   in the Log. Do not rename tests wholesale; adjust names only where a
   "v45" in the name now misdescribes the fixture (e.g. "a fresh v45
   database" on a fresh-current-schema DB) — each rename in the Log.
2. `db-lifecycle-foundation.test.ts` (:501 v40 test + the v42/v43
   load-sensitive siblings + the `runtimeSchemaVersion: 45` /
   `databaseSchemaVersion: 45` expectation at :1346-1347): every "45" that
   means "current schema after migration" becomes `SCHEMA_VERSION`
   (imported from `../db/engine.ts` or the file's existing gsd-db import —
   match the file's convention). Genuine historical-version literals (a v40
   fixture STARTS at 40) stay literal — only post-migration expectations
   move.
3. `db-milestone-reopen-schema.test.ts:218` and
   `db-milestone-completion-schema.test.ts:176` (+ the v42 sibling): same
   treatment — the DB was just migrated to current, so
   `schemaVersion(db) === SCHEMA_VERSION`; drop or relativize the bare
   `SCHEMA_VERSION, 45` guard. Keep the historical seed versions literal.
4. `gsd-rebuild.test.ts:160`: the rebuild now re-renders WITH T008's
   `<!-- gsd:state-version=R:E -->` stamp line — that is the correct new
   behavior. Update the expected bytes to the stamped form (follow how
   `markdown-renderer.test.ts` / `projection-fidelity.test.ts` assert
   stamped output — stamp-aware expectations, not string surgery that
   strips the stamp before comparing, unless the test's intent is purely
   the pre-stamp body; pick ONE and record why in the Log).
5. `migrate-safety-audit.test.ts:4560`: the audit compares canonical
   projection representations and now trips on stamped re-renders. Choose
   the SEMANTICALLY HONEST fix with evidence, not the quietest one:
   (a) if the audit's canonical-representation check SHOULD ignore the
   stamp line (the stamp is metadata, not content divergence), make the
   comparison stamp-insensitive at the CHECK site only if that check's code
   is in this task's files — it is NOT (`migrate/audit.js` is production,
   unowned) — so instead (b) update the test's fixture/expectation so both
   compared representations carry the same stamp (re-render through the
   current renderer rather than hand-writing unstamped bytes), preserving
   the test's original intent (history removes inter-attempt artifacts).
   If (b) is impossible without weakening the audit's intent, STOP and
   block with the evidence — do NOT weaken `migrate/audit.js` or the
   check.
6. SWEEP (review recommendation, explicit): grep the full test surface for
   remaining stale literals and unstamped exact-byte projection assertions:
   `grep -rn "SCHEMA_VERSION, 45" src --include="*.test.ts"`,
   `grep -rn "version: 45\b" src --include="*.test.ts"`, and render-output
   assertions lacking `gsd:state-version`. Planner pre-sweep result: after
   steps 1–3 the only remaining `version: 45` hits are legitimate
   historical fixtures (`db-authority-recovery-schema.test.ts:152`
   pending step-1 evaluation; `legacy-import-preview-database-target.test.ts:969`
   `historical-v45` — legitimate, historical-v45 IS the historical fixture
   post-realignment, DO NOT touch; that file is T005's, done). Exact-byte
   sweep found no further unstamped projection assertions beyond the two
   files fixed in steps 4–5 (the review's full 1177-file compiled-tier run
   corroborates). If YOUR sweep finds additional red hits in files NOT in
   this task's files list: check ownership against every `.project/tasks/`
   files list — if owned by a pending task (T010–T023), STOP and block with
   the file list; if unowned, you may fix it, append it to this task's
   files list, and record the failure output in the Log.
7. Full gate: run this task's Verify. Note the reviewer's documented
   environmental exclusions (wave-2 review AC5): run the compiled tier with
   CI's addon mirror (`dist-test/native/addon`) + `GSD_NATIVE_PREFER_LOCAL=1`
   and an isolated `GSD_HOME` (the machine-global stale `~/.gsd/agent`
   bundle reds `read-cli-args` regardless of repo state); the 300s cap may
   require chunking — record exactly what was run in the Log.

## Acceptance criteria

1. All six named test files green at HEAD (source runner AND compiled
   tier): zero `46 !== 45` assertion failures, zero unstamped-byte
   failures, zero canonical-representation conflicts.
2. Every changed version expectation is `SCHEMA_VERSION`-relative or a
   deliberately-historical literal with its reason visible; no bare
   `SCHEMA_VERSION, 45` literals remain in `src/**` test files (grep
   proof).
3. `gsd-rebuild` / `migrate-safety-audit` fixes preserve each test's
   original intent (stamp is the correct new behavior; the audit check is
   not weakened); the chosen approach + evidence is in the Log.
4. `pnpm run test:unit` (= `test:compile && test:unit:compiled`) exit 0 at
   HEAD, environmental exclusions per step 7 documented — T009 AC5's
   test:unit leg satisfied.
5. Diff touches only files in this task's files list; `verify:pr` not
   weakened anywhere (no script, threshold, skip, or gate change).

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-authority-recovery-schema.test.ts src/resources/extensions/gsd/tests/db-lifecycle-foundation.test.ts src/resources/extensions/gsd/tests/db-milestone-reopen-schema.test.ts src/resources/extensions/gsd/tests/db-milestone-completion-schema.test.ts src/resources/extensions/gsd/tests/gsd-rebuild.test.ts src/resources/extensions/gsd/tests/migrate-safety-audit.test.ts && ! grep -rn "SCHEMA_VERSION, 45" src --include="*.test.ts" && pnpm run test:unit
```

## Log

- 2026-08-02 — created by planner (wave-2 review cycle 1 blocked → fix task T009F1). Carries T009 AC5. Planner pre-sweep at HEAD extended the review's 4-file enumeration to 6: `db-milestone-reopen-schema.test.ts:218` + `db-milestone-completion-schema.test.ts:176` (+v42 sibling) confirmed red via source runner (26 pass / 3 fail, `actual: 46, expected: 45`); all six files UNOWNED (checked every task files list); exact-byte projection sweep found no unstamped assertions beyond the two review-named files; remaining `version: 45` hits post-fix are legitimate historical fixtures (`legacy-import-preview-database-target.test.ts:969` historical-v45 — T005's file, do-not-touch).
