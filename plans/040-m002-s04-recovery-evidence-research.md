# M002/S04 Research: Recovery, Evidence, and Verdict Foundation

**Status:** Research complete
**Date:** 2026-07-12
**Scope:** Additive schema v34 only; no runtime cutover or legacy backfill
**Final recommendation:** Add eight canonical tables—three for recovery and five for criteria/evidence/verdict/remediation—while reusing v32 Attempts, Attempt Results, Lifecycles, and Blockers.

## Outcome

The smallest model that preserves the approved contract has two deliberately separate halves:

1. **Recovery facts and routing:** immutable Failure Observations, restart-safe bounded budgets, and exactly one selected Recovery Action.
2. **Verification and acceptance:** versioned criteria, immutable objective evidence, evidence-derived Technical Verdicts, separate Human Acceptance for explicitly subjective UAT, and immutable remediation links.

Do not add another Attempt, UAT run, assessment, gate, blocker, or rework system. V32 already supplies execution identity and the narrow human-only blocker taxonomy. V34 should remain shadow canonical data until later Domain Operations and Query Module work can write and read it atomically.

## Final convergence after simplification review

The source audit initially proposed ten tables. The implementation review removed
two relational layers that duplicated facts already present elsewhere:

- objective Evidence belongs directly to one Technical Verdict bundle, so no
  verdict-evidence membership table is needed; and
- a failed/inconclusive Technical Verdict or rejected Human Acceptance is
  already the actionable finding source, so one immutable Remediation Link
  replaces separate finding and finding-work tables.

Recovery budgets are immutable count allocations. Their use is derived by
counting immutable Recovery Actions, avoiding a mutable consumption counter or
charge ledger. `max_uses` therefore counts recovery actions after the initial
Attempt: deterministic repair is capped at one, while every other accepted
policy class is capped at two. A human-routed Failure Observation owns the exact
V32 Blocker used by clarify/pause. The final eight tables are
`workflow_failure_observations`, `workflow_recovery_budgets`, `workflow_recovery_actions`,
`workflow_acceptance_criteria`, `workflow_technical_verdicts`,
`workflow_verification_evidence`, `workflow_human_acceptances`, and
`workflow_remediation_links`.

## Accepted contract

The RFC defines an Attempt Result as `succeeded | failed | interrupted`, a Recovery Action as exactly one of `retry | repair | replan | remediate | clarify | pause | abort`, objective Verification Evidence as immutable and revision-bound, a Technical Verdict as `pass | fail | inconclusive`, and Human Acceptance as a separate subjective verdict ([RFC, lines 116–127](../docs/dev/proposals/rfc-database-authoritative-workflow-refactor.md#execution-verification-and-recovery)).

The kernel sequence is Advance → Execute → Verify → Route → Closeout. Execute persists an Attempt Result or Failure Observation; Verify gathers fresh evidence; Route selects exactly one bounded recovery action ([RFC, lines 213–221](../docs/dev/proposals/rfc-database-authoritative-workflow-refactor.md#lifecycle-kernel-and-ownership-boundaries)).

The evidence contract is stricter than the legacy tables: every complete Technical Verdict bundle includes fresh immutable evidence with criterion, work and Attempt identity, exact command/tool and working directory, timestamps, exit code, source and database revisions, content hashes, durable output reference, and environment metadata. Machine-fixable failures create or reuse linked remediation work, and only the approved human-only taxonomy may pause for a person ([ADR-046, lines 155–190](../docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md#automation-first-verification-and-recovery)). V34 validates each evidence row against its owning verdict; S06 must make bundle completeness atomic and mandatory.

Recovery budgets must persist across restarts and unchanged failure fingerprints. The accepted caps are initial plus two retries for transient execution, one deterministic repair per unchanged fingerprint, at most two schema-corrected attempts, at most two remediation attempts for the same cause, and at most three objective-UAT Attempts ([RFC, lines 238–252](../docs/dev/proposals/rfc-database-authoritative-workflow-refactor.md#automated-verification-uat-and-recovery)).

## Current authority and drift map

### Recovery is fragmented

- The current classifier has twelve failure kinds but reduces routing to only `retry | escalate | stop`; neither the classification nor selected route is canonical database state ([`recovery-classification.ts`, lines 11–25 and 44–95](../src/resources/extensions/gsd/recovery-classification.ts)).
- Timeout recovery combines process-local maps with `.gsd/runtime` counters and private idle/hard caps. Exhaustion can create placeholder blockers, mark a phase skipped, or advance outside a canonical recovery transaction ([`auto-timeout-recovery.ts`, lines 49–180](../src/resources/extensions/gsd/auto-timeout-recovery.ts)).
- The session owns multiple correctness-bearing maps and counters for recovery, verification, pre-execution repair, missing plans, and tool availability, then clears them on reset/start ([`auto/session.ts`, lines 146–261](../src/resources/extensions/gsd/auto/session.ts)).
- Unit runtime state is stored under `.gsd/runtime/units/*.json`; malformed JSON is treated as absent, and completion/recovery can be inferred from summaries, plan checkboxes, STATE, and a disk-to-DB refresh ([`unit-runtime.ts`, lines 69–201 and 228–290](../src/resources/extensions/gsd/unit-runtime.ts)).
- `unit_dispatches` duplicates retry attempt number, maximum attempts, retry timing, and error state even though v32 now owns canonical execution Attempts and Results ([`db-coordination-schema.ts`, lines 40–64](../src/resources/extensions/gsd/db-coordination-schema.ts)). Dispatch history then adds a six-entry, trace-scoped process window ([`auto/dispatch-history.ts`, lines 1–67 and 111–190](../src/resources/extensions/gsd/auto/dispatch-history.ts)).
- Closeout recovery and `turn_git_transactions` form another publish/recovery lifecycle, while crash recovery splits state among workers, dispatches, runtime KV, and `auto.lock`. Runtime KV explicitly describes itself as soft state, so it must not govern recovery eligibility ([`closeout-recovery.ts`, lines 15–130 and 218–309](../src/resources/extensions/gsd/closeout-recovery.ts); [`crash-recovery.ts`, lines 1–17 and 43–255](../src/resources/extensions/gsd/crash-recovery.ts); [`db-runtime-kv-schema.ts`, lines 7–14](../src/resources/extensions/gsd/db-runtime-kv-schema.ts)).
- The most dangerous inversion remains artifact recovery: disk proof can refresh and promote authoritative task completion. V34 must not reuse that path as canonical recovery ([`auto-recovery.ts`, lines 74–270](../src/resources/extensions/gsd/auto-recovery.ts)).

### Evidence, verdict, and UAT are conflated

- Current UAT input combines evidence references, per-check outcomes, aggregate verdict, human flags, and attempt linkage. Aggregate freshness requires only one `gsd_uat_exec` reference anywhere, and the next attempt number is derived from `.gsd/uat/**/attempt-N.json` ([`uat-run.ts`, lines 30–69, 263–294, and 359–368](../src/resources/extensions/gsd/uat-run.ts)).
- Saving UAT sequentially writes an assessment/projection, an assessment row, a JSON attempt file, a mutable `quality_gates` row, and a `gate_runs` row. This is not a single revision-checked Domain Operation ([`workflow-tool-executors.ts`, lines 1255–1325](../src/resources/extensions/gsd/tools/workflow-tool-executors.ts)).
- Legacy `verification_evidence` is task/command oriented and conflates observation with verdict; it has no criterion, v32 Attempt, source/DB revision, cwd, environment, hash, or durable output identity. Assessments and quality gates are mutable current-state records, while gate runs have no causal FK to evidence, criterion, or Attempt ([`db-base-schema.ts`, lines 220–230 and 277–338](../src/resources/extensions/gsd/db-base-schema.ts)).
- UAT policy permits some mixed/live/human modes to aggregate PASS with `NEEDS-HUMAN`, which collapses “technical checks passed” and “the person accepted the subjective experience” into one value ([`uat-policy.ts`, lines 12–75 and 216–246](../src/resources/extensions/gsd/uat-policy.ts)).
- Milestone validation stamps one aggregate verdict across multiple criteria rather than proving each criterion independently ([`milestone-validation-gates.ts`, lines 28–52](../src/resources/extensions/gsd/milestone-validation-gates.ts)).
- Rework findings are mutable and destructively replaced, so they cannot provide immutable provenance from the originating verdict through later resolving proof ([`db-migration-steps.ts`, lines 470–498](../src/resources/extensions/gsd/db-migration-steps.ts)).

## Initial ten-table candidate (superseded by final convergence)

### Reuse, do not duplicate

Reuse these v32 records:

- `workflow_item_lifecycles` for the affected work identity;
- `workflow_execution_attempts` for every execution and objective-UAT run;
- `workflow_attempt_results` for immutable `succeeded | failed | interrupted` outcomes; and
- `workflow_blockers` for only the approved human/external boundary.

V32 already enforces one active Attempt per lifecycle, retry sequencing, settlement provenance, immutable Results, and the narrow blocker vocabulary ([`db-lifecycle-foundation-schema.ts`, lines 114–395 and 398–530](../src/resources/extensions/gsd/db-lifecycle-foundation-schema.ts)).

### Recovery tables (3)

#### `workflow_failure_observations`

Immutable facts about a failed or inconclusive boundary.

Core columns:

- identity/scope: `failure_observation_id`, `project_id`, `lifecycle_id`;
- causal execution: nullable `attempt_id`, nullable `result_id`;
- explicit `recovery_owner`: `agent | user | external`, plus the exact nullable
  v32 Blocker for user/external ownership;
- `boundary_stage`: `advance | execute | verify | route | closeout`;
- `failure_kind`, normalized `failure_fingerprint`, `summary`, `evidence_json`;
- `observed_at`, `operation_id`, `project_revision`, `authority_epoch`.

Recommended normalized failure vocabulary:

`tool-schema | tool-contract | tool-unavailable | deterministic-policy | lifecycle-progression | stale-worker | worktree-invalid | verification-failed | verification-drift | reconciliation-drift | illegal-transition | provider-network | provider-rate-limit | provider-server | provider-stream | provider-connection | provider-model-error | provider-unsupported-model | provider-permanent | timeout | interrupted | closeout-effect | projection | runtime-unknown`

This preserves current classifier distinctions while normalizing provider subtypes at observation time. `projection` remains recoverable and non-authoritative; `interrupted` describes the observed boundary while the Attempt Result remains the execution outcome.

Constraints:

- `result_id` implies `attempt_id` and both match the same project/lifecycle;
- an Execute observation references a failed/interrupted Result;
- fingerprint is nonblank, trimmed, and lowercase-normalized;
- exact operation/revision/epoch FK; immutable update/delete triggers.

#### `workflow_recovery_budgets`

Restart-safe policy allocation and consumption.

Core columns:

- `recovery_budget_id`, `project_id`, `lifecycle_id`;
- optional `failure_kind`, optional `failure_fingerprint`;
- `budget_kind`: `attempts | unchanged-failure | cost | elapsed`;
- `limit_value`, `consumed_value`;
- `unit`: `count | usd | milliseconds` with kind/unit consistency;
- `budget_status`: `active | exhausted | superseded`;
- `policy_version`;
- opened/updated timestamps and exact opened/updated operation provenance.

Keep this table lean and monotonically mutable rather than adding a budget-charge ledger in v34. The later Domain Operation must atomically increment consumption with the selected action/Attempt. Identity, scope, policy, and limit are immutable; consumption never decreases; state only moves from active to exhausted/superseded. A partial unique index permits one active budget per lifecycle/kind/failure-kind/fingerprint scope.

#### `workflow_recovery_actions`

Exactly one selected response per Failure Observation.

Core columns:

- `recovery_action_id`, `project_id`, `lifecycle_id`;
- `failure_observation_id UNIQUE`;
- `action`: `retry | repair | replan | remediate | clarify | pause | abort`;
- optional `recovery_budget_id`, `target_lifecycle_id`, `blocker_id`, `retry_not_before`;
- `rationale`, `policy_version`, `selected_at`;
- exact operation/revision/epoch provenance.

Constraints:

- action, observation, budget, target, and blocker share project/scope;
- retry requires an active budget and the same lifecycle target;
- repair/replan/remediate require a target lifecycle;
- clarify/pause require an existing open v32 Blocker of an approved human-only kind;
- machine-fixable failure kinds cannot select clarify/pause merely because a retry budget is exhausted;
- immutable update/delete; indexed by lifecycle and selection time.

SQLite cannot safely enforce “every observation has an action” with an immediate insert trigger without circular/deferred insertion. Enforce the positive side through one future `recordFailureAndSelectRecovery` Domain Operation and make all continuation queries require a joined action. `UNIQUE(failure_observation_id)` enforces the negative side: never two routes.

Do not add a separate remediation-link table on the recovery side. One Recovery Action selects one immediate target; any wider remediation fan-out belongs to ordinary lifecycle dependencies and the verification finding links below.

### Criteria, evidence, verdict, and acceptance tables (7)

#### `workflow_acceptance_criteria`

Immutable version rows with current-head supersession.

- `criterion_kind`: `technical | subjective_uat`;
- `evidence_class`: `command | runtime | browser | artifact | human`;
- technical requires a nonhuman evidence class; subjective UAT requires `human`;
- scope to project/lifecycle and optionally requirement;
- required flag, description, supersedes ID, exact provenance.

Supersession must target the same project/criterion lineage and current head, with strictly increasing revision and nondecreasing Authority Epoch. A new criterion version makes earlier proof historical, not current.

#### `workflow_verification_evidence`

Immutable objective observations, never called verdicts.

- criterion, project, lifecycle, v32 `attempt_id`;
- evidence class;
- exact command/tool, cwd, started/ended timestamps, nullable exit code;
- `observation`: `passed | failed | inconclusive`;
- source revision, observed project revision, content hash, durable output reference, environment JSON;
- exact operation/revision/epoch provenance.

Evidence must match the criterion and Attempt scope. Missing/malformed metadata and stale source revision cannot support PASS. Update/delete are forbidden.

#### `workflow_technical_verdicts`

Immutable current-head chain per technical criterion/Attempt/tested revision.

- `verdict`: `pass | fail | inconclusive`;
- policy ID/version, rationale, supersedes verdict ID;
- exact operation/revision/epoch provenance.

Only technical criteria may receive Technical Verdicts.

#### `workflow_technical_verdict_evidence`

Immutable many-to-many membership joining a Technical Verdict to the exact evidence used to derive it.

Membership must match project, lifecycle, criterion, Attempt, and tested source revision. A finalized verdict needs evidence. PASS requires every required member to be fresh and `passed`; missing, failed, inconclusive, stale, or wrong-criterion evidence cannot pass.

#### `workflow_human_acceptances`

Separate immutable head chain for a `subjective_uat` criterion.

- `disposition`: `accepted | rejected`; pending is the absence of a row;
- composite reference to the v33 Answer identity `(answer_id, question_id, interaction_id, project_id)`;
- actor, rationale, supersedes acceptance ID, exact provenance.

A trigger must prove the referenced v33 Interaction has kind `subjective-uat` and that the referenced Answer is the currently accepted answer. Generic consent is not Human Acceptance. V33 already gives the needed interaction kind and composite answer identity ([`db-conversation-foundation-schema.ts`, lines 171–205 and 314–372](../src/resources/extensions/gsd/db-conversation-foundation-schema.ts)). Note that v33 `answer_disposition='accepted'` means the response was durably accepted; v34 `disposition='accepted'` means the subjective product criterion was accepted.

#### `workflow_verification_findings`

Immutable actionable consequences with:

- exactly one source: Technical Verdict XOR Human Acceptance;
- criterion/lifecycle scope;
- `severity`: `blocking | advisory`;
- normalized fingerprint, description, required outcome, exact provenance.

The finding is history and is never mutated to “resolved.” A unique fingerprint constraint prevents duplicate actionable findings for the same criterion/cause.

#### `workflow_finding_work_links`

Immutable finding-to-work routing:

- `route_kind`: `rework | remediation`;
- target lifecycle/task;
- later resolving Technical Verdict or Human Acceptance reference;
- exact provenance.

`rework` targets the producer lifecycle; `remediation` targets distinct corrective work. Resolution is derived from a later fresh proof, not a mutable finding status.

## Final eight-table contract

V34 enforces the relational, provenance, immutability, and bounded-count parts
of this contract. S06 must add atomic bundle writes and completeness queries for
routing, dispatch, and closeout.

1. Every new row has an exact causal FK to `workflow_operations(operation_id, project_id, resulting_revision, resulting_authority_epoch)`.
2. Project/lifecycle/Attempt/Result/criterion/evidence/verdict/acceptance scopes must align; cross-project or cross-lifecycle joins abort.
3. IDs, scopes, creation timestamps, observations, verdicts, acceptances, remediation links, and actions are immutable; deletes are denied.
4. Supersession always names the current head, advances project revision, and never decreases Authority Epoch.
5. Objective proof and subjective acceptance never substitute for one another.
6. S06 queries must not infer a technical PASS from aggregate assessment text, projection presence, legacy gate rows, or a different criterion's evidence.
7. V34 persists `agent | user | external` recovery ownership independently of
   the extensible failure kind. Agent-owned failures cannot carry a Blocker;
   user/external failures and clarify/pause must link the exact open approved
   v32 Blocker with the matching resolution owner. S06 classification keeps
   failed tests, projection failures, ordinary defects, worktree repair, stale
   workers, missing harnesses, browser startup, and Git conflicts agent-owned
   by default; routing itself remains deterministic.
8. Budget use is the count of linked immutable Recovery Actions. The future Domain Operation must make action selection idempotent so replay cannot add a second Action or exceed `max_uses`.
9. S06 lifecycle queries must prevent failure, inconclusive evidence, recovery exhaustion, or missing projections from authorizing completion.

## Legacy concepts not to repurpose

Keep these unchanged and non-authoritative for the v34 shadow model:

- `verification_evidence`: legacy task-summary/projection support, not canonical criterion evidence;
- `assessments`: artifact/path snapshot, not a criterion, verdict, or Human Acceptance;
- `quality_gates`: mutable legacy aggregate gate state, not canonical verdict;
- `gate_runs`: operational audit, not an Attempt, evidence set, or verdict derivation;
- UAT attempt JSON and Markdown assessment files: projections/import sources only, never run identity or freshness authority;
- `rework_briefs` / `rework_brief_findings`: legacy mutable workflow, not immutable findings/remediation provenance;
- `unit_dispatches` retry fields and dispatch-history windows: coordination/compatibility only, not recovery budget authority;
- `.gsd/runtime`, `runtime_kv`, `metrics.json`, `auto.lock`, reopen-reason JSON, doctor JSONL, process counters/maps: diagnostics or soft state only;
- `workflow_attempt_results`: reuse as execution outcomes; do not stretch them into Failure Observations or Technical Verdicts;
- `workflow_blockers`: reuse only for genuine human/external boundaries; do not insert machine-fixable failure classes;
- generic consent answers: never subjective UAT acceptance;
- Markdown/file existence: never evidence freshness, completion, retry eligibility, or recovery routing.

No v34 backfill should reinterpret any of these rows. The migration creates empty additive tables and preserves raw legacy meaning for later explicit import/shadow comparison.

## Proposed RED, restart, fault, and sabotage tests

### Schema and migration

1. Fresh v34 exposes exactly the eight new tables and exact vocabularies while preserving all v31–v33 tables.
2. V33 → v34 upgrade creates a verified `.backup-v33`, leaves every legacy row byte/semantically unchanged, creates empty v34 tables, and passes `PRAGMA quick_check`.
3. Inject a migration fault after v34 DDL but before COMMIT: schema version remains 33, all eight tables roll back, backup remains independently openable, and retry reaches 34 cleanly. Mirror the established v33 migration/restore tests ([`db-conversation-foundation.test.ts`, lines 934–1035](../src/resources/extensions/gsd/tests/db-conversation-foundation.test.ts)).

### Recovery contract

4. A failed/interrupted Result accepts a matching Failure Observation; a succeeded Result, mismatched lifecycle/project, blank/non-normalized fingerprint, or wrong causal revision is rejected.
5. A future `recordFailureAndSelectRecovery` fault at observation or action insert leaves no partial observation/action bundle.
6. One observation accepts exactly one action; a second route is rejected. An observation without a joined action is never dispatchable.
7. Close/reopen between repeated identical fingerprints preserves the derived budget-use count and returns the same eligible route; a new trace/session cannot reset the cap.
8. Idempotent action replay counts once; concurrent actions cannot exceed an exhausted budget.
9. Clarify/pause rejects an agent-owned failure or a missing, mismatched, or
   closed narrow Blocker. Novel failure kinds remain valid because ownership is
   an explicit fact rather than a hardcoded kind mapping. S06 must not
   synthesize skipped/completed work on exhaustion.
10. S06 lifecycle queries must prevent projection, closeout-effect, worktree, timeout, and interrupted failures from settling the affected Lifecycle complete.
11. Delete/corrupt `.gsd/runtime`, `metrics.json`, reopen JSON, doctor JSONL, assessment/UAT files, and clear process maps; reopened recovery eligibility and selected action remain byte-identical.

### Evidence, verdict, and acceptance contract

12. Technical criteria reject `human`; subjective-UAT criteria reject objective evidence classes.
13. Evidence rejects a mismatched Attempt/lifecycle/project, an observation
    older than Attempt settlement or the current criterion version, stale
    source revision, missing hash/output/environment, and mutation/deletion.
14. PASS accepts only passed evidence. FAIL and INCONCLUSIVE may retain passed
    companion checks, but S06 bundle-completeness queries must require at least
    one failed or inconclusive observation respectively and reject an absent,
    incomplete, or all-passed bundle.
15. A new criterion version makes the prior PASS historical and cannot fork from a non-head version.
16. Multiple objective-UAT Attempts persist in v32 Attempt rows, retain immutable evidence across restart, and never derive numbering from files.
17. S06 closeout queries must reject Technical PASS plus a required subjective criterion with no Human Acceptance; accepted authorizes that criterion and rejected blocks it.
18. Generic consent cannot create Human Acceptance. Only a current accepted v33 Answer on a `subjective-uat` Interaction can.
19. S06 aggregate milestone validation must not stamp unrelated criteria. Each required criterion needs its own current proof.
20. Remediation source XOR, fingerprint deduplication, and rework/remediation target rules are enforced without mutable finding records.

### Sabotage proofs

21. Sabotage a PASS observation to failed/inconclusive, remove the only
    failed/inconclusive observation from those verdict bundles, alter tested
    source revision, or swap criterion. Local invalid rows must fail, and S06
    aggregate closeout must remain unauthorized for incomplete bundles.
22. Write a legacy PASS assessment, PASS quality gate, gate run, UAT Markdown, attempt JSON, and contradictory projection with no canonical evidence. S06 Technical Verdict/closeout queries must remain unchanged.
23. Reset every legacy/process retry counter while preserving the canonical unchanged fingerprint and exhausted Action count. Retry remains exhausted after independent reopen.
24. Insert a machine failure plus a user-facing placeholder file/blocker string. The S06 router must neither open a human Blocker nor pause without an authorized blocker/action transaction.

## Implementation notes for S04

- Add one `db-recovery-evidence-foundation-schema.ts` helper and one v34 migration step; keep schema PR ownership serialized.
- Wire fresh-install creation, `SCHEMA_VERSION = 34`, migration/backup/rollback tests, and the explicit single-writer allowlist. Older-version rewind fixtures must remove every later-version table and index before stamping the earlier version.
- Use the existing v31 exact provenance tuple and v32/v33 immutable/head-chain trigger style.
- This slice should expose schema only. Do not add runtime writers, readers, UAT cutover, backfill, or compatibility deletion.
- The later Domain Operation layer must atomically create failure/action and verdict/evidence bundles, plus any applicable remediation links. V34 standalone triggers enforce local facts and reject invalid combinations; they should not simulate the future kernel.

## Decision summary

Adopt **3 recovery tables + 5 verification/acceptance/remediation tables**.
The eight-table model preserves the independent truths—what failed, what proof
was observed, what policy concluded, what a person subjectively accepted, and
which Task work repairs the gap—without membership, mutable finding, UAT-run,
assessment, blocker, Attempt, or consumption-ledger duplicates. Legacy
projections remain untouched until the explicit cutover program.
