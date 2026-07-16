<!-- Project/App: gsd-pi -->
<!-- File Purpose: T06 primary-source fault-boundary research for semantic-shadow soak and no-cutover proof. -->

# M003/S07 T06 fault research

> **Status:** Historical pre-implementation design snapshot. Current behavior
> is owned by the
> [semantic-shadow contract](M003-S07-SEMANTIC-SHADOW-RESEARCH.md) and the
> [lifecycle integration runbook](lifecycle-command-integration-runbook.md#s07-semantic-shadow-dossier).

## Outcome

T06 can reuse nearly all of the repository's existing fault machinery. The lean
implementation is one real-process worker, one soak test, one behavioral
no-cutover test, and one small gate script. It does not need a generalized fault
framework or changes to lifecycle authority.

One deterministic hook is missing and justified: a test-only milestone-status
interleave immediately after the legacy response queries and before
`getMilestoneLifecycleShadowSnapshot()` runs, while the existing read transaction
is still open. Without that seam, a real writer/read race can only be sampled
probabilistically; it cannot force a commit between the two halves of the exact
production read and therefore cannot prove that a hybrid response/observation is
impossible.

## Source-owned boundaries

### Query and classification

`executeMilestoneStatus` opens the database, reads the legacy Milestone, Slices,
and task counts, and reads the lifecycle shadow inside one `readTransaction`.
Only after that transaction returns does it build and emit the observation, then
return the already-built response
([workflow-tool-executors.ts:2059-2152](../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts)).
`readTransaction` uses `BEGIN DEFERRED`, and its contract explicitly promises one
consistent snapshot across multiple SELECTs
([engine.ts:924-978](../../src/resources/extensions/gsd/db/engine.ts)). The shadow
query reads only `project_authority`, legacy hierarchy tables, and
`workflow_item_lifecycles`; Markdown is not an input
([queries.ts:439-516](../../src/resources/extensions/gsd/db/queries.ts)).

The exact five classifications are a pure function of raw and normalized legacy
and canonical statuses
([lifecycle-shadow-comparison.ts:4-103](../../src/resources/extensions/gsd/db/lifecycle-shadow-comparison.ts)).
For the most useful race fixture, a legacy Task with status `complete` and no
canonical row is `missing_shadow` before repair; after canonical `completed`
adoption it is `semantic_match_exact_delta`. Its public legacy response remains
byte-identical across both states.

### Observation persistence and loss accounting

An observation carries query/context losses before persistence
([lifecycle-shadow-observation.ts:92-176](../../src/resources/extensions/gsd/lifecycle-shadow-observation.ts)).
The primary sink is `audit_events`. A primary failure produces a
`lifecycle-shadow-observation-loss` event with `persistedCount: 0`, then tries the
audit JSONL, runtime spool, and emergency journal in order. A projection failure
after a successful DB insert records a second loss event in the authoritative DB
with `persistedCount: 1`
([uok/audit.ts:38-67](../../src/resources/extensions/gsd/uok/audit.ts),
[uok/audit.ts:130-203](../../src/resources/extensions/gsd/uok/audit.ts)).

These paths already have executable obstruction recipes: drop `audit_events` for
primary-sink failure; make `.gsd/audit` a regular file for JSONL failure; make
`.gsd/runtime` a regular file for spool failure. Existing tests prove the DB,
JSONL, spool, and emergency outcomes
([uok-audit.test.ts:200-382](../../src/resources/extensions/gsd/tests/uok-audit.test.ts)).
No production hook is needed for those faults. A TEMP `BEFORE INSERT` trigger may
replace `DROP TABLE` when preserving the schema matters.

If the DB and all three filesystem destinations are simultaneously unwritable,
the current code necessarily has no durable place to account for the loss and
swallows the final error ([uok/audit.ts:49-66](../../src/resources/extensions/gsd/uok/audit.ts)).
T06 should treat that as an intentionally detected dossier failure/genuine
external obstruction, not claim successful accounting.

### Repair commit, evidence stability, replay, and contention

Repair reads a SELECT-only evidence candidate in a read transaction and hashes
the durable completion facts
([queries.ts:335-436](../../src/resources/extensions/gsd/db/queries.ts)). Before
the Domain Operation starts, `_setLifecycleShadowRepairBeforeCommitForTest` can
change evidence; the operation then rereads and requires the legacy status,
canonical head, last operation, target, evidence digest, and comparison to remain
stable ([lifecycle-shadow-repair-domain-operation.ts:42-46](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts),
[lifecycle-shadow-repair-domain-operation.ts:115-195](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts)).
An external evidence change remains durable, but the rejected repair must leave
no operation, lifecycle, event, outbox, or Projection Work residue.

The shared Domain Operation injector exposes six rollback points and one
lost-response point: `after-operation`, `after-mutation`, `after-events`,
`after-outbox`, `after-projections`, `before-cas`, and `after-commit`
([domain-operation.ts:74-115](../../src/resources/extensions/gsd/db/domain-operation.ts)).
All mutation, event, outbox, Projection Work, and authority-CAS work is enclosed
by one `BEGIN IMMEDIATE`; `after-commit` fires only after that transaction has
returned ([domain-operation.ts:382-605](../../src/resources/extensions/gsd/db/domain-operation.ts)).

Repair stores one event receipt, replays through the private idempotency key, and
keeps unresolved outcomes durable and separate from classification
([lifecycle-shadow-repair-domain-operation.ts:93-112](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts),
[lifecycle-shadow-repair-domain-operation.ts:196-269](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts)).
The writer accepts only the narrow forward edges and fences advanced Task
completion to the current matching prior repair receipt
([lifecycle-commands.ts:520-599](../../src/resources/extensions/gsd/db/writers/lifecycle-commands.ts)).
Existing tests already prove all six rollback points for adopt/advance/complete,
after-commit exact replay, changed-key reuse conflict, evidence rejection, and
unsupported-edge rejection
([lifecycle-shadow-forward-repair.test.ts:270-395](../../src/resources/extensions/gsd/tests/lifecycle-shadow-forward-repair.test.ts),
[lifecycle-shadow-forward-repair.test.ts:450-525](../../src/resources/extensions/gsd/tests/lifecycle-shadow-forward-repair.test.ts)).

For process contention, reuse the barrier-file worker pattern rather than adding
locks or sleeps to production. The Slice contention suite starts two actual Node
processes, waits until both have opened the same DB, releases them together, and
asserts one committed/one replayed result for the same key or one committed/one
typed revision conflict for different keys
([slice-lifecycle-multiprocess-contention.test.ts:52-126](../../src/resources/extensions/gsd/tests/slice-lifecycle-multiprocess-contention.test.ts),
[slice-lifecycle-multiprocess-contention.test.ts:148-220](../../src/resources/extensions/gsd/tests/slice-lifecycle-multiprocess-contention.test.ts),
[slice-lifecycle-multiprocess-contention.test.ts:263-412](../../src/resources/extensions/gsd/tests/slice-lifecycle-multiprocess-contention.test.ts)).

### Projections and public response neutrality

The comprehensive contradiction fixture writes false `STATE.md`, `PROJECT.md`,
`REQUIREMENTS.md`, `DECISIONS.md`, ROADMAP, and PLAN projections and proves that
direct DB authority reads do not change
([workflow-authority-projection-conflict.test.ts:14-88](../../src/resources/extensions/gsd/tests/workflow-authority-projection-conflict.test.ts),
[workflow-authority-projection-conflict.test.ts:134-177](../../src/resources/extensions/gsd/tests/workflow-authority-projection-conflict.test.ts)).
The frozen semantic-shadow fixture independently proves that a contradictory
ROADMAP and canonical/legacy mismatch do not change native Pi or shared executor
content/details, and that the legacy status remains public read authority
([semantic-shadow-contract.test.ts:318-360](../../src/resources/extensions/gsd/tests/semantic-shadow-contract.test.ts)).

Observation query and sink failures already preserve the public status result
while making the loss visible
([milestone-status-shadow-observation.test.ts:181-285](../../src/resources/extensions/gsd/tests/milestone-status-shadow-observation.test.ts)).
The cross-mode fixture provides reusable five-classification seeding and the
frozen response object
([semantic-shadow-mode-matrix.test.ts:152-212](../../src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts)).

## Minimal T06 fault matrix

| Boundary | Injection / reused seam | Required precondition | Required postcondition |
|---|---|---|---|
| Before shadow query | Rename `workflow_item_lifecycles` or `project_authority` before `executeMilestoneStatus` | Frozen legacy response fixture; authority snapshot captured | Public response unchanged; one persisted `shadow_query_failed`; no authority mutation |
| During the atomic read | **New single test hook** after legacy response queries, before shadow snapshot; reader child waits while repair child commits | Legacy `complete`, canonical missing, revision `r` | One observation is exactly `(r, missing_shadow)` or `(r+1, semantic_match_exact_delta)`; never a mixed revision/classification; public response is byte-identical |
| Primary observation sink | Drop `audit_events` or arm a TEMP abort trigger | Successful five-class query and frozen response | Response unchanged; fallback loss event has `primary_sink_failed`, `lossCount + 1`, `persistedCount: 0` |
| JSONL projection sink | Make `.gsd/audit` a regular file | Primary DB insert succeeds | Response unchanged; DB contains the observation and a `projection_sink_failed` loss event with `persistedCount: 1` |
| JSONL plus spool | Also make `.gsd/runtime` a regular file | Primary sink fails | Emergency journal contains one loss event; response unchanged |
| Repair precommit | Existing six Domain Operation fault points, for adopt/advance/complete | Exact full authority snapshot captured | Throw; snapshot deep-equal; no operation/event/outbox/projection/lifecycle residue |
| Repair postcommit / restart | `after-commit` in worker process, then fresh worker with the same request | Repairable evidence and stable private key | First response lost but exactly one edge committed; fresh retry is `replayed`; no new lineage |
| Repair changed reuse | Fresh worker reuses the committed key with another item/payload | Stored receipt exists | Typed idempotency conflict; committed snapshot unchanged |
| Same-key repair race | Two barrier-released worker processes with identical request | Both opened the same file-backed DB before release | One `committed`, one replay-equivalent `replayed`; one operation/event/outbox/projection and one revision advance |
| Different-key repair race | Same barrier with distinct keys | Both read the same starting fence | One commit, one `GSD_REVISION_CONFLICT`; loser leaves no residue |
| Projection contradiction | Reuse comprehensive contradiction writer; also obstruct readable output paths | Five-class DB fixture captured before file writes | Classifications, revision, content, details, ordering, and task counts are unchanged |
| Repeat-read soak | Repeated real-process status reads before, during, and after one repair | Capture authority tables and telemetry counts separately | Authority remains unchanged after reads; only audit telemetry grows; every read maps to a valid pre/post tuple |
| No-cutover sabotage | Temporarily switch status to canonical, expand response, remove named fixture, or weaken baseline inventory; restore after assertion | Gate is green before sabotage | Each controlled sabotage makes the behavioral gate fail; restored tree passes gate and workflow-authority baseline 4/4 |

## Exact snapshots to compare

Use separate snapshots so allowed telemetry does not hide authority drift:

- **Read authority:** `project_authority`, legacy hierarchy rows,
  `workflow_item_lifecycles`, Attempts, Results, operations, domain events,
  outbox, and Projection Work. Repeat reads must leave this deep-equal.
- **Observation telemetry:** `audit_events` plus the audit JSONL, loss spool, and
  emergency journal. Assert exact count deltas and loss causes.
- **Repair authority:** the read-authority snapshot plus the repair event payload.
  A successful missing-shadow adoption adds one revision, one lifecycle, one
  operation, one event, one outbox row, and one Projection Work row; it adds no
  Attempt or Result and does not rewrite the legacy row. A rollback fault changes
  none of them. An exact replay changes none of them.
- **Projection files:** hash contradictory/obstructed files separately. They may
  fail delivery or disagree with the DB; neither condition may alter the response
  or semantic classification.

## Exact missing hook recommendation

Add only this process-local test seam to
`tools/workflow-tool-executors.ts`:

```ts
type MilestoneStatusReadInterleave = () => void;

let milestoneStatusReadInterleaveForTest: MilestoneStatusReadInterleave | null = null;

export function _setMilestoneStatusReadInterleaveForTest(
  hook: MilestoneStatusReadInterleave | null,
): void {
  milestoneStatusReadInterleaveForTest = hook;
}
```

Invoke `milestoneStatusReadInterleaveForTest?.()` inside the existing
`readTransaction`, after the legacy `result`/response has been fully assembled
and immediately before `getMilestoneLifecycleShadowSnapshot()`. Invoke it on the
not-found branch at the equivalent point as well. Tests must reset it in
`afterEach`; production never sets it. Do not pass fault controls through the
public tool arguments, environment, database, or MCP schema.

The reader worker can make that hook create a `read-ready` file and synchronously
wait for `writer-committed`. A repair worker then commits against the same WAL DB
and creates that file. When the reader resumes, SQLite must retain its original
snapshot. A second fresh reader proves the post-commit tuple. This gives a
deterministic production-seam proof with one tiny hook.

No additional observation hook is warranted: database schema faults and
filesystem obstruction already reach every persistence/loss branch. No repair
hook is warranted: the stable-evidence interleave and seven Domain Operation
fault points already cover it.

## No-cutover gate shape

Keep `scripts/semantic-shadow-no-cutover-gate.mjs` deterministic and local. It
should verify the required source/fixture inventory exists, then run behavioral
contracts rather than assert on source strings:

1. the new semantic-shadow no-cutover test;
2. the frozen semantic-shadow contract and mode matrix;
3. named unadopted import/reconcile, park/unpark/discard, skipped-dependency, and
   DB-unavailable compatibility fixtures; and
4. `scripts/workflow-authority-baseline.mjs`, requiring exactly four passing
   invariants.

The concrete compatibility inventory is
`md-importer-adopted-authority.test.ts`'s unadopted re-import case
([lines 281 onward](../../src/resources/extensions/gsd/tests/md-importer-adopted-authority.test.ts)),
`workflow-reconcile.test.ts`'s unadopted completion case
([lines 326 onward](../../src/resources/extensions/gsd/tests/workflow-reconcile.test.ts)),
the park/unpark/discard suite
([park-milestone.test.ts:108-288](../../src/resources/extensions/gsd/tests/park-milestone.test.ts)),
the adopted skipped-status authorization cases
([adopted-milestone-validation-waiver.test.ts:378-410](../../src/resources/extensions/gsd/tests/adopted-milestone-validation-waiver.test.ts)),
and the DB-unavailable status case
([milestone-status-tool.test.ts:209-240](../../src/resources/extensions/gsd/tests/milestone-status-tool.test.ts)).

This matches the repository rule that tests execute behavior instead of grepping
source text ([check-source-grep-tests.sh:1-91](../../scripts/check-source-grep-tests.sh)).
The existing baseline already owns DB authority, projection contradiction, the
fault-harness contract, and the real fault boundary matrix
([workflow-authority-baseline.mjs:10-31](../../scripts/workflow-authority-baseline.mjs),
[workflow-authority-baseline.mjs:99-137](../../scripts/workflow-authority-baseline.mjs)).
The gate must not query GitHub metadata, labels, or tags.
