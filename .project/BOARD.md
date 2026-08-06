# Board — gsd-pi

<!-- Maintained by the $gsd-path-build orchestrator. Human-readable summary;
     task-file frontmatter is the source of truth on any disagreement. -->

Current wave: 3 of 4 — BLOCKED (T010, second block)
Updated: 2026-08-05

## Waves

| Wave | Goal | Tasks | Done | Review |
|------|------|-------|------|--------|
| 1 | risk burn-down | 4 | 4/4 | pass, 1 cycle (wave-1.cycle1.md) |
| 2 | walking skeleton (+T024/T025/T026/T027 repairs) | 9 | 9/9 | pass, 2 cycles (wave-2.cycle2.md) |
| 3 | consumers, evidence, command, docs | 10 | 3/10 | — |
| 4 | timebox-gated deletions (separable) and closeout | 4 | 0/4 | — |

## In flight

| Task | Agent | Since |
|------|-------|-------|

## Escalations & plan defects

<!-- Anything a human should know: 2×-failed tasks, defective task files
     fixed mid-build, serialized file conflicts. -->
- 2026-08-05 — T010 BLOCKED a second time (2× blocked task; build stopped for a user ruling). Both blocks are documented plan defects, not implementation failures — the coder produced no product diff either attempt. Second defect: Step 5's re-points in artifact-verification.ts break two pinned seam tests in `src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts`, a path outside T010's `files` and owned by no task. Those tests assert the markdown-fallback recovery behavior Step 5 removes, so the fix is a milestone-semantics call, not a scope tweak. Worktree .worktrees/gsd-path-T010 retained clean at base 28701e57c. Also recorded during this recovery: T014 shipped `handleDbRestoreBackup` (commands-maintenance.ts:1483) with no command route — `commands/handlers/ops.ts` was outside T014's `files`, so `/gsd db restore-backup` is unreachable. Belongs in wave-3 review as a finding; a hand-made fix is parked outside the repo.
- 2026-08-02 — plan defect repair: T001 found BASELINE RED (gates fail on unbuilt @opengsd/contracts/dist) → new task T024 (wave 2) redirects @opengsd/contracts to source in both resolve hooks + re-runs baseline. T003 spike observed silent divergence → T005 re-scoped to read-seam surfacing, T006 to projection-write version gating/rebuild error propagation; T007/T009 file scope+deps adjusted.
