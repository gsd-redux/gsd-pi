# M003 S01 — Lifecycle command writer research

Status: converged implementation contract
Scope: database-only typed primitives; no production handler or read-authority cutover

## Decision

M003 reuses the v31-v35 canonical tables. S01 adds narrow writers that can run
only inside `executeDomainOperation`; it does not add v36, expose a database
adapter, start nested transactions, or import tool handlers.

The public primitives are:

- `readDomainOperationFence(idempotencyKey?)`
- `adoptOrTransitionLifecycle(context, input)`
- `claimRunningAttempt(context, input)`
- `settleAttemptWithResult(context, input)`
- `appendKernelCheckpoint(context, input)` for later same-Attempt stages
- `compareLifecycleShadow(legacyStatus, canonicalStatus)`

The Domain Operation caller continues to own semantic events and Projection
Work. Generated writer identities are returned for composition inside the
callback; replayed callers recover durable state by query rather than rerunning
the callback.

## Replay fence

For a fresh or omitted idempotency key, `readDomainOperationFence` returns the
current project id, revision, Authority Epoch, and `replay: false`. For an
existing project-scoped key it returns that operation's original expected
revision and epoch with `replay: true`. This lets a lost-response retry rebuild
the original request after project revision has advanced.

A concurrent fresh request can still become stale between the read and write;
`executeDomainOperation` remains the compare-and-swap authority and fails the
loser without residue.

## Lifecycle adoption and transition

The legacy milestone/slice/task row must already exist because v32 lifecycle
rows carry exact hierarchy foreign keys. Adoption inserts one lifecycle head at
state version zero with the supplied canonical status and the current operation
tuple. It returns `adopted: true`; this marker is not fabricated as historical
Attempts or Results.

An existing head either:

- returns a no-op result when the requested status already matches; or
- changes status once, increments `state_version` by one, and advances exact
  operation/revision/epoch provenance.

The schema permits only:

- pending -> ready or cancelled;
- ready -> in_progress, paused, or cancelled;
- in_progress -> paused, completed, or cancelled;
- paused -> ready, in_progress, or cancelled; and
- completed/cancelled -> ready.

The writer does not weaken these triggers or map a terminal reopen directly to
`in_progress`.

## Attempt and Result ordering

v32 records claim and settlement provenance but has no start-operation tuple.
S01 therefore uses `claimRunningAttempt`, which atomically:

1. verifies the lifecycle, worker, live held lease, and optional dispatch scope;
2. derives the next gap-free Attempt number and immediate retry predecessor;
3. inserts the Attempt directly in `running` with `claimed_at` and `started_at`;
4. inserts the first `execute` Kernel checkpoint with the same claim operation.

A separate claimed-to-running command is deferred unless a later explicit
migration adds start provenance. Dispatch integration also remains deferred;
its existing claim API does not validate lease expiry, while the Attempt trigger
does.

Settlement runs in a later Domain Operation. It updates the running Attempt to
`settled`, sets its exact settlement tuple, and then inserts one immutable
Result whose tuple must equal the settlement. Typed validation rejects blank
timestamps, invalid JSON values, and blank failure classes even where v32 DDL
is deliberately looser. A later handler adapter transitions the lifecycle and
marks the coordination dispatch terminal in the same outer operation.

## Kernel checkpoint contract

The root checkpoint is sequence one, stage `execute`, has no predecessor, and
shares the Attempt claim tuple. A retry's new `execute` checkpoint extends the
current lifecycle head and uses an Attempt whose `retry_of_attempt_id` is the
previous checkpoint's Attempt. Later same-Attempt stages extend the current
head by one revision. Full execute/verify/route/closeout policy belongs to the
Lifecycle Kernel milestone, not this writer primitive.

## Semantic comparison

`compareLifecycleShadow` is pure and returns one of:

- `match`
- `semantic_match_exact_delta`
- `missing_shadow`
- `extra_shadow`
- `status_mismatch`

Every result preserves raw and normalized statuses. Legacy aliases normalize
as follows:

- pending/queued/planned -> pending, accepting canonical pending or ready;
- active/in_progress/in-progress -> in_progress, accepting in_progress or
  ready for the terminal-reopen ambiguity;
- parked/blocked -> paused;
- complete/done/closed -> completed; and
- skipped/deferred -> cancelled.

Unknown or blank legacy values are `status_mismatch`; they are never cast into
a canonical status. `ready` is a semantic match only for the two legacy
vocabularies that cannot distinguish dependency waiting from dispatchable or
newly reopened work. The exact delta remains visible.

## RED and verification contract

The executable contract proves:

1. adoption and legal transition with exact operation provenance;
2. current and replay fence selection after revision advance;
3. running Attempt claim, failed settlement Result, and deterministic retry;
4. one first `execute` checkpoint per new Attempt;
5. invalid retry and forged context rollback with no residue;
6. close/reopen durability;
7. all five comparison classifications with exact values;
8. a real two-process same-fence race; and
9. module loading without any production tool-handler import.

Later GREEN verification adds fault injection, migration/restore, single-writer,
typecheck, authority baseline, and sabotage gates. Production handlers, routing,
legacy reads/responses, import/reconciliation, projection delivery, and closeout
remain unchanged throughout S01.

## Blocking downstream entry gates

These writers are dormant foundations in S01. No production handler may call
`claimRunningAttempt` until S03 proves a lease-loss recovery path. The v32
transition fence requires the original worker and live lease token to settle an
Attempt; after expiry or takeover, that Attempt otherwise remains `running` and
the active-Attempt uniqueness rule prevents retry. S03 must design and test a
schema-authorized recovery/interrupt settlement before enabling the first claim
integration.

S04-S06 must also resolve reopen convergence explicitly. Legacy reopen cascades
land directly on active/pending states, while canonical terminal lifecycles must
first reopen to `ready`. Integration must choose and test an ordered follow-up
operation or a deliberate observable shadow delta; it must not silently claim
exact parity in one revision.
