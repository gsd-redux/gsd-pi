---
id: T017
title: Rewrite docs/dev/ci-cd-pipeline.md to document the manual npm-publish.yml reality
wave: 3
deps: []
status: done
agent: build_T017
commit: c507999eb25cd8f385e8570403785068397a47f3
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
- 2026-08-05 — coder: rewrote `docs/dev/ci-cd-pipeline.md` against the real
  `.github/workflows/`. Replaced the Dev→Test→Prod promotion overview/diagram
  with the actual topology: `ci.yml` is the merge gate, `pipeline.yml` only
  rebuilds `ghcr.io/open-gsd/gsd-ci-builder:latest` (guarded on
  `Dockerfile`/`package.json`/`pipeline.yml` diffs), and `npm-publish.yml`
  `workflow_dispatch` is the sole npm publisher. Documented the `channel`
  input (dev/next/latest), the `ref` and `publish_auth` inputs, the
  @dev-publish-and-verify-then-`prod`-environment-approval sequence for
  `latest`, the concurrent-publish idempotent-skip guard, and the manual
  `npm dist-tag add @opengsd/gsd-pi@<version> <channel>` escape hatch the
  workflow's own error messages print. Corrected the workflow inventory
  (`build-native.yml` is `workflow_dispatch`, not `v*` tags; `ci.yml` branch
  list), replaced the `RUN_LIVE_TESTS` row and `test` environment with the
  real `next`/`prod` environments plus `RELEASE_PAT` /
  `DISCORD_CHANGELOG_WEBHOOK`, dropped the nonexistent `:next` Docker tag,
  fixed `cache: 'npm'` → `cache: pnpm`, and replaced the entire "LLM Fixture
  Tests" section (no `test:fixtures` script, no `tests/fixtures/`, no
  `GSD_FIXTURE_*` code anywhere in the repo) with a "Live Test Suites"
  section covering the real `test:smoke` / `test:live-regression` /
  `test:live` / `test:live-workflow` scripts and `GSD_SMOKE_BINARY`.
  Left the CI job tiers, change-detection, prompt-injection-scan, and npm
  trusted-publishing sections untouched (verified still accurate).
- 2026-08-05 — coder: mechanical claim re-check — all 14 `npm run` scripts
  referenced in the doc exist in package.json; all 9 `*.yml` names exist in
  `.github/workflows/`; `scripts/verify-npm-release.mjs`,
  `scripts/ci-classify-changes.sh`, `scripts/docs-prompt-injection-scan.sh`,
  `.prompt-injection-scanignore`, `.secretscanignore`, and
  `docs/dev/test-confidence-stack.md` all exist.
- 2026-08-05 — coder: Verify result — command run in the T017 worktree:
  `! grep -qiE "auto-?promot|automatic.*promotion" docs/dev/ci-cd-pipeline.md && grep -q "npm-publish.yml" docs/dev/ci-cd-pipeline.md && grep -q "workflow_dispatch" docs/dev/ci-cd-pipeline.md && ! grep -q "test:fixtures\|tests/fixtures/record" docs/dev/ci-cd-pipeline.md`
  → exit=0 (PASS), no output.
- 2026-08-05 — coder note (non-blocking): the dispatch brief named
  `AGENTS.md` as project conventions, but no `AGENTS.md` exists at the
  worktree root. Used `CONTRIBUTING.md` conventions (no drive-by
  reformatting, surgical diff) instead. No file outside `files` was touched.
- 2026-08-05 — orchestrator Verify rerun (authoritative, isolated worktree):
  exit 0 — no auto-promotion claim, `npm-publish.yml` and `workflow_dispatch`
  both named, zero `test:fixtures`/`tests/fixtures/record` references. Diff
  scope check: 1 declared file plus the task file; zero paths outside `files`.
