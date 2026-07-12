# M002 S06 — Revision-checked Domain Operation research

**Status:** Converged implementation contract
**Scope:** Additive transaction primitive only; no production handler or authority cutover

## Decision

S06 adds one deep Domain Operation module with one public execution method. The
module hides transaction ordering, authority compare-and-swap, transport
idempotency, provenance, immutable events, durable outbox rows, and Projection
Work enqueueing behind a small interface.

The module does not expose a database adapter. A fresh operation invokes one
deterministic database-only mutation callback with a frozen operation context.
The callback may compose existing typed writers inside the outer transaction
and returns only ordered event and projection intents. A replay never invokes
the callback and returns the original stored receipt.

This keeps the transaction seam useful for the command-specific writers that
later milestones add without teaching S06 every lifecycle, conversation,
recovery, import, and closeout command prematurely.

## Public interface

```ts
executeDomainOperation(
  request: DomainOperationRequest,
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult
```

`DomainOperationRequest` contains:

- operation type and project-scoped idempotency key;
- expected project revision and Authority Epoch;
- actor type/id, source transport, and optional trace/turn identifiers;
- a JSON-compatible payload that completely describes the requested domain
  intent; and
- whether this operation explicitly advances the Authority Epoch.

The module canonicalizes and hashes the semantic request. Callers cannot supply
or spoof `request_hash`.

`DomainOperationMutation` contains:

- one or more ordered domain events;
- one or more durable outbox destinations attached to each event; and
- one or more logical Projection Work targets.

The result contains only a durable receipt:

- `committed | replayed`;
- operation/project identity;
- resulting revision and Authority Epoch;
- request hash; and
- stored event, outbox, and projection identities.

There is no arbitrary callback return value because v31 stores no generic
response payload that could be reconstructed after a lost response.

## Commit algorithm

Inside one `BEGIN IMMEDIATE` transaction:

1. Read the singleton project authority and look up the project-scoped
   idempotency key before checking current revision.
2. On an existing key, require the same operation type, canonical request hash,
   actor, transport, and expected revision/epoch. Return the stored receipt
   without running the mutation. Any mismatch is an idempotency conflict.
3. On a fresh key, require the exact expected revision and Authority Epoch.
4. Derive `resulting_revision = expected_revision + 1`; retain the epoch unless
   the request explicitly advances it by exactly one.
5. Insert the immutable operation provenance row.
6. Invoke the deterministic mutation exactly once with a frozen context.
7. Insert a gap-free event sequence, its event-linked outbox destinations, and
   per-logical-key Projection Work successors using the same operation tuple.
8. Advance `project_authority` with a revision-and-epoch CAS and require exactly
   one changed row.
9. Commit and return the stored receipt.

Any validation, mutation, event, outbox, projection, or CAS failure rolls the
whole operation back. Database mutation errors are never caught inside the
transaction.

## Deterministic ownership

The Domain Operation module owns:

- canonical JSON and `sha256:` request hashing;
- exact stale revision/epoch and idempotency-conflict errors;
- one reserved-writer transaction;
- operation/event/outbox/projection identity and ordering;
- per-key projection supersession; and
- receipt reconstruction after restart.

Command-specific typed writers own:

- lifecycle and stage prerequisites;
- exact sibling facts for Attempts, conversation, recovery, verification,
  import, and closeout;
- policy classification and bounded recovery choice; and
- semantic event vocabulary and projection targets.

Database constraints continue to reject impossible local facts. They do not
select policy or simulate the Lifecycle Kernel.

## RED and fault contract

The focused test must prove:

1. A successful operation advances revision once and atomically creates one
   operation, gap-free events, linked outbox rows, and Projection Work.
2. A second operation for the same projection key extends the current head.
3. Stale revision and stale Authority Epoch fail loudly with zero residue.
4. Exact replay returns the original receipt and never reruns the mutation.
5. Reusing a key with changed semantic input is a hard conflict.
6. Faults after operation insert, mutation, events, outbox, projections, or
   before CAS leave the exact pre-operation snapshot.
7. A simulated lost response after commit replays the original receipt.
8. Two independent writers racing the same expected tuple produce one commit
   and one stale result, never orphan rows or an exposed `SQLITE_BUSY` result.
9. Independent close/reopen preserves replay and receipt identity.
10. Explicit epoch advance increments by one; ordinary operations retain it.
11. The same contract works after a v30-to-v35 upgrade and restored-backup
    upgrade without importing canonical rows merely by opening the database.

Sabotage targets are transaction removal, weakened revision/epoch CAS,
idempotency replay without request-hash comparison, callback execution during
replay, and projection enqueue after commit.

## Deferred cutover map

S06 does not change handlers or runtime authority. Later milestones add, in
order:

1. command-specific lifecycle/Attempt/Result/checkpoint writers;
2. a fenced Projection Worker and removal of projection rollback behavior;
3. explicit Import Preview/Application with verified backup and no implicit
   disk import;
4. shared prepare/settle closeout and idempotent host-effect adapters;
5. auto, interactive, guided, UOK, custom, and legacy adapters over one Kernel;
6. removal of file-derived readiness, completion, UAT, and reconciliation
   authority after shadow evidence and compatibility windows pass.

## Expected files

- `src/resources/extensions/gsd/db/domain-operation.ts`
- `src/resources/extensions/gsd/tests/domain-operation.test.ts`
- `src/resources/extensions/gsd/gsd-db.ts`
- `src/resources/extensions/gsd/tests/single-writer-invariant.test.ts`
- `docs/dev/refactor-foundation-runbook.md`

Schema version remains v35.
