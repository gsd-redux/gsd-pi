# Board — gsd-pi

<!-- Maintained by the $gsd-path-build orchestrator. Human-readable summary;
     task-file frontmatter is the source of truth on any disagreement. -->

Current wave: 3 of 4 — review cycle 1 BLOCKED; 5 fix tasks (T029-T033) dispatched
Updated: 2026-08-05

## Waves

| Wave | Goal | Tasks | Done | Review |
|------|------|-------|------|--------|
| 1 | risk burn-down | 4 | 4/4 | pass, 1 cycle (wave-1.cycle1.md) |
| 2 | walking skeleton (+T024/T025/T026/T027 repairs) | 9 | 9/9 | pass, 2 cycles (wave-2.cycle2.md) |
| 3 | consumers, evidence, command, docs (+T028, +T029-T033 fixes) | 16 | 11/16 | cycle 1 blocked (4 findings) |
| 4 | timebox-gated deletions (separable) and closeout | 4 | 0/4 | — |

## In flight

| Task | Agent | Since |
|------|-------|-------|

## Escalations & plan defects

<!-- Anything a human should know: 2×-failed tasks, defective task files
     fixed mid-build, serialized file conflicts. -->
- 2026-08-06 — wave-3 review cycle 1 BLOCKED: 7 pass, 4 fail (T010, T011, T013, T014). Every failure was invisible to the Verify commands, which all pass. Highest-value finding is cross-cutting and changes what this milestone can claim: the static proof and importer registry key on the `parsers-legacy` MODULE SPECIFIER, which wave 3 largely emptied by RENAMING imports to schemas/parsers.js for byte-identical functions. Seven production modules still parse legacy markdown; after T022 the gate would report zero offenders with the legacy read path live, satisfying INTENT success criterion 3 by a rename. User ruled 2026-08-06: re-key on symbols (T033), accepting the gate goes red and T020 becomes unreachable until those seven are addressed. Second cross-cutting warning, NOT yet owned by a task and needing a ruling at closeout: `legacy:cleanup:evidence` cannot go green honestly — no command in DEFAULT_EVIDENCE_COMMANDS produces telemetry, so the only green path is a caller-supplied --command writing the report; INTENT criterion 3 requires it green, and SYNTHESIS ruled no markdownFallbackUsed counter would be built. Also unowned: `detectStaleRenders` is a hard `return []` stub and `detectProjectionDrift` has no production caller, so two of SYNTHESIS's three promised positive post-cutover checks are inert.
- 2026-08-05 — plan defect (planning omission, not a task failure): T015's static proof cut production `parsers-legacy` importers 9 → 2, and the survivors are `gsd/state.ts` (expected; T022 removes it) and `gsd/markdown-renderer.ts` (owned by NO task — T008's AC2 forbade only a NEW import and never required removing the existing one, so T008 passed correctly). T016's expected-state assertions and T020's zero-importer deletion gate are both unreachable without it. Added T028 (re-home to schemas/parsers.js, same disposition already used by T010/T012/T013); T016 deps += T028. T008 is NOT reopened.
- 2026-08-05 — T010 resolved on the fourth contract, after three blocks — all three were plan defects, none an implementation failure. Root cause: `files` was built from an inventory that never enumerated the tests pinning markdown-fallback behavior, so each attempt discovered only what it broke. Closed by sweeping all 21 unlisted test files touching these modules against the implementation (19 green, 2 red) and repairing once against the measured blast radius. A pinned SILENT PASS was found and inverted: `idle-recovery` "complete-slice — no roadmap file present is lenient (returns true)" asserted the exact verify-fail→verify-pass hole SYNTHESIS (c) exists to close.
- 2026-08-05 — T010 BLOCKED a second time (2× blocked task; build stopped for a user ruling). Both blocks are documented plan defects, not implementation failures — the coder produced no product diff either attempt. Second defect: Step 5's re-points in artifact-verification.ts break two pinned seam tests in `src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts`, a path outside T010's `files` and owned by no task. Those tests assert the markdown-fallback recovery behavior Step 5 removes, so the fix is a milestone-semantics call, not a scope tweak. Worktree .worktrees/gsd-path-T010 retained clean at base 28701e57c. Also recorded during this recovery: T014 shipped `handleDbRestoreBackup` (commands-maintenance.ts:1483) with no command route — `commands/handlers/ops.ts` was outside T014's `files`, so `/gsd db restore-backup` is unreachable. Belongs in wave-3 review as a finding; a hand-made fix is parked outside the repo.
- 2026-08-02 — plan defect repair: T001 found BASELINE RED (gates fail on unbuilt @opengsd/contracts/dist) → new task T024 (wave 2) redirects @opengsd/contracts to source in both resolve hooks + re-runs baseline. T003 spike observed silent divergence → T005 re-scoped to read-seam surfacing, T006 to projection-write version gating/rebuild error propagation; T007/T009 file scope+deps adjusted.
