<!-- Project/App: gsd-pi -->
<!-- File Purpose: Primary-source trace and integration recommendation for M003/S03 task execution adoption. -->

# M003/S03 task execution research

Status: research complete  
Scope: current task claim, start, completion, failure, retry, lost-response, event, projection, dispatch, and Kernel-checkpoint behavior  
Sources: repository source, tests, accepted design records, and local Git history at `0bd4d431`

## Outcome

Task execution currently has three independent state machines:

1. auto-mode's best-effort `unit_dispatches` coordination ledger;
2. the legacy task row plus `gsd_task_complete`, Markdown, JSONL, runtime files,
   and process-local retry state; and
3. the canonical Lifecycle, Attempt, Result, Domain Operation, Projection Work,
   and Kernel-checkpoint tables introduced by M002/M003 but not used by task
   execution.

The result is not merely duplicated bookkeeping. Each state machine can reach a
different conclusion about whether a Task is running, failed, retryable,
verified, or complete. The highest-risk inversion is that `gsd_task_complete`
marks the legacy Task complete before host-owned verification, while the
verification runner explicitly treats a later failure as non-blocking when the
Task is already complete
([`complete-task.ts`, lines 395-524](../../src/resources/extensions/gsd/tools/complete-task.ts#L395-L524);
[`auto-verification.ts`, lines 816-879](../../src/resources/extensions/gsd/auto-verification.ts#L816-L879)).

**Recommendation:** put the S03 seam at one Task Execution Domain module with
two transaction-separated commands: `claimTaskAttempt` and
`settleTaskAttempt`. Claim must atomically move the canonical Task lifecycle to
`in_progress`, create the fenced Attempt, link the coordination dispatch, emit
the semantic event and Projection Work, and append the `execute` checkpoint.
Settlement must atomically persist exactly one immutable Result and append the
next checkpoint (`verify` after an executor success, `route` after failure or
interruption). It must not complete the Task. Verification and closeout remain
later Kernel stages.

This is the narrowest deep module because a provider call necessarily separates
claim from settlement; collapsing them would require holding a database
transaction across model execution, while exposing more commands would leak
stage policy back into handlers. The accepted architecture assigns sequencing,
claims, stages, and outcomes to the Lifecycle Kernel and database mutations to
Domain Operations
([ADR-046, lines 130-147](ADR-046-database-authoritative-workflow-lifecycle.md#L130-L147);
[ADR-046, lines 209-220](ADR-046-database-authoritative-workflow-lifecycle.md#L209-L220)).

## Current public-to-persistence flow

### 1. Selection and claim

`/gsd auto` and `/gsd next` converge on the auto loop. After reconciliation,
dispatch selection, worktree checks, and model preparation, the loop attempts to
hold a milestone lease and calls `openDispatchClaim`
([`auto/loop.ts`, lines 1242-1317](../../src/resources/extensions/gsd/auto/loop.ts#L1242-L1317)).

`openDispatchClaim` derives `attempt_n` by reading the most recent dispatch,
inserts a `unit_dispatches` row, then calls `markDispatchRunning` as a separate
write. Missing worker/lease/milestone state or any unexpected write error returns
`degraded`
([`workflow-dispatch-claim.ts`, lines 122-178](../../src/resources/extensions/gsd/auto/workflow-dispatch-claim.ts#L122-L178)).
The loop's pure decision function intentionally converts `degraded` into
`{ action: "run", dispatchId: null }`, so execution proceeds without a durable
claim
([`workflow-kernel.ts`, lines 250-268](../../src/resources/extensions/gsd/auto/workflow-kernel.ts#L250-L268)).

The ledger insert validates that the supplied lease row is held and uses a
partial unique index to prevent another active dispatch for the same `unit_id`.
It also cancels an existing active dispatch when a different worker or fencing
token takes over
([`db/unit-dispatches.ts`, lines 101-163](../../src/resources/extensions/gsd/db/unit-dispatches.ts#L101-L163);
[`db/unit-dispatches.ts`, lines 165-270](../../src/resources/extensions/gsd/db/unit-dispatches.ts#L165-L270)).
It does not validate lease expiry. The subsequent `claimed -> running` update is
silent if it changes no row and emits no start event
([`db/unit-dispatches.ts`, lines 272-280](../../src/resources/extensions/gsd/db/unit-dispatches.ts#L272-L280)).

No public task start handler changes the legacy Task status or creates a
canonical Attempt. The planned Task is normally canonical `ready`; the canonical
Attempt writers remain gated off from production until S03 proves lease-loss
interruption and retry
([`lifecycle-command-integration-runbook.md`, lines 51-58](lifecycle-command-integration-runbook.md#L51-L58)).

### 2. Runtime start and executor dispatch

`runUnitPhase` records process/runtime state after the dispatch claim:

- process-local `currentUnit` and current phase;
- a best-effort `unit-start` journal entry;
- `.gsd/runtime/units/*.json` with phase `dispatched`;
- supervision state and an `auto.lock` file; and
- a Git safety checkpoint for `execute-task`.

It then calls `runUnit`
([`auto/unit-phase.ts`, lines 438-513](../../src/resources/extensions/gsd/auto/unit-phase.ts#L438-L513)).
`runUnit` creates a session, captures an in-memory turn generation, sends the
prompt, and waits for `agent_end` or a hard timeout. Its timeout deferral reads
the runtime JSON file, not a canonical Attempt checkpoint
([`auto/run-unit.ts`, lines 244-325](../../src/resources/extensions/gsd/auto/run-unit.ts#L244-L325)).

At this point the authoritative-looking records disagree:

- `unit_dispatches` may be `running` or may not exist;
- the legacy Task is still `pending`;
- its canonical lifecycle is still `ready`; and
- `workflow_execution_attempts` and `workflow_kernel_checkpoints` have no row.

### 3. Agent-side completion

The executor prompt requires the agent to call `gsd_task_complete` before it
finishes, but also says auto-mode decides when the Task is actually done
([`prompts/execute-task.md`, lines 68-82](../../src/resources/extensions/gsd/prompts/execute-task.md#L68-L82)).
Both Pi and workflow MCP expose the same executor. The Pi adapter discards the
tool-call ID; MCP serializes the call but supplies no private idempotency or
Attempt identity
([`bootstrap/db-tools.ts`, lines 814-889](../../src/resources/extensions/gsd/bootstrap/db-tools.ts#L814-L889);
[`packages/mcp-server/src/workflow-tools.ts`, lines 1090-1104](../../packages/mcp-server/src/workflow-tools.ts#L1090-L1104)).

`handleCompleteTask` then:

1. validates model-supplied completion prose and optional ownership from the
   separate `.gsd/unit-claims.db`;
2. in one legacy transaction upserts the Task as `complete`, writes mutable
   verification rows, and mutates rework findings;
3. after commit writes `SUMMARY.md` and re-renders PLAN checkboxes;
4. if either projection write fails, compensates the database back to `pending`;
5. performs additional gate and escalation writes outside the first transaction;
6. renders more projections and a manifest; and
7. appends a best-effort `complete-task` JSONL compatibility event.

The core transaction is visible at
[`complete-task.ts`, lines 395-524](../../src/resources/extensions/gsd/tools/complete-task.ts#L395-L524),
the projection compensation at
[`complete-task.ts`, lines 563-618](../../src/resources/extensions/gsd/tools/complete-task.ts#L563-L618),
and the post-mutation projection/event tail at
[`complete-task.ts`, lines 737-774](../../src/resources/extensions/gsd/tools/complete-task.ts#L737-L774).
This ordering directly conflicts with the accepted rule that projection failure
is visible and retryable but never rolls lifecycle authority backward
([ADR-046, lines 92-104](ADR-046-database-authoritative-workflow-lifecycle.md#L92-L104)).

The tool registration claims repeat calls are idempotent, but the handler rejects
a normal second call as “already complete.” Only a stale in-process turn or a
missing SUMMARY projection gets a special duplicate success
([`bootstrap/db-tools.ts`, lines 824-835](../../src/resources/extensions/gsd/bootstrap/db-tools.ts#L824-L835);
[`complete-task.ts`, lines 426-450](../../src/resources/extensions/gsd/tools/complete-task.ts#L426-L450);
[`complete-task.ts`, lines 526-560](../../src/resources/extensions/gsd/tools/complete-task.ts#L526-L560)).

### 4. Agent end, artifact checks, and host verification

After `agent_end`, `runUnitPhase` uses the expected artifact as the immediate
success observation, emits a best-effort `unit-end` JSONL event, and returns
`next`
([`auto/unit-phase.ts`, lines 878-941](../../src/resources/extensions/gsd/auto/unit-phase.ts#L878-L941)).
The JSONL journal itself explicitly never throws, may skip on lock contention,
and silently catches write errors; it is therefore an observability projection,
not authority
([`journal.ts`, lines 1-13](../../src/resources/extensions/gsd/journal.ts#L1-L13);
[`journal.ts`, lines 111-171](../../src/resources/extensions/gsd/journal.ts#L111-L171)).

Finalize then runs host-owned verification. The verifier loads the Task row after
the agent's completion tool. When tests fail and that row is already `complete`,
it clears retry state, reports the failure as non-blocking, and continues
([`auto-verification.ts`, lines 867-879](../../src/resources/extensions/gsd/auto-verification.ts#L867-L879)).
Thus the Task can unlock downstream work despite host verification failure. This
violates the accepted requirements that missing/failed evidence is not a pass and
that required evidence precedes dependency unlock
([ADR-046, lines 167-178](ADR-046-database-authoritative-workflow-lifecycle.md#L167-L178);
[ADR-046, lines 192-207](ADR-046-database-authoritative-workflow-lifecycle.md#L192-L207)).

### 5. Dispatch completion or failure

Only after finalize does the outer loop mark the `unit_dispatches` row completed
and notify the in-memory orchestrator. Any unit break, retry, exception, or
finalize retry instead marks that dispatch failed
([`auto/loop.ts`, lines 1318-1489](../../src/resources/extensions/gsd/auto/loop.ts#L1318-L1489)).
Those ledger writes are deliberately best-effort: a null dispatch is ignored and
write errors are logged then swallowed
([`workflow-dispatch-ledger.ts`, lines 1-44](../../src/resources/extensions/gsd/auto/workflow-dispatch-ledger.ts#L1-L44)).

`markCompleted` and `markFailed` update only active coordination rows, then emit
separate audit events. Neither operation changes Task lifecycle, creates an
immutable Attempt Result, advances the project revision, or appends a Kernel
checkpoint
([`db/unit-dispatches.ts`, lines 287-374](../../src/resources/extensions/gsd/db/unit-dispatches.ts#L287-L374)).

### 6. Retry and lost-response behavior

Retries are selected through outer-loop return values plus session maps and
runtime JSON. A new iteration computes `attempt_n = latest + 1` and creates a new
coordination row. Dispatch history adds another trace-scoped sliding window for
stuck detection
([`workflow-dispatch-claim.ts`, lines 140-155](../../src/resources/extensions/gsd/auto/workflow-dispatch-claim.ts#L140-L155);
[`auto/dispatch-history.ts`, lines 1-26](../../src/resources/extensions/gsd/auto/dispatch-history.ts#L1-L26);
[`auto/dispatch-history.ts`, lines 149-179](../../src/resources/extensions/gsd/auto/dispatch-history.ts#L149-L179)).
This retry number is not the canonical Attempt number and its budget is not a
canonical Recovery Action.

A lost completion response has no stable replay identity:

- Pi discards `_toolCallId` at the completion adapter;
- MCP passes only public task arguments;
- `handleCompleteTask` does not execute a Domain Operation; and
- a process restart loses the turn-generation exception that recognizes one
  class of stale duplicate.

By contrast, the planning path already proves the required pattern: a private,
transport-stable invocation key reopens the original revision fence and exact
replay returns the committed receipt without rerunning the mutation
([`planning-invocation.ts`, lines 1-30](../../src/resources/extensions/gsd/planning-invocation.ts#L1-L30);
[`db/domain-operation.ts`, lines 407-428](../../src/resources/extensions/gsd/db/domain-operation.ts#L407-L428)).

## Dormant canonical execution model

The schema already represents the right durable identities:

- one lifecycle per hierarchy item;
- one active Attempt per lifecycle;
- gap-free retry lineage;
- immutable settled Results;
- optional exact link to `unit_dispatches`;
- worker and milestone fencing provenance; and
- an immutable per-lifecycle Kernel checkpoint chain.

These constraints are enforced in
[`db-lifecycle-foundation-schema.ts`, lines 114-340](../../src/resources/extensions/gsd/db-lifecycle-foundation-schema.ts#L114-L340)
and
[`db-projection-import-kernel-closeout-foundation-schema.ts`, lines 319-428](../../src/resources/extensions/gsd/db-projection-import-kernel-closeout-foundation-schema.ts#L319-L428).

The S01 writers also exist. `claimRunningAttempt` verifies an `in_progress`
lifecycle, live worker/lease/dispatch scope, creates a gap-free running Attempt,
and appends the initial `execute` checkpoint in the same Domain Operation
([`db/writers/lifecycle-commands.ts`, lines 492-590](../../src/resources/extensions/gsd/db/writers/lifecycle-commands.ts#L492-L590)).
`settleAttemptWithResult` atomically settles the Attempt and inserts one immutable
Result
([`db/writers/lifecycle-commands.ts`, lines 593-675](../../src/resources/extensions/gsd/db/writers/lifecycle-commands.ts#L593-L675)).
Tests prove failure settlement followed by a lineage-linked retry and a new
`execute` checkpoint
([`lifecycle-command-writers.test.ts`, lines 473-565](../../src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts#L473-L565)).

They remain dormant because the current transition-fencing trigger requires the
original live lease to settle a running Attempt. If that lease expires or is
replaced, the Attempt cannot settle and the unique active-Attempt index prevents
retry. This is the explicit S03 entry gate
([`plans/043-m003-s01-lifecycle-writer-research.md`, lines 138-146](../../plans/043-m003-s01-lifecycle-writer-research.md#L138-L146)).

## Drift windows, ranked

| Priority | Window | Observable split | Consequence |
|---|---|---|---|
| P0 | Completion before host verification | Task `complete`; no canonical Result/checkpoint; dispatch still `running` | Failed tests can be declared non-blocking and dependencies may unlock. |
| P0 | Lost `gsd_task_complete` response | Task committed; caller sees failure/timeout; retry has no stable operation identity | Retry errors, rewrites a projection, or depends on process-local stale-turn detection rather than exact replay. |
| P0 | Lease expires after canonical claim | Attempt `running`; old worker cannot settle; new worker cannot claim | Permanent dead-end unless S03 adds schema-authorized interrupted settlement. |
| P1 | Dispatch claim degrades | Executor runs with `dispatchId = null` | No durable coordination, attempt number, terminal ledger state, or restart proof. |
| P1 | Claim and running are separate writes | Dispatch `claimed` after crash; no start event | Recovery guesses whether provider execution began. |
| P1 | Agent completion and dispatch settlement are separate | Task `complete` while dispatch can later become `failed`; or dispatch `completed` while its audit event write fails | Task truth, dispatch history, and forensics disagree. |
| P1 | Projection failure after Task completion | Task briefly `complete`, then compensates to `pending`; SUMMARY cleanup may also fail | A projection controls authority and can leave mixed task/evidence/rework state. |
| P1 | Verification failure after completion | Task remains complete; verifier clears retry state | Automation reports a failure but advances anyway. |
| P2 | JSONL/runtime/lock writes are best-effort | Files omit start/end/recovery facts while DB may differ | Restart and forensics consume incomplete projections. |
| P2 | Hook retry resets Task directly | Legacy Task returns to `pending`, SUMMARY is deleted, and plan is rendered outside a Domain Operation | Canonical lifecycle/Attempt history is not advanced with the retry decision ([`auto-post-unit.ts`, lines 2361-2415](../../src/resources/extensions/gsd/auto-post-unit.ts#L2361-L2415)). |

## Recommended deep-module seam

### Interface

Place a Task Execution Domain module beside the planning Domain Operation module,
not in generic status writers, `runUnit`, transport handlers, or the broad auto
loop. Its external interface should have only the two commands forced by the
provider-call boundary:

```ts
claimTaskAttempt(input: {
  invocation: ExecutionInvocation;
  task: { milestoneId: string; sliceId: string; taskId: string };
  workerId: string;
  milestoneLeaseToken: number;
  coordinationDispatchId: number;
}): ClaimTaskAttemptReceipt

settleTaskAttempt(input: {
  invocation: ExecutionInvocation;
  attemptId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
}): SettleTaskAttemptReceipt
```

`ExecutionInvocation` should follow planning's private envelope: stable
idempotency key, normalized transport, actor, trace, and turn identity. Public
tool schemas should not expose correctness tokens. Pi can derive keys from the
canonical operation plus tool-call/dispatch identity; workflow MCP must require a
private replay-stable metadata key, as planning already does
([`plans/044-m003-s02-planning-adoption-research.md`, lines 31-65](../../plans/044-m003-s02-planning-adoption-research.md#L31-L65)).

### Claim operation

One `executeDomainOperation` callback should:

1. require the canonical Task lifecycle to be `ready` or adopt the compatible
   legacy Task once;
2. validate the current milestone lease and exact coordination dispatch scope,
   including expiry;
3. transition `ready -> in_progress`;
4. create the running Attempt linked to the coordination dispatch;
5. append the first `execute` checkpoint;
6. emit one semantic claim/start event plus durable outbox and Projection Work;
7. commit one project revision.

The current `unit_dispatches` insert can remain a temporary coordination adapter,
but production execution must fail closed if the canonical claim operation does
not commit. `degraded -> run` must not survive the cutover.

### Settlement operation

One later `executeDomainOperation` callback should:

1. require the exact running Attempt and replay-stable invocation;
2. settle it once with immutable Result output;
3. append `verify` for `succeeded`, or `route` for `failed/interrupted`;
4. settle the linked coordination row in the same transaction or make it a
   derived compatibility projection;
5. emit one semantic Result event plus durable outbox and Projection Work;
6. leave Task lifecycle `in_progress`.

`gsd_task_complete` should become a compatibility adapter that submits the
executor's `succeeded` Result for the current Attempt. Its name can remain for
transport compatibility during M003, but its implementation must stop marking
the Task complete. Only later fresh Technical Verdict and closeout settlement may
transition the Task lifecycle to `completed`.

### Lease-loss interruption

Before the first production claim, S03 must add one typed recovery operation and
the minimum schema authorization needed to settle an orphaned running Attempt as
`interrupted` after proving that its original lease is expired, released, or
superseded by a higher fencing token. The operation must:

- preserve the original Attempt identity and immutable claim provenance;
- record an interrupted Result and failure class such as `stale-worker`;
- append `route` on the same Attempt;
- require a current recovery actor/lease and a newer project revision;
- reject recovery while the original lease is still valid; and
- permit the next claim to reference the interrupted Attempt as its immediate
  retry predecessor.

Do not weaken the active-Attempt uniqueness constraint or allow a new worker to
rewrite the old claim tuple. The schema and tests already use immutable identity
and retry lineage as the safety boundary
([`db-lifecycle-foundation-schema.ts`, lines 257-340](../../src/resources/extensions/gsd/db-lifecycle-foundation-schema.ts#L257-L340)).

## Rejected seams

- **Instrument `insertTask` or `applyStatusTransition`.** Those helpers serve
  planning, import, restore, reopen, and compatibility mutations with different
  semantics. S02 already rejected generic-helper instrumentation for the same
  reason
  ([`plans/044-m003-s02-planning-adoption-research.md`, lines 10-29](../../plans/044-m003-s02-planning-adoption-research.md#L10-L29)).
- **Put Attempt logic in `runUnit`.** `runUnit` is a provider/session adapter and
  is also used by non-Task units. It lacks the database semantic context and
  should return a typed executor result, not mutate lifecycle.
- **Make `unit_dispatches` the canonical Attempt.** It duplicates attempt number,
  status, error, and retry metadata but lacks project revision provenance,
  immutable Results, lifecycle identity, stage checkpoints, and durable replay.
- **Treat `gsd_task_complete` as closeout.** The executor cannot authoritatively
  attest host verification, fresh evidence, publication effects, or dependency
  unlock. Its result belongs to Execute, not Closeout.
- **Add another orchestrator above auto.** ADR-046 explicitly requires one
  persisted Lifecycle Kernel across auto, interactive, custom, and parallel
  adapters; another coordinator would preserve the current drift.

## S03 executable contract

Before production routing, focused tests should prove:

1. fresh `ready -> in_progress` claim atomically creates one linked Attempt,
   `execute` checkpoint, event, outbox row, Projection Work item, and authority
   revision;
2. a second worker cannot claim the same Task while the first lease is valid;
3. failure and interruption settle immutable Results without completing the
   Task;
4. executor success settles the Result and advances only to `verify`;
5. exact lost-response replay after unrelated revision advance returns the same
   receipt and does not duplicate any row;
6. changed payload under the same key conflicts with zero residue;
7. Pi canonical/alias and MCP canonical/alias converge on one operation identity;
8. MCP without private idempotency identity fails before mutation;
9. an expired/replaced lease can be schema-authoritatively interrupted, then a
   lineage-linked retry can claim;
10. the same recovery is rejected while the original lease remains valid;
11. claim/start/settlement faults before commit leave no residue;
12. an after-commit fault converges on retry;
13. projection failure leaves canonical execution committed and retryable;
14. host verification failure never leaves the Task completed or unlocks its
   dependents; and
15. structural tests prove production Task execution does not call legacy
   `updateTaskStatus(..., "pending"|"complete")`, append correctness-bearing
   JSONL, or proceed after a degraded claim.

The closest existing proof is the S01 writer test for failed settlement and
retry, but it is a primitive-level fixture with manually seeded dispatch/lease
rows. S03 must test through the public auto and tool adapters as well as through
the new module interface
([`lifecycle-command-writers.test.ts`, lines 473-594](../../src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts#L473-L594)).

## Git-history evidence

- `33846b6a` introduced the canonical lifecycle foundation without runtime
  cutover.
- `53e6d291` added transaction-bound lifecycle, Attempt, Result, and checkpoint
  writers and explicitly left them dormant behind the S03 entry gate.
- `0bd4d431` adopted planning through replay-safe lifecycle Domain Operations,
  establishing the private invocation/replay pattern S03 should reuse.
- The older completion fixes (`0db7792b`, `a9f8ae7d`, `bc123e8b`) repeatedly
  repaired DB/PLAN compensation behavior. That history is evidence that the
  projection-coupled seam is the wrong ownership boundary, not a reason to add
  another compensation branch.

## Final implementation lean

Reuse the canonical schema and writers; do not add a second Attempt model. Add
only the lease-loss recovery authorization that the existing schema cannot
express, then route one low-risk family—auto-mode `execute-task`—through the new
Task Execution Domain module. Keep legacy public result shapes temporarily, but
make canonical claim and Result persistence fail closed and replay-safe. Once
that path is proven, interactive, MCP, custom, and parallel adapters should
translate into the same two commands rather than owning their own task state.
