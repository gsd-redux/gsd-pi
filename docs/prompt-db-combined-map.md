# gsd-pi Prompt ↔ Database Combined Map

> How each prompt in the pipeline reads and writes the database, and which DB state drives which prompt to fire.

See also:
- [prompt-map.md](./prompt-map.md) — full prompt system detail
- [db-map.md](./db-map.md) — full database schema detail

---

## 1. Master Flow: State Machine

```
┌─────────────────────────────────────────────────────────────────────┐
│                         gsd.db (SQLite WAL)                         │
│                                                                     │
│  milestones  slices  tasks  quality_gates  workers  unit_dispatches │
│  memories  artifacts  decisions  requirements  runtime_kv  ...      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │  reads
                       ▼
              auto-dispatch.ts
            (DISPATCH_RULES, 29 rules,
             first match → prompt + builder)
                       │
                       ▼
              auto-prompts.ts
           (buildXxxPrompt — inlines
            context from DB + disk files)
                       │
                       ▼
              Pi SDK session.run(prompt)
                       │
                       ▼
                   LLM runs
                       │
                       ▼ calls gsd_* tools
              bootstrap/db-tools.ts
                       │
                       ▼
              gsd-db.ts  (compatibility barrel over the explicit
                          single-writer allowlist)
                       │
                 transaction()/immediateTransaction()
                       │
                       ▼
               SQLite writes
                       │
         ┌─────────────┴──────────────┐
         │                            │
         ▼                            ▼
   DB tables updated          Markdown artifacts
   (canonical source)         regenerated + written to disk
         │
         ▼
   auto.ts loop ──► back to auto-dispatch.ts
```

`QUEUE-ORDER.json` is the exception to the usual generated-artifact projection rule. `/gsd rethink` and related phase-management flows write it as the durable milestone reorder contract, and state derivation mirrors it into `milestones.sequence` before dispatch so stale DB sequence can be repaired without importing arbitrary markdown projections.

`db/domain-operation.ts` provides the authoritative planning write seam: a
project-scoped, revision- and Authority-Epoch-checked `BEGIN IMMEDIATE`
transaction that atomically stores provenance, ordered events, outbox
destinations, Projection Work, and the authority CAS. Exact retries return a
durable receipt without rerunning mutation. Milestone/slice/task planning,
task/slice replanning, and roadmap reassessment route through this seam while
preserving their legacy response shapes. File-derived completion and UAT remain
outside the cutover.

Command primitives under `db/writers/lifecycle-commands.ts` compose
canonical lifecycle, Attempt, Result, and Kernel checkpoint facts inside that
transaction. `readDomainOperationFence()` recovers either the current fence or
an existing idempotency key's original expected fence, while
`db/lifecycle-shadow-comparison.ts` compares normalized legacy and canonical
statuses without discarding exact values. Planning handlers use lifecycle
adoption/transition and replay fences; Attempt integration remains blocked on
proven lease-loss recovery.

---

## 2. Prompt → DB Read/Write Reference

Each row = one prompt file. Columns show which DB tables it touches and how.

### Setup Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `guided-workflow-preferences` | — | runtime_kv (research-decision seed) | PREFERENCES.md |
| `guided-discuss-project` | — | artifacts (PROJECT) | PROJECT.md |
| `guided-discuss-requirements` | requirements | requirements (INSERT), artifacts (REQUIREMENTS) | REQUIREMENTS.md |
| `guided-research-decision` | runtime_kv | runtime_kv (research-decision.json key) | — |
| `guided-research-project` | milestones, artifacts | artifacts (RESEARCH × 4 aspects) | M##-RESEARCH.md |

### Milestone Planning Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `discuss` / `guided-discuss-milestone` | milestones, artifacts | artifacts (CONTEXT) | M##-CONTEXT.md |
| `discuss-headless` | milestones, artifacts | milestones, slices, decisions, artifacts | M##-CONTEXT.md, DECISIONS.md |
| `research-milestone` | milestones, artifacts | artifacts (RESEARCH) | M##-RESEARCH.md |
| `plan-milestone` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, milestones (UPDATE planning), slices (INSERT), optional single-slice metadata via `gsd_plan_slice`, optional single-slice tasks via `gsd_plan_task`, decisions | ROADMAP.md; NN-MM-PLAN.md with embedded tasks for single-slice fast path |
| `queue` | milestones | milestones (INSERT queued), artifacts (CONTEXT) | PROJECT.md, QUEUE.md |

### Slice Planning Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `parallel-research-slices` | slices, artifacts | artifacts (RESEARCH per slice) | S##-RESEARCH.md × N |
| `guided-discuss-slice` | slices, artifacts | artifacts (CONTEXT) | S##-CONTEXT.md |
| `research-slice` / `guided-research-slice` | slices, memories | artifacts (RESEARCH), memories (hit_count++) | S##-RESEARCH.md |
| `plan-slice` | project_authority, workflow_operations, workflow_item_lifecycles, slices, tasks, memories | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, slices metadata via `gsd_plan_slice`, per-task rows via `gsd_plan_task`, memories (hit_count++) | NN-MM-PLAN.md with embedded active task planning |
| `refine-slice` | project_authority, workflow_operations, workflow_item_lifecycles, slices (is_sketch=1), tasks | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, slices metadata and full task replacement/update via `gsd_plan_slice`; removed pending tasks become `skipped` / `cancelled` | NN-MM-PLAN.md with embedded active task planning |

### Execution Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `execute-task` | tasks, slices, milestones, memories, quality_gates | tasks (UPDATE status, narrative, summary), verification_evidence (INSERT), memories (hit_count++) | S##-T##-SUMMARY.md; NN-MM-PLAN.md checkbox; legacy T##-SUMMARY.md readable |
| `guided-resume-task` | tasks, slices | tasks (UPDATE status, summary), verification_evidence (INSERT) | S##-T##-SUMMARY.md; legacy T##-SUMMARY.md readable |
| `reactive-execute` | tasks | tasks (via N× execute-task subagents; recovery may mark summary-present tasks complete and missing-summary tasks skipped) | S##-T##-SUMMARY.md × N; S##-REACTIVE-BLOCKER.md when batch summaries remain missing after retries |
| `quick-task` | — | — (no DB; writes summaryPath directly) | {{summaryPath}} |

### Quality Gate Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `gate-evaluate` | quality_gates | quality_gates (UPDATE), gate_runs (INSERT, same transaction) | gate result per subagent |
| `validate-milestone` | milestones, slices, tasks, quality_gates | assessments (INSERT VALIDATION) | VALIDATION.md |
| `run-uat` | slices, assessments | assessments (INSERT ASSESSMENT) | S##-ASSESSMENT.md |

### Completion Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `complete-slice` | tasks, slices | slices (UPDATE status+summary), tasks (cascade skipped) | S##-SUMMARY.md, S##-UAT.md; ROADMAP.md checkpoint |
| `reassess-roadmap` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, milestones (UPDATE), slices (INSERT/UPDATE; removed pending rows become `skipped` / `cancelled`), assessments | ROADMAP.md, ASSESSMENT.md |
| `complete-milestone` | milestones, slices, tasks | milestones (UPDATE status=closed, completed_at) | M##-SUMMARY.md |

### Maintenance Phase

| Prompt | DB Reads | DB Writes | Disk Artifact Written |
|--------|----------|-----------|----------------------|
| `replan-slice` | project_authority, workflow_operations, workflow_item_lifecycles, slices, tasks | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, slices, tasks, replan_history, quality_gates; removed pending tasks become `skipped` / `cancelled` | NN-MM-PLAN.md, NN-MM-REPLAN.md |
| `rethink` | milestones, slices, artifacts | slices (UPDATE status=skipped), milestones (UPDATE sequence; repaired from QUEUE-ORDER.json during state derivation) | QUEUE-ORDER.json, PARKED.md |
| `rewrite-docs` | decisions, requirements, artifacts | decisions, requirements, artifacts | DECISIONS.md, REQUIREMENTS.md, slice plans with embedded task planning |
| `doctor-heal` | slices, tasks, artifacts | artifacts (repair CONTEXT/SUMMARY/UAT) | repairs existing artifacts |
| `review-migration` | milestones, slices, tasks, artifacts, decisions, requirements | — (read-only audit) | — |
| `scan` | — | — | STACK.md, INTEGRATIONS.md, ARCHITECTURE.md |
| `debug-diagnose` | memories | memories (INSERT pattern/gotcha), memories (hit_count++) | — |
| `forensics` | audit_events, gate_runs, turn_git_transactions | — (read-only) | — |
| `triage-captures` | artifacts (CAPTURES) | artifacts (CAPTURES, updated classifications) | CAPTURES.md |
| `add-tests` | tasks, slices | — | test files (via code execution) |
| `heal-skill` | — | — | skill-review-queue.md |

---

## 3. DB State → Which Prompt Fires

The dispatch loop reads DB state to determine which prompt to issue next. This is the precise join between DB and prompt layer:

```
DB State                                           → Prompt Dispatched
───────────────────────────────────────────────────────────────────────
PREFERENCES.md missing                             → guided-workflow-preferences

artifacts WHERE artifact_type='PROJECT' missing    → guided-discuss-project

requirements table empty                           → guided-discuss-requirements

runtime_kv[scope='global', key='research-decision']
  absent or value='pending'                        → guided-research-decision

runtime_kv[research-decision]='deep' AND
  M##-RESEARCH artifacts missing                   → guided-research-project × 4 subagents

milestones.status='active' AND
  artifacts WHERE artifact_type='CONTEXT' missing  → discuss / guided-discuss-milestone

CONTEXT present AND
  M##-RESEARCH missing AND complexity='high'       → research-milestone

CONTEXT present AND
  slices WHERE milestone_id=M## count = 0          → plan-milestone

slices exist AND
  S##-RESEARCH artifacts missing                   → parallel-research-slices × N subagents

slices WHERE slice_id=S## AND
  S##-CONTEXT artifact missing                     → guided-discuss-slice

S##-CONTEXT present AND
  tasks WHERE slice_id=S## count = 0               → plan-slice

slices WHERE is_sketch = 1                         → refine-slice

tasks WHERE status='pending' AND count ≥ 3 AND no S##-REACTIVE-BLOCKER
                                                       → reactive-execute (parallel)

tasks WHERE status='pending' AND count < 3         → execute-task (sequential)

quality_gates WHERE status='pending'               → gate-evaluate

tasks all status='complete' AND
  S##-ASSESSMENT artifact missing                  → run-uat

tasks all complete AND
  slices.status ≠ 'complete'                       → complete-slice

slice just completed AND
  roadmap requires update                          → reassess-roadmap

slices all complete AND
  VALIDATION artifact missing                      → validate-milestone

VALIDATION present AND
  milestones.status ≠ 'closed'                     → complete-milestone

milestones.status = 'closed' AND
  next milestone in queue                          → loop: next milestone

nothing matches                                    → stop
```

---

## 4. Full Data Lineage: Task Completion

One task's full DB journey from creation to completion:

```
plan-milestone prompt fires
  └─► gsd_plan_milestone tool
        └─► INSERT INTO slices (milestone_id, id, title, status='pending', is_sketch=1, sequence)
        └─► UPDATE slices SET goal, success_criteria, proof_level, ...

plan-slice prompt fires
  └─► gsd_plan_slice tool
        └─► UPDATE slices SET goal, success_criteria, proof_level, ...
        └─► If tasks omitted or empty: preserve existing tasks
        └─► If tasks non-empty: full replacement/update for this slice's tasks
  └─► gsd_plan_task tool (once per task for incremental planning)
        └─► INSERT INTO tasks (if missing)
        └─► UPDATE tasks SET full_plan_md, description, estimate, files, verify, ...
        └─► INSERT INTO quality_gates for task-scoped gates

refine-slice prompt fires (if is_sketch=1)
  └─► gsd_plan_slice tool
        └─► UPDATE slices SET is_sketch=0, goal, success_criteria, proof_level, ...
        └─► INSERT/UPDATE tasks from full task payload
        └─► UPDATE tasks SET full_plan_md, description, estimate, files, verify, ...

execute-task prompt fires
  └─► (reads) tasks WHERE id=T## → full_plan_md, description, estimate, files, verify
  └─► (reads) slices WHERE id=S## → goal, success_criteria
  └─► (reads) memories FTS → relevant knowledge
  └─► (reads) quality_gates WHERE status='pending' → gates to close
  └─► LLM executes the task
  └─► gsd_task_complete tool
        └─► UPDATE tasks SET
              status='complete',
              one_liner, narrative, verification_result,
              full_summary_md, key_files, key_decisions,
              completed_at, blocker_discovered
        └─► INSERT INTO verification_evidence (command, exit_code, verdict, duration_ms)
        └─► UPDATE quality_gates SET status='evaluated', verdict (if gate was open)
        └─► INSERT INTO gate_runs (audit; same transaction as the gate verdict)
        └─► Write S##-T##-SUMMARY.md to disk
        └─► Toggle checkbox in NN-MM-PLAN.md
        └─► If summary or plan projection write fails:
              DELETE verification_evidence for the task
              UPDATE tasks SET status='pending'
              remove attempted S##-T##-SUMMARY.md
              return an error instead of a stale success

complete-slice prompt fires (after all tasks complete)
  └─► gsd_slice_complete tool
        └─► UPDATE slices SET status='complete', full_summary_md, full_uat_md, completed_at
        └─► UPDATE tasks SET status='skipped' WHERE status='pending' (cascade)
        └─► Write S##-SUMMARY.md, S##-UAT.md to disk
        └─► Toggle checkpoint in ROADMAP.md

complete-milestone prompt fires (after all slices complete)
  └─► gsd_complete_milestone tool
        └─► UPDATE milestones SET status='closed', completed_at
        └─► Write M##-SUMMARY.md to disk
```

---

## 5. Memory System: capture_thought → memory_query

```
execute-task / debug-diagnose / complete-milestone prompts
  └─► capture_thought(category, content)
        └─► INSERT INTO memories (id, category, content, confidence, source_unit_type, created_at)
        └─► FTS triggers fire: INSERT INTO memories_fts

later execute-task / plan-slice / research-slice prompts
  └─► memory_query(keywords)
        └─► SELECT FROM memories_fts WHERE content MATCH keywords  (FTS5)
             OR  SELECT FROM memories WHERE content LIKE '%keywords%' LIMIT cap  (fallback)
        └─► incrementMemoryHitCount(id, now):
            UPDATE memories SET hit_count = hit_count + 1, last_hit_at = now  ← V28
        └─► queryMemoriesRanked applies memoryDecayFactor(last_hit_at):
            score *= max(0.7, 1.0 - 0.3 * min(1.0, daysAgo/90))               ← V28
        └─► Returns ranked memory rows → inlined into {{inlinedContext}}
```

### Artifact Integrity Fingerprint (V27)

Every prompt that writes an artifact (e.g. `guided-discuss-project` writing
`artifacts (PROJECT)`, `complete-slice` writing the slice summary) flows through
`insertArtifact` in `gsd-db.ts`, which now computes and persists a SHA-256 of
`full_content` alongside the row:

```
prompt → gsd_summary_save tool → insertArtifact({...})
  └─► content_hash = createHash('sha256').update(full_content).digest('hex')   ← V27
  └─► INSERT OR REPLACE INTO artifacts (..., content_hash) VALUES (..., :hash)
```

The hash is read-only metadata for now (no consumers verify it yet); the column
exists so future integrity-check tooling can detect manual edits or truncated
writes without breaking older binaries (column is nullable).

---

## 6. Coordination: Auto-Mode Multi-Worker DB Interactions

```
worker process starts
  └─► INSERT INTO workers (worker_id, host, pid, started_at, version, status)

worker claims a milestone
  └─► INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, expires_at, status='active')
  └─► (unique PK on milestone_id prevents two workers claiming same milestone)

worker dispatches a unit
  └─► INSERT INTO unit_dispatches (trace_id, turn_id, worker_id, milestone_lease_token,
                                   milestone_id, slice_id, task_id, unit_type, unit_id,
                                   status='claimed', attempt_n, started_at)
  └─► unique partial index: only one row with status IN ('claimed','running') per unit_id

user cancels
  └─► INSERT INTO cancellation_requests (scope, scope_id, dispatch_id, reason, status='pending')
  └─► worker polls: SELECT FROM cancellation_requests WHERE status='pending'
  └─► UPDATE cancellation_requests SET status='acked', acked_worker_id, acked_at

command broadcast
  └─► INSERT INTO command_queue (target_worker=NULL, command, args_json)  ← NULL = all workers
  └─► INSERT INTO command_queue (target_worker='w-123', command, args_json) ← targeted
  └─► worker claims with BEGIN IMMEDIATE so read-then-write claim races serialize under WAL

unit completes
  └─► UPDATE unit_dispatches SET status='done'|'failed', ended_at, exit_reason, error_summary
  └─► (all further state from gsd_task_complete, gsd_slice_complete, etc.)
```

---

## 7. Schema File → Tables Defined

| Source File | Tables |
|------------|--------|
| `db-base-schema.ts` | schema_version, decisions, requirements, artifacts, memories, memory_processed_units, memory_sources, memory_embeddings, memory_relations, milestones, slices, tasks, verification_evidence, replan_history, assessments, quality_gates, slice_dependencies, gate_runs, turn_git_transactions, milestone_commit_attributions, audit_events, audit_turn_index + all indexes + active_decisions/active_requirements/active_memories views |
| `db-canonical-foundation-schema.ts` | project_authority, workflow_operations, workflow_domain_events, workflow_outbox + domain-event immutability, durable-outbox deletion, safe-integer identity triggers, and canonical-foundation indexes (V31; planning handlers are runtime-routed) |
| `db-lifecycle-foundation-schema.ts` | workflow_item_lifecycles, workflow_execution_attempts, workflow_attempt_results, workflow_blockers, workflow_waivers, workflow_requirement_dispositions + lifecycle, fencing, provenance, history, and vocabulary constraints (V32; planning adopts lifecycle heads, while Attempt and terminal lifecycle integration remain later work) |
| `db-conversation-foundation-schema.ts` | workflow_milestone_contexts, workflow_open_questions, workflow_question_dependencies, workflow_interactions, workflow_interaction_options, workflow_answers, workflow_conversation_decisions, workflow_decision_impacts, workflow_work_checkpoints + recommendation-first, causal provenance, targeted revalidation, immutability, and single-head history constraints (V33, additive and not runtime-routed yet) |
| `db-recovery-evidence-foundation-schema.ts` | workflow_failure_observations, workflow_recovery_budgets, workflow_recovery_actions, workflow_acceptance_criteria, workflow_technical_verdicts, workflow_verification_evidence, workflow_human_acceptances, workflow_remediation_links + explicit agent/user/external recovery ownership, immutable count budgets derived from linked Actions, requirement-scoped criterion lineage, verdict-owned objective evidence, separate subjective acceptance, and immutable rework/remediation routing (V34, additive and not runtime-routed yet) |
| `db-projection-import-kernel-closeout-foundation-schema.ts` | workflow_projection_work, workflow_import_applications, workflow_kernel_checkpoints, workflow_closeout_plans, workflow_closeout_effects, workflow_settlement_receipts + per-key fenced projection delivery, import receipts carrying preview and verified-backup metadata, immutable kernel-stage lineage, versioned closeout plans, ordered idempotency-keyed effects, and success-only settlement receipts (V35; planning enqueues Projection Work, while the remaining families are not runtime-routed yet) |
| `db-coordination-schema.ts` | workers, milestone_leases, unit_dispatches, cancellation_requests, command_queue |
| `db-memory-fts-schema.ts` | memories_fts (FTS5 virtual table), memories_ai/ad/au triggers |
| `db-runtime-kv-schema.ts` | runtime_kv |
| `db-verification-evidence-schema.ts` | verification_evidence dedup index (helper for V13 migration) |
| `eval-review-schema.ts` | YAML frontmatter schema + parser for `/gsd eval-review` output (no SQL table — the eval-review contract lives in markdown frontmatter) |

---

## 8. Accessor Layer → Tables

| Row Accessor File | Tables It Accesses |
|------------------|--------------------|
| `db-task-slice-rows.ts` | slices, tasks (row → typed struct parsers) |
| `db-milestone-artifact-rows.ts` | milestones, artifacts (row → typed struct parsers) |
| `db-decision-requirement-rows.ts` | decisions, requirements (row → typed struct parsers) |
| `db-gate-rows.ts` | quality_gates (row → GateRow) |
| `db-verification-evidence-rows.ts` | verification_evidence (row → VerificationEvidenceRow) |
| `db-lightweight-query-rows.ts` | tasks (IdStatusSummary, ActiveTaskSummary, TaskStatusCounts aggregates) |

---

## 9. Key Invariants (Cross-Cutting)

| Invariant | Where Enforced |
|-----------|---------------|
| Single-writer: all write SQL in the explicit single-writer allowlist (`db/engine.ts`, authoritative transaction boundary `db/domain-operation.ts`, `db/writers/**`, `gsd-db.ts`, typed coordination/runtime writers `db/milestone-leases.ts`, `db/unit-dispatches.ts`, `db/auto-workers.ts`, `db/runtime-kv.ts`, `db/command-queue.ts`, schema/migration helpers `db-canonical-foundation-schema.ts`, `db-lifecycle-foundation-schema.ts`, `db-conversation-foundation-schema.ts`, `db-recovery-evidence-foundation-schema.ts`, `db-projection-import-kernel-closeout-foundation-schema.ts`, `db-memory-fts-schema.ts`, `db-schema-metadata.ts`, `db-verification-evidence-schema.ts`, and ADR migration/backfill helper `memory-backfill.ts`); this is not permission for arbitrary writes under `db/`; `unit-ownership.ts` owns separate `.gsd/unit-claims.db`; `db/queries.ts` is read-only | structural test `single-writer-invariant.test.ts` (explicit allowlist) |
| Cascade on slice complete: pending tasks → skipped | `gsd_slice_complete` transaction |
| Cascade on milestone reopen: all slices → in_progress, tasks → pending | `gsd_milestone_reopen` transaction |
| No nested write transactions: `transaction()` and `immediateTransaction()` share one depth counter; `executeDomainOperation()` rejects an existing outer transaction so it owns the reserved-writer boundary; read-then-write claims use `immediateTransaction()` and gate verdict + ledger writes commit atomically | `db-transaction.test.ts`, `domain-operation.test.ts`, `command-queue.test.ts`, `gate-storage.test.ts` |
| Workspace isolation: one DB per project root, shared across worktrees via WAL | `db-connection-cache.ts` identityKey |
| Coordination: one active dispatch per unit_id at a time | `idx_unit_dispatches_active_per_unit` unique partial index |
| Memory FTS fallback: LIKE scan if FTS5 unavailable | `tryCreateMemoriesFtsSchema` onUnavailable callback |
| Pre-migration backup: file-backed migrations checkpoint WAL before replacing `.gsd/gsd.db.backup-vN`; the copied database must have the expected schema version and pass SQLite `quick_check`, and checkpoint/copy/validation failures warn then stop before migration DDL | `db-migration-backup.ts` |
| Prompt template vars: all `{{vars}}` must be provided before substitution | `prompt-loader.ts` pre-substitution validation |
| Prompt cache stability: static sections always before dynamic | `prompt-ordering.ts` reorderForCaching |

V34 keeps four truths separate: a Failure Observation records what happened; a
Recovery Action records the one selected route; a Technical Verdict records the
policy conclusion for one current technical criterion and settled Attempt; and
Verification Evidence records the immutable objective observation owned by that
verdict. A subjective-UAT criterion uses Human Acceptance linked to the current
accepted V33 `subjective-uat` Answer instead of a Technical Verdict. Immutable
Recovery Budgets store a `max_uses` allocation and no mutable consumed counter;
consumption is derived by counting linked immutable Recovery Actions. The cap is
one use for deterministic repair or two for every other policy class. A
human-routed Failure Observation owns the exact V32 Blocker used by
clarify/pause, so an unrelated blocker cannot justify a pause. Criterion changes
append a same-key supersession head, corrected Technical Verdicts supersede the
current head for the same criterion, Attempt, and tested source revision, and
failed/inconclusive verdicts or current rejected Human Acceptance route through
immutable `rework | remediation` links.

Legacy `verification_evidence`, assessments, quality gates, gate runs, UAT
files, rework briefs, dispatch retry fields, runtime JSON/KV, and process-local
counters are not repurposed or backfilled by V34. V34 also does not cut runtime
recovery, verification, UAT, lifecycle completion, projections, manifest
restore, or worktree reconciliation over to the new tables. Later
command-specific writers must use the S06 Domain Operation boundary to commit
failure/action and verdict/evidence bundles plus any applicable remediation
links atomically, and require bundle completeness before dispatch or closeout.

V35 makes projection delivery, import application, kernel position, and
closeout settlement restart-safe without creating parallel work or execution
identities. Markdown remains projection output and never becomes runtime
authority. Projection currentness is tracked per logical target; enqueue facts
bind to a Domain Operation, while fenced delivery transitions are operational
and do not advance project revision.

An import preview remains non-authoritative until one immutable application
receipt records its exact source/change envelope and independently verified
backup metadata. The schema requires repeated envelope metadata, hashes, and
counts to match the preview JSON, binds the `import.apply` operation request
hash to `preview_hash`, and makes the operation immutable once receipted. It
validates lowercase `sha256:` formats but cannot recompute SHA-256; the deferred
import application writer owns canonical preview hashing, source/change
verification, and opening and hashing the referenced backup before insertion.
Absence of a kernel checkpoint means Advance; the first persisted checkpoint
is Execute and shares the selected Attempt's claim operation.
Closeout state is derived from the current immutable plan, its ordered
idempotency-keyed effects, and complete success-only receipts. Missing receipt means
pending, while failures route through V34 recovery facts rather than failed
receipts. V35 adds no kernel-run or settlement aggregate.

V35 is still an additive foundation. The S06 boundary owns the base atomic
provenance/event/outbox/Projection Work bundle and authority CAS. Later
milestones own command-specific sibling bundles and adapters, queries,
stage/readiness checks, effect/proof hashing, idempotent host execution, runtime
routing, and final lifecycle completion.
