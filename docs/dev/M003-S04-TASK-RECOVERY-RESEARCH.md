<!-- Project/App: gsd-pi -->
<!-- File Purpose: Research and cutover contract for M003/S04 Task recovery and genuine blockers. -->

# M003/S04 Task recovery research

## Outcome

S04 should replace the current collection of Task reset shortcuts with one
typed Task recovery boundary. It must keep three intents separate:

- **Reopen:** a terminal Task returns to canonical `ready` and legacy
  `pending`. It does not start work or create an Attempt.
- **Retry:** a failed or interrupted Attempt is followed by a lineage-linked
  Attempt. It does not reset Task status or delete completion artifacts.
- **Cancel:** actionable work becomes canonical `cancelled` and legacy
  `skipped`. A running Attempt must be interrupted before the lifecycle becomes
  terminal.

This is the smallest design that satisfies R017 without adding another
orchestration framework. Existing v32-v35 lifecycle, blocker, waiver,
disposition, recovery, and checkpoint tables remain the canonical model.

## Contract anchors

- R017 permits a pause only for an unresolved user or external boundary.
  Agent-owned failures must select a bounded retry, repair, replan, remediation,
  or abort action in durable state.
- D008 requires terminal reopen to commit `completed|cancelled -> ready`.
  The later Task claim performs `ready -> in_progress` in a separate Domain
  Operation; one revision cannot silently claim both transitions.
- Legacy reads and public response shapes remain authoritative during M003.
  Canonical and legacy writes still commit together and are compared in the
  operation.
- Markdown, summary cleanup, manifest rendering, and prompt context are
  projections. Their failure cannot compensate a committed lifecycle backward.

## Current drift surfaces

| Surface | Current behavior | Required S04 behavior |
| --- | --- | --- |
| `gsd_task_reopen` | Direct legacy `complete -> pending`, then deletes files and writes a one-shot reason artifact | One replay-safe Domain Operation writes legacy `pending` plus canonical terminal `ready`; DB stores the reason/checkpoint; projections follow commit |
| `/gsd undo-task` | Force-capable direct `pending` reset without canonical transition or event | Route through the same reopen command and guards |
| Post-unit hook retry | Resets legacy status, deletes summary/retry artifacts, and continues after DB errors | Classify terminal work as reopen and failed/interrupted execution as retry; never continue after an authoritative write failure |
| Planning omission | Planning operations already write legacy `skipped` plus canonical `cancelled` | Reuse a context-bound cancellation writer without changing planning transaction ownership |
| Reactive artifact recovery | Can fabricate legacy complete/skipped state from Markdown to advance | Fail closed for adopted canonical history; select an explicit durable recovery action |
| Legacy completion compensation | Projection or escalation failures can roll complete back to pending | Projection failure remains retryable Projection Work and never changes committed lifecycle state |
| Generic status writer | Closed-to-open Task transitions remain unguarded for historical callers | Reject Task closed-to-open writes outside the sanctioned semantic command |

The primary implementation callers are
`tools/reopen-task.ts`, `bootstrap/db-tools.ts`,
`packages/mcp-server/src/workflow-tools.ts`,
`tools/workflow-tool-executors.ts`, `undo.ts`, `auto-post-unit.ts`, and
`auto-recovery.ts`. Slice reset descendants remain an S05 integration concern,
but S04 must prevent them from bypassing adopted Task history.

## Canonical command boundary

Every command reads `readDomainOperationFence`, receives a stable private
invocation identity, and executes through `executeDomainOperation`.
Context-bound writers perform only deterministic mutations.

### Reopen Task

1. Require open parent milestone and slice compatibility rows.
2. Require matching terminal heads: legacy `complete|done|skipped` and canonical
   `completed|cancelled`.
3. Preserve all prior Attempts, Results, blockers, waivers, dispositions, and
   checkpoints.
4. Atomically write legacy `pending`, canonical `ready`, a causal recovery/work
   checkpoint, domain event, Projection Work, and raw-plus-normalized shadow
   comparison.
5. On replay, return the original receipt without duplicating history.
6. After commit, render or remove projections. A failure is visible delivery
   work and never rolls the Task back.

### Cancel Task

Pending or ready work may transition directly to cancelled/skipped. In-progress
work requires a matching running Attempt to settle as `interrupted`, with its
dispatch and Kernel route checkpoint updated under the command's provenance.
Cancellation is not a failed Result and never fabricates completion.

### Failure routing and genuine blockers

Failure classification must be deterministic and persist one observation and
one selected action:

| Owner | Allowed result | Pause? |
| --- | --- | --- |
| Agent | Bounded retry, repair, replan, remediation, or abort | No |
| User | Open blocker of an allowed user-boundary kind plus clarify/pause action | Yes |
| External | Open blocker of an allowed external-boundary kind plus pause action | Yes |

An agent-owned observation cannot reference a blocker. A user/external action
must reference its matching open blocker. Retry and repair must consume the
matching immutable budget and fail loudly when exhausted. Waivers must be
active and unexpired; dispositions must supersede the current head. Resolving
or dismissing a blocker and terminating a waiver must advance causal revision
and preserve prior facts.

### Work checkpoints

Reopen, pause, resume, correction, and handoff append immutable checkpoints to
the current scope head. Each successor must reference the current head and a
later project revision. Prompt context is rendered from this history instead of
claimed by deleting a JSON file.

## Transport and mode convergence

- Pi uses the canonical tool name plus tool-call ID.
- Workflow MCP requires the private idempotency key already used by S02/S03.
- Internal auto and recovery callers supply stable keys derived from the
  durable cause, not a process-local retry counter.
- Public text and structured response fields remain compatible.
- Auto, interactive, guided, UOK, custom, and legacy entry paths call the same
  adapter. UOK remains a verification caller and does not gain Task lifecycle
  authority.

## Verification matrix

The executable contract must cover:

- completed and cancelled Task reopen to `ready` with exact legacy `pending`;
- later claim as the separate ordered `ready -> in_progress` operation;
- pending/ready cancellation and active cancellation with interrupted Attempt;
- failed/interrupted retry lineage without a legacy status reset;
- user/external blocker open, resolve, dismiss, and invalid owner/kind pairs;
- bounded recovery budgets, exhaustion, and duplicate/lost-response replay;
- active/unexpired waiver enforcement and current-head dispositions;
- work-checkpoint current-head enforcement;
- revision, epoch, race, restart, pre-commit fault, and after-commit lost-response
  cases with no partial residue;
- projection obstruction with committed DB state and retryable Projection Work;
- unchanged prior Attempt/Result/blocker history except explicit superseding
  facts;
- Pi, MCP, internal, hook, and recovery caller identity plus response parity;
- structural rejection of raw Task closed-to-open and artifact-authority writes.

Each new invariant needs RED, GREEN, and temporary sabotage proof. Focused
tests should precede adjacent lifecycle/domain-operation and changed-source
gates; the full merge gate remains the final pre-PR check.

## Planned sequence

1. Lock the typed recovery policy and writer contract with failing tests.
2. Implement replay-safe reopen/cancel, blocker, waiver, disposition, recovery,
   and work-checkpoint Domain Operations.
3. Cut Pi, MCP, undo, hook, and recovery callers onto the shared adapter while
   retaining public compatibility.
4. Prove fault/restart/projection and cross-mode convergence, remove the
   obsolete shortcut authority, and document any intentionally deferred S05
   cascade work.
