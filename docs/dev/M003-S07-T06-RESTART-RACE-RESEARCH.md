# M003/S07/T06 restart and race research

> **Status:** Historical pre-implementation design snapshot. Current behavior
> is owned by the
> [semantic-shadow contract](M003-S07-SEMANTIC-SHADOW-RESEARCH.md) and the
> [lifecycle integration runbook](lifecycle-command-integration-runbook.md#s07-semantic-shadow-dossier).

**Date:** 2026-07-15
**Scope:** Research only. This record maps the real process and SQLite seams for
the S07 restart/race/fault soak. It does not authorize read cutover.

## Recommendation

Build one deterministic, real-process soak around the existing public status
executor and repair operation. Use explicit child-process barriers, not random
timing. The minimum credible proof has four parts:

1. a status read while a second process holds a fully staged but uncommitted
   lifecycle-shaped transaction, followed by the same read after commit;
2. two repair processes stopped at the existing pre-operation hook, then
   released together for same-key and different-key races;
3. fresh-process replay after pre-commit rollback and after-commit lost response;
4. two simultaneous token-bearing same-project MCP children, both of which must
   remain alive and resolve only their own pump token.

The fourth case is RED against the current implementation. The MCP PID registry
is a project-wide singleton and terminates any verified earlier same-project MCP
process, even when it is still a legitimate child of an overlapping pump. The
smallest fix is to exempt token-bearing ephemeral workflow MCP children from the
singleton registry and retain the existing parent-loss/stdin watchdog for their
cleanup. Do not weaken PID verification for ordinary long-lived MCP sessions.

## Primary-source findings

### SQLite gives the read seam the right atomicity

File-backed GSD databases normally open in WAL mode with a 5-second busy timeout
and `synchronous=NORMAL`
([`db/engine.ts:123-130`](../../src/resources/extensions/gsd/db/engine.ts)). The
status executor wraps the legacy response queries and the canonical shadow query
in one `readTransaction`
([`workflow-tool-executors.ts:2088-2124`](../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts)).
The transaction helper explicitly uses `BEGIN DEFERRED`, and its contract is a
single consistent snapshot across multiple SELECTs
([`db/engine.ts:961-978`](../../src/resources/extensions/gsd/db/engine.ts),
[`db-transaction.ts:36-42`](../../src/resources/extensions/gsd/db-transaction.ts)).

This matches SQLite's documented WAL snapshot isolation: a reader keeps the
database view from the start of its transaction, concurrent commits are invisible
until that transaction ends, readers and a writer may run concurrently, and
there is only one writer at a time. See the official SQLite documentation on
[isolation](https://www.sqlite.org/isolation.html) and
[WAL concurrency](https://sqlite.org/wal.html#concurrency).

The hierarchy shadow query reads the authority revision/epoch, legacy hierarchy,
and canonical lifecycle identities in the caller-owned snapshot
([`db/queries.ts:440-516`](../../src/resources/extensions/gsd/db/queries.ts)).
Therefore a correct status result must be one complete fingerprint from before a
commit or one complete fingerprint from after it. A mixture is an application
bug in transaction placement, not an allowed WAL result.

Do not use WAL-file size or the base `gsd.db` bytes as the oracle. Commits append
to the WAL and checkpointing later copies frames into the base file; readers
correctly consult both. A checkpoint may stop at an active reader's end mark
([official WAL documentation](https://sqlite.org/wal.html#how_wal_works)). Assert
SQL-visible rows and revisions through a fresh connection instead.

### Writes and repairs already have the correct serialization fence

Domain Operations use `BEGIN IMMEDIATE`, translate SQLite writer contention into
`GSD_REVISION_CONFLICT`, check idempotency before checking the expected revision,
and commit the operation, mutation, events, outbox, projection work, and authority
CAS together
([`db/domain-operation.ts:361-430`](../../src/resources/extensions/gsd/db/domain-operation.ts),
[`db/domain-operation.ts:431-606`](../../src/resources/extensions/gsd/db/domain-operation.ts)).
SQLite documents that `BEGIN IMMEDIATE` obtains the write transaction up front,
preventing a later read-to-write upgrade from failing with
`SQLITE_BUSY_SNAPSHOT` ([official isolation documentation](https://www.sqlite.org/isolation.html)).

The repair path reads a candidate, then re-reads and requires identical durable
legacy/canonical state and evidence inside its Domain Operation
([`lifecycle-shadow-repair-domain-operation.ts:115-169`](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts)).
Exact replay is checked before new work; repair edges are receipt-fenced and only
the enumerated forward edges are legal
([`lifecycle-shadow-repair-domain-operation.ts:229-299`](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts),
[`db/writers/lifecycle-commands.ts:548-599`](../../src/resources/extensions/gsd/db/writers/lifecycle-commands.ts)).

Existing tests prove these rules in one process, including exact replay versus
changed key reuse, stable-evidence rejection, all pre-commit fault points, and
after-commit replay
([`lifecycle-shadow-forward-repair.test.ts:270-287`](../../src/resources/extensions/gsd/tests/lifecycle-shadow-forward-repair.test.ts),
[`lifecycle-shadow-forward-repair.test.ts:450-525`](../../src/resources/extensions/gsd/tests/lifecycle-shadow-forward-repair.test.ts)).
Existing Slice contention tests establish the repository's preferred real-process
pattern: spawn Node workers, wait at explicit files, release them together, and
assert one durable lineage rather than scheduler ordering
([`slice-lifecycle-multiprocess-contention.test.ts:52-125`](../../src/resources/extensions/gsd/tests/slice-lifecycle-multiprocess-contention.test.ts),
[`slice-lifecycle-multiprocess-contention.test.ts:263-412`](../../src/resources/extensions/gsd/tests/slice-lifecycle-multiprocess-contention.test.ts)).
T06 should reuse that convention rather than add probabilistic loops.

### Observation persistence is intentionally outside the read snapshot

The executor ends the read transaction before building and emitting the
observation, then returns the already-built legacy response
([`workflow-tool-executors.ts:2124-2131`](../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts)).
This prevents telemetry writes from extending or upgrading the read transaction.
If the canonical shadow query fails, the legacy response remains available and
the observation records `shadow_query_failed`
([`lifecycle-shadow-observation.ts:118-170`](../../src/resources/extensions/gsd/lifecycle-shadow-observation.ts)).

The primary observation sink is `audit_events`. A failure falls through to a
locked JSONL audit projection, then a runtime spool, then an emergency loss
journal. Projection failure after a successful DB insert creates a second
authoritative loss event
([`uok/audit.ts:130-203`](../../src/resources/extensions/gsd/uok/audit.ts)). Existing
tests already show portable obstruction techniques: replace `.gsd/audit` or
`.gsd/runtime` directories with files, or remove the audit table, then assert the
DB/spool/emergency record
([`uok-audit.test.ts:285-349`](../../src/resources/extensions/gsd/tests/uok-audit.test.ts),
[`uok-audit.test.ts:352-382`](../../src/resources/extensions/gsd/tests/uok-audit.test.ts)).

### Per-pump tokens prevent attribution drift but expose two lifecycle gaps

Each pump inserts one opaque token row in `runtime_kv`, including the canonical
database path, mode, trace/turn, and expiry
([`milestone-status-observation-context.ts:165-204`](../../src/resources/extensions/gsd/milestone-status-observation-context.ts)).
Lookup is an exact key lookup and validates both token and database path; a
missing, invalid, expired, or cross-project token degrades to explicit context
loss rather than guessing
([`milestone-status-observation-context.ts:132-163`](../../src/resources/extensions/gsd/milestone-status-observation-context.ts),
[`milestone-status-observation-context.ts:226-250`](../../src/resources/extensions/gsd/milestone-status-observation-context.ts)).

The stream adapter scrubs any inherited token, injects the newly created token
into both the SDK child environment and the selected local MCP server environment,
and clears the exact row on every normal/error/abort/finally exit
([`stream-adapter.ts:2317-2339`](../../src/resources/extensions/claude-code-cli/stream-adapter.ts),
[`stream-adapter.ts:2353-2365`](../../src/resources/extensions/claude-code-cli/stream-adapter.ts),
[`stream-adapter.ts:2383-2416`](../../src/resources/extensions/claude-code-cli/stream-adapter.ts),
[`stream-adapter.ts:2796-2822`](../../src/resources/extensions/claude-code-cli/stream-adapter.ts)).
The MCP status handler reads only that environment token and preserves explicit
loss when resolution is unavailable
([`workflow-tools.ts:3201-3228`](../../packages/mcp-server/src/workflow-tools.ts)).

Two gaps remain:

1. **Hard-killed pump residue.** Expiry is checked only when that exact token is
   read. A hard-killed pump leaves an unreferenced expired row indefinitely
   because `begin` does not scavenge expired prefix rows. This cannot cause
   misattribution, but it defeats the intended bounded crash fallback. On `begin`,
   delete expired/invalid rows under the observation prefix in the same short
   isolated connection. Keep this soft-state cleanup response-neutral.
2. **Live MCP collision.** MCP CLI startup sweeps orphans, then registers one PID
   per project
   ([`cli-runner.ts:275-285`](../../packages/mcp-server/src/cli-runner.ts)). Registration
   does not require the existing process to be orphaned: if a verified entry has
   another PID, it sends SIGTERM and possibly SIGKILL before overwriting the row
   ([`pid-registry.ts:432-535`](../../packages/mcp-server/src/pid-registry.ts)). Two
   overlapping per-pump children are therefore treated as replacement instances.
   Exact tokens prevent wrong attribution, but the first legitimate tool call can
   be interrupted. Token-bearing ephemeral children should skip singleton
   registration, as probe sessions already do
   ([`cli-runner.test.ts:248-275`](../../packages/mcp-server/src/cli-runner.test.ts));
   their existing parent-loss/stdin cleanup remains active
   ([`cli-runner.ts:252-273`](../../packages/mcp-server/src/cli-runner.ts),
   [`cli-runner.ts:295-323`](../../packages/mcp-server/src/cli-runner.ts)).

### Checkpoint caution for the soak

`closeDatabase` explicitly runs `PRAGMA wal_checkpoint(TRUNCATE)` before closing
([`db/engine.ts:803-814`](../../src/resources/extensions/gsd/db/engine.ts)). Do not
make concurrent close/checkpoint calls part of the race oracle. Release and join
all writer/read workers first, then close connections in teardown. This keeps the
test focused on lifecycle semantics and avoids conflating it with checkpoint
scheduling.

SQLite disclosed a rare WAL-reset race affecting older SQLite releases during
concurrent checkpoint/write activity and fixed it in 3.51.3 and selected
backports ([official WAL documentation, section 11](https://sqlite.org/wal.html#the_wal_reset_bug)).
The local research runtime reports SQLite 3.53.1, but the package supports Node
22+ and must not assume every supported runtime embeds that version. T06 should
record `SELECT sqlite_version()` in diagnostics, avoid deliberate simultaneous
checkpoints, and treat integrity testing across the supported Node matrix as a
separate CI/runtime-compatibility concern.

## Deterministic soak design

### Smallest credible worker fixture

Create one executable fixture at
`src/resources/extensions/gsd/tests/fixtures/semantic-shadow-worker.ts`. Give it a
single JSON input and emit exactly one `SEMANTIC_SHADOW_OUTCOME=<json>` line.
Support only these actions:

| Action | Behavior | Barrier |
|---|---|---|
| `hold-write` | Open the real DB, `BEGIN IMMEDIATE`, update a legacy hierarchy row, its canonical lifecycle head, and authority revision to the supplied post-state; wait; COMMIT. This is a lifecycle-shaped atomic write fixture, not production routing. | `ready` after open, `staged` after updates, `release` before COMMIT |
| `repair` | Open DB, arm `_setLifecycleShadowRepairBeforeCommitForTest`; capture the candidate/fence, signal, wait, then call `repairLifecycleShadowForward`; optionally arm a Domain Operation fault. | `ready`, `candidate-read`, `release` |
| `token-hold` | Begin an exact observation turn with supplied mode/trace, emit token, wait or exit without clear to model hard death. | `token-created`, `release` |
| `mcp-serve` | Run the real stdio MCP CLI with a supplied project root, unique token, and isolated `GSD_HOME`; keep stdin open until parent closes it. | readiness comes from the CLI's existing “MCP server started” stderr line |

Use the existing TypeScript child launch convention (`process.execPath`, the
repository resolver, `--experimental-strip-types`) from the Slice contention
test. File barriers are adequate and cross-process; deadlines must fail loudly
if a child exits early. Always include stdout/stderr in assertion failures.

### Scenario 1: read is wholly pre-commit or post-commit

For 12–25 rounds, seed two exact fingerprints:

- pre: revision `r`, known legacy response/task counts, known raw and normalized
  lifecycle classifications;
- post: revision `r+1`, a different legacy response/task-count fingerprint and
  matching post canonical heads.

Start `hold-write`, wait until its transaction is staged but uncommitted, and run
the real `executeMilestoneStatus`. It must return the complete pre response and
persist an observation with revision `r` and the complete pre classification set.
Release the child, wait for COMMIT, then repeat the public read; it must match the
complete post pair. Reject every response/observation combination not in the two
allowed pairs. Alternate the two states across rounds so cached answers cannot
pass.

This deliberately does not depend on landing a COMMIT between two individual
SELECT statements. The staged-uncommitted read proves readers never see partial
pages; the single `readTransaction` plus SQLite snapshot guarantee covers a
commit that occurs during the read.

### Scenario 2: repair contention and restart

Use a single-edge missing terminal Task shadow with durable completion evidence.

- **Same key:** stop both repair children at `candidate-read`, release together,
  and require one `committed`, one `replayed`, receipt-equivalent payloads, one
  revision increment, one operation/event/outbox/projection lineage, and one
  canonical head.
- **Different keys:** use the same barrier but distinct idempotency keys. Require
  one committed receipt and one `GSD_REVISION_CONFLICT` (or stable-candidate
  rejection if the loser crossed the barrier later), with zero loser residue.
- **Pre-commit crash:** arm `after-events` (and one representative `before-cas`),
  let the process exit after the injected error, verify the exact pre-snapshot in
  a fresh process, then retry the same key and require one commit.
- **After-commit lost response:** arm `after-commit`, let the first process report
  failure and exit, then invoke the same payload/key in a fresh process and
  require `replayed` with unchanged revision/lineage.
- **Changed reuse:** fresh process, same key but a different item identity;
  require idempotency conflict and unchanged authority.

The full in-process fault matrix already exists; the soak should sample boundary
classes, not duplicate all six points.

### Scenario 3: exact tokens survive overlap and restart

Start two `token-hold` children for the same database with distinct modes/traces.
Resolve each token from a third process and require exact attribution. Swap tokens
across another project and require `legacy` plus `contextError=unavailable`; never
select the other live row. SIGKILL one owner, start a replacement with a new
token, and prove the replacement cannot read the stale context. Advance the test
clock past TTL/start another turn and require the stale prefix row to be removed
once scavenging is implemented.

Then start two real `mcp-serve` children for the same project, each with a unique
observation token. Require both to reach MCP readiness and remain alive until the
parent closes their separate stdin streams. This test must fail if the second
startup signals the first or overwrites a shared live-session invariant. Also run
one ordinary non-token MCP pair/unit case to preserve the existing singleton
replacement behavior.

### Scenario 4: fault and projection neutrality

Freeze the public response before each fault.

- Rename the canonical lifecycle table after DB open (restore in `finally`) so
  the shadow SELECT fails while legacy queries still succeed. Require the frozen
  response and a visible `shadow_query_failed` observation/loss cause.
- Hold a second-process `BEGIN IMMEDIATE`, temporarily lower the reader
  connection's busy timeout, and execute the status read. The read must succeed;
  the audit insert must fail into an explicit primary-sink loss projection/spool.
  Restore the timeout immediately.
- Replace `.gsd/audit` with a file. Require unchanged response, one authoritative
  observation plus one `projection_sink_failed` loss event.
- Write contradictory Markdown projections and separately obstruct projection
  destinations. Require identical DB-derived classification. The existing
  authority conflict fixture demonstrates the correct contradiction pattern
  ([`workflow-authority-projection-conflict.test.ts:134-175`](../../src/resources/extensions/gsd/tests/workflow-authority-projection-conflict.test.ts)).

Finally run 25 identical reads and compare authoritative snapshots before/after.
Only audit telemetry and the test-owned token soft state may change; hierarchy,
lifecycle, authority revision/epoch, operations, events, outbox, projection work,
Attempts, Results, and evidence must be identical.

## Required assertions and diagnostics

Every failure should print child PID/action, barrier reached, exit/signal,
stdout/stderr, SQLite version/journal mode, pre/post authority revision, operation
key, and row-count deltas. The soak passes only if:

- every status response and observation is one allowed pre/post pair;
- same-key repair has one committed lineage and one replay-equivalent receipt;
- a losing different-key/changed-payload attempt leaves no rows;
- fresh-process post-commit retry is replayed, not recommitted;
- sink/query/projection faults never alter the frozen public response and always
  produce visible loss accounting;
- exact tokens never cross pumps or projects;
- two token-bearing same-project MCP children coexist;
- repeat reads mutate telemetry only; and
- `PRAGMA quick_check` returns `ok` after all workers join.

## Implementation order

1. Add the worker fixture and RED tests for read snapshot, repair races/restart,
   token residue, and dual MCP liveness.
2. Fix only the two demonstrated lifecycle gaps: expired token scavenging and
   token-bearing MCP singleton exemption.
3. Add query/sink/projection fault cases and the repeat-read mutation snapshot.
4. Run the focused soak repeatedly (at least 20 local invocations), then the
   existing repair, observation, MCP CLI/PID registry, workflow fault, and
   authority-baseline suites.
5. Keep no-cutover enforcement in the separate structural/behavioral gate; this
   soak supplies runtime evidence and must not become an alternate cutover gate.
