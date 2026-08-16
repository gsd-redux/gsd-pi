---
id: T033
title: Re-key the legacy static proof and importer registry on parser symbols, not the module specifier
wave: 3
deps: [T015, T016, T028]
status: done
agent: build_T033
commit: 265a8e108b4385708ac96e213e5454a0189dbb4e
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
- 2026-08-06 — coder (build_T033). Implementation:
  - `scripts/legacy-state-path-proof.mjs`: new `legacyParserSymbol` offender kind
    keyed on `/\b(?:parseLegacyRoadmap|parseLegacyPlan)\b/` — the legacy exports of
    `schemas/parsers.ts` that parse projection markdown as a data source
    (`parseRoadmap` at `schemas/parsers.ts:311` is the unrelated validation parser
    and is deliberately excluded). Specifier detection kept as an additional signal
    and broadened from `from '…'`/`import('…')`/`require('…')` to the specifier in
    any string literal, which covers the side-effect (`import './parsers-legacy.js';`)
    and specifier-on-its-own-line forms the reviewer found missed. `stripComment`
    replaced by an exported whole-file `stripComments` that tracks `/* … */` state
    across lines and skips string literals, killing the block-comment false
    positives (verified live: `markdown-renderer.ts:1233`, inside a commented-out
    block, is correctly NOT reported, while `:52` and `:1345` are). Exemptions:
    the shim `gsd/parsers-legacy.ts` (the module under ban, deleted by T020) and
    `gsd/schemas/parsers.ts` (the symbols' declaration home) — flagging either would
    make the offender list unclearable by construction.
  - `parsers-legacy-importers.test.ts`: same symbol-keyed rule plus the same
    comment-stripping, so registry and proof agree by construction. `SELF_PATHS`
    replaces the single shim skip. `ALLOWED_IMPORTERS` grew 1 → 8 to match reality;
    `gsd/state.ts` keeps its T022 justification, the seven relocated-symbol
    consumers each carry an explicit `Retired by: none`. `BANNED_DECISION_PATHS`
    left byte-unchanged (15 entries); no ban was weakened.
  - `legacy-cleanup-gate.test.ts`: offender fixture extended with the rename case
    (`relocated.ts` importing `parseLegacyPlan` from `./schemas/parsers.js`), the
    side-effect form, the own-line form, a block-comment prose case that must NOT
    report, and the exempt `schemas/parsers.ts`; clean-case renamed and given a
    symbol-in-tests-only fixture. Added a live-repository test asserting the proof
    is RED with at least one `legacyParserSymbol` offender — it pins the honest
    state so a future rename cannot quietly green the gate.
- 2026-08-06 — Verify (run in the T033 worktree), exact result:
  `grep -q parseLegacyRoadmap … && grep -q parseLegacyPlan … && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts src/tests/legacy-cleanup-gate.test.ts`
  → `tests 14 / suites 0 / pass 14 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 610.978666`. Exit 0.
  `npx tsc -p tsconfig.extensions.json --noEmit --incremental false` → zero errors.
- 2026-08-06 — `node scripts/legacy-state-path-proof.mjs` → `Status: BLOCK`, exit 2.
  This red is the intended output of this task (AC4); it was NOT engineered away.
  8 offender files / 12 offender lines:
  - legacyParserSymbol src/resources/extensions/gsd/artifact-verification.ts:7, :92, :471
  - legacyParserSymbol src/resources/extensions/gsd/doctor-engine-checks.ts:31, :149
  - legacyParserSymbol src/resources/extensions/gsd/markdown-renderer.ts:52, :1345
  - legacyParserSymbol src/resources/extensions/gsd/md-importer.ts:50
  - legacyParserSymbol src/resources/extensions/gsd/migration-auto-check.ts:11
  - legacyParserSymbol src/resources/extensions/gsd/state-reconciliation/drift/roadmap.ts:21
  - legacyParserSymbol src/resources/extensions/gsd/state-reconciliation/drift/sketch-flag.ts:18
  - parsersLegacyImporter src/resources/extensions/gsd/state.ts:25
  This is exactly the review's seven relocated-symbol modules plus the one surviving
  shim importer. Consequence, as ruled: `legacy:cleanup:gate` stays BLOCK and T020's
  deletion gate is unreachable until these seven are addressed — no task currently
  owns them (hence the `none` justifications).
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
