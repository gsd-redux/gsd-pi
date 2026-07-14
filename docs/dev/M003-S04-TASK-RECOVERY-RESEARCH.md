<!-- Project/App: gsd-pi -->
<!-- File Purpose: Research and cutover contract for M003/S04 Task recovery and genuine blockers. -->

# M003/S04 Task recovery research

> Historical design record. The current operational contract is maintained in
> the [lifecycle command integration runbook](./lifecycle-command-integration-runbook.md),
> with user-facing behavior in the [Auto Mode guide](../user-docs/auto-mode.md#state-authority).

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

## T05 runtime cutover findings

Research after T04 found that durable recovery records exist but runtime retry
authority still bypasses them. The Task wrapper settles failed and interrupted
Attempts, then a later dispatch may claim a retry from the immediate predecessor
without requiring a current Recovery Action. Host-verification failures have a
succeeded Result plus a failed or inconclusive Technical Verdict, so the current
failed-Result-only router cannot authorize their remediation.

T05 closes the drift door in this order:

1. Add a verdict-causal recovery face and require a current retry-capable
   Recovery Action before a routed predecessor can be claimed again.
2. Route execute failures, stale interruptions, and host-verification failures
   immediately after their immutable failure fact is committed. Translate the
   durable action into retry or agent-owned abort; never invent a human pause.
3. Remove Task-specific ephemeral counters and status resets from hook, timeout,
   and artifact recovery. Retry remains Attempt lineage; terminal follow-up is
   an explicit reopen.
4. Stop checked PLAN files, SUMMARY files, and blocker placeholders from
   fabricating Task completion or cancellation.
5. Remove completion compensation that rolls committed database state backward
   when a projection fails, then reject generic closed-to-open Task writes.

Broader Markdown import, event-ledger replay, reactive graph, CONTINUE, and UAT
projection authority remain separately identified drift surfaces. They are not
allowed to bypass the Task recovery seal introduced here and will be cut over in
their owning milestone slices rather than folded into one unsafe rewrite.

## T05 convergence decisions

The implementation review added five constraints that are easy to miss when
the happy path is the only path tested:

- Publication is complete when its Domain Operation commits. A failed PLAN or
  SUMMARY render must replay the same publication operation and repair the
  projection even though the Attempt head is already settled.
- A repeated verification failure signature cannot override a retry-capable
  Recovery Action. Legacy duplicate-hash and cost counters remain telemetry or
  non-Task policy; the durable recovery budget owns Task exhaustion.
- Source drift after a passing Technical Verdict appends an inconclusive
  superseding verdict and routes `verification-drift`. A read-time comparison
  cannot manufacture an undocumented abort.
- Agent-fixable verification setup and policy errors append fail or
  inconclusive evidence before recovery is selected. Only an explicitly
  human-owned verification policy may pause without agent remediation.
- Timeout recovery recognizes a settled, succeeded Attempt rather than a
  closed Task row, checked PLAN item, or SUMMARY file. Hook retry intent is
  retained until the canonical reopen and orchestration retry both succeed.
- Provider pauses, timeouts, and other known transient execution outcomes map
  to a bounded durable policy class. Unknown or hard failures remain terminal;
  free-form phase text cannot silently decide between retry and abort.
- A verification write that fails before commit propagates without inventing
  an abort, leaving the succeeded Attempt at `verify` for a clean retry.
- Hook retry intent is bound to the reviewed completion operation. A stale
  review cannot reopen a newer completion, and persistence/acknowledgement
  failures are observable and fail closed.

Reactive graph advancement and slice/milestone descendant cascades remain S05
work. Diagnostic blockers may describe those failures, but they do not mutate
or prove Task lifecycle state.

## Repaired abort convergence

Runtime replay exposed one further fail-closed gap: an agent-owned `abort`
correctly stopped execution, but the Task remained active and every later run
selected the same routed Attempt again. Cancellation was rejected as the
recovery mechanism because legacy `skipped` means intentional omission and can
advance a slice despite required work remaining.

The supported repair path is an explicit `task.recovery.resume` Domain
Operation. It binds non-empty repair evidence to the exact current abort,
settled Attempt, Result, route head, and Task entity. The original failure,
Recovery Action, and exhausted budget remain immutable. A later claim may use
that event only for the abort Attempt's immediate lineage successor; the claim
itself consumes the authorization structurally. A repeated failure therefore
routes normally and cannot reuse the earlier repair evidence.

Auto-mode never creates this authorization. It continues to stop on ordinary
abort and proceeds only when a replayed abort receipt exposes an exact,
unconsumed resume event. The control-plane tool is intentionally excluded from
dispatched unit tool registries so a failing worker cannot authorize its own
retry.
