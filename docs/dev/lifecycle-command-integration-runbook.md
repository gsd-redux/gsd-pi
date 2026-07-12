<!-- Project/App: gsd-pi -->
<!-- File Purpose: Integration and verification runbook for canonical lifecycle command writers. -->

# Lifecycle command integration runbook

This runbook governs the command primitives introduced in M003/S01 and first
adopted by planning in M003/S02. They write canonical lifecycle, Attempt,
Result, and Kernel checkpoint facts only inside an active Domain Operation.
Milestone, slice, and task planning, task and slice replanning, and roadmap
reassessment now use the lifecycle and replay-fence subset. Legacy hierarchy
reads and public responses remain the compatibility contract until a later,
separately proven read-authority cutover.

## Command boundary

1. Read the current or replay fence with `readDomainOperationFence`.
2. Start one semantic Domain Operation with that expected revision and Authority
   Epoch.
3. Run the legacy compatibility mutation and the matching canonical writer in
   the same callback.
4. Compare legacy and canonical states with `compareLifecycleShadow`; preserve
   the raw statuses even when the normalized states agree.
5. Return the legacy response during M003. Projection delivery follows the
   committed operation and cannot compensate canonical state backward.

Handlers must use `normalizeLegacyLifecycleStatus` and the exported
`CanonicalLifecycleStatus` type. Do not duplicate alias tables in tools,
commands, or orchestration modules.

## S02 planning boundary

- Planning handlers carry a private `PlanningInvocation`; Pi keys use the
  canonical tool name and tool-call ID, while workflow MCP requires a nonblank
  `io.opengsd/idempotency-key` in private request metadata. Missing identity
  fails before mutation because request/session IDs are not replay-stable.
- A planning mutation, lifecycle adoption or transition, shadow comparison,
  event/outbox rows, Projection Work, and authority revision commit atomically.
  Projection rendering follows commit; replay retries rendering without
  rerunning the mutation or duplicating compatibility events. Replan and
  reassessment projections read their content and creation time from the
  committed domain event or assessment row, so a replay reproduces the
  original artifact instead of the retry payload or clock.
- Removed pending tasks and slices retain their hierarchy identity as legacy
  `skipped` and canonical `cancelled`. Active plan projections omit them, and
  their IDs cannot be reused until the matching reopen command succeeds. Stale
  PLAN cleanup removes only content still owned by the compatibility marker or
  PLAN artifact; a user-modified file is preserved.
- Restore, hierarchy replacement, milestone discard, and worktree teardown fail
  closed when they would erase or strand adopted canonical history.

## Entry gates for later slices

- S03 must prove a schema-authorized interrupted settlement and retry after the
  original lease expires or is replaced. Until then, no production handler may
  call `claimRunningAttempt`.
- Kernel stage policy remains outside S01. Do not call
  `appendKernelCheckpoint` directly from production until S03 defines the
  allowed stage/state matrix.
- S04-S06 must make terminal reopen ordering explicit. Canonical
  `completed/cancelled -> ready -> in_progress` cannot be represented as exact
  one-revision parity with legacy complete-to-active/pending cascades.

## Verification loop

Run the smallest focused gate while editing, then the adjacent contract matrix:

```sh
pnpm exec tsx --test src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts
pnpm exec tsx --test \
  src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts \
  src/resources/extensions/gsd/tests/db-lifecycle-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-projection-closeout-foundation.test.ts \
  src/resources/extensions/gsd/tests/domain-operation.test.ts \
  src/resources/extensions/gsd/tests/single-writer-invariant.test.ts
pnpm run typecheck:extensions
pnpm run baseline:workflow-authority
pnpm run baseline:refactor:gate
pnpm run test:changed:src
```

Before merging, also run `pnpm run verify:merge`. For every new invariant, prove
the corresponding test fails under a temporary sabotage, restore the source,
and rerun the focused gate.
