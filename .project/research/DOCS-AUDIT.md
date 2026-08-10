# Docs Audit

<!-- Written by the docs auditor ($gsd-path-onboard, task onboard_docs).
     Every verdict carries evidence; a verdict without evidence is a defect. -->

Repo root: /Users/jeremymcspadden/github/open-gsd/gsd-pi
Audited: 2026-07-14 (worktree HEAD ade9db0e4cb7c69440000fa81630091f56dbdcd1)
Updated: 2026-08-10 to remove entries for retired legacy remote-product documentation.
Alignment mode: no — no prior .project/ pipeline artifacts; INTENT/SYNTHESIS/BOARD/STATE not checked

## Summary

| Verdict | Count |
|---------|-------|
| verified | 141 |
| stale | 67 |
| aspirational | 0 |
| unverifiable | 10 |
| descriptive docs (no testable claims) | 277 |

Worst drift: docs/dev/ci-cd-pipeline.md still describes an automatic Dev → Test → Prod dist-tag promotion pipeline, but .github/workflows/pipeline.yml now only rebuilds the CI builder image and its header states publishing lives in the manual npm-publish.yml workflow — a contributor following the doc would wait for promotions that never happen.

## Doc: .github/PULL_REQUEST_TEMPLATE.md

descriptive — PR template; its policy line mirrors CONTRIBUTING.md (verified there).

## Doc: .plans/api-key-manager.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Proposed /gsd keys command surface" | feature | verified | 'keys' in /gsd catalog (catalog.ts:20) — plan has been implemented |

## Doc: .plans/autocomplete-qol-improvements.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "References packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts" | structure | stale | packages/pi-coding-agent/src/modes/ does not exist at HEAD |

## Doc: .plans/directory-safeguards.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Plan to block launches from dangerous directories ($HOME, /, etc.)" | feature | verified | implemented: src/resources/extensions/gsd/gsd-home.ts + tests/gsd-root-home-guard.test.ts |

## Doc: .plans/doctor-cleanup-consolidation.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/dynamic-model-discovery.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/extension-loading-multi-path.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/fix-high-cpu-process-lifecycle.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/issue-125-provider-fallback.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "References packages/pi-coding-agent/src/cli/commands/settings.ts" | structure | stale | packages/pi-coding-agent/src/cli/commands/ does not exist at HEAD |

## Doc: .plans/issue-524-git2-migration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "git2 crate already a dependency (vendored libgit2) with native read-only functions" | status | verified | native/crates/engine/Cargo.toml:43 git2 0.20 vendored-libgit2; native-git-bridge.d.ts present |

## Doc: .plans/issue-575-dynamic-model-routing.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/issue-672-parallel-milestone-orchestration.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/left-native-tui-main-session-plan.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "References packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts" | structure | stale | packages/pi-coding-agent/src/modes/ does not exist at HEAD |

## Doc: .plans/native-perf-optimizations.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/ollama-native-provider.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/onboarding-detection-wizard.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Phases 1/3/4/5 marked IMPLEMENTED" | status | verified | src/resources/extensions/gsd/tests/prefs-wizard-coverage.test.ts exists; wizard.ts present at src root |

## Doc: .plans/preferences-wizard-completeness.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/single-writer-engine-v3-control-plane.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/startup-performance.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/token-optimization-suite.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/tui-dashboard-cleanup.md

descriptive — draft/WIP implementation plan; self-labeled status, no independently testable claims extracted.

## Doc: .plans/workflow-templates.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: In Progress — Phase 1" | status | stale | 'templates' ships in the /gsd command catalog (catalog.ts:20) and gitbook documents the feature |

## Doc: CHANGELOG.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Latest recorded release [1.11.0] - 2026-07-12" | status | verified | CHANGELOG.md:10 vs package.json:3 — match |

## Doc: CONTEXT.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Runtime snapshot exports orchestrationPhase telemetry" | feature | verified | src/resources/extensions/gsd/auto-runtime-state.ts:33,46 |
| "auto.ts wires a concrete module through createWiredAutoOrchestrationModule(...)" | feature | stale | grep createWiredAutoOrchestrationModule across src/ → 0 hits; AutoOrchestrationModule type imported at auto.ts:277 from auto/contracts.js |

## Doc: CONTRIBUTING.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Setup/day-to-day/verify scripts (install, secret-scan:install-hook, build, test, test:changed:src, verify:fast/pr/merge/full, audit:test-confidence)" | command | verified | package.json scripts — all present |
| "CI enforces source-grep ban via scripts/check-source-grep-tests.sh" | feature | verified | scripts/check-source-grep-tests.sh exists |
| "Scope-area path table (packages/pi-*, mcp-server, src/resources/extensions/gsd/, native/, vscode-extension/, web/)" | structure | verified | ls — all present |
| "Extension SDK docs authoritative at docs/extension-sdk/" | structure | verified | docs/extension-sdk/ exists with 6 guides |
| "Recurring defect classes reference issue #4931" | integration | stale | gh issue view 4931 -R open-gsd/gsd-pi → 'Could not resolve to an issue' (repo's issues are ~#1500 range; number predates the fork) |

## Doc: README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Repository layout table (src/, packages/, apps/, native/, studio/, web/, docs/, scripts/)" | structure | verified | ls of repo root — all 8 paths present |
| "Dev commands: pnpm install --frozen-lockfile / build / test / verify:fast / verify:pr / verify:merge" | command | verified | package.json scripts block — all present |
| "Latest release v1.11.0" | status | verified | package.json:3 version 1.11.0; npm view @opengsd/gsd-pi version → 1.11.0 |
| "gsd --web launches web mode" | feature | verified | src/cli.ts:110,417 |
| "gsd upgrade command" | command | verified | src/resources/extensions/gsd/commands/handlers/ops.ts:277-278; catalog.ts:82 |
| ".gsd-backups/migrate-* pruned after 30 days" | feature | verified | src/resources/extensions/gsd/flat-phase-migration.ts:310 FLAT_PHASE_BACKUP_RETENTION_MS = 30d |
| "cursor-agent default model composer-2.5; CURSOR_API_KEY supported" | config | verified | src/resources/extensions/cursor-cli/models.ts:12; cursor-cli/readiness.ts |
| "Install via npx @opengsd/gsd-pi@latest" | command | verified | npm view @opengsd/gsd-pi version → 1.11.0 (package published) |
| "GSD Pi web configurator at https://pi.opengsd.net/" | integration | unverifiable | external hosted service; not checkable from repo |

## Doc: VISION.md

descriptive — vision/principles and project-history narrative; no testable claims (external history links not audited).

## Doc: docker/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Image/compose file table (Dockerfile.sandbox, Dockerfile.ci-builder, docker-compose.yaml, docker-compose.full.yaml)" | structure | verified | ls docker/ — all four present |
| "Requires Docker Desktop 4.58+" | config | unverifiable | external product requirement |

## Doc: docs/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "User/dev/SDK guide link tables" | structure | verified | all linked targets present in frozen inventory |
| "Release Notes link described as 'Current 1.2.0 release notes'" | status | stale | package.json:3 and CHANGELOG.md:10 are at 1.11.0 |

## Doc: docs/agents/domain.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Single-context layout: CONTEXT.md at root, ADR-*.md in docs/dev/" | structure | verified | ls — CONTEXT.md and 40+ docs/dev/ADR-*.md present |

## Doc: docs/agents/issue-tracker.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Issue tracker is GitHub open-gsd/gsd-pi via gh -R" | integration | verified | gh label list -R open-gsd/gsd-pi succeeded (auth + repo resolve) |

## Doc: docs/agents/triage-labels.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Five canonical labels map 1:1 to tracker labels" | config | verified | gh label list -R open-gsd/gsd-pi → needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix all exist |
| "ready-for-agent / ready-for-human / wontfix 'will be created on first use'" | status | stale | gh label list → all three already exist with the documented descriptions |

## Doc: docs/archive/legacy-release-history.md

descriptive — archived release history; historical record, not audited for currency.

## Doc: docs/db-map.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "DB stack files: bootstrap/db-tools.ts, tools/workflow-tool-executors.ts, gsd-db.ts, db/engine.ts, db/domain-operation.ts" | structure | verified | ls src/resources/extensions/gsd/ — all present |

## Doc: docs/dev/2026-04-24-swarm-delivery-implementation-plan.md

descriptive — dated implementation plan (status: In progress); referenced verify commands exist in package.json.

## Doc: docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md

descriptive — dated plan-of-plans (status: Replanned).

## Doc: docs/dev/ADR-001-branchless-worktree-architecture.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-002-external-state-directory.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-003-pipeline-simplification.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-004-capability-aware-model-routing.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Implemented (Phase 2)" | status | unverifiable | capability-routing spot greps inconclusive; needs targeted trace of the routing pipeline against the ADR's Phase-2 scope |

## Doc: docs/dev/ADR-005-multi-model-provider-tool-strategy.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-006-extension-modularization.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-007-model-catalog-split.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-008-IMPLEMENTATION-PLAN.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-008-gsd-tools-over-mcp-for-provider-parity.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (implemented) — GSD tools over MCP" | status | verified | packages/mcp-server exists with bin gsd-mcp-server exposing GSD tools |

## Doc: docs/dev/ADR-009-IMPLEMENTATION-PLAN.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-009-orchestration-kernel-refactor.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (implemented; emergency legacy fallback retained)" | status | unverifiable | no OrchestrationKernel symbol found by name; needs trace of the kernel refactor against HEAD |

## Doc: docs/dev/ADR-010-pi-clean-seam-architecture.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (Phase 1 implemented) — @gsd/agent-core + @gsd/agent-modes seam packages" | status | verified | packages/gsd-agent-core and packages/gsd-agent-modes exist; scripts/apply-seam.cjs exists |

## Doc: docs/dev/ADR-011-progressive-planning-escalation.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (mostly implemented)" | status | unverifiable | escalation greps match unrelated recovery code; needs targeted trace |

## Doc: docs/dev/ADR-012-provider-id-vs-api-shape.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-013-memory-store-consolidation.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (mostly implemented — Phase 6 preflight/cutover)" | status | unverifiable | memory-store symbol greps inconclusive; needs targeted trace of the consolidation phases |

## Doc: docs/dev/ADR-014-auto-orchestration-deep-module.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-015-runtime-invariant-modules.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-016-phase-2-design.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-016-worktree-lifecycle-and-projection.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-016-worktree-safety-fail-closed.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-017-state-reconciliation-drift-driven.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-018-project-authority-contract.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-019-unify-tui-style-system.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-022-post-unit-gate-enforcement.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-023-post-unit-hook-outcome-artifacts.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-024-gsd-browser-primary-browser-engine.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-025-closeout-consistency-gate.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-026-per-phase-thinking-level.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-027-source-observation-context-block.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-028-preload-authoritative-discuss.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-029-preload-authoritative-auto-research-validate.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-030-two-altitude-state-machine.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-031-worktree-placement.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-032-unit-closeout-seam.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-033-unit-type-registry.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-034-milestone-merge-publication-split.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-035-projection-dirty-scope.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-036-tool-surface-readiness.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (implemented)" | status | unverifiable | no tool-surface-readiness symbol found by name; needs targeted trace |

## Doc: docs/dev/ADR-037-browser-engine-proven-resolution.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-038-dispatch-history-deep-module.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-039-consent-question-module.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-040-write-gate-two-adapter-seam.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-041-engine-hook-contract.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-042-three-session-types.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-043-parent-workspace-mode-contract.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-044-per-repository-git-isolation.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-045-flat-phase-layout-completion.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md

descriptive — decision record with self-labeled status; no independently testable claims extracted.

## Doc: docs/dev/FILE-SYSTEM-MAP.md

descriptive — label taxonomy mapping files to subsystems; sampled paths (browser-tools, gsd extension) verified during other checks.

## Doc: docs/dev/FRONTIER-TECHNIQUES.md

descriptive — self-labeled 'Research / Pre-RFC'.

## Doc: docs/dev/M003-S03-TASK-EXECUTION-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S04-TASK-RECOVERY-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S05-SLICE-LIFECYCLE-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S06-MILESTONE-LIFECYCLE-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-SEMANTIC-SHADOW-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-T06-FAULT-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-T06-NO-CUTOVER-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-T06-RESTART-RACE-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-T07-CUTOVER-DECISION-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-T07-DOSSIER-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M003-S07-T07-UAT-SHIP-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M004-S02-T06-CLASSIFICATION-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M004-S02-T07-PUBLIC-PREVIEW-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M004-S03-VERIFIED-BACKUP-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M004-S04-TRANSACTIONAL-IMPORT-APPLICATION-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M004-S05-AUTHORITY-EPOCH-FORWARD-REPAIR-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/M004-S05-T06-PID-OWNERSHIP-RESEARCH.md

descriptive — self-labeled research snapshot/boundary document; historical working notes.

## Doc: docs/dev/PRD-branchless-worktree-architecture.md

descriptive — product requirements record.

## Doc: docs/dev/PRD-pi-clean-seam-refactor.md

descriptive — product requirements record.

## Doc: docs/dev/agent-knowledge-index.md

descriptive — routing table to runtime-installed copies under ~/.gsd/docs/ (mirrors of docs/dev/what-is-pi); runtime state not auditable from repo, sources verified present.

## Doc: docs/dev/architecture.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "System structure: loader.ts → cli.ts, extensions/gsd core, agents/ (scout, researcher, worker), GSD-WORKFLOW.md" | structure | verified | ls src/resources/ — GSD-WORKFLOW.md, agents/ (13 agents incl. scout/researcher/worker), extensions/ present; src/cli.ts confirmed |
| "'22 supporting extensions'" | structure | verified | 24 extension dirs total; 22 excluding gsd core and shared lib — consistent |
| "gsd headless / gsd --mode mcp entry modes" | feature | verified | src/headless.ts; src/cli.ts:113 |

## Doc: docs/dev/building-coding-agents/01-work-decomposition.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/02-what-to-keep-discard-from-human-engineering.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/03-state-machine-context-management.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/04-optimal-storage-for-project-context.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/05-parallelization-strategy.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/06-maximizing-agent-autonomy-superpowers.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/07-system-prompt-llm-vs-deterministic-split.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/08-speed-optimization.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/09-top-10-tips-for-a-world-class-agent.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/10-top-10-pitfalls-to-avoid.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/11-god-tier-context-engineering.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/12-handling-ambiguity-contradiction.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/13-long-running-memory-fidelity.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/14-multi-agent-semantic-conflict-resolution.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/15-legacy-code-brownfield-onboarding.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/16-encoding-taste-aesthetics.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/17-irreversible-operations-safety-architecture.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/18-the-handoff-problem-agent-human-maintainability.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/19-when-to-scrap-and-start-over.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/20-error-taxonomy-routing.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/21-cost-quality-tradeoff-model-routing.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/22-cross-project-learning-reusable-intelligence.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/23-evolution-across-project-scale.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/24-security-trust-boundaries.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/25-designing-for-non-technical-users-vibe-coders.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/26-cross-cutting-themes-where-all-4-models-converge.md

descriptive — research essay on agent design; no testable claims.

## Doc: docs/dev/building-coding-agents/README.md

descriptive — index of the 26 research essays (links verified present).

## Doc: docs/dev/ci-cd-pipeline.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Merged PRs auto-promote Dev → Test → Prod via dist-tags (publishes gsd-pi@<ver>-dev.<sha> @dev automatically)" | feature | stale | .github/workflows/pipeline.yml header: 'npm publishing lives in one trusted manual workflow (npm-publish.yml)'; pipeline.yml only rebuilds the CI builder image; npm-publish.yml is workflow_dispatch (manual) |
| "npm run test:fixtures / node tests/fixtures/record.ts" | command | stale | test:fixtures absent from package.json; tests/fixtures/ does not exist |

## Doc: docs/dev/context-and-hooks/01-the-context-pipeline.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/02-hook-reference.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/03-context-injection-patterns.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/04-message-types-and-llm-visibility.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/05-inter-extension-communication.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/06-advanced-patterns-from-source.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/07-the-system-prompt-anatomy.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/context-and-hooks/README.md

descriptive — deep-reference on pi context/hooks; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/extending-pi/01-what-are-extensions.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/02-architecture-mental-model.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/03-getting-started.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Extension sample imports ExtensionAPI from @gsd/pi-coding-agent" | config | verified | matches packages/pi-coding-agent/package.json name |
| "Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts)" | command | stale | no `pi` bin in any package.json; binary is `gsd` |

## Doc: docs/dev/extending-pi/04-extension-locations-discovery.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/05-extension-structure-styles.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/06-the-extension-lifecycle.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts)" | command | stale | no `pi` bin in any package.json; binary is `gsd` |

## Doc: docs/dev/extending-pi/07-events-the-nervous-system.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/08-extensioncontext-what-you-can-access.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/09-extensionapi-what-you-can-do.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/10-custom-tools-giving-the-llm-new-abilities.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts)" | command | stale | no `pi` bin in any package.json; binary is `gsd` |

## Doc: docs/dev/extending-pi/11-custom-commands-user-facing-actions.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/12-custom-ui-visual-components.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/13-state-management-persistence.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/14-custom-rendering-controlling-what-the-user-sees.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/15-system-prompt-modification.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/16-compaction-session-control.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/17-model-provider-management.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/18-remote-execution-tool-overrides.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/19-packaging-distribution.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts)" | command | stale | no `pi` bin in any package.json; binary is `gsd` |

## Doc: docs/dev/extending-pi/20-mode-behavior.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/21-error-handling.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/22-key-rules-gotchas.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/23-file-reference-documentation.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/24-file-reference-example-extensions.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/25-slash-command-subcommand-patterns.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/26-extension-manifest-spec.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/27-testing-extensions.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/extending-pi/README.md

descriptive — extension API guide; no drift markers detected.

## Doc: docs/dev/hermes-integration-plan.md

descriptive — integration plan; the integration it plans exists at integrations/hermes/ (verified).

## Doc: docs/dev/lifecycle-command-integration-runbook.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Gate commands incl. node scripts/m003-s07-cutover-dossier.mjs, baseline:workflow-authority, baseline:refactor:gate, test:changed:src" | command | verified | scripts/m003-s07-cutover-dossier.mjs exists; all pnpm scripts present in package.json |

## Doc: docs/dev/new-milestone-discuss-flow.md

descriptive — flow narrative (ellipsis paths are illustrative, not literal).

## Doc: docs/dev/pi-context-optimization-opportunities.md

descriptive — analysis document.

## Doc: docs/dev/pi-internal-import-audit.md

descriptive — ADR-010 import audit table.

## Doc: docs/dev/pi-overlay-execution-plan.md

descriptive — no testable claims.

## Doc: docs/dev/pi-ui-tui/01-the-ui-architecture.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/02-the-component-interface-foundation-of-everything.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/03-entry-points-how-ui-gets-on-screen.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/04-built-in-dialog-methods.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/05-persistent-ui-elements.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/06-ctx-ui-custom-full-custom-components.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/07-built-in-components-the-building-blocks.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/08-high-level-components-from-pi-coding-agent.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/09-keyboard-input-how-to-handle-keys.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/10-line-width-the-cardinal-rule.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/11-theming-colors-and-styles.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/12-overlays-floating-modals-and-panels.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/13-custom-editors-replacing-the-input.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/14-tool-rendering-custom-tool-display.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/15-message-rendering-custom-message-display.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/16-performance-caching-and-invalidation.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/17-theme-changes-and-invalidation.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/18-ime-support-the-focusable-interface.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/19-building-a-complete-component-step-by-step.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/20-real-world-patterns-from-examples.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/21-common-mistakes-and-how-to-avoid-them.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/22-quick-reference-all-ui-apis.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/23-file-reference-example-extensions-with-ui.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-ui-tui/README.md

descriptive — vendored Pi TUI API documentation; no upstream-name drift detected (marker scan clean).

## Doc: docs/dev/pi-upstream.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Pinned upstream ref v0.75.5, scope @earendil-works, package map" | config | verified | scripts/pi-upstream.json pinnedRef 'v0.75.5', npmScope '@earendil-works', packageMap present |
| "Vendor/verify commands: build:pi, verify:pi-boundary, verify:pi-patches, test:pi-claude-schemas, test:smoke, vendor-pi*.cjs, apply-seam.cjs" | command | verified | package.json scripts present; scripts/vendor-pi.cjs, vendor-pi-deps.cjs, vendor-pi-coding-agent-core.cjs, apply-seam.cjs all exist |
| "Protected packages gsd-agent-core / gsd-agent-modes" | structure | verified | packages/gsd-agent-core, packages/gsd-agent-modes exist |

## Doc: docs/dev/proposals/698-browser-tools-feature-additions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Shipped — implemented tools incl. browser_save_pdf, browser_mock_route" | status | verified | src/resources/extensions/browser-tools/tools/pdf.ts, network-mock.ts exist; listed in extension-manifest.json |

## Doc: docs/dev/proposals/rfc-database-authoritative-workflow-refactor.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Accepted (2026-07-11), ADR-046 accepted" | status | verified | docs/dev/ADR-046-*.md self-labels Accepted (2026-07-11); CONTEXT.md adopts the vocabulary |

## Doc: docs/dev/proposals/rfc-gitops-branching-strategy.md

descriptive — self-labeled experimental RFC requesting feedback.

## Doc: docs/dev/proposals/workflows/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Scaffold workflows create-release.yml / sync-next.yml / backmerge.yml present for review" | structure | verified | ls docs/dev/proposals/workflows/ — all three yml files present |

## Doc: docs/dev/refactor-baseline-runbook.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "npm run baseline:refactor / baseline:refactor:gate / baseline:workflow-authority" | command | verified | package.json scripts present; scripts/refactor-baseline.mjs, workflow-authority-baseline.mjs exist |

## Doc: docs/dev/refactor-foundation-runbook.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "verify:merge, typecheck:extensions, baseline:workflow-authority commands" | command | verified | package.json scripts — present |

## Doc: docs/dev/superpowers/plans/2026-03-17-cicd-pipeline.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Plan targets tests/fixtures/* replay harness and an auto Dev→Prod promotion pipeline" | structure | stale | tests/fixtures/ absent; .github/workflows/pipeline.yml is now CI-builder-only; publishing manual via npm-publish.yml |

## Doc: docs/dev/superpowers/specs/2026-03-17-cicd-pipeline-design.md

descriptive — design companion to the 2026-03-17 CI/CD plan (see plan for drift).

## Doc: docs/dev/superpowers/specs/2026-05-27-installer-redesign-design.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status: Approved (design review); npx @opengsd/gsd-pi@latest[ --yes] installer flow" | status | verified | scripts/install.js is the package bin gsd-pi; npm view @opengsd/gsd-pi → 1.11.0 published |

## Doc: docs/dev/test-confidence-stack.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "audit:test-confidence / audit:test-gaps / audit:test-matrix commands" | command | verified | package.json scripts — all present |

## Doc: docs/dev/test-evaluation-report.md

descriptive — generated report (regenerable via npm run audit:test-matrix -- --write-report; script present in package.json).

## Doc: docs/dev/tool-schema-authoring.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "npm run test:pi-claude-schemas / verify:pi-patches gates" | command | verified | package.json scripts — present |

## Doc: docs/dev/uat-process.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "UAT spec classified through src/resources/extensions/gsd/uat-policy.ts; results saved via gsd_uat_result_save" | feature | verified | uat-policy.ts exists; gsd_uat_result_save referenced in auto-dispatch.ts, guidance.ts |

## Doc: docs/dev/warp-auto-disconnect-findings.md

descriptive — investigation writeup for issue #5086.

## Doc: docs/dev/what-is-pi/01-what-pi-is.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/02-design-philosophy.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/03-the-four-modes-of-operation.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/04-the-architecture-how-everything-fits-together.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/05-the-agent-loop-how-pi-thinks.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/06-tools-how-pi-acts-on-the-world.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/07-sessions-memory-that-branches.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/08-compaction-how-pi-manages-context-limits.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/09-the-customization-stack.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/10-providers-models-multi-model-by-default.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/11-the-interactive-tui.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/12-the-message-queue-talking-while-pi-thinks.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/13-context-files-project-instructions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/14-the-sdk-rpc-embedding-pi.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/15-pi-packages-the-ecosystem.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/16-why-pi-matters-what-makes-it-different.md

descriptive — Pi concept documentation; no command/path claims.

## Doc: docs/dev/what-is-pi/17-file-reference-all-documentation.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Lists docs/what-is-pi/19-... and docs/session.md under the installed package root" | structure | stale | repo has docs/dev/what-is-pi/ (not docs/what-is-pi/) and packages/pi-coding-agent/docs/sessions.md + session-format.md (no docs/session.md) |

## Doc: docs/dev/what-is-pi/18-quick-reference-commands-shortcuts.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses `pi` as the CLI binary in command examples" | command | stale | no `pi` bin in any package.json (binary renamed `gsd`); e.g. grep '"pi":' packages/*/package.json → none |

## Doc: docs/dev/what-is-pi/19-building-branded-apps-on-top-of-pi.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses @gsd/pi-coding-agent scope in install examples" | config | verified | matches packages/pi-coding-agent/package.json name |
| "References packages/coding-agent/* and packages/web-ui/README.md" | structure | stale | upstream layout names; actual: packages/pi-coding-agent/* (docs/sdk.md exists there), no packages/web-ui |

## Doc: docs/dev/what-is-pi/README.md

descriptive — series index.

## Doc: docs/extension-sdk/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Quick-start manifest tier 'community' + provides.tools shape" | config | verified | matches docs/extension-sdk/manifest-spec.md field table and src/extension-registry.ts:58 isManifest checks |

## Doc: docs/extension-sdk/api-reference.md

descriptive — API surface reference; registerTool spot-verified (packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts, src/index.ts).

## Doc: docs/extension-sdk/building-extensions.md

descriptive — how-to guide; API names consistent with api-reference.md (spot-checked).

## Doc: docs/extension-sdk/manifest-spec.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "readManifest() in src/extension-registry.ts; isManifest() validates id/name/version/tier" | feature | verified | src/extension-registry.ts:58 isManifest, :160 readManifest |

## Doc: docs/extension-sdk/rules.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "StringEnum exported from @gsd/pi-ai" | feature | verified | packages/pi-ai/src/utils/typebox-helpers.ts:14 export function StringEnum |

## Doc: docs/extension-sdk/testing.md

descriptive — testing conventions guide.

## Doc: docs/prompt-db-combined-map.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "DISPATCH_RULES has 29 rules" | structure | stale | counted unitType entries inside DISPATCH_RULES array (auto-dispatch.ts:783..) → 28 at HEAD |

## Doc: docs/prompt-map.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Prompt pipeline files: auto.ts, auto-dispatch.ts (DISPATCH_RULES), auto-prompts.ts, prompt-loader.ts" | structure | verified | ls src/resources/extensions/gsd/ — all present; DISPATCH_RULES at auto-dispatch.ts:783 |

## Doc: docs/superpowers/plans/2026-06-21-flat-phase-layout.md

descriptive — execution plan; the flat-phase migration it planned exists (src/resources/extensions/gsd/flat-phase-migration.ts).

## Doc: docs/superpowers/plans/2026-06-21-gsd-core-pi-backwards-compat.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "References docs/how-to/switching-between-gsd-tools.md" | structure | stale | actual location docs/user-docs/switching-between-gsd-tools.md (no docs/how-to/ dir) |

## Doc: docs/superpowers/plans/2026-06-21-planning-dir-parity.md

descriptive — plan document.

## Doc: docs/superpowers/specs/2026-06-21-gsd-core-pi-backwards-compat-design.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "References docs/how-to/switching-between-gsd-tools.md" | structure | stale | actual location docs/user-docs/switching-between-gsd-tools.md |

## Doc: docs/superpowers/specs/2026-06-21-pi-adopts-planning-layout-design.md

descriptive — self-labeled Proposed design.

## Doc: docs/superpowers/specs/2026-06-21-planning-dir-parity-design.md

descriptive — self-labeled Proposed design.

## Doc: docs/token-consumption-savings-evidence.md

descriptive — PR evidence record referencing ephemeral /tmp audit logs; historical evidence, not current claims.

## Doc: docs/tui-audit.md

descriptive — self-labeled historical snapshot (2026-05-18); header honestly disclaims drift.

## Doc: docs/user-docs/auto-mode.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Auto-mode state machine, crash recovery, steering" | feature | verified | auto.ts, auto-dispatch.ts (DISPATCH_RULES:783), recovery-classification.ts present; /gsd auto in catalog |

## Doc: docs/user-docs/captures-triage.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | /gsd capture and /gsd triage in catalog.ts:20 |

## Doc: docs/user-docs/claude-code-auth-compliance.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | claude-code-cli extension present (compliance guidance doc) |

## Doc: docs/user-docs/claude-code-subscription.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Claude Code CLI provider integration" | feature | verified | src/resources/extensions/claude-code-cli/ present with tests |
| "curl -fsSL https://claude.ai/install.sh \| bash installer" | command | unverifiable | third-party installer; not checkable from repo |

## Doc: docs/user-docs/commands.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Headless subcommands (auto, next, query, new-milestone, dispatch, recover) and CLI examples" | command | verified | src/headless.ts:122-125,314,394,411; src/headless-events.ts:266-271 QUICK_COMMANDS; catalog.ts:20 command list |

## Doc: docs/user-docs/configuration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Preferences/model/git/token-profile configuration surface" | config | verified | preferences-validation.ts, models-json-writer.ts present; /gsd prefs\|config\|model in catalog.ts:20 |

## Doc: docs/user-docs/cost-management.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | cost tracking surfaced via headless query .cost.total (headless-query.ts); /gsd usage in catalog |

## Doc: docs/user-docs/custom-models.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "models.json schema, compat flags, overrides; gsd update --models" | config | verified | models-json-writer.ts, model-resolver.ts present; /gsd update in catalog.ts:82 |

## Doc: docs/user-docs/debug.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | /gsd debug and /gsd forensics in catalog.ts:20 |

## Doc: docs/user-docs/dynamic-model-routing.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | model-resolver.ts, model-registry.ts, model-discovery.ts present; routing area label exists on tracker |

## Doc: docs/user-docs/eval-review.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | /gsd eval-review in catalog.ts:20 |

## Doc: docs/user-docs/getting-started.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Node.js >= 22.18.0 prerequisite; npx/npm/pnpm install flows; gsd upgrade" | command | verified | package.json engines node >=22.18.0; npm view @opengsd/gsd-pi → 1.11.0; upgrade alias at ops.ts:277 |

## Doc: docs/user-docs/git-strategy.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | worktree-safety.ts, worktree-placement.ts, native-git-bridge present |

## Doc: docs/user-docs/hooks.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | /gsd hooks and /gsd run-hook in catalog.ts:20; lifecycle-hooks.ts present |

## Doc: docs/user-docs/local-runtime-contract.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Project-local script/local-runtime/ discovery convention (runtime.mjs priority order)" | feature | verified | src/resources/extensions/gsd/runtime-contract.ts + tests/runtime-contract.test.ts (user-project convention, not a repo path) |

## Doc: docs/user-docs/migration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | flat-phase-migration.ts implements .gsd migration incl. backup pruning (runtime .gsd paths are product-side) |

## Doc: docs/user-docs/multi-repo-workspace.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | repository-registry.ts present; ADR-044 per-repository git isolation |

## Doc: docs/user-docs/node-lts-macos.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Node 22.18.0 minimum / 24 LTS recommended" | config | verified | package.json engines node >=22.18.0 |

## Doc: docs/user-docs/parallel-orchestration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | /gsd parallel in catalog.ts:20 |

## Doc: docs/user-docs/providers.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Provider setup flows incl. Ollama localhost:11434" | integration | verified | ollama extension dir present; provider implementations in packages/pi-ai/src/providers/ |

## Doc: docs/user-docs/remote-questions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | src/resources/extensions/remote-questions/ present; /gsd remote in catalog |

## Doc: docs/user-docs/skills.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Bundled skills, discovery, authoring" | feature | verified | src/resources/skills/ present; skill fixtures exercised by packages/pi-coding-agent tests |
| "npx skills add/check/update third-party CLI" | command | unverifiable | external tool (not in this repo's deps) |

## Doc: docs/user-docs/subagents.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | src/resources/extensions/subagent/ present with tests |

## Doc: docs/user-docs/switching-between-gsd-tools.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | compat-marker handling referenced by docs/superpowers specs; doc exists at this path |

## Doc: docs/user-docs/token-optimization.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | token optimization plans 035-039 marked DONE in plans/README.md; prompt-budget code present |

## Doc: docs/user-docs/troubleshooting.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Migration/uninstall command sequences (npm uninstall -g, pnpm add -g, npx installer)" | command | verified | package names match package.json / npm registry (npm view → 1.11.0); pnpm dlx flow matches package presence |

## Doc: docs/user-docs/visualizer.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | /gsd visualize in catalog.ts:20 |

## Doc: docs/user-docs/web-interface.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "gsd --web [--host --port --allowed-origins]" | command | verified | src/cli.ts:110,417 (--web) |

## Doc: docs/user-docs/working-in-teams.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | team mode validated in preferences-validation.ts:119-172 (solo\|team) |

## Doc: docs/zh-CN/README.md

descriptive — translation index with explicit 'English prevails on divergence' disclaimer.

## Doc: docs/zh-CN/user-docs/auto-mode.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/auto-mode.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/captures-triage.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/captures-triage.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/claude-code-auth-compliance.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/claude-code-auth-compliance.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/commands.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/commands.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |
| "`gsd --debug` top-level flag enables diagnostic logging" | command | stale | no --debug parsing in src/cli.ts / src/cli-web-branch.ts; --debug exists only as a /gsd auto flag (catalog.ts:115,120) |

## Doc: docs/zh-CN/user-docs/configuration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/configuration.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/cost-management.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/cost-management.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/custom-models.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/custom-models.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/debug.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/debug.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/dynamic-model-routing.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/dynamic-model-routing.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/getting-started.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/getting-started.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/git-strategy.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/git-strategy.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/migration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/migration.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/node-lts-macos.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/node-lts-macos.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/parallel-orchestration.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/parallel-orchestration.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/providers.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/providers.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/remote-questions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/remote-questions.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/skills.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/skills.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/token-optimization.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/token-optimization.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/troubleshooting.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/troubleshooting.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/visualizer.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/visualizer.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/web-interface.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/web-interface.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: docs/zh-CN/user-docs/working-in-teams.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Simplified-Chinese mirror of docs/user-docs/working-in-teams.md (claims inherit the English verdicts)" | feature | verified | parity spot-check: getting-started zh matches English Node 22.18.0/install claims; index disclaims English priority |

## Doc: gitbook/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Install + first-run commands" | command | verified | npx @opengsd/gsd-pi@latest published (npm view → 1.11.0); gsd bin in package.json |

## Doc: gitbook/SUMMARY.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "All linked pages exist" | structure | verified | every linked path present in frozen inventory |

## Doc: gitbook/configuration/custom-models.md

descriptive — mirror of user-docs/custom-models.md (verified there).

## Doc: gitbook/configuration/git-settings.md

descriptive — git/worktree settings (worktree code verified).

## Doc: gitbook/configuration/mcp-servers.md

descriptive — MCP configuration guide (mcp-server package verified).

## Doc: gitbook/configuration/notifications.md

descriptive — notifications guide (/gsd notifications in catalog.ts:20).

## Doc: gitbook/configuration/preferences.md

descriptive — preferences reference (validation code verified: preferences-validation.ts).

## Doc: gitbook/configuration/providers.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Provider setup via gsd config" | command | verified | /gsd config in catalog.ts:20; provider implementations in packages/pi-ai/src/providers/ |

## Doc: gitbook/core-concepts/auto-mode.md

descriptive — auto-mode concepts (engine verified: auto.ts, auto-dispatch.ts).

## Doc: gitbook/core-concepts/project-structure.md

descriptive — .gsd layout explainer; gsd.db existence verified via db/engine.ts (SCHEMA_VERSION=45).

## Doc: gitbook/core-concepts/step-mode.md

descriptive — step-mode concepts (headless next verified in commands docs).

## Doc: gitbook/features/captures.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/cost-management.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/debug.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/dynamic-model-routing.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/github-sync.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "GitHub sync feature with gh auth" | integration | verified | src/resources/extensions/github-sync/ present; gh CLI usage standard |

## Doc: gitbook/features/headless.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Headless mode commands incl. --json, new-milestone, query, gsd --mode mcp" | command | verified | src/headless.ts:197-253 flag parsing; src/cli.ts:113 (--mode mcp) |

## Doc: gitbook/features/parallel.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/remote-questions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/skills.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Skills feature" | feature | verified | src/resources/skills/ present |
| "npx skills add/check/update third-party CLI" | command | unverifiable | external tool |

## Doc: gitbook/features/teams.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/token-optimization.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/visualizer.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Documented feature exists in code" | feature | verified | mirrors docs/user-docs counterpart verified in this audit (catalog.ts:20 / extension dirs) |

## Doc: gitbook/features/web-interface.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "gsd --web" | command | verified | src/cli.ts:110,417 |

## Doc: gitbook/features/workflow-templates.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Workflow templates feature" | feature | verified | 'templates' in /gsd command catalog (catalog.ts:20) |

## Doc: gitbook/getting-started/choosing-a-model.md

descriptive — model selection guidance.

## Doc: gitbook/getting-started/first-project.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "gsd, gsd --continue/-c, gsd sessions commands" | command | verified | src/cli-web-branch.ts:89 (--continue\|-c); src/cli.ts:366 ('sessions') |

## Doc: gitbook/getting-started/installation.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Install flows (npx/npm/pnpm), gsd config, gsd --web, gsd-cli alias" | command | verified | package.json bins gsd + gsd-cli; src/cli.ts:110; npm view → 1.11.0 |

## Doc: gitbook/reference/cli-flags.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Core flags: --continue/-c, --model, --thinking, --web, --worktree/-w, --no-session, --extension, --append-system-prompt, --tools, --print/-p, --mode, sessions, --session, --session-dir, --list-models, headless --max-restarts" | command | verified | each flag grep-verified in src/cli.ts / src/cli-web-branch.ts / src/headless.ts |
| "`gsd --debug` top-level flag enables diagnostic logging" | command | stale | no --debug parsing in src/cli.ts / src/cli-web-branch.ts; --debug exists only as a /gsd auto flag (catalog.ts:115,120) |

## Doc: gitbook/reference/commands.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Command reference mirrors user-docs/commands.md" | command | verified | catalog.ts:20 + headless.ts verified for English counterpart |

## Doc: gitbook/reference/environment-variables.md

descriptive — env var reference (GSD_NATIVE_PREFER_LOCAL cross-checked in CONTRIBUTING.md).

## Doc: gitbook/reference/keyboard-shortcuts.md

descriptive — shortcut reference.

## Doc: gitbook/reference/migration.md

descriptive — migration guide (flat-phase-migration.ts verified).

## Doc: gitbook/reference/troubleshooting.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Recovery command sequences" | command | verified | package names/registry verified (npm view → 1.11.0); schema-version example is illustrative text, not a version claim (actual SCHEMA_VERSION=45, db/engine.ts:159) |

## Doc: gsd-orchestrator/SKILL.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Headless flags-before-command contract, JSON to stdout, exit codes 0/1/10/11" | feature | verified | src/headless-events.ts:29-30 EXIT_BLOCKED=10, EXIT_CANCELLED=11; src/headless.ts flag parsing |

## Doc: gsd-orchestrator/references/answer-injection.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "--answers file injection flow" | command | verified | src/headless.ts:231 --answers parsing; src/headless-answers.ts present |

## Doc: gsd-orchestrator/references/commands.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Global flags (--output-format, --bare, --resume, --timeout, --supervised, --answers, --events) and workflow commands (auto, next, new-milestone, dispatch <phase>)" | command | verified | src/headless.ts:197-253, 122-125; headless-query.ts:96 dispatch action |

## Doc: gsd-orchestrator/references/json-result.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "query JSON shape (.state.phase, .cost.total); --resume" | command | verified | src/headless.ts:251 --resume, :394 query handling |

## Doc: gsd-orchestrator/templates/spec.md

descriptive — spec template.

## Doc: gsd-orchestrator/workflows/build-from-spec.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Spec → headless new-milestone --auto workflow" | command | verified | src/headless.ts:104 new-milestone+auto chaining (HEADLESS_CHAIN_AUTO_FLAG) |

## Doc: gsd-orchestrator/workflows/monitor-and-poll.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "query polling, steer, stop, --answers resume flows" | command | verified | headless-events.ts:266-271 QUICK_COMMANDS incl. steer/stop; headless-ui.ts:458 steer |

## Doc: gsd-orchestrator/workflows/step-by-step.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "next/skip/undo --force/dispatch step loop" | command | verified | QUICK_COMMANDS incl. skip/undo; headless.ts:122-125 next |

## Doc: integrations/hermes/CONTEXT.md

descriptive — domain glossary for the hermes plugin.

## Doc: integrations/hermes/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "gsd hermes install --project <dir> installer command" | command | verified | src/cli.ts:261-264 hermes subcommand → hermes-integration-install.js |
| "Manual dev path pip install -e integrations/hermes" | command | verified | integrations/hermes/ package tree present with plugin.yaml (referenced in root package.json files list) |

## Doc: integrations/hermes/docs/issue-1162-grilling.md

descriptive — issue writeup (references the external hermes repo's own tests).

## Doc: integrations/hermes/docs/setup.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "gsd read progress --json and npm run build:core usage" | command | verified | 'read' command at src/cli.ts:362,498; build:core in package.json |

## Doc: integrations/hermes/docs/upstream-hermes-pr.md

descriptive — PR text targeting the upstream hermes repo (paths belong to that repo).

## Doc: integrations/hermes/tests/fixtures/minimal-project/.gsd/STATE.md

descriptive — test fixture data.

## Doc: native/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "npm run build:native / build:native:dev / test:native; crates engine/grep/ast" | command | verified | package.json scripts present; native/crates/{engine,grep,ast} exist; git2 0.20 vendored in engine/Cargo.toml:43 |

## Doc: packages/mcp-server/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "npm install @opengsd/mcp-server / npx gsd-mcp-server" | command | verified | packages/mcp-server/package.json name @opengsd/mcp-server, bin gsd-mcp-server |

## Doc: packages/pi-agent-core/CHANGELOG.md

descriptive — vendored upstream changelog (historical record; upstream names expected).

## Doc: packages/pi-agent-core/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Titles and install/import examples use @earendil-works/pi-agent-core" | config | stale | package.json name is @gsd/pi-agent-core; README is vendored upstream content (docs/dev/pi-upstream.md overlay policy) |

## Doc: packages/pi-agent-core/docs/agent-harness.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "npm run test:harness / coverage:harness" | command | verified | packages/pi-agent-core/package.json scripts include test:harness, coverage:harness |
| "References packages/agent/test/harness/* and src/harness/env/nodejs.ts" | structure | stale | actual: packages/pi-agent-core/test/harness/agent-harness{,-stream}.test.ts and packages/pi-agent-core/src/harness/env/nodejs.ts (upstream path names) |

## Doc: packages/pi-agent-core/docs/durable-harness.md

descriptive — design notes (synced from jot).

## Doc: packages/pi-agent-core/docs/hooks.md

descriptive — hooks design record.

## Doc: packages/pi-agent-core/docs/observability.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Refers to packages/ai and packages/agent" | structure | stale | actual packages are pi-ai and pi-agent-core (upstream names) |

## Doc: packages/pi-ai/CHANGELOG.md

descriptive — vendored upstream changelog (historical record; upstream names expected).

## Doc: packages/pi-ai/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Titles and install/import examples use @earendil-works/pi-ai" | config | stale | package.json name is @gsd/pi-ai; README is vendored upstream content (docs/dev/pi-upstream.md overlay policy) |

## Doc: packages/pi-coding-agent/CHANGELOG.md

descriptive — vendored upstream changelog (historical record; upstream names expected).

## Doc: packages/pi-coding-agent/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Titles and install/import examples use @earendil-works/pi-coding-agent" | config | stale | package.json name is @gsd/pi-coding-agent; README is vendored upstream content (docs/dev/pi-upstream.md overlay policy) |

## Doc: packages/pi-coding-agent/docs/compaction.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/custom-provider.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/development.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/extensions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/index.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/json.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/keybindings.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/models.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/packages.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/prompt-templates.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/providers.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/quickstart.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/rpc.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/sdk.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/session-format.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/sessions.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/settings.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/shell-aliases.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/skills.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/terminal-setup.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/termux.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/themes.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/tmux.md

descriptive — tmux configuration guidance (no command/path drift markers; product named 'Pi').

## Doc: packages/pi-coding-agent/docs/tui.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/usage.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/docs/windows.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope" | command | stale | vendored upstream doc (pi-upstream.md overlay policy); fork reality: `gsd` bin, ~/.gsd/, @gsd/* scopes |

## Doc: packages/pi-coding-agent/examples/README.md

descriptive — examples index.

## Doc: packages/pi-coding-agent/examples/extensions/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Upstream `pi`/`~/.pi` references" | command | stale | vendored upstream doc; fork uses gsd/~/.gsd |

## Doc: packages/pi-coding-agent/examples/extensions/doom-overlay/README.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/dynamic-resources/SKILL.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/dynamic-resources/dynamic.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/plan-mode/README.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/README.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/agents/planner.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/agents/reviewer.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/agents/scout.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/agents/worker.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/prompts/implement-and-review.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/prompts/implement.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/extensions/subagent/prompts/scout-and-plan.md

descriptive — example extension content (prompt/agent definitions).

## Doc: packages/pi-coding-agent/examples/sdk/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Upstream scope/binary references" | command | stale | vendored upstream doc; fork uses @gsd/* and gsd |

## Doc: packages/pi-coding-agent/test/fixtures/skills-collision/first/calendar/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills-collision/second/calendar/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/consecutive-hyphens/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/disable-model-invocation/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/invalid-name-chars/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/invalid-yaml/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/long-name/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/missing-description/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/multiline-description/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/name-mismatch/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/nested/child-skill/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/no-frontmatter/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/root-skill-preferred/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/root-skill-preferred/nested-child/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/unknown-field/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/fixtures/skills/valid-skill/SKILL.md

descriptive — skill-parser test fixture (deliberately valid/invalid inputs).

## Doc: packages/pi-coding-agent/test/suite/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Directs to faux provider at packages/ai/src/providers/faux.ts" | structure | stale | actual: packages/pi-ai/src/providers/faux.ts (packages/ai does not exist); harness.ts exists as documented |

## Doc: packages/pi-tui/CHANGELOG.md

descriptive — vendored upstream changelog (historical record; upstream names expected).

## Doc: packages/pi-tui/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Titles and install/import examples use @earendil-works/pi-tui" | config | stale | package.json name is @gsd/pi-tui; README is vendored upstream content (docs/dev/pi-upstream.md overlay policy) |

## Doc: packages/rpc-client/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "@opengsd/rpc-client with RpcClient class; types shared via @opengsd/contracts" | feature | verified | package name verified; packages/contracts present in workspace |

## Doc: plans/001-worktree-safety-all-isolation-modes.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/002-dispatch-history-rehydrate-errors.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/003-reset-session-timeout-counter.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/004-batch-slice-queries-state-derivation.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/005-convert-source-grep-tests.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/006-auto-closeout-verdict-tests.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/007-mcp-server-gsd-bridge-seam.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/008-extract-auto-loop-phase-modules.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/009-harden-cloud-pairing-codes.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/010-redact-secrets-in-persisted-logs.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/011-buffer-websocket-sends-cloud-runtime.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/012-graceful-shutdown-sigterm-sigkill-timing.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/013-surface-workspace-link-failures.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/014-batch-task-queries-projection.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/015-bound-discord-message-batcher.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/016-dependency-security-overrides.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/017-doc-dx-quick-fixes.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/020-cloud-pairing-http-timeouts.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/026-schema-version-and-migration-safety.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/028-db-write-layer-small-fixes.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/032-lean-mean-cleanup.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/032a-dead-code-audit.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/036-stabilize-prompt-cache-prefix.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/037-dedupe-per-turn-context-messages.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/038-cheapen-compaction-calls.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/039-close-prompt-budget-gaps.md

descriptive — historical execution plan; status tracked in plans/README.md.

## Doc: plans/040-m002-s04-recovery-evidence-research.md

descriptive — milestone research/contract document (self-labeled research).

## Doc: plans/041-m002-s05-projection-import-kernel-closeout-research.md

descriptive — milestone research/contract document (self-labeled research).

## Doc: plans/042-m002-s06-domain-operation-research.md

descriptive — milestone research/contract document (self-labeled research).

## Doc: plans/043-m003-s01-lifecycle-writer-research.md

descriptive — milestone research/contract document (self-labeled research).

## Doc: plans/044-m003-s02-planning-adoption-research.md

descriptive — milestone research/contract document (self-labeled research).

## Doc: plans/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Status table: plans 001-039 rows consistent with present files (spot-checked 003/004 subjects exist in code)" | status | verified | deriveStateFromDb referenced in auto-dispatch.ts/state.ts; timeout-counter and batch-slice code present; lost-file note matches inventory gaps (018,019,021,023,024,027,029-031 absent) |
| "Index omits rows for plans 040-044" | status | stale | plans/040..044-*.md present in repo but absent from the README table |
| "Note says plan 032's file was lost and is NOT recoverable" | status | stale | plans/032-lean-mean-cleanup.md exists (commit d044ebb41) but with different scope than the lost 032 row — plan number reused |

## Doc: scripts/archive/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Archived scripts are unreferenced; listed files present" | structure | verified | ls scripts/archive/ — all listed files present incl. __tests__ |

## Doc: scripts/ci_monitor.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "node scripts/ci_monitor.cjs <command> routing table" | command | verified | scripts/ci_monitor.cjs exists |

## Doc: tests/e2e/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "npm run build:core + GSD_SMOKE_BINARY + npm run test:e2e flow" | command | verified | build:core and test:e2e in package.json; tests/e2e/ present |

## Doc: tests/live-workflow/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Live workflow layer drives real binary via gsd headless next; separate from tests/e2e and tests/live" | feature | verified | test:live-workflow in package.json; headless next verified (headless.ts:122-125) |

## Doc: vscode-extension/CHANGELOG.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Changelog records [1.0.0] - 2026-05-22 as the only release" | status | stale | vscode-extension/package.json version is 0.3.0 — changelog's single 1.0.0 entry never matches any released version |

## Doc: vscode-extension/README.md

| Claim | Type | Verdict | Evidence |
|-------|------|---------|----------|
| "Requires Node >= 22.18.0, VS Code >= 1.95.0, npm i -g @opengsd/gsd-pi" | config | verified | vscode-extension/package.json engines.vscode ^1.95.0; root engines node >=22.18.0; npm view @opengsd/gsd-pi → 1.11.0 |

## Alignment (alignment mode only)

Not applicable — alignment mode is off (no .project/ pipeline artifacts exist at HEAD).

## User rulings

<!-- Appended after the ruling walk (standalone runs). Verbatim, append-only. -->

| Queue # | Ruling | User's words | Planned |
|---------|--------|--------------|---------|
| 7 | verified (reclassified) | Configurator URL fetched live 2026-08-01 during grill: pi.opengsd.net serves the cloud config editor — claim stands | n/a |
| 11, 12, 13, 14, 15 | fix-doc | ADR-004/-009/-011/-013/-036 status labels not confirmable from code → downgrade labels to match reality ("an ADR labeled Implemented that the auditor can't find is worse than one honestly labeled Accepted, partially landed"); lean presented 2026-08-01, no user objection | no |
| 36, 37, 39 (and 8) | no ruling needed | External vendor/tool references (claude.ai installer, npx skills CLI, Docker Desktop 4.58+) — remediation already "None — external" | n/a |
| 41–70 | accept-drift | Vendored upstream docs (packages/pi-*) keep upstream pi / ~/.pi/ / @earendil-works wording per overlay policy: "Patching vendored docs creates merge friction on every upstream sync for zero runtime benefit"; lean presented 2026-08-01, no user objection | n/a (accept-drift) |
| ci-cd-pipeline.md row | fix-doc | Document the manual npm-publish.yml reality; automatic Dev→Test→Prod promotion "will burn the next person who waits for a promotion that never fires"; lean presented 2026-08-01, no user objection | no |

## Remediation queue

<!-- Every non-verified claim, classified. The user rules on this queue;
     the auditor never fixes anything. -->

| # | Doc | Claim | Verdict | Class | Suggested action |
|---|-----|-------|---------|-------|------------------|
| 1 | .plans/autocomplete-qol-improvements.md | References packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts | stale | fix-doc | Refresh the referenced paths or mark the plan historical |
| 2 | .plans/issue-125-provider-fallback.md | References packages/pi-coding-agent/src/cli/commands/settings.ts | stale | fix-doc | Refresh the referenced paths or mark the plan historical |
| 3 | .plans/left-native-tui-main-session-plan.md | References packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts | stale | fix-doc | Refresh the referenced paths or mark the plan historical |
| 4 | .plans/workflow-templates.md | Status: In Progress — Phase 1 | stale | fix-doc | Update status to reflect shipped state |
| 5 | CONTEXT.md | auto.ts wires a concrete module through createWiredAutoOrchestrationModule(...) | stale | fix-doc | Update snapshot to the current wiring name or mark the snapshot historical |
| 6 | CONTRIBUTING.md | Recurring defect classes reference issue #4931 | stale | fix-doc | Re-link to the equivalent open-gsd/gsd-pi issue or drop the number |
| 7 | README.md | GSD Pi web configurator at https://pi.opengsd.net/ | unverifiable | NEEDS-USER | Confirm configurator URL is live or drop the reference |
| 8 | docker/README.md | Requires Docker Desktop 4.58+ | unverifiable | NEEDS-USER | None — external requirement |
| 9 | docs/README.md | Release Notes link described as 'Current 1.2.0 release notes' | stale | fix-doc | Update or de-version the description |
| 10 | docs/agents/triage-labels.md | ready-for-agent / ready-for-human / wontfix 'will be created on first use' | stale | fix-doc | Drop the create-on-first-use note and the gh label create block |
| 11 | docs/dev/ADR-004-capability-aware-model-routing.md | Status: Implemented (Phase 2) | unverifiable | NEEDS-USER | Confirm Phase-2 routing scope landed or downgrade the status label |
| 12 | docs/dev/ADR-009-orchestration-kernel-refactor.md | Status: Accepted (implemented; emergency legacy fallback retained) | unverifiable | NEEDS-USER | Confirm the kernel landed under a different name or adjust the label |
| 13 | docs/dev/ADR-011-progressive-planning-escalation.md | Status: Accepted (mostly implemented) | unverifiable | NEEDS-USER | Confirm or adjust the label |
| 14 | docs/dev/ADR-013-memory-store-consolidation.md | Status: Accepted (mostly implemented — Phase 6 preflight/cutover) | unverifiable | NEEDS-USER | Confirm or adjust the label |
| 15 | docs/dev/ADR-036-tool-surface-readiness.md | Status: Accepted (implemented) | unverifiable | NEEDS-USER | Confirm or adjust the label |
| 16 | docs/dev/ci-cd-pipeline.md | Merged PRs auto-promote Dev → Test → Prod via dist-tags (publishes gsd-pi@<ver>-dev.<sha> @dev automatically) | stale | fix-doc | Rewrite to describe the manual npm-publish.yml channel flow |
| 17 | docs/dev/ci-cd-pipeline.md | npm run test:fixtures / node tests/fixtures/record.ts | stale | fix-doc | Remove or repoint the fixture-replay commands |
| 18 | docs/dev/extending-pi/03-getting-started.md | Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts) | stale | fix-doc | Rename command examples to `gsd` |
| 19 | docs/dev/extending-pi/06-the-extension-lifecycle.md | Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts) | stale | fix-doc | Rename command examples to `gsd` |
| 20 | docs/dev/extending-pi/10-custom-tools-giving-the-llm-new-abilities.md | Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts) | stale | fix-doc | Rename command examples to `gsd` |
| 21 | docs/dev/extending-pi/19-packaging-distribution.md | Uses `pi` CLI in examples (e.g. pi -e ./my-extension.ts) | stale | fix-doc | Rename command examples to `gsd` |
| 22 | docs/dev/superpowers/plans/2026-03-17-cicd-pipeline.md | Plan targets tests/fixtures/* replay harness and an auto Dev→Prod promotion pipeline | stale | fix-doc | Archive the plan or annotate superseded-by current pipeline |
| 23 | docs/dev/what-is-pi/01-what-pi-is.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 24 | docs/dev/what-is-pi/03-the-four-modes-of-operation.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 25 | docs/dev/what-is-pi/06-tools-how-pi-acts-on-the-world.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 26 | docs/dev/what-is-pi/10-providers-models-multi-model-by-default.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 27 | docs/dev/what-is-pi/13-context-files-project-instructions.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 28 | docs/dev/what-is-pi/14-the-sdk-rpc-embedding-pi.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 29 | docs/dev/what-is-pi/15-pi-packages-the-ecosystem.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 30 | docs/dev/what-is-pi/17-file-reference-all-documentation.md | Lists docs/what-is-pi/19-... and docs/session.md under the installed package root | stale | fix-doc | Correct the relative paths |
| 31 | docs/dev/what-is-pi/18-quick-reference-commands-shortcuts.md | Uses `pi` as the CLI binary in command examples | stale | fix-doc | Rename command examples to `gsd` (or note the upstream binary name explicitly) |
| 32 | docs/dev/what-is-pi/19-building-branded-apps-on-top-of-pi.md | References packages/coding-agent/* and packages/web-ui/README.md | stale | fix-doc | Repoint to the gsd-pi layout |
| 33 | docs/prompt-db-combined-map.md | DISPATCH_RULES has 29 rules | stale | fix-doc | Update the rule count or drop the number |
| 34 | docs/superpowers/plans/2026-06-21-gsd-core-pi-backwards-compat.md | References docs/how-to/switching-between-gsd-tools.md | stale | fix-doc | Repoint the link |
| 35 | docs/superpowers/specs/2026-06-21-gsd-core-pi-backwards-compat-design.md | References docs/how-to/switching-between-gsd-tools.md | stale | fix-doc | Repoint the link |
| 36 | docs/user-docs/claude-code-subscription.md | curl -fsSL https://claude.ai/install.sh \| bash installer | unverifiable | NEEDS-USER | None — external vendor command |
| 37 | docs/user-docs/skills.md | npx skills add/check/update third-party CLI | unverifiable | NEEDS-USER | None — external tool reference |
| 38 | docs/zh-CN/user-docs/commands.md | `gsd --debug` top-level flag enables diagnostic logging | stale | fix-doc | Remove the row or scope it to /gsd auto --debug |
| 39 | gitbook/features/skills.md | npx skills add/check/update third-party CLI | unverifiable | NEEDS-USER | None — external tool reference |
| 40 | gitbook/reference/cli-flags.md | `gsd --debug` top-level flag enables diagnostic logging | stale | fix-doc | Remove the row or scope it to /gsd auto --debug |
| 41 | packages/pi-agent-core/README.md | Titles and install/import examples use @earendil-works/pi-agent-core | stale | NEEDS-USER | Vendored upstream doc: either accept drift per overlay policy or carry a rename patch in the allowlist |
| 42 | packages/pi-agent-core/docs/agent-harness.md | References packages/agent/test/harness/* and src/harness/env/nodejs.ts | stale | NEEDS-USER | Vendored upstream doc — accept drift or patch in allowlist |
| 43 | packages/pi-agent-core/docs/observability.md | Refers to packages/ai and packages/agent | stale | NEEDS-USER | Vendored upstream doc — accept drift or patch in allowlist |
| 44 | packages/pi-ai/README.md | Titles and install/import examples use @earendil-works/pi-ai | stale | NEEDS-USER | Vendored upstream doc: either accept drift per overlay policy or carry a rename patch in the allowlist |
| 45 | packages/pi-coding-agent/README.md | Titles and install/import examples use @earendil-works/pi-coding-agent | stale | NEEDS-USER | Vendored upstream doc: either accept drift per overlay policy or carry a rename patch in the allowlist |
| 46 | packages/pi-coding-agent/docs/compaction.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 47 | packages/pi-coding-agent/docs/custom-provider.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 48 | packages/pi-coding-agent/docs/development.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 49 | packages/pi-coding-agent/docs/extensions.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 50 | packages/pi-coding-agent/docs/index.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 51 | packages/pi-coding-agent/docs/json.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 52 | packages/pi-coding-agent/docs/keybindings.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 53 | packages/pi-coding-agent/docs/models.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 54 | packages/pi-coding-agent/docs/packages.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 55 | packages/pi-coding-agent/docs/prompt-templates.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 56 | packages/pi-coding-agent/docs/providers.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 57 | packages/pi-coding-agent/docs/quickstart.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 58 | packages/pi-coding-agent/docs/rpc.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 59 | packages/pi-coding-agent/docs/sdk.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 60 | packages/pi-coding-agent/docs/session-format.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 61 | packages/pi-coding-agent/docs/sessions.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 62 | packages/pi-coding-agent/docs/settings.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 63 | packages/pi-coding-agent/docs/shell-aliases.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 64 | packages/pi-coding-agent/docs/skills.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 65 | packages/pi-coding-agent/docs/terminal-setup.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 66 | packages/pi-coding-agent/docs/termux.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 67 | packages/pi-coding-agent/docs/themes.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 68 | packages/pi-coding-agent/docs/tui.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 69 | packages/pi-coding-agent/docs/usage.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 70 | packages/pi-coding-agent/docs/windows.md | Uses upstream `pi` binary / ~/.pi/ paths / @earendil-works scope | stale | NEEDS-USER | Vendored upstream doc — accept drift or carry rename patches in the allowlist |
| 71 | packages/pi-coding-agent/examples/extensions/README.md | Upstream `pi`/`~/.pi` references | stale | NEEDS-USER | Accept drift or patch in allowlist |
| 72 | packages/pi-coding-agent/examples/sdk/README.md | Upstream scope/binary references | stale | NEEDS-USER | Accept drift or patch in allowlist |
| 73 | packages/pi-coding-agent/test/suite/README.md | Directs to faux provider at packages/ai/src/providers/faux.ts | stale | fix-doc | Update the path to packages/pi-ai/... |
| 74 | packages/pi-tui/README.md | Titles and install/import examples use @earendil-works/pi-tui | stale | NEEDS-USER | Vendored upstream doc: either accept drift per overlay policy or carry a rename patch in the allowlist |
| 75 | plans/README.md | Index omits rows for plans 040-044 | stale | fix-doc | Add rows for 040-044 |
| 76 | plans/README.md | Note says plan 032's file was lost and is NOT recoverable | stale | NEEDS-USER | Resolve the duplicate 032 numbering (renumber or annotate) |
| 77 | vscode-extension/CHANGELOG.md | Changelog records [1.0.0] - 2026-05-22 as the only release | stale | NEEDS-USER | Decide the extension's real version line and align changelog vs package.json |
