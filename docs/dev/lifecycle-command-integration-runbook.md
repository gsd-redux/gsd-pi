<!-- Project/App: gsd-pi -->
<!-- File Purpose: Integration and verification runbook for canonical lifecycle command writers. -->

# Lifecycle command integration runbook

This runbook governs the dormant command primitives introduced in M003/S01.
They write canonical lifecycle, Attempt, Result, and Kernel checkpoint facts only
inside an active Domain Operation. Legacy hierarchy reads and responses remain
authoritative until a later, separately proven cutover.

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

## Entry gates for later slices

- S02 must introduce automation-aware, typed failure routing before handlers
  depend on command errors.
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
