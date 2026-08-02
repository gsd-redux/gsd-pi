# Board — gsd-pi

<!-- Maintained by the $gsd-path-build orchestrator. Human-readable summary;
     task-file frontmatter is the source of truth on any disagreement. -->

Current wave: 2 of 4
Updated: 2026-08-02

## Waves

| Wave | Goal | Tasks | Done | Review |
|------|------|-------|------|--------|
| 1 | risk burn-down | 4 | 4/4 | pass, 1 cycle (wave-1.cycle1.md) |
| 2 | walking skeleton (+T024 gate-unblock) | 6 | 0/6 | — |
| 3 | consumers, evidence, command, docs | 10 | 0/10 | — |
| 4 | timebox-gated deletions (separable) and closeout | 4 | 0/4 | — |

## In flight

| Task | Agent | Since |
|------|-------|-------|

## Escalations & plan defects

<!-- Anything a human should know: 2×-failed tasks, defective task files
     fixed mid-build, serialized file conflicts. -->
- 2026-08-02 — plan defect repair: T001 found BASELINE RED (gates fail on unbuilt @opengsd/contracts/dist) → new task T024 (wave 2) redirects @opengsd/contracts to source in both resolve hooks + re-runs baseline. T003 spike observed silent divergence → T005 re-scoped to read-seam surfacing, T006 to projection-write version gating/rebuild error propagation; T007/T009 file scope+deps adjusted.
