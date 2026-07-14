<!-- Project/App: gsd-pi -->
<!-- File Purpose: Integration and verification runbook for canonical lifecycle command writers. -->

# Lifecycle command integration runbook

This runbook governs the command primitives introduced in M003/S01 and first
adopted by planning in M003/S02. They write canonical lifecycle, Attempt,
Result, and Kernel checkpoint facts only inside an active Domain Operation.
Milestone, slice, and task planning, task and slice replanning, and roadmap
reassessment now use the lifecycle and replay-fence subset. Legacy hierarchy
reads and public responses remain the compatibility contract until a later,
separately proven read-authority cutover.

## Command boundary

1. Read the current or replay fence with `readDomainOperationFence`.
2. Start one semantic Domain Operation with that expected revision and Authority
   Epoch.
3. Run the legacy compatibility mutation and the matching canonical writer in
   the same callback.
4. Compare legacy and canonical states with `compareLifecycleShadow`; preserve
   the raw statuses even when the normalized states agree.
5. Return the legacy response during M003. Projection delivery follows the
   committed operation and cannot compensate canonical state backward.

Handlers must use `normalizeLegacyLifecycleStatus` and the exported
`CanonicalLifecycleStatus` type. Do not duplicate alias tables in tools,
commands, or orchestration modules.

## S02 planning boundary

- Planning handlers carry a private `PlanningInvocation`; Pi keys use the
  canonical tool name and tool-call ID, while workflow MCP requires a nonblank
  `io.opengsd/idempotency-key` in private request metadata. Missing identity
  fails before mutation because request/session IDs are not replay-stable.
- A planning mutation, lifecycle adoption or transition, shadow comparison,
  event/outbox rows, Projection Work, and authority revision commit atomically.
  Projection rendering follows commit; replay retries rendering without
  rerunning the mutation or duplicating compatibility events. Replan and
  reassessment projections read their content and creation time from the
  committed domain event or assessment row, so a replay reproduces the
  original artifact instead of the retry payload or clock.
- Removed pending tasks and slices retain their hierarchy identity as legacy
  `skipped` and canonical `cancelled`. Active plan projections omit them, and
  their IDs cannot be reused until the matching reopen command succeeds. Stale
  PLAN cleanup removes only content still owned by the compatibility marker or
  PLAN artifact; a user-modified file is preserved.
- Restore, hierarchy replacement, milestone discard, and worktree teardown fail
  closed when they would erase or strand adopted canonical history.

## Integration boundaries

- S03 established schema-authorized interrupted settlement and retry after an
  original lease expires or is replaced. Production claims must preserve that
  lease fence and immediate Attempt lineage.
- Kernel checkpoints follow the S03 stage/state matrix and are appended only
  inside their owning Domain Operation.
- S04 makes terminal Task reopen ordering explicit. Canonical
  `completed/cancelled -> ready` commits with legacy `pending`; the later claim
  owns a separate `ready -> in_progress` revision.
- Slice and milestone descendant reopen/reset cascades remain S05 work. S04
  closes Task recovery authority only and must not infer hierarchy convergence
  from its Task-level proof.

## Resume after an agent-owned abort

Use `gsd_task_recovery_resume` only after the recorded cause has been repaired:

1. Read the current abort and preserve its exact `recoveryActionId`.
2. Repair the cause outside the failed dispatched unit and run the smallest
   meaningful verification.
3. Call the tool with that action ID, a plain-language repair summary, and
   non-empty structured evidence. Keep replay identity in private Pi/MCP
   metadata; never add it to the public arguments.
4. Resume orchestration. The next claim must name the aborted Attempt as its
   immediate predecessor and atomically consume the authorization.

At successor claim, the database revalidates the causal Result and any current
evidence-backed failure verdict. A resume is valid only when its
`workCheckpointId` names the Work Checkpoint created by the same resume
operation for the same lifecycle. The v39 migration applies the same
current-head gate to recovery routes retained from v38.

Do not cancel/reopen the Task, delete the abort, reset its budget, or edit the
database directly. A stale action, duplicate resume, open blocker, running or
later Attempt, mismatched Result, or missing repair evidence must fail without
partial checkpoint or event residue.

## S04 recovery convergence matrix

The database explains every pause, retry, resume, reopen, cancellation, and
publication. Markdown, manifests, summaries, blocker placeholders, and UAT
reports are readable projections; they cannot authorize a lifecycle change.

| Scenario | Required canonical evidence | Expected outcome |
| --- | --- | --- |
| Agent failure | Immutable failure observation and bounded Recovery Action; each retry is a fresh lineage-linked Attempt and terminal dispatch | Retry/repair/remediate until the budget selects abort; never ask the user for an objective failure |
| Repaired abort | Exact current abort plus one `task.recovery.resume` operation, concrete repair evidence, and a successor claim that consumes it | One immediate successor only; the dispatched worker cannot self-authorize or reuse the event |
| Genuine pause | Matching open user or external Blocker, Recovery Action, and work checkpoint | Ask one plain-language question, recommend the best route and why, allow pushback, then resolve or dismiss without consuming an agent budget |
| Verified completion | Succeeded Result, current passing Technical Verdict/evidence, and `task.completion.publish` | Legacy `complete` and canonical `completed` commit once; projection failure cannot roll either backward |
| Reopen/cancel | One Domain Operation, event, work checkpoint, semantic shadow payload, and Projection Work row | Reopen ends at `ready`; cancel ends at `cancelled`; all prior Attempts/Results remain immutable |
| Pi/MCP/internal | Private stable identity at the real entry point and persisted `source_transport` | Public text and structured outcome agree; replay returns the original operation without duplicate facts |

An automated objective failure remains agent-owned. Human review may pause only
when the configured policy makes the decision subjective. External ownership is
valid only for an external dependency. UAT and UOK may verify and report, but
their dispatched tool surfaces do not include Task recovery resume or reopen
authority.

Closing a user/external Blocker does not erase or mutate its pause action. If
work continues after an execution or subjective verification failure, reroute
the same Result through the agent policy with the exact resolved/dismissed
`blockerId` as `supersedesResolvedBlockerId`; the new retry-capable Recovery
Action authorizes one fresh lineage successor. The new Attempt must produce its
own Result and current evidence-backed verdict before publication.
The successor claim revalidates that causal Result and verdict at consumption
time, so a retained route or resume cannot outlive superseded, stale, or missing
verification evidence.

## Projection obstruction

Lifecycle mutation commits before rendering. Each Domain Operation enqueues a
current `workflow_projection_work` head. The capstone proves that obstructed
artifact cleanup cannot roll back the committed state and leaves its Projection
Work pending. The projection-delivery contract separately governs claim,
retry, and dead-letter state. Repair the filesystem and replay delivery. Do not
restore status from a checked PLAN item, SUMMARY file, manifest, or blocker
placeholder.

Use these read-only diagnostics against the authoritative database:

```sql
-- Current Task lifecycle plus immutable Attempt/Result lineage.
SELECT lifecycle.lifecycle_status, attempt.attempt_number,
       attempt.retry_of_attempt_id, attempt.attempt_state,
       result.outcome, dispatch.status AS dispatch_status
FROM workflow_item_lifecycles lifecycle
LEFT JOIN workflow_execution_attempts attempt
  ON attempt.lifecycle_id = lifecycle.lifecycle_id
LEFT JOIN workflow_attempt_results result
  ON result.attempt_id = attempt.attempt_id
LEFT JOIN unit_dispatches dispatch
  ON dispatch.id = attempt.coordination_dispatch_id
WHERE lifecycle.milestone_id = :milestone_id
  AND lifecycle.slice_id = :slice_id
  AND lifecycle.task_id = :task_id
ORDER BY attempt.attempt_number;

-- Current Projection Work heads that still need delivery.
SELECT work.projection_key, work.delivery_state, work.attempt_count,
       work.next_attempt_at, work.last_error
FROM workflow_projection_work work
WHERE work.delivery_state IN ('pending', 'claimed', 'dead_letter')
  AND NOT EXISTS (
    SELECT 1 FROM workflow_projection_work successor
    WHERE successor.supersedes_projection_work_id = work.projection_work_id
  )
ORDER BY work.source_project_revision;

-- Immutable recovery history, including the exact action/blocker IDs needed
-- for repair or supersession.
SELECT action.recovery_action_id, action.action, action.project_revision,
       observation.attempt_id, observation.result_id,
       observation.recovery_owner, observation.failure_kind,
       blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status
FROM workflow_recovery_actions action
JOIN workflow_failure_observations observation
  ON observation.failure_observation_id = action.failure_observation_id
LEFT JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
WHERE action.lifecycle_id = :lifecycle_id
ORDER BY action.project_revision;

-- Current routed Attempt only. No row means execution has advanced beyond route.
SELECT action.recovery_action_id, action.action, observation.attempt_id,
       observation.result_id, blocker.blocker_id, blocker.blocker_status
FROM workflow_kernel_checkpoints checkpoint
JOIN workflow_failure_observations observation
  ON observation.kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
JOIN workflow_recovery_actions action
  ON action.failure_observation_id = observation.failure_observation_id
LEFT JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
WHERE checkpoint.lifecycle_id = :lifecycle_id
  AND checkpoint.next_stage = 'route'
  AND NOT EXISTS (
    SELECT 1 FROM workflow_kernel_checkpoints successor
    WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
  )
ORDER BY action.project_revision DESC
LIMIT 1;

-- Current host verdict, publication, and terminal dispatch closeout evidence.
SELECT attempt.attempt_id, result.outcome, verdict.verdict,
       evidence.evidence_id, publish.operation_id AS publication_operation_id,
       dispatch.status AS dispatch_status
FROM workflow_execution_attempts attempt
JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
JOIN workflow_technical_verdicts verdict ON verdict.attempt_id = attempt.attempt_id
JOIN workflow_acceptance_criteria criterion
  ON criterion.criterion_id = verdict.criterion_id
JOIN workflow_verification_evidence evidence
  ON evidence.verdict_id = verdict.verdict_id
 AND evidence.project_id = verdict.project_id
 AND evidence.attempt_id = verdict.attempt_id
LEFT JOIN workflow_domain_events published
  ON published.event_type = 'task.completion.published'
 AND json_extract(published.payload_json, '$.attemptId') = attempt.attempt_id
LEFT JOIN workflow_operations publish ON publish.operation_id = published.operation_id
LEFT JOIN unit_dispatches dispatch ON dispatch.id = attempt.coordination_dispatch_id
WHERE attempt.lifecycle_id = :lifecycle_id
  AND NOT EXISTS (
    SELECT 1 FROM workflow_technical_verdicts successor
    WHERE successor.supersedes_verdict_id = verdict.verdict_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_acceptance_criteria successor
    WHERE successor.supersedes_criterion_id = criterion.criterion_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_technical_verdicts newer
    JOIN workflow_verification_evidence newer_evidence
      ON newer_evidence.verdict_id = newer.verdict_id
     AND newer_evidence.project_id = newer.project_id
     AND newer_evidence.attempt_id = newer.attempt_id
    WHERE newer.project_id = verdict.project_id
      AND newer.criterion_id = verdict.criterion_id
      AND newer.lifecycle_id = verdict.lifecycle_id
      AND newer.attempt_id = verdict.attempt_id
      AND newer.project_revision > verdict.project_revision
      AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts successor
        WHERE successor.supersedes_verdict_id = newer.verdict_id
      )
  )
ORDER BY attempt.attempt_number DESC
LIMIT 1;

-- Repaired-abort resume and the one successor that consumes it.
SELECT action.recovery_action_id, resumed.project_revision AS resume_revision,
       successor.attempt_id AS consuming_attempt_id,
       successor.attempt_number AS consuming_attempt_number
FROM workflow_domain_events resumed
JOIN workflow_recovery_actions action
  ON action.recovery_action_id = json_extract(resumed.payload_json, '$.recoveryActionId')
LEFT JOIN workflow_execution_attempts successor
  ON successor.retry_of_attempt_id = json_extract(resumed.payload_json, '$.attemptId')
 AND successor.claim_project_revision > resumed.project_revision
WHERE resumed.event_type = 'task.recovery.resumed'
  AND action.lifecycle_id = :lifecycle_id
ORDER BY resumed.project_revision DESC;
```

## Automated UAT and closeout

Run the capstone plus the adjacent recovery, auto/custom verification, MCP, UOK,
projection, and compatibility suites. UAT should execute the live runtime or
browser path whenever automation can observe it; a human decision is reserved
for subjective acceptance or unavailable authority/access. Close S04 only when
the DB contains a successful Result, current passing Technical Verdict,
publication/closeout operation, terminal dispatch, and passing UAT receipt.
Markdown status alone never satisfies closeout.

## Verification loop

Run the smallest focused gate while editing, then the adjacent contract matrix:

```sh
pnpm exec tsx --test src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts
pnpm exec tsx --test \
  src/resources/extensions/gsd/tests/task-recovery-convergence.test.ts \
  src/resources/extensions/gsd/tests/recovery-policy.test.ts \
  src/resources/extensions/gsd/tests/task-recovery-writers.test.ts \
  src/resources/extensions/gsd/tests/task-recovery-domain-operation.test.ts \
  src/resources/extensions/gsd/tests/auto-task-execution-cutover.test.ts \
  src/resources/extensions/gsd/tests/custom-task-host-verification.test.ts \
  src/resources/extensions/gsd/tests/task-completion-executor-identity.test.ts \
  packages/mcp-server/src/workflow-tools.test.ts \
  src/resources/extensions/gsd/tests/uok-gate-runner.test.ts \
  src/resources/extensions/gsd/tests/uok-loop-adapter-writer.test.ts \
  src/resources/extensions/gsd/tests/projection-no-plan-overwrite.test.ts \
  src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts \
  src/resources/extensions/gsd/tests/db-lifecycle-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-projection-closeout-foundation.test.ts \
  src/resources/extensions/gsd/tests/domain-operation.test.ts \
  src/resources/extensions/gsd/tests/single-writer-invariant.test.ts
pnpm run typecheck:extensions
pnpm run baseline:workflow-authority
pnpm run baseline:refactor:gate
pnpm run test:changed:src
```

Before merging, also run `pnpm run verify:merge`. For every new invariant, prove
the corresponding test fails under a temporary sabotage, restore the source,
and rerun the focused gate.
