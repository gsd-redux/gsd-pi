# M003/S06 Milestone Lifecycle Convergence Research

**Status:** pre-implementation snapshot at `72ac5a5e`

**Scope:** Milestone validation, complete, and full-hierarchy reopen/reset; the
current cancellation-adjacent actions are mapped but remain outside S06 unless
the accepted M003 boundary changes.

**Method:** static analysis of repository source, tests, accepted ADRs, and the
database-backed M003 project roadmap on 2026-07-14.

## Executive recommendation

Add one `milestone-lifecycle-domain-operation.ts` adapter and one context-bound
`db/writers/milestone-lifecycle.ts` writer. Route Milestone validation,
completion, and full-redo reopen through stable private execution identity, one
revision/Authority-Epoch-fenced Domain Operation, and one durable receipt.

Completion should change only the Milestone head after proving every descendant
legacy/canonical pair is terminal and matched, every cancellation has a current
Waiver, and the current database validation/UAT/gate evidence passes. Reopen
should preserve the existing full-redo public contract: Milestone legacy
`active` / canonical `ready`, every Slice legacy `in_progress` / canonical
`ready`, and every terminal Task legacy `pending` / canonical `ready`, while all
Attempts, Results, evidence, and prior events remain immutable. Those pairs are
the already-approved `semantic_match_exact_delta`, not an excuse for a second
transition or silent mismatch (`db/lifecycle-shadow-comparison.ts:27-41,62-95`).

Do not put merge/publication settlement, park/unpark, physical discard, legacy
read cutover, or projection-worker redesign into S06. The M003 roadmap explicitly
leaves closeout effects, park/unpark, import/reconciliation authority, projection
delivery, and legacy reads unchanged (`.gsd/phases/03-lifecycle-command-integration-and-shadow/03-ROADMAP.md:3-13,32-53`), and the S05 runbook repeats that Milestone complete/reopen are S06 while park/unpark is later
(`docs/dev/lifecycle-command-integration-runbook.md:63-64,94-107`).

## Accepted invariants and reusable foundation

- SQLite is the only normal-runtime authority; only Domain Operations mutate
  workflow state, atomically committing state, events, outbox, Projection Work,
  and revision (`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:74-90`).
- Files are one-way projections. Their failure is visible and retryable but
  cannot authorize, roll back, or fabricate lifecycle state
  (`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:92-112,192-207`).
- Schema v41 already supplies the required Milestone lifecycle tables and
  identities; no new lifecycle table is needed
  (`src/resources/extensions/gsd/db-lifecycle-foundation-schema.ts:13-43,47-60`).
  Implementation disproved the stronger no-migration assumption: v36 settlement
  triggers authorized only `attempt.settle`, so v42 narrowly extends the existing
  Attempt/Result/verdict/evidence invariants to permit one atomic
  `milestone.validate` operation without weakening other settlement paths.
- `executeDomainOperation()` already owns replay detection, revision/Epoch
  validation, the outer transaction, events, outbox, Projection Work, and the
  authority CAS (`src/resources/extensions/gsd/db/domain-operation.ts:382-429,431-518`).
- Planning already adopts the Milestone as canonical `ready` inside
  `workflow.milestone.plan`, so S06 is a cutover of existing heads rather than a
  backfill design (`src/resources/extensions/gsd/milestone-planning-persistence.ts:214-271`).
- S05 supplies the closest implementation pattern: command-specific receipts,
  event-backed replay payloads, current-head checks, post-commit projection
  delivery, and public `duplicate` / `superseded` / `stale` truth
  (`src/resources/extensions/gsd/slice-lifecycle-domain-operation.ts:80-101,120-199,202-277,325-363`).

## Current flow map

| Semantic flow | Public/internal entry points | Current authority path | Main gap |
| --- | --- | --- | --- |
| Validate | Pi/MCP `gsd_validate_milestone`, MCP alias `gsd_milestone_validate`, `/gsd verdict`, auto validation unit | `tools/validate-milestone.ts` writes `assessments` + `quality_gates` in a standalone transaction, then writes/mirrors `VALIDATION.md` | No Domain Operation, stable identity, immutable/versioned verdict, revision/Epoch fence, event, or Projection Work |
| Complete | Pi/MCP `gsd_complete_milestone`, MCP alias `gsd_milestone_complete`, auto complete unit, closeout repair/recovery | `tools/complete-milestone.ts` directly changes the legacy Milestone, then writes SUMMARY and compatibility outputs | Canonical Milestone remains unchanged; retry is payload/time dependent and has no durable receipt |
| Reopen/reset | Pi/MCP `gsd_milestone_reopen`, MCP alias `gsd_reopen_milestone` | `tools/reopen-milestone.ts` calls transaction-owning `reopenMilestoneCascade()`, then deletes projections | Full hierarchy legacy reset without any canonical transition, replay identity, durable reason, or projection fence |
| Cancel-adjacent | Guided Park, Discard, or “Skip — create new milestone” | `milestone-actions.ts`; “skip” only starts another Milestone | There is no `gsd_milestone_cancel`; park/unpark and deletion are explicitly deferred |

### Validation is database-first but not durable lifecycle evidence

The handler derives required verification classes, may downgrade browser-visible
work without evidence, then `INSERT OR REPLACE`s one path-keyed assessment and
upserts shared quality-gate verdicts (`tools/validate-milestone.ts:117-197`;
`gsd-db.ts:1147-1172`; `milestone-validation-gates.ts:28-51`). A later validation
overwrites history instead of superseding an immutable current head. The resolver
prefers the database but falls back to worktree/project-root Markdown when the row
is absent (`milestone-validation-verdict.ts:25-77`). Browser evidence inspection
also reads DB artifacts and then filesystem assessments
(`milestone-validation-evidence.ts:28-81`).

Recommendation: include `milestone.validate` in the S06 adapter. Persist the
normalized verdict, rationale, verification-class rows, browser/runtime evidence
decision, and gate results in one event-backed receipt. Completion must reference
that current validation operation/revision, not accept only
`verificationPassed: true` plus a replaceable assessment row.

### Completion splits one decision across unrelated writes

`handleCompleteMilestone()` checks a caller boolean, latest assessment status,
legacy Slice/Task statuses, and deferred aliases, then directly updates only
`milestones.status` in a standalone transaction
(`tools/complete-milestone.ts:130-203`). SUMMARY is generated from the current
request after commit, is not overwritten if already present, and manifest/JSONL
work is best-effort (`tools/complete-milestone.ts:209-277`). There is no canonical
Milestone transition, lifecycle shadow proof, durable request payload, event
receipt, Projection Work row, or changed-payload replay conflict.

The surrounding closeout pipeline still treats files as guards or repair input:
it parses `VALIDATION.md`, requires Slice SUMMARY files, and inspects operational
prose before dispatch (`milestone-closeout.ts:214-299`). Closeout consistency can
fabricate pass-through validation from existing SUMMARY files and can refresh the
database from disk (`closeout-consistency-gate.ts:75-153,156-202`), while closeout
proof requires and classifies the Milestone SUMMARY file
(`milestone-closeout-proof.ts:62-79,97-122`). These are real drift surfaces, but
the M003 legacy-read boundary assigns their read-authority removal to S07/later.
S06 should keep them outside the mutation core and make any obstruction report
projection staleness rather than undo completion.

### Reopen is atomic only for legacy rows

`reopenMilestoneCascade()` requires a closed legacy Milestone and, in one local
transaction, sets the Milestone active, every Slice in progress, and every Task
pending (`db/writers/cascades.ts:81-114`). The handler then manually deletes
Milestone, Slice, UAT, and Task artifacts before flushing other projections
(`tools/reopen-milestone.ts:50-143`). This preserves the established full-redo
behavior but loses canonical parity and can race a newer projection.

The v32 writer already permits terminal `completed|cancelled -> ready`, and the
normalizer explicitly treats legacy active/in-progress or pending against
canonical ready as an observable semantic delta
(`db/writers/lifecycle-commands.ts:206-220`;
`db/lifecycle-shadow-comparison.ts:62-95`). Therefore one Milestone reopen
operation can update every affected legacy and canonical row without a second
operation. It must revoke current descendant cancellation Waivers, reject any
running Attempt or nonterminal/mismatched descendant, retain immutable history,
and enqueue projection cleanup rather than deleting files as authority.

### Cancellation, park, and discard are not S06 aliases

There is no Milestone cancellation tool. `parkMilestone()` writes `PARKED.md`
before best-effort DB synchronization; `unparkMilestone()` removes the marker and
best-effort sets legacy active; `discardMilestone()` removes worktree/files/queue
state and then attempts database deletion (`milestone-actions.ts:50-183`). Guided
“skip” does not terminate the old Milestone; it dispatches discussion for a new
one (`guided-flow.ts:1813-1906`). ADR-046 ultimately models omission as
cancellation plus an authorized Waiver
(`docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md:60-72`), but M003
explicitly defers park/unpark and legacy deletion. S06 should fail loud if a
caller tries to reinterpret these actions as complete/reopen.

## Callers that must converge or be fenced

Pi completion/validation omit tool-call identity, Pi reopen bypasses the shared
executor, and MCP canonical/alias calls likewise omit execution identity
(`bootstrap/db-tools.ts:1022-1104,1421-1483`;
`packages/mcp-server/src/workflow-tools.ts:1238-1246,1313-1334,2693-2732,2956-2976`).
All should use one shared executor and canonical alias identity, following S05.

Four non-tool paths can still manufacture Milestone completion:

- worktree merge cleanup (`worktree-lifecycle.ts:96-115`);
- startup replay of `worktree-merged` JSONL (`auto-start.ts:233-271`);
- stuck closeout recovery from artifacts (`auto-recovery.ts:210-257`); and
- legacy event replay (`workflow-reconcile.ts:189-209`).

After canonical Milestone adoption, these paths must replay the original receipt,
dispatch the normal completion operation, or fail closed. None may call
`updateMilestoneStatus(..., "complete")`. Compatibility-only behavior may remain
for unadopted imports, matching the S05 task/slice event-replay fence
(`workflow-reconcile.ts:124-143`).

### T06 research checkpoint: fence the shared legacy close seam

The pre-implementation T06 audit confirmed those four paths and found two more
ways Markdown can close an existing Milestone: PROJECT summary registration via
`upsertMilestonePlanning(...status: "complete")` and full hierarchy import via
`updateMilestoneStatus(..., "complete")`. Fixing only the four planned callers
would therefore leave the same authority violation reachable through import.

The lean cutover is one atomic open-to-closed guard at the generic legacy
Milestone status seam, plus explicit truthful handling at each planned caller.
An adopted Milestone may be closed only by `milestone.complete`; compatibility
callers may still close an unadopted import. Closed-to-closed timestamp repair,
planning metadata updates that do not change status, park/unpark, discard, and
general database reconciliation remain outside this rule.

The callers must not average canonical and legacy state:

- merge cleanup succeeds for an adopted Milestone only when canonical completion
  already owns the current head and the legacy row is also closed;
- startup journal replay cannot turn `worktree-merged` JSONL into adopted
  completion authority;
- stuck recovery checks adoption before legacy status or filesystem proof and
  may observe a current durable completion receipt, but cannot manufacture one
  from SUMMARY, VALIDATION, Git, or GitHub evidence;
- legacy reconciliation ignores adopted Milestone completion events just as it
  already ignores adopted Task and Slice events; and
- unadopted compatibility rechecks adoption and status inside one immediate
  transaction before performing the legacy close, preventing an adoption race.

There is no safe generic replay-by-operation-id API: exact replay requires the
original private idempotency key and request payload. Legacy JSONL and recovery
artifacts do not contain that identity or the canonical closeout payload, so the
correct adopted behavior is to observe an already-current durable receipt or
fail closed and let the normal command be dispatched by its owning workflow.

T06 proof must cover adopted-ready and canonical/legacy sabotage states through
merge, startup, recovery, reconciliation, PROJECT registration, and Markdown
import; duplicate delivery must remain mutation-free. Existing unadopted import,
closed-row repair, canonical complete/reopen, and park/unpark behavior must stay
green. No new registry, queue, worker protocol, or schema is justified.

## Test baseline and missing proof

Existing tests cover handler guards/idempotent-looking re-completion and file
non-overwrite (`tests/complete-milestone.test.ts:4-9,145-179,207-290`), projection
obstruction (`tests/complete-milestone-projection-stale.test.ts:57`), validation
write order/browser evidence (`tests/validate-milestone-write-order.test.ts:51-550`),
park/discard (`tests/park-milestone.test.ts:109-272`), and MCP happy paths
(`packages/mcp-server/src/workflow-tools.test.ts:2888-2987`). They do not prove a
Milestone operation receipt, revision/Epoch conflicts, changed-payload replay,
multiprocess contention, canonical/legacy sabotage, no-residue rollback, immutable
validation lineage, current-Waiver enforcement, or stale completion/reopen
projection suppression.

## Smallest viable S06 cutover

### Implementation clarifications from T01

- Canonical browser-required validation accepts only current structured browser
  or runtime evidence bound to the tested source revision. Filesystem assessment
  prose remains an unadopted compatibility input and cannot authorize canonical
  completion.
- Subjective UAT questions and answers are durable, source-bound database facts.
  T05 must expose answers only through a trusted Pi/MCP user-response callback
  with server-derived user identity; no agent-callable answer tool may claim the
  user accepted an option.
- A newer source revision or superseding criterion atomically withdraws its stale
  open question before creating the replacement. Validation and readiness accept
  only the current answered question and exact acceptance evidence.
- T02 requires schema v43 because planned Milestones are canonically `ready`,
  while v41 authorized direct `ready -> completed` only for Slices. The new
  exception is limited to a causally matching `milestone.complete` operation.
- T05 supplies replay-stable private Pi/MCP invocation identity to the shared
  completion executor. Canonical and alias tool names share one canonical
  identity namespace; missing MCP private metadata fails before mutation.
  Unadopted compatibility completion remains available, while merge, journal,
  artifact-recovery, and reconciliation bypasses are fenced separately in T06.
- T03 adds one `milestone.reopen` operation for the full-redo contract. It moves
  the Milestone, every Slice, and every Task head to canonical `ready` while
  preserving the established legacy `active`/`in_progress`/`pending` projection,
  clears compatibility completion content, and resets each Slice Q8 gate.
- Reopen rejects claimed or running Attempts, nonterminal or mismatched heads,
  and progressed transitive dependent Milestones. It revokes only current
  cancellation Waivers; a current waived Task disposition is preserved and
  superseded by an immutable `unsatisfied` row.
- Schema v44 causally authorizes terminal-to-ready transitions by hierarchy:
  `milestone.reopen` for Milestones, `slice.reopen|milestone.reopen` for Slices,
  and `task.reopen|slice.reopen|milestone.reopen` for Tasks. The legacy cascade
  atomically refuses any hierarchy containing canonical authority, including
  partial adoption.
- T04 still owns per-artifact tombstone/current-operation fencing. T03 skips a
  known superseded replay and surfaces projection staleness, but a newer
  operation can still race between a currentness read and legacy file cleanup.
- T04 reuses the existing lifecycle projection key and current-head lineage;
  no second queue or worker protocol is required. Completion checks ownership
  before and after delivery, while reopen removes every supported Milestone,
  Slice, UAT, and Task closeout path through operation-specific tombstones.
- A superseded completion removes only its delivered bytes when the current
  Milestone is reopened. If a newer completion owns the head, compensation
  regenerates the current summary from the latest immutable
  `milestone.completed` event so byte-identical output cannot be misattributed.
- Exact current replay repairs obstructed projection delivery without creating
  new authority. Historical completion/reopen replay does not touch files, and
  manifest/compatibility event delivery stops after ownership is lost.
- Full database rebuild renders adopted Milestone SUMMARY content from the
  durable completion event and refuses to resurrect cached terminal artifacts
  for an active Milestone. Durable `milestone.reopened` history takes precedence
  over the compatibility JSONL ledger, which remains only an import fallback.
- T05 routes Pi and MCP reopen through the same explicit-identity executor as
  completion. Both transports preserve legacy response fields and add receipt
  revision, replay, currentness, supersession, and projection-staleness truth.
  MCP completion now preserves audit attribution, and adopted closeout recovery
  rebuilds a missing SUMMARY from the immutable completion event without
  replaying a mutation or advancing database authority. Recovery and every
  compensation write recheck the exact completion operation before and after
  delivery, including completion-to-completion-to-reopen races.
- Both cloud execution paths now preserve the gateway request ID as private MCP
  metadata. The linked daemon and standalone `@opengsd/gsd-cloud` runtime use
  the same `io.opengsd/idempotency-key` contract without exposing identity in
  public tool arguments.

1. **Characterize and RED the contract.** Add a Milestone capstone matrix for
   validate, complete, and reopen: deep hierarchy, terminal aliases, cancelled
   descendants/current Waivers, active Attempts, mismatch/sabotage, fault points,
   lost response, replay conflict, contention, and projection obstruction.
2. **Add the deep writer and adapter.** Implement only
   `milestone-lifecycle-domain-operation.ts` and
   `db/writers/milestone-lifecycle.ts`. Reuse `executeDomainOperation()`, lifecycle
   writers, S05 receipt/current-head conventions, existing evidence tables, and
   the existing projection queue. Add no generic command registry or schema
   family.
3. **Cut over validation and completion.** Persist versioned validation facts and
   normalized summary content/event payload, then transition legacy `complete` +
   canonical `completed` only after all database guards pass. Descendants are
   verified, not rewritten. Return `duplicate`, `superseded`, and `stale`
   truthfully.
4. **Cut over full-redo reopen/reset.** Transition the complete hierarchy in one
   operation, revoke current cancellation Waivers, preserve immutable history,
   and make cleanup current-operation-fenced projection work.
5. **Unify and fence callers.** Give Pi, MCP aliases, auto/recovery, and internal
   closeout stable private identity. Fence merge/journal/artifact repair paths
   after canonical adoption; retain explicit import compatibility only.
6. **Prove and close.** Run focused fault/race/restart tests, adjacent auto/MCP/
   worktree/validation suites, automated database-backed UAT, and update the
   lifecycle runbook. Record the remaining S07 read-authority and later
   closeout-effect/park/unpark work explicitly.

The cutover is complete when every successful Milestone mutation has exactly one
operation/revision/event/outbox/projection receipt; every rejected or injected
pre-commit failure leaves no residue; exact retry returns the stored receipt;
changed payload conflicts; projections can be deleted and rebuilt without
changing workflow state; and no adopted Milestone can be completed or reopened
through a legacy bypass.
