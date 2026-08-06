---
id: T017
title: Rewrite docs/dev/ci-cd-pipeline.md to document the manual npm-publish.yml reality
wave: 3
deps: []
status: in-progress
agent: build_T017
commit: null
base: 291e71c154aac359be01cc38a34dccd992ab47b4
worktree: .worktrees/gsd-path-T017
task_branch: gsd-path/T017
files:
  - docs/dev/ci-cd-pipeline.md
---

# T017 — Fix-doc: ci-cd-pipeline.md documents the manual publish reality

## Context

User-accepted fix-doc item (DOCS-AUDIT.md remediation queue,
`## User rulings` 2026-08-01): `docs/dev/ci-cd-pipeline.md` still describes
an automatic Dev → Test → Prod dist-tag promotion pipeline, but
`.github/workflows/pipeline.yml` now only rebuilds the CI builder image —
its header states "npm publishing lives in one trusted manual workflow
(npm-publish.yml)" — and `.github/workflows/npm-publish.yml` is
`workflow_dispatch` (manual). The audit also flagged stale commands:
`npm run test:fixtures` / `node tests/fixtures/record.ts` (absent from
package.json; `tests/fixtures/` does not exist). A contributor following
the current doc would wait for promotions that never happen.

## Steps

1. Read `docs/dev/ci-cd-pipeline.md`, `.github/workflows/pipeline.yml`, and
   `.github/workflows/npm-publish.yml` (note the manual channel input:
   "npm dist-tag or release path to publish; latest publishes/verifies
   @dev first, then waits for prod approval", and the concurrent-publish /
   dist-tag-mutation guards).
2. Rewrite the doc to describe reality: (a) `pipeline.yml` = CI builder
   image rebuild only (triggered by CI completion on main or manual
   dispatch); (b) npm publishing is exclusively the manual
   `npm-publish.yml` `workflow_dispatch` flow — document the channel input,
   the @dev-first-then-prod-approval sequence, and the manual dist-tag
   move escape hatch (`npm dist-tag add @opengsd/gsd-pi@<version>
   <channel>`) the workflow's own error messages reference; (c) remove the
   automatic Dev→Test→Prod promotion description entirely; (d) remove or
   repoint the `test:fixtures` / `tests/fixtures/record.ts` commands to
   real commands from package.json.
3. Keep the doc's remaining accurate content (CI workflow inventory,
   builder-image details) intact — surgical rewrite of the publish
   sections only.

## Acceptance criteria

1. The doc contains no claim of automatic Dev→Test→Prod promotion.
2. The doc names `npm-publish.yml`, `workflow_dispatch`, and the
   @dev-first/prod-approval sequence.
3. No reference to `test:fixtures` or `tests/fixtures/record.ts` remains.
4. Every command in the doc exists in package.json or a workflow file
   (re-run the audit's claim check mechanically).

## Verify

```bash
! grep -qiE "auto-?promot|automatic.*promotion" docs/dev/ci-cd-pipeline.md && grep -q "npm-publish.yml" docs/dev/ci-cd-pipeline.md && grep -q "workflow_dispatch" docs/dev/ci-cd-pipeline.md && ! grep -q "test:fixtures\|tests/fixtures/record" docs/dev/ci-cd-pipeline.md
```

## Log

- 2026-08-01 — created by planner
