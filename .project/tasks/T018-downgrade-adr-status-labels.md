---
id: T018
title: Downgrade ADR-004/-009/-011/-013/-036 status labels to audit-verified reality
wave: 3
deps: []
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - docs/dev/ADR-004-capability-aware-model-routing.md
  - docs/dev/ADR-009-orchestration-kernel-refactor.md
  - docs/dev/ADR-011-progressive-planning-escalation.md
  - docs/dev/ADR-013-memory-store-consolidation.md
  - docs/dev/ADR-036-tool-surface-readiness.md
---

# T018 — Fix-doc: downgrade five ADR status labels to match code reality

## Context

User-accepted fix-doc item (DOCS-AUDIT.md remediation rows 11–15, ruled
2026-08-01): "an ADR labeled Implemented that the auditor can't find is
worse than one honestly labeled Accepted, partially landed". The audit
verdict for each of the five is `unverifiable` from code at HEAD:
- ADR-004 `Status: Implemented (Phase 2)` — capability-routing greps
  inconclusive.
- ADR-009 `Status: Accepted (implemented; emergency legacy fallback
  retained)` — no `OrchestrationKernel` symbol found by name.
- ADR-011 `Status: Accepted (mostly implemented)` — escalation greps match
  unrelated recovery code.
- ADR-013 `Status: Accepted (mostly implemented — Phase 6
  preflight/cutover)` — memory-store greps inconclusive.
- ADR-036 `Status: Accepted (implemented)` — no tool-surface-readiness
  symbol found by name.

## Steps

1. For each ADR, do a targeted code trace at HEAD (not just greps): find
   what actually landed relative to the ADR's scope, and pick the honest
   replacement label from this fixed vocabulary: `Accepted (partially
   landed — <what exists>)`, `Accepted (landed under different names —
   <where>)`, or `Accepted (implementation not verified at HEAD)`. Do NOT
   use `Implemented` anywhere the trace cannot confirm it.
2. Replace ONLY the Status line (and, where the body asserts completion
   that the trace contradicts, append a one-line `> Implementation note
   (2026-08-01 audit): …` directly under the Status line citing what the
   trace found). Do not rewrite the ADR bodies.
3. Record the per-ADR trace evidence (symbols/paths found or not found) in
   the task Log.

## Acceptance criteria

1. No Status line in the five files claims `Implemented` or
   `(implemented)`/`(mostly implemented)` without trace evidence recorded
   in the Log.
2. Each file's new label comes from the fixed vocabulary and matches its
   trace.
3. Audit claim check re-run: each Status claim is now confirmable or
   honestly labeled unconfirmed.

## Verify

```bash
! grep -nE "^\*\*Status:\*\*.*([Ii]mplemented)" docs/dev/ADR-004-capability-aware-model-routing.md docs/dev/ADR-009-orchestration-kernel-refactor.md docs/dev/ADR-011-progressive-planning-escalation.md docs/dev/ADR-013-memory-store-consolidation.md docs/dev/ADR-036-tool-surface-readiness.md && grep -lE "partially landed|landed under different names|implementation not verified" docs/dev/ADR-004-capability-aware-model-routing.md docs/dev/ADR-009-orchestration-kernel-refactor.md docs/dev/ADR-011-progressive-planning-escalation.md docs/dev/ADR-013-memory-store-consolidation.md docs/dev/ADR-036-tool-surface-readiness.md | wc -l | grep -q 5
```

## Log

- 2026-08-01 — created by planner
