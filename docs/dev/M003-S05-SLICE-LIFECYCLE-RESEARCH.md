# M003/S05 Slice Lifecycle Command Integration Research

**Status:** historical pre-implementation snapshot at `f7dbea8524`; S05 is now implemented

Current lifecycle contracts are owned by the [architecture overview](./architecture.md)
and [lifecycle command integration runbook](./lifecycle-command-integration-runbook.md).
The command map and recommendations below describe the reviewed baseline, not
the post-S05 runtime.

**Scope:** slice lifecycle commands only; milestone lifecycle integration remains S06

**Method:** static analysis of repository code, tests, ADRs, and the canonical project database on 2026-07-14

## Executive recommendation

Move slice **complete**, **cancel** (the canonical meaning behind public `skip`),
and **reopen** through one command-specific Domain Operation adapter. Keep the
existing public tool names and responses during cutover, but give every Pi, MCP,
guided, and auto-mode invocation the same stable private identity and the same
atomic writer path.

The integration should not wrap the existing transaction-owning cascade helpers.
Instead, extract deterministic, context-bound slice writers that run inside
`executeDomainOperation()`. One transaction must commit the legacy hierarchy
changes, canonical lifecycle changes, semantic shadow comparisons, ordered domain
events, outbox rows, Projection Work, operation receipt, and authority revision.
Markdown rendering, compatibility JSONL, manifests, and cleanup remain
post-commit projections and may fail without rolling back workflow authority.

Planning and replanning already use this architecture. The primary S05 work is to
bring complete, reopen, skip, `/gsd reset-slice`, and completion-exhaustion
recovery onto it without expanding into milestone commands.

### Accepted implementation decisions

- Public `skip` means canonical cancellation. Completed descendants and their
  immutable history stay complete; unfinished descendants are cancelled.
- Public slice reopen preserves its existing full-redo contract. Every terminal
  descendant in the reopened slice moves to legacy `pending` / canonical
  `ready`; callers that want a partial redo must use task reopen instead.
- The transaction-owning legacy cascades are not called from inside a Domain
  Operation. Their validated semantics are extracted into context-bound leaves
  so the Domain Operation remains the sole transaction and receipt owner.
- Completion's broad compatibility payload stays at the transport adapter. The
  lifecycle module receives normalized closeout facts rather than Markdown as
  authority.

## Scope anchor and accepted invariants

The canonical `.gsd/gsd.db` records S05 as **Slice lifecycle command
integration**, with the goal of moving slice cascades onto command-specific
Domain Operations without reading Markdown as completion authority. Its proof
contract calls for deep guards, selective cancellation, terminal reopen, lost
response, multiprocess contention, projection obstruction, and partial-failure
coverage with exact canonical/legacy parity and no residue. Requirement R018
requires slice and milestone cascades to update canonical and legacy rows
atomically; S05 closes the slice half and leaves the milestone half to S06.

The repository's accepted architecture sharpens that contract:

- SQLite is the only normal runtime authority, and only a Domain Operation may
  mutate workflow state
  (`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:74-90`).
- Markdown and similar artifacts are projections. Projection failure is
  retryable and cannot change committed workflow authority
  (`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:92-112`).
- A normal operation atomically commits domain state, events, outbox work,
  Projection Work, and the authority revision
  (`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:82-90`).
- Cross-transport retries are idempotent and fenced; projections cannot fabricate
  completion; compatibility adapters cannot retain independent authority
  (`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:192-207`).
- The current compatibility-stage command boundary is one read fence, one Domain
  Operation, legacy and canonical writes in the same callback, semantic shadow
  comparison, then the legacy-shaped response
  (`docs/dev/lifecycle-command-integration-runbook.md:4-28`).
- Removed pending work is retained as legacy `skipped` and canonical `cancelled`,
  while immutable history is preserved
  (`docs/dev/lifecycle-command-integration-runbook.md:30-49`).
- The runbook explicitly limits the completed S04 cutover to task lifecycle and
  assigns slice/milestone cascades to later slices
  (`docs/dev/lifecycle-command-integration-runbook.md:51-63`).
- The architecture summary acknowledges the remaining gap: file-derived slice
  completion, UAT, and broader lifecycle routing have not fully cut over
  (`docs/dev/architecture.md:36`).

## Current command and caller map

| Semantic command | Public surfaces | Current mutation path | Domain Operation status |
| --- | --- | --- | --- |
| Plan slice | Pi `gsd_plan_slice` / `gsd_slice_plan`; MCP canonical and alias; guided/auto planning units | `tools/plan-slice.ts` -> `executePlanningDomainOperation()` | Integrated |
| Replan slice | Pi `gsd_replan_slice` / `gsd_slice_replan`; MCP canonical and alias; auto replan unit | `tools/replan-slice.ts` -> `executePlanningDomainOperation()` | Integrated |
| Complete slice | Pi `gsd_slice_complete` / `gsd_complete_slice`; MCP canonical and alias; guided/auto completion unit | `tools/complete-slice.ts` -> `completeSliceCascade()` plus separate metadata/gate/projection writes | Not integrated |
| Skip slice | Pi and MCP `gsd_skip_slice` | `tools/skip-slice.ts` -> `skipSliceCascade()`; wrapper rebuilds STATE | Not integrated |
| Reopen slice | Pi `gsd_slice_reopen` / `gsd_reopen_slice`; MCP canonical and alias | `tools/reopen-slice.ts` -> `reopenSliceCascade()`; post-commit file deletion/render | Not integrated |
| Reset slice | `/gsd reset-slice` | `undo.ts` changes the slice, then independently reopens each task | Not integrated; currently refuses adopted slice history |
| Exhausted complete recovery | automatic recovery | `writeBlockerPlaceholder()` may directly mark a legacy slice complete | Independent authority bypass |

### Plan slice: reference implementation already in production

Pi registers the canonical tool and compatibility alias together and passes a
canonicalized invocation identity
(`src/resources/extensions/gsd/bootstrap/db-tools.ts:690-744`). MCP does the same
through a shared executor
(`packages/mcp-server/src/workflow-tools.ts:2469-2506`;
`src/resources/extensions/gsd/tools/workflow-tool-executors.ts:1556-1597`).

The handler performs one `workflow.slice.plan` Domain Operation, writes the
legacy hierarchy and canonical lifecycle rows in its mutation callback, retains
removed pending tasks as legacy skipped/canonical cancelled, and promotes the
new slice/tasks into ready state
(`src/resources/extensions/gsd/tools/plan-slice.ts:361-583`). Rendering and
manifest/JSONL compatibility work occur after commit
(`src/resources/extensions/gsd/tools/plan-slice.ts:591-643`).

Planning is invoked by the plan/refine unit registry and by guided and automatic
dispatch, so the handler seam already spans conversational and unattended modes
(`src/resources/extensions/gsd/unit-registry.ts:233-268`;
`src/resources/extensions/gsd/guided-flow.ts:2656-2661`;
`src/resources/extensions/gsd/auto-dispatch.ts:1342-1450`).

### Replan slice: second reference implementation

Replanning likewise canonicalizes Pi and MCP aliases
(`src/resources/extensions/gsd/bootstrap/db-tools.ts:1162-1217`;
`packages/mcp-server/src/workflow-tools.ts:2559-2586`) and uses the shared
executor (`src/resources/extensions/gsd/tools/workflow-tool-executors.ts:1686-1727`).

Its `workflow.slice.replan` operation rejects terminal slices, requires a
completed non-cancelled blocker, preserves completed task history, and retains
removed pending identities as legacy skipped/canonical cancelled
(`src/resources/extensions/gsd/tools/replan-slice.ts:117-323`). Exact replay
renders the replan artifact from durable event content rather than the retry's
clock or prose (`src/resources/extensions/gsd/tools/replan-slice.ts:330-392`).

These two handlers establish the minimum-change pattern for S05. They should not
be redesigned as part of the slice lifecycle cutover; parity tests are sufficient.

### Complete slice: authority is split across several writes

Pi and MCP expose canonical and alias forms, but unlike planning they do not pass
a stable private invocation into completion
(`src/resources/extensions/gsd/bootstrap/db-tools.ts:901-984`;
`packages/mcp-server/src/workflow-tools.ts:1227-1236,2612-2631`). The shared
executor validates input and calls the handler without replay identity
(`src/resources/extensions/gsd/tools/workflow-tool-executors.ts:1030-1143`).

The handler applies ownership, failure-language, and UAT-mode guards, then calls
the standalone cascade (`src/resources/extensions/gsd/tools/complete-slice.ts:302-398`).
After the status transaction commits, it separately writes summary/UAT content,
renders files, updates the roadmap, and closes gates
(`src/resources/extensions/gsd/tools/complete-slice.ts:400-532`). Gate failures
are caught after completion, so a completed slice can lack its intended gate
state. Manifest, legacy event, and graph work are also post-commit and not backed
by a durable operation receipt (`src/resources/extensions/gsd/tools/complete-slice.ts:539-589`).

`completeSliceCascade()` owns its own transaction, checks that all tasks are
closed, creates absent legacy hierarchy rows, marks the legacy slice complete,
and may activate its milestone. It does not write canonical lifecycles, a Domain
Operation, an authority revision, semantic events, or Projection Work
(`src/resources/extensions/gsd/db/writers/cascades.ts:122-195`).

Automatic dispatch reaches this path from the summarizing unit, and guided flow
does the same (`src/resources/extensions/gsd/auto-dispatch.ts:829-843`;
`src/resources/extensions/gsd/guided-flow.ts:2725-2730`). The lifecycle operation
therefore must live below these callers rather than being reimplemented in each
mode.

### Skip slice: selective legacy cascade without canonical cancellation

Pi and MCP call `handleSkipSlice()` directly without an idempotency identity
(`src/resources/extensions/gsd/bootstrap/db-tools.ts:986-1076`;
`packages/mcp-server/src/workflow-tools.ts:2633-2655`). The handler delegates all
database work to `skipSliceCascade()`
(`src/resources/extensions/gsd/tools/skip-slice.ts:71-107`).

The cascade rejects a completed slice, marks the slice skipped, marks every
unfinished child skipped, and preserves completed tasks. It owns its transaction
and records no canonical cancellation, operation receipt, durable reason, event,
or Projection Work (`src/resources/extensions/gsd/db/writers/cascades.ts:197-243`).
The selective child behavior is worth preserving, but the canonical meaning is
**cancel**, not a second terminal lifecycle outcome. ADR-046 models intentionally
omitted work as cancellation plus an authorized Waiver
(`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:60-72`).

### Reopen slice: full reset semantics without operation fencing

Pi's reopen registration bypasses the existing shared executor, and neither Pi
nor MCP supplies stable invocation identity
(`src/resources/extensions/gsd/bootstrap/db-tools.ts:1438-1497`;
`packages/mcp-server/src/workflow-tools.ts:1205-1213,2889-2910`;
`src/resources/extensions/gsd/tools/workflow-tool-executors.ts:948-987`).

The handler calls `reopenSliceCascade()`, then deletes task/slice summary and UAT
files and attempts projection/manifest/JSONL work
(`src/resources/extensions/gsd/tools/reopen-slice.ts:56-149`). The cascade owns a
transaction, requires an open parent milestone, changes the legacy slice to
in-progress, and resets every child task to pending while clearing timestamps.
It writes no canonical lifecycle, receipt, event, or Projection Work
(`src/resources/extensions/gsd/db/writers/cascades.ts:29-85`). It also overwrites
all compatibility child statuses, including previously skipped tasks, so the
terminal-reopen policy must be made explicit rather than inherited accidentally.

Canonical lifecycle transitions already define the allowed endpoint: completed
or cancelled items may reopen to ready, while nonterminal transitions remain
more restricted (`src/resources/extensions/gsd/db/writers/lifecycle-commands.ts:206-216`).

### Reset slice: a second, partially atomic reopen implementation

`/gsd reset-slice` routes through the operational command handler
(`src/resources/extensions/gsd/commands/handlers/ops.ts:117-120`). Its preflight
guards tasks, milestones, and running attempts, and compares legacy/canonical
state (`src/resources/extensions/gsd/undo.ts:103-155`). It currently refuses any
slice with adopted canonical lifecycle history, explicitly exposing S05 as the
missing integration (`src/resources/extensions/gsd/undo.ts:474-491`).

With `--force`, reset updates the slice and then reopens each child through an
independent task operation (`src/resources/extensions/gsd/undo.ts:520-524`). A
mid-loop failure can therefore leave the slice open with only some children
reopened. S05 should make reset a compatibility adapter into the same atomic
slice-reopen operation, not add a fourth lifecycle semantic. The unused
`resetSliceCascade()` in `db/writers/cascades.ts:245-263` should not become a new
authority path.

### Automatic recovery can fabricate completion

When a complete-slice unit exhausts recovery, `writeBlockerPlaceholder()` may
directly mark the legacy slice complete and append a compatibility event. It only
fails closed once canonical slice history is already present
(`src/resources/extensions/gsd/auto-recovery.ts:375-438`). Tests currently
preserve both behaviors
(`src/resources/extensions/gsd/tests/integration/idle-recovery.test.ts:411-430`;
`src/resources/extensions/gsd/tests/auto-recovery.test.ts:2246-2275`).

This is incompatible with database-authoritative completion evidence. Recovery
may diagnose, retry, or surface a blocker, but it must not manufacture successful
completion. The bypass should be removed as part of transport/caller cutover,
with old tests updated to assert fail-loud recovery.

## Current authority and drift analysis

### Database authority is already used for normal slice progression

State derivation opens the existing database and refuses an implicit Markdown
fallback when database authority is unavailable
(`src/resources/extensions/gsd/state/derive/index.ts:73-103`). It determines
milestone completion from database rows
(`src/resources/extensions/gsd/state/derive/from-db.ts:101-119,158-168`), uses
database slice status for dependency readiness
(`src/resources/extensions/gsd/state/derive/from-db.ts:337-361`), and derives
planning/summarizing phases from database task rows
(`src/resources/extensions/gsd/state/derive/from-db.ts:474-515`). Replan triggers
also come from database blocker/history fields
(`src/resources/extensions/gsd/state/derive/from-db.ts:543-597`).

During the compatibility stage, legacy hierarchy rows remain the public response
source while canonical lifecycle rows are a semantic shadow. Planning operations
already compute that comparison inside the operation transaction
(`src/resources/extensions/gsd/planning-domain-operation.ts:38-72`). S05 should
extend that same dual-write/shadow rule to complete, cancel, and reopen; it should
not switch public read responses ahead of the later convergence slice.

### Markdown is post-commit output, but several adjacent readbacks remain

The durable model is clear, yet a few adjacent surfaces still read projections:

- state derivation loads recent decision text from Markdown for its readable
  status surface (`src/resources/extensions/gsd/state/derive/index.ts:36-70`);
- opening the state database synchronizes queue order from a Markdown projection
  back into SQLite (`src/resources/extensions/gsd/state/derive/db-open.ts:9-23`);
- the current projection flush merely invokes synchronous rendering
  (`src/resources/extensions/gsd/projection-flush.ts:14-20`).

The queue-order readback violates the final target model, but it is not slice
lifecycle authority and should be recorded for a later convergence task rather
than expanding S05. S05 must ensure its own guards and cascade membership are
computed exclusively from database rows.

### Durable Projection Work exists; lifecycle commands do not use it yet

The schema stores revision-aware Projection Work and enforces current-head
relationships (`src/resources/extensions/gsd/db-projection-import-kernel-closeout-foundation-schema.ts:65-140,142-243`).
`executeDomainOperation()` creates projection work in the same transaction as
the mutation (`src/resources/extensions/gsd/db/domain-operation.ts:534-596`).
Complete, reopen, and skip bypass this seam, so their file rendering cannot be
recovered from the operation receipt after a lost response.

## Replay, fault, and projection behavior

### The operation kernel already supplies the required guarantees

The Domain Operation kernel owns the outer immediate transaction, loads and
checks authority, enforces project-scoped exact idempotency, writes provenance,
then invokes the mutation (`src/resources/extensions/gsd/db/domain-operation.ts:382-485`).
Mutation callbacks may compose deterministic typed writers only; they cannot own
transactions, access files/network, route retries, or swallow errors
(`src/resources/extensions/gsd/db/domain-operation.ts:382-394`).

Stable planning identity is already transport-aware: Pi keys canonical tool name
plus tool-call identity, MCP prefixes the canonical operation and stable private
request key, and aliases share canonical identity
(`src/resources/extensions/gsd/planning-invocation.ts:6-30`;
`packages/mcp-server/src/workflow-tools.ts:979-1002`). The lifecycle commands need
equivalent identity, including internal auto-mode invocations.

Lifecycle writers already refuse writes without active matching operation
provenance and expose the original expected revision for exact replay
(`src/resources/extensions/gsd/db/writers/lifecycle-commands.ts:160-181,270-303`).
That is the correct leaf-writer contract for S05.

### Legacy JSONL replay is incomplete and can compete with canonical history

`replaySliceComplete()` validates legacy tasks and directly marks the legacy
slice done (`src/resources/extensions/gsd/workflow-reconcile.ts:62-76`). The
reconciler ignores Task events after canonical Task adoption but has no analogous
guard for Slice completion (`src/resources/extensions/gsd/workflow-reconcile.ts:99-177`).
Replan is informational and reopen/skip have no replay cases
(`src/resources/extensions/gsd/workflow-reconcile.ts:236-239`). The event
vocabulary likewise covers slice plan/replan/complete but not reopen/cancel/reset
(`src/resources/extensions/gsd/workflow-event-vocabulary.ts:22-57`).

New Domain Operation receipts and events must be the replay source. Compatibility
JSONL may remain a post-commit export, but reconciliation must ignore
lifecycle-affecting legacy Slice events once canonical Slice history exists, just
as it already does for Tasks.

### Existing proof patterns can be reused

The planning fault matrix injects failures around the operation transaction,
proves rollback leaves no residue, and proves a post-commit lost-response retry
returns the exact receipt without duplicate operations or JSONL
(`src/resources/extensions/gsd/tests/planning-domain-fault-matrix.test.ts:25-32,105-171`).
Replan tests cover exact retry, idempotency reuse conflict, newer durable
projection preservation, explicit reopen before identity reuse, provenance, and
canonical/legacy sabotage
(`src/resources/extensions/gsd/tests/replan-slice-domain-replay.test.ts:95-253`).
General Domain Operation tests cover projection-head supersession and failure
with no residue
(`src/resources/extensions/gsd/tests/domain-operation.test.ts:509-563`).

Current slice authority tests prove that contradictory Markdown and projection
failure do not reverse committed legacy completion
(`src/resources/extensions/gsd/tests/workflow-authority-faults.test.ts:38-44,188-237`).
They do not yet prove an operation receipt, canonical shadow, authority revision,
or durable Projection Work because completion does not use those facilities.

## Recommended integration seam

### 1. Add one slice lifecycle Domain Operation adapter

Add a sibling of `planning-domain-operation.ts`, tentatively
`slice-lifecycle-domain-operation.ts`, with command-specific entry points such as:

- `completeSliceLifecycle()`;
- `cancelSliceLifecycle()` (the implementation behind public `gsd_skip_slice`);
- `reopenSliceLifecycle()`.

Each entry point should accept normalized command data plus a stable private
invocation, obtain the exact-replay fence via `readDomainOperationFence()`, and
call `executeDomainOperation()` once. The callback should validate deep guards
from the current transaction snapshot, call deterministic context-bound writers,
write legacy and canonical outcomes, and calculate semantic shadow comparisons.
The returned value should be a typed durable receipt sufficient to reproduce the
existing public response and post-commit projections.

Do not add these commands to `planning-domain-operation.ts`: planning mutates the
work graph, while lifecycle commands settle or reopen an existing graph. Keeping
the adapters separate makes the policy boundary explicit without inventing a
generic orchestration framework.

### 2. Replace transaction-owning cascades with context-bound leaf writers

Add `db/writers/slice-lifecycle.ts` or refactor the slice members of
`db/writers/cascades.ts` so the low-level writers:

- require active matching Domain Operation provenance;
- never begin, commit, or catch a transaction;
- read hierarchy membership and guards from the supplied database context;
- return affected identities and raw/normalized shadow values;
- do no rendering, event append, retry routing, or clock-based response work.

Calling the existing cascade from a Domain Operation would create nested
transaction ownership, which the kernel explicitly forbids
(`src/resources/extensions/gsd/db/domain-operation.ts:392-394`).

### 3. Define command semantics before transport cutover

| Command | Compatibility outcome | Canonical outcome | Child behavior | Required guard/evidence behavior |
| --- | --- | --- | --- | --- |
| Complete | slice `complete` | slice `completed` | no child status mutation; every non-cancelled child must already be terminal and shadow-matched | normalized UAT/summary/gate evidence is persisted in the same operation or is a precondition already durably persisted |
| Skip/cancel | slice `skipped` | slice `cancelled` | unfinished children become legacy `skipped` / canonical `cancelled`; completed children and immutable attempts/results remain unchanged | persist reason and authorized waiver/decision lineage; never treat raw Markdown as authority |
| Reopen | slice `in_progress` | slice `ready` | reopen the policy-defined terminal children to legacy `pending` / canonical `ready`; preserve immutable attempts/results/evidence | parent milestone remains open; reject a running attempt; mark affected evidence for revalidation where required |

Reopen uses the existing full-reset contract: every descendant is terminal when
the slice is legitimately reopenable, and every terminal descendant moves to
ready/pending. This keeps `gsd_slice_reopen` and `/gsd reset-slice` compatible and
leaves partial redo to `gsd_task_reopen`. Immutable Attempts, Results, verdicts,
evidence, dispatches, and checkpoints remain untouched.

The cancellation path must account for ADR-046's Waiver requirement. If no typed
slice-level waiver writer exists at implementation time, the command should fail
loud rather than recording an unaudited terminal cancellation.

### 4. Canonicalize every transport and internal caller

Route Pi, MCP, guided flow, auto dispatch, and `/gsd reset-slice` through shared
executors that pass canonical operation names and transport-stable identity.
Aliases must map to the same idempotency identity as their canonical tools. Keep
the public response schema stable during shadow cutover.

The smallest compatible approach is to reuse the existing planning invocation
shape. A neutral rename can follow later if it would otherwise enlarge S05.
Internal callers need a durable invocation key tied to the unit/turn identity;
random UUIDs are not sufficient for recovery after process loss.

`/gsd reset-slice` should become an adapter to `reopenSliceLifecycle()`, with its
confirmation UX retained. Automatic completion exhaustion must stop updating
slice status and instead return a retryable failure or an explicit blocker route.

### 5. Make projections replayable and non-authoritative

Persist the semantic completion/cancellation/reopen payload, event lineage, and
Projection Work in the Domain Operation. After commit:

- render summaries, UAT, roadmap, STATE, and cleanup targets from durable rows or
  the stored receipt;
- append compatibility JSONL and update manifests only for a committed operation;
- on exact retry, skip mutation and redeliver pending/current Projection Work;
- never compensate workflow state when rendering is obstructed;
- never regenerate replay content from the retry clock or uncommitted caller prose.

One root semantic event with an ordered affected-item shadow payload is the
simplest sufficient lineage. Add child events only if a consumer requires causal
per-child subscription; do not multiply events speculatively.

## Verification matrix

All tests should assert the raw legacy value, normalized canonical value,
operation receipt, revision, ordered event lineage, and Projection Work together.
They must also assert absence of partial rows after failure.

| Proof area | Minimum cases |
| --- | --- |
| Deep guards | missing hierarchy, closed milestone, pending/running child, canonical/legacy sabotage, stale revision, stale Authority Epoch |
| Complete | exact canonical/legacy parity; durable summary/UAT/gate evidence; no child mutation; dependency unlock only after commit |
| Selective cancel | unfinished children cancelled; completed history preserved; waiver/reason durable; repeated exact request returns exact receipt |
| Terminal reopen | completed and cancelled slice paths; policy-defined child set only; attempts/results immutable; running Attempt rejected |
| Replay | lost response after commit; fresh-process exact retry; changed payload under reused idempotency key rejected; alias/canonical retry equivalence |
| Concurrency | two processes contend on the same slice; exactly one semantic operation commits; loser gets replay or conflict, never drift |
| Fault injection | every Domain Operation fault point; writer failure mid-cascade; event/outbox/projection capacity failure; exact zero residue on rollback |
| Projection obstruction | unwritable/contradictory Markdown; committed DB remains authoritative; pending Projection Work survives restart and later converges |
| Caller parity | Pi, MCP, guided, auto, and reset adapter produce the same durable operation and preserve legacy response shape |
| Reconciliation sabotage | legacy JSONL replay cannot change an adopted canonical Slice; stale files cannot fabricate completion or cancellation |

Run focused tests after each task, then the existing lifecycle command writer,
planning replay/fault, authority fault, MCP workflow, reset, recovery, and state
derivation suites at integration checkpoints. Full-repository verification belongs
at final S05 convergence, not after every edit.

## Proposed implementation tasks

### T01 — Characterize the cutover boundary

Add failing/characterization tests for complete, skip/cancel, reopen, reset, and
automatic recovery. Lock the current public schemas and enumerate the intended
legacy/canonical transition matrix. Decide the explicit child set for reopen and
the durable waiver representation for cancel before production changes.

**Checkpoint:** tests demonstrate every current bypass and ambiguity; no
production behavior changes.

### T02 — Build context-bound slice lifecycle writers and operations

Implement deterministic slice cascade writers plus the command-specific Domain
Operation adapter for complete, cancel, and reopen. Commit deep guards, legacy
hierarchy state, canonical lifecycle state, semantic shadow payloads, events,
outbox, Projection Work, receipt, and revision atomically.

**Checkpoint:** direct operation tests prove exact rollback/no residue and legal
transition behavior; old transports are not cut over yet.

### T03 — Cut over transports and internal callers

Pass stable identity through shared Pi/MCP executors, canonicalize aliases, route
guided and auto callers through the same operation, make reset an atomic reopen
adapter, and remove automatic recovery's fabricated completion path.

**Checkpoint:** all caller surfaces produce one equivalent durable receipt while
preserving public response compatibility.

### T04 — Converge evidence, gates, and projections

Move completion summary/UAT/gate authority into the operation or make durable
normalized evidence an explicit completion precondition. Render summary, UAT,
roadmap, STATE, cleanup, manifest, and compatibility JSONL only after commit from
durable content. Fence legacy Slice reconciliation after canonical adoption.

**Checkpoint:** projection obstruction and lost-response restart tests converge
without workflow rollback or duplicate lineage.

### T05 — Prove races, faults, sabotage, and restart recovery

Apply the established Domain Operation fault matrix to all three commands. Add
multiprocess contention, exact replay, changed-payload conflict, partial-writer
failure, stale revision/epoch, canonical/legacy sabotage, and legacy JSONL replay
tests.

**Checkpoint:** every injected pre-commit failure leaves no operation, hierarchy,
lifecycle, event, outbox, projection, or revision residue; post-commit failure
returns the durable receipt on retry.

### T06 — Close integration and operational documentation

Run focused and adjacent integration gates, update the lifecycle integration
runbook and architecture status, and record automated database-backed UAT proof
for S05. Leave milestone commands unchanged for S06.

**Checkpoint:** the project database records all S05 proof, public projections
match it, and no unexplained slice lifecycle shadow mismatch remains.

## Explicit non-goals and deferred findings

- Do not integrate milestone completion/reopen/cancel; that is S06.
- Do not replace compatibility reads or public response schemas during S05.
- Do not redesign plan/replan, aside from shared invocation plumbing or parity
  tests required by the lifecycle cutover.
- Do not solve the queue-order Markdown readback in S05; track it for authority
  convergence.
- Do not build a speculative generic workflow engine. A slice-specific operation
  adapter and deterministic writers are sufficient.
- Do not make synchronous rendering the new authority. Durable Projection Work
  is the recovery contract even if delivery remains eager during compatibility.
- Do not revive the unused `resetSliceCascade()` or permit direct `deleteSlice()`
  to bypass adopted canonical history. Deletion protection should be addressed
  at the nearest lifecycle/delete hardening task without broadening command
  semantics.

## Decision summary

The least risky path is a narrow vertical cutover: three slice lifecycle
operations, one atomic writer boundary, stable identity across every caller, and
post-commit projections driven by durable data. It reuses the proven planning
and task-lifecycle kernel, removes the remaining independent slice authority
paths, and supplies the exact replay/fault/race evidence required by S05 while
preserving compatibility until later convergence.
