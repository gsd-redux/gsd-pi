# M002 S05 Projection, Import, Kernel, and Closeout Research

**Status:** Research complete
**Date:** 2026-07-12
**Scope:** Additive schema foundation only; S06 owns atomic Domain Operations, adapters, queries, and runtime cutover
**Final recommendation:** Add six tables and reuse the v31–v34 authority, lifecycle, Attempt, recovery, and evidence facts.

## Outcome

S05 should add only the durable facts that are still missing:

1. one projection work queue;
2. one immutable import application receipt;
3. one append-only kernel checkpoint chain;
4. immutable closeout plans;
5. immutable ordered closeout effects; and
6. immutable success-only settlement receipts.

Do not add another project, work item, Attempt, kernel run, closeout session,
settlement aggregate, effect-attempt ledger, projection-attempt history, import
preview hierarchy, repository registry, workspace registry, or recovery system.
Existing canonical records already own those identities or outcomes.

## Research Findings

### Projection drift

- `workflow-projections.ts::renderAllProjections` and
  `projection-flush.ts::flushWorkflowProjections` are caller-triggered and
  process-local. A failed render has no durable desired revision, claim,
  retry, or supersession fact.
- `workflow-projections.ts::renderStateProjection` consults
  `state-manifest.json` before writing. A projection therefore influences
  projection policy even though the database is meant to be authoritative.
- `commands-maintenance.ts::rebuildMarkdownProjectionsFromDb` refreshes the
  database from disk before rebuilding Markdown and may delete artifact rows
  in response to file drift. Rebuild crosses the authority boundary.
- `worktree-state-projection.ts` copies summaries, assessments, and completed
  unit trees between roots. Its own comments describe stale assessment files
  causing UAT redispatch after database rebuild.
- Task completion currently rolls database state back when projection fails,
  while slice/milestone completion keeps database completion. This inconsistent
  behavior is the highest-value negative cutover test.
- Reuse the pure renderers and atomic file-write helpers. Reuse the v31 outbox
  claim/retry pattern, but not the generic outbox table: projection work needs
  a logical target, source revision, rendered hash, and supersession semantics.

### Import drift

- `migrate/plan.ts::createMigrationPlan` and
  `migrate/preview.ts::generatePreview` return aggregate counts rather than an
  exact source fingerprint and ordered change set. They cannot prove that the
  approved input is unchanged.
- `migrate/execution.ts::executeMigrationWrite` writes Markdown, clears the
  database, imports the Markdown, and may restore the whole `.gsd` directory
  after a later error. This reverses the one-way authority rule.
- `md-importer.ts` derives status and completion from checkboxes, SUMMARY
  existence, and mtimes, then upserts live state. Parser and transformer code
  may remain import adapters; their live writers must not be canonical.
- `workflow-manifest.ts`, JSONL event replay, and reconciliation skip or
  reinterpret corrupt/unknown history. Import them as diagnosed history only;
  never replay them as current authority.
- Reuse `db-migration-backup.ts` mechanics: WAL checkpoint, independent open,
  schema validation, and `PRAGMA quick_check`. Directory-copy backup semantics
  are insufficient.

### Kernel and work identity

- `project_authority` already owns the singleton project identity, root, exact
  revision, and Authority Epoch.
- `workflow_item_lifecycles` already owns milestone/slice/task work identity.
  `workflow_execution_attempts` owns execution identity, fencing, retry chains,
  and one-active-Attempt rules. A second work or kernel-run table would drift.
- `workflow_work_checkpoints` are narrative conversation/resume records. They
  are not an execution-stage cursor and should not receive kernel stage kinds.
- `auto/workflow-kernel.ts` is process-local loop policy; `uok/kernel.ts`
  selects legacy/UOK paths and writes parity telemetry. Neither is restart
  authority.
- The accepted five-stage kernel still includes Advance, but no lifecycle
  checkpoint exists before work selection: absence of an active checkpoint is
  the durable Advance state. The first checkpoint records Execute and is
  created atomically with the selected lifecycle's claimed Attempt. Persisting
  a pre-claim Advance row would require an invented project-global worker/run
  identity. A settled checkpoint represents the current cycle, not permanent
  lifecycle finality, because v32 permits authorized reopen.
- Worktree paths are ephemeral runtime handles. Repository definitions are
  preferences-derived today. Closeout effects should snapshot their logical
  repository/effect inputs rather than introduce repository/workspace tables.

### Closeout and settlement drift

- `unit-closeout.ts`, `auto-unit-closeout.ts`, and the auto orchestrator use
  different pipelines. Git outcomes, metrics, memory, and process booleans are
  not one restart-safe settlement fact.
- `closeout-consistency-gate.ts` may refresh the database from disk and can
  synthesize a passing validation from SUMMARY presence.
- `milestone-closeout-proof.ts` and `milestone-settlement.ts` require files and
  process-local `milestoneMerged` state. Restart continuity is inferred rather
  than receipted.
- `turn_git_transactions` and `milestone_commit_attributions` are replaceable
  audit/compatibility rows without canonical lifecycle, effect, revision, or
  idempotency identity. They cannot become settlement receipts.
- Projection, notification, metrics, indexing, and memory are follow-on work.
  They must not become settlement-critical host effects.

## Final Six-Table Contract

### 1. `workflow_projection_work`

One durable specialized queue; no separate projection-attempt table.

Core fields:

- `projection_work_id`, `project_id`;
- normalized `projection_key` as the complete logical target identity and
  `projection_kind` as renderer selection metadata;
- unique nullable `supersedes_projection_work_id` current-head lineage;
- enqueue `operation_id`, `source_project_revision`, and
  `source_authority_epoch` as one exact v31 provenance tuple;
- `renderer_version` metadata;
- delivery state `pending | claimed | rendered | dead_letter`;
- claim owner, `claim_fencing_token`, `claimed_at`, `claim_expires_at`,
  monotonic `state_version`, `attempt_count`, `next_attempt_at`, and
  `last_error`;
- rendered hash/time;
- causal operation/revision/epoch provenance.

Identity, logical target, renderer version, and enqueue provenance are
immutable. A successor must name the causally older current head for the same
project/key and advance source revision without decreasing epoch. Supersession
is derived from that successor; it is not a mutable state. Only delivery fields
transition. A failed attempt returns `claimed → pending` while incrementing
attempt/backoff/error; the next claim preserves that diagnostic and backoff.
Exhausted work becomes `dead_letter`.

Currentness is per logical projection key: its lineage head is current when it
is rendered and its rendered source revision/hash match that desired row. An
unrelated project operation does not stale unaffected projections. A claim or
render transition must reject a row with a successor. Local DDL validates claim
shape and monotonic fence/state versions; S06's compare-and-swap writer proves
the caller presented the current fence. Operational delivery changes do not
create v31 Domain Operations or advance project revision. Store no absolute
path as authority. V35 intentionally retains only cumulative attempt count and
the latest failure; per-attempt delivery history can be added later only if
operational audit requires it.

### 2. `workflow_import_applications`

One immutable application receipt; preview generation must leave the
authoritative database byte-identical.

Core fields:

- application `operation_id` primary key, `project_id`, exact resulting
  revision, and resulting Authority Epoch;
- import kind, importer version, preview schema version;
- unique `preview_id` and `preview_hash`;
- base project revision, Authority Epoch, and database schema version;
- source-set hash, change-set hash, counts, and `unresolved_count = 0`;
- canonical versioned `preview_json` containing ordered source fingerprints,
  parse diagnoses, exact changes, raw legacy values/references, and explicit
  ambiguity resolutions;
- backup reference, SHA-256, byte size, schema version, project revision,
  Authority Epoch, `quick_check = ok`, and verified timestamp;
- application timestamp and exact resulting revision/epoch.

V31 operations provide actor, expected/resulting revision, idempotency, and
request hash. V31 domain events provide per-entity result provenance. Child
preview/source/change tables add no authority because application is
indivisible. A non-authoritative sidecar may retain a preview across restart;
application re-fingerprints and re-parses every source before the transaction.
The receipt trigger requires an import-application operation whose expected
revision/epoch equal the stored base, whose resulting tuple equals the receipt,
whose request hash equals `preview_hash`, and whose backup schema/revision/epoch
equal the base snapshot. Once receipted, that operation is immutable. The
canonical JSON repeats the schema-visible envelope metadata, hashes, and counts
so raw mismatches fail locally. `preview_hash`
covers that complete canonical envelope—scalar metadata plus ordered sources,
changes, raw values, diagnostics, and resolutions—not only the nested lists.
SQLite validates digest formats and equality of repeated fields but does not
recompute SHA-256 or open the referenced backup. The S06 application writer
must canonicalize and hash the preview, re-fingerprint its sources and changes,
and independently open, check, and hash the backup before inserting the receipt.
Unparsed material must be explicitly preserved with raw content/reference and
an accepted disposition or remain unresolved; it may never disappear behind a
zero aggregate count.

### 3. `workflow_kernel_checkpoints`

One append-only current-head chain per lifecycle.

Core fields:

- `kernel_checkpoint_id`, `project_id`, `lifecycle_id`, `attempt_id`;
- `next_stage`: `execute | verify | route | closeout | settled`;
- sequence and unique `previous_kernel_checkpoint_id`;
- created timestamp and exact operation/revision/epoch provenance.

Absence of a checkpoint means Advance. The first row is sequence 1, has no
predecessor, records Execute, and names the already-claimed v32 Attempt. A
second root for the lifecycle is forbidden. Every successor names the current
head, increments sequence by one, strictly advances revision, and never
decreases epoch. Ordinary successors retain the Attempt. Any Attempt change
requires Execute and a new v32 Attempt whose `retry_of_attempt_id` is the
predecessor checkpoint's Attempt. This covers retry and authorized reopen; do
not separately hardcode predecessor stages. A settled head may therefore gain
a later Execute successor. S05 enforces chain, scope, retry identity,
provenance, and immutability; S06 enforces legal stage prerequisites and writes
each checkpoint atomically with sibling Result, verdict, recovery, or closeout
facts. Do not add payload JSON, status text, worker identity, or resume tokens.

### 4. `workflow_closeout_plans`

Immutable prepared plan versions with current-head supersession.

Core fields:

- `closeout_plan_id`, project/lifecycle/Attempt identity;
- opaque tested source-set hash and deterministic readiness/basis hash;
- unique `supersedes_closeout_plan_id`;
- prepared timestamp and exact operation/revision/epoch provenance.

No mutable plan status. There is one root lineage per project/lifecycle, not
per Attempt, and the lineage head is current. Supersession preserves
project/lifecycle but may name a later descendant Attempt; v32's larger attempt
number in the same lifecycle proves descent even if intervening Attempts never
reached Closeout. S06 revalidates the basis before each host effect and before
final lifecycle completion.

### 5. `workflow_closeout_effects`

Immutable ordered settlement-critical host effects owned by one plan.

Core fields:

- `closeout_effect_id`, plan/project/lifecycle identity;
- integer ordinal;
- normalized effect kind;
- deterministic idempotency key;
- canonical effect spec JSON and spec hash;
- the exact same preparation operation/revision/epoch tuple as the parent plan.

Use one ordinal, not an effect dependency graph. Effect idempotency keys are
unique within a plan and may repeat across superseding plans so adapters can
recognize prior host results. A plan may have zero host effects. Only effects
whose success is required before closeout belong here,
typically source commit, worktree integration, merge, or publish. Projection
and advisory follow-on work are excluded. V35 validates nonempty JSON and
lowercase `sha256:` shape; S06 owns canonical spec hashing and idempotent host
execution.

### 6. `workflow_settlement_receipts`

Immutable success-only receipt, at most one per closeout effect.

Core fields:

- `settlement_receipt_id`, effect/project/lifecycle identity;
- outcome `performed | recognized`;
- external identity/reference;
- canonical proof JSON and proof hash;
- settled timestamp and exact operation/revision/epoch provenance.

External identity is nonblank for performed and recognized outcomes. Receipt
provenance is strictly later than plan/effect creation and may not decrease
epoch. A receipt requires receipts for all lower effect ordinals on the same
plan and is rejected if that plan already has a successor. Missing receipt
means pending. Failures are v34 Failure Observations and Recovery Actions,
never failed receipts. A crash after a host effect but before its receipt must
replay the same idempotency key, recognize the existing host result, and write
`recognized`. Old receipts remain valid history after later plan supersession;
S06 completion queries consider only the current plan. Do not add a settlement
aggregate: current plan plus receipt coverage plus lifecycle status already
answer settlement state. V35 validates nonempty proof JSON and lowercase
`sha256:` shape; S06 owns canonical proof hashing and verification.

## Local S05 Invariants

1. Every new authoritative fact binds to the exact v31 project/revision/epoch operation tuple.
2. Projection desired identity/lineage is immutable; delivery transitions are fenced, versioned, and restart-safe without advancing domain revision.
3. Import application is immutable, unresolved-free, carries matching verified-backup metadata, and is unique per preview hash; S06 performs external backup and digest verification.
4. Kernel checkpoints form one immutable, gap-free, no-fork head per lifecycle.
5. Kernel Attempt changes are restricted to a valid retry/reopen Execute checkpoint.
6. Closeout plan supersession preserves project/lifecycle, uses the same or a later descendant Attempt, and advances provenance.
7. Effects are immutable, born with their plan, uniquely ordered per plan, and carry per-plan deterministic idempotency keys.
8. Receipts are ordered immutable success facts, unique per effect, causally scoped, and cannot be added after plan supersession.
9. No new table or trigger changes current lifecycle completion behavior during S05.

## RED, Restart, Migration, and Fault Proofs

### Schema and migration

- Fresh and v34→v35 upgrade create exactly six tables and preserve all legacy/v31–v34 rows.
- Backup independently opens, reports the prior schema version, and passes `quick_check`.
- A fault after v35 DDL but before commit leaves no v35 tables and retries cleanly.
- Older-version rewind fixtures remove every later table and index before stamping the older version.

### Projection

- Claim, lease expiry, retry, failure, rendered hash, and supersession survive reopen.
- Local transitions reject a missing/malformed claim tuple, a non-increasing
  fence/state version, an invalid retry/dead-letter transition, and any
  claim/render of a row with a successor.
- A second lineage root, fork, stale source revision, or mismatched logical key
  is rejected; an unrelated project operation does not stale an unaffected
  rendered lineage head.
- Projection claims and delivery transitions leave
  `project_authority.revision` unchanged.

### Import

- Raw receipt inserts reject unresolved, malformed, count/hash-mismatched,
  wrong-operation-type, expected/resulting revision mismatch, and backup/base
  mismatch.
- Application receipts and sealed preview envelopes reject update/delete.
- The same preview hash or v31 idempotency identity cannot create two
  applications.
- Tests compare a stable logical database snapshot—authority revision/epoch,
  schema, and table contents—rather than incidental SQLite file/WAL bytes.

### Kernel

- Reopen after every checkpoint returns the identical current head and next stage.
- Reject wrong-lifecycle Attempts, forks, gaps, stale revision/epoch, invalid Attempt changes, update, and delete.
- Removing runtime files, JSONL, worktree markers, or Markdown does not change the current head.
- S06 fault tests later prove no checkpoint can commit without its sibling facts.

### Closeout

- Reject a second plan root, a fork, unrelated/lower Attempt supersession,
  cross-scope effects/receipts, effects outside the plan's preparation
  operation, and duplicate ordinals/idempotency keys within one plan.
- Permit the same idempotency key on a superseding plan.
- Reject out-of-order receipts, receipt mutation/deletion, and receipt insertion
  after plan supersession.
- Reopen with partial receipts returns the same first missing ordinal.
- File summaries, validation artifacts, Git audit rows, process flags, and projections cannot substitute for a receipt.
- Zero-effect plans are valid and require no synthetic receipt.

## Future S06 Acceptance Tests

- Obstruct a projection target: the domain operation and Projection Work
  enqueue commit, the worker records retryable failure without rolling domain
  completion back, removal permits retry, and an obsolete claimant cannot
  overwrite the newer real file.
- Delete or contradict Markdown, manifests, JSONL, runtime state, and worktree
  markers; canonical domain state, projection backlog, and kernel head remain
  unchanged.
- Preview generation performs no authoritative write and preserves the logical
  database snapshot. A one-byte source/base/parser/resolution change invalidates
  approval. Application faults at validation, domain mutation, event emission,
  or receipt insertion roll back the whole transaction; idempotent retry yields
  one application and ordered event set.
- Crash before a host effect, after the host effect, and after receipt insert.
  Replaying the deterministic key performs or recognizes one host result and
  writes one ordered receipt without duplicating the effect.
- Fault at every kernel sibling write; no checkpoint commits without its
  Attempt/Result/verdict/recovery/closeout facts.

## Explicit S06 Boundary

S05 lands schema and local invariants only. S06 owns:

- atomic Domain Operations and expected-revision/fencing checks;
- domain mutation + event + projection-work enqueue;
- import application writers and entity events;
- Attempt claim + first kernel checkpoint;
- Result/failure/evidence/verdict/recovery + kernel transitions;
- closeout preparation, effect execution/recognition, receipt recording, final completion, and dependency unlock;
- canonical Query Module reads and idempotent replay;
- projection worker/adapters and filesystem-obstruction cutover tests;
- migration/import adapters and the Forward Repair boundary; and
- removal of file/process authority from auto, interactive, custom, and UOK paths.

S05 must not install triggers that block existing v32 lifecycle completion or
wire current tools to the new tables. That would create a partial runtime
cutover before the atomic operation boundary exists.

## Decision Summary

Adopt **six tables**: Projection Work, Import Applications, Kernel Checkpoints,
Closeout Plans, Closeout Effects, and Settlement Receipts. This is the smallest
model that makes desired projection revision, applied import provenance,
restart stage, prepared closeout intent, host effects, and successful external
settlement independently durable without duplicating existing identities or
creating new mutable state machines.
