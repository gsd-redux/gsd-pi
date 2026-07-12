# gsd-pi Database Map

> Complete schema, access layer, migration history, and cross-reference to the prompt system.

---

## 1. Database Infrastructure Stack

```
gsd_* tool call (from LLM)
       │
       ▼
bootstrap/db-tools.ts          ← tool registration + input parsing
       │
       ▼
tools/workflow-tool-executors.ts  ← business logic
       │
       ├── validation reads (milestones, slices, tasks)
       │
       ▼
gsd-db.ts  ← compatibility barrel over the explicit single-writer allowlist
       │
       ├── db/engine.ts     ← connection/handle, schema/migrations, transaction primitives
       ├── db/writers/*.ts  ← the Single Writer Layer (one write subsystem per file)
       ├── db/{milestone-leases,unit-dispatches,auto-workers,runtime-kv,command-queue}.ts
       │                    ← typed coordination/runtime writers
       ├── db-canonical-foundation-schema.ts, db-lifecycle-foundation-schema.ts,
       │   db-conversation-foundation-schema.ts, db-memory-fts-schema.ts, db-schema-metadata.ts,
       │   db-verification-evidence-schema.ts
       │                    ← allowlisted schema/migration helpers
       ├── memory-backfill.ts
       │                    ← allowlisted ADR migration/backfill helper
       ├── db/queries.ts    ← the Query Module (read-only SELECT wrappers)
       │
       ├── transaction()/immediateTransaction()
       │   (db/engine.ts via db-transaction.ts — depth counter, no nested BEGIN)
       │
       ▼
db-adapter.ts  ← normalized prepared-statement cache
       │
       ▼
db-provider.ts  ← node:sqlite (primary) or better-sqlite3 (fallback)
       │
       ▼
SQLite WAL  (.gsd/gsd.db)
       │
       ▼
After commit: regenerate markdown artifacts → write to disk → invalidate cache
```

**Connection scoping (db-connection-cache.ts):**
- Keyed by workspace `identityKey` (realpath of project root)
- Sibling worktrees share the same `.gsd/gsd.db` via SQLite WAL
- Only one connection is "active" at a time; others cached for fast re-activation
- On process exit: checkpoint WAL → vacuum → close
- Before file-backed schema migrations, `db-migration-backup.ts` checkpoints WAL and replaces `.gsd/gsd.db.backup-vN` with a copy of the database being migrated. The copy must report the expected schema version and pass SQLite `quick_check`; checkpoint, copy, or validation failures warn and fail closed before migration DDL.

**Provider fallback chain:**
1. `node:sqlite` (Node ≥ 22 built-in) — preferred
2. `better-sqlite3` (npm) — fallback if node:sqlite unavailable
3. null → DB unavailable. Runtime `deriveState()` fails closed with an explicit blocker; markdown-only recovery is available only through explicit migration/recovery commands.

**Runtime state derivation:** `deriveState()` opens the existing workflow DB through `state/derive/db-open.ts`, projects rows in `state/derive/from-db.ts`, and returns a DB-unavailable blocker instead of implicitly deriving runtime state from markdown projections. Markdown hierarchy import is explicit recovery/migration behavior, not the normal read path. When `GSD_MILESTONE_LOCK` changes, auto-mode invalidates the short-lived derive cache because the cache key is only the base path while the DB projection is lock-filtered.

---

## 2. Schema Version History

Current version: **V33**

| Version | What Changed |
|---------|-------------|
| V1 | schema_version + decisions + requirements tables |
| V2 | artifacts table |
| V3 | memories + memory_processed_units; FTS3 |
| V4 | decisions.made_by column |
| V5 | **Core hierarchy**: milestones, slices, tasks, verification_evidence |
| V6 | slices.full_summary_md, full_uat_md |
| V7 | slices.depends, demo; milestones.depends_on |
| V8 | Deep planning fields on milestones/slices/tasks; replan_history; assessments |
| V9 | sequence ordering on slices + tasks |
| V10 | slices.replan_triggered_at |
| V11 | tasks.full_plan_md; replan_history unique index |
| V12 | quality_gates table (broken DDL, fixed in V22) |
| V13 | Hot-path indexes; verification_evidence dedup index |
| V14 | slice_dependencies table |
| V15 | gate_runs, turn_git_transactions, audit_events, audit_turn_index |
| V16 | slices.is_sketch, sketch_scope (ADR-011); decisions.source |
| V17 | tasks escalation columns (blocker_source, escalation_*) |
| V18 | memory_sources; memories.scope + tags |
| V19 | memory_embeddings; memories_fts (FTS5 virtual table + triggers) |
| V20 | memory_relations |
| V21 | memories.structured_fields |
| V22 | quality_gates table repair (task_id constraint); scope column |
| V23 | milestones.sequence |
| V24 | **Auto-mode coordination**: workers, milestone_leases, unit_dispatches, cancellation_requests, command_queue |
| V25 | runtime_kv (soft state KV with global/worker/milestone scope) |
| V26 | milestone_commit_attributions |
| V27 | artifacts.content_hash (SHA-256 of full_content, computed on every insertArtifact) |
| V28 | memories.last_hit_at; incrementMemoryHitCount sets it; queryMemoriesRanked applies time-decay (1.0 → 0.7 floor over 90 days) |
| V29 | slices.target_repositories and tasks.target_repositories for multi-repository planning |
| V30 | rework_briefs and rework_brief_findings for structured task rework gates |
| V31 | **Additive canonical foundation**: singleton project authority with revision and Authority Epoch, workflow operation provenance/idempotency receipts, immutable revision-linked domain events, and a durable event outbox |
| V32 | **Additive lifecycle foundation**: canonical lifecycle state, fenced execution Attempts, immutable Attempt Results, human-only Blockers, authorized Waivers, and immutable Requirement Disposition history |
| V33 | **Additive guided-conversation foundation**: milestone context and advisory horizons, focused recommendation-first interactions, immutable verbatim Answers and correction-safe Decisions, dependency-targeted impacts, and restart-safe Work Checkpoints |

---

## 3. Complete Table Inventory

### 3a. Core Hierarchy (V1, V5–V11)

#### `schema_version`
```
version    INTEGER NOT NULL
applied_at TEXT NOT NULL
```
Tracks which migrations have run.

---

#### `decisions`
```
seq            INTEGER PRIMARY KEY AUTOINCREMENT
id             TEXT NOT NULL UNIQUE
when_context   TEXT NOT NULL DEFAULT ''
scope          TEXT NOT NULL DEFAULT ''
decision       TEXT NOT NULL DEFAULT ''
choice         TEXT NOT NULL DEFAULT ''
rationale      TEXT NOT NULL DEFAULT ''
revisable      TEXT NOT NULL DEFAULT ''
made_by        TEXT NOT NULL DEFAULT 'agent'     ← V4
source         TEXT NOT NULL DEFAULT 'discussion' ← V16
superseded_by  TEXT DEFAULT NULL
```
- View: `active_decisions` WHERE superseded_by IS NULL

---

#### `requirements`
```
id                TEXT PRIMARY KEY
class             TEXT NOT NULL DEFAULT ''
status            TEXT NOT NULL DEFAULT ''
description       TEXT NOT NULL DEFAULT ''
why               TEXT NOT NULL DEFAULT ''
source            TEXT NOT NULL DEFAULT ''
primary_owner     TEXT NOT NULL DEFAULT ''
supporting_slices TEXT NOT NULL DEFAULT ''
validation        TEXT NOT NULL DEFAULT ''
notes             TEXT NOT NULL DEFAULT ''
full_content      TEXT NOT NULL DEFAULT ''
superseded_by     TEXT DEFAULT NULL
```
- View: `active_requirements` WHERE superseded_by IS NULL

---

#### `artifacts` (V2)
```
path          TEXT PRIMARY KEY
artifact_type TEXT NOT NULL DEFAULT ''
milestone_id  TEXT DEFAULT NULL
slice_id      TEXT DEFAULT NULL
task_id       TEXT DEFAULT NULL
full_content  TEXT NOT NULL DEFAULT ''
imported_at   TEXT NOT NULL DEFAULT ''
content_hash  TEXT DEFAULT NULL                  ← V27, SHA-256 of full_content
```
Stores markdown artifact content (PROJECT, REQUIREMENTS, SUMMARY, RESEARCH, CONTEXT, etc.).
V27: `content_hash` is computed and stored on every `insertArtifact` for integrity fingerprinting.

---

#### `milestones` (V5)
```
id                      TEXT PRIMARY KEY
title                   TEXT NOT NULL DEFAULT ''
status                  TEXT NOT NULL DEFAULT 'active'
depends_on              TEXT NOT NULL DEFAULT '[]'   ← JSON array, V7
created_at              TEXT NOT NULL DEFAULT ''
completed_at            TEXT DEFAULT NULL
vision                  TEXT NOT NULL DEFAULT ''           ← V8
success_criteria        TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
key_risks               TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
proof_strategy          TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
verification_contract   TEXT NOT NULL DEFAULT ''           ← V8
verification_integration TEXT NOT NULL DEFAULT ''          ← V8
verification_operational TEXT NOT NULL DEFAULT ''          ← V8
verification_uat        TEXT NOT NULL DEFAULT ''           ← V8
definition_of_done      TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
requirement_coverage    TEXT NOT NULL DEFAULT ''           ← V8
boundary_map_markdown   TEXT NOT NULL DEFAULT ''           ← V8
sequence                INTEGER DEFAULT 0                  ← V23
```
- Index: `idx_milestones_status` (status)
- Status values: `active`, `closed`, `queued`
- `sequence` is the canonical DB ordering used to choose the next open milestone. `.gsd/QUEUE-ORDER.json` is the durable operator reorder contract for `/gsd rethink` and `/gsd phase`; when present, state derivation mirrors that file into `milestones.sequence` before dispatch.

---

#### `slices` (V5)
```
milestone_id         TEXT NOT NULL
id                   TEXT NOT NULL
title                TEXT NOT NULL DEFAULT ''
status               TEXT NOT NULL DEFAULT 'pending'
risk                 TEXT NOT NULL DEFAULT 'medium'
depends              TEXT NOT NULL DEFAULT '[]'         ← V7, JSON
demo                 TEXT NOT NULL DEFAULT ''           ← V7
created_at           TEXT NOT NULL DEFAULT ''
completed_at         TEXT DEFAULT NULL
full_summary_md      TEXT NOT NULL DEFAULT ''           ← V6
full_uat_md          TEXT NOT NULL DEFAULT ''           ← V6
goal                 TEXT NOT NULL DEFAULT ''           ← V8
success_criteria     TEXT NOT NULL DEFAULT ''           ← V8
proof_level          TEXT NOT NULL DEFAULT ''           ← V8
integration_closure  TEXT NOT NULL DEFAULT ''           ← V8
observability_impact TEXT NOT NULL DEFAULT ''           ← V8
target_repositories TEXT NOT NULL DEFAULT '[]'          ← V29, JSON
sequence             INTEGER DEFAULT 0                  ← V9
replan_triggered_at  TEXT DEFAULT NULL                  ← V10
is_sketch            INTEGER NOT NULL DEFAULT 0         ← V16
sketch_scope         TEXT NOT NULL DEFAULT ''           ← V16
PRIMARY KEY (milestone_id, id)
FOREIGN KEY milestone_id → milestones(id)
```
- Index: `idx_slices_active` (milestone_id, status)
- Status values: `pending`, `in_progress`, `complete`, `skipped` (legacy/imported `done` and `closed` are treated as closed aliases by `status-guards.ts`)

---

#### `tasks` (V5)
```
milestone_id                TEXT NOT NULL
slice_id                    TEXT NOT NULL
id                          TEXT NOT NULL
title                       TEXT NOT NULL DEFAULT ''
status                      TEXT NOT NULL DEFAULT 'pending'
one_liner                   TEXT NOT NULL DEFAULT ''
narrative                   TEXT NOT NULL DEFAULT ''
verification_result         TEXT NOT NULL DEFAULT ''
duration                    TEXT NOT NULL DEFAULT ''
completed_at                TEXT DEFAULT NULL
blocker_discovered          INTEGER DEFAULT 0
blocker_source              TEXT NOT NULL DEFAULT ''           ← V17
escalation_pending          INTEGER NOT NULL DEFAULT 0         ← V17
escalation_awaiting_review  INTEGER NOT NULL DEFAULT 0         ← V17
escalation_artifact_path    TEXT DEFAULT NULL                  ← V17
escalation_override_applied_at TEXT DEFAULT NULL              ← V17
deviations                  TEXT NOT NULL DEFAULT ''
known_issues                TEXT NOT NULL DEFAULT ''
key_files                   TEXT NOT NULL DEFAULT '[]'         ← JSON
key_decisions               TEXT NOT NULL DEFAULT '[]'         ← JSON
full_summary_md             TEXT NOT NULL DEFAULT ''
description                 TEXT NOT NULL DEFAULT ''           ← V8
estimate                    TEXT NOT NULL DEFAULT ''           ← V8
files                       TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
verify                      TEXT NOT NULL DEFAULT ''           ← V8
inputs                      TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
expected_output             TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
observability_impact        TEXT NOT NULL DEFAULT ''           ← V8
full_plan_md                TEXT NOT NULL DEFAULT ''           ← V11
target_repositories         TEXT NOT NULL DEFAULT '[]'         ← V29, JSON
sequence                    INTEGER DEFAULT 0                  ← V9
PRIMARY KEY (milestone_id, slice_id, id)
FOREIGN KEY (milestone_id, slice_id) → slices(milestone_id, id)
```
- Indexes: `idx_tasks_active` (milestone_id, slice_id, status), `idx_tasks_escalation_pending`
- Status values: `pending`, `in_progress`, `complete`, `skipped`, `blocked` (legacy/imported `done` and `closed` are treated as complete aliases; `insertTask` stamps `completed_at` for `complete`/`done`/`closed`, but not `skipped`)

---

#### `verification_evidence` (V5)
```
id           INTEGER PRIMARY KEY AUTOINCREMENT
task_id      TEXT NOT NULL DEFAULT ''
slice_id     TEXT NOT NULL DEFAULT ''
milestone_id TEXT NOT NULL DEFAULT ''
command      TEXT NOT NULL DEFAULT ''
exit_code    INTEGER DEFAULT 0
verdict      TEXT NOT NULL DEFAULT ''
duration_ms  INTEGER DEFAULT 0
created_at   TEXT NOT NULL DEFAULT ''
FOREIGN KEY (milestone_id, slice_id, task_id) → tasks
```
- Indexes: `idx_verification_evidence_task`, unique dedup index (V13)

---

#### `replan_history` (V8)
```
id                       INTEGER PRIMARY KEY AUTOINCREMENT
milestone_id             TEXT NOT NULL
slice_id                 TEXT DEFAULT NULL
task_id                  TEXT DEFAULT NULL
summary                  TEXT NOT NULL DEFAULT ''
previous_artifact_path   TEXT DEFAULT NULL
replacement_artifact_path TEXT DEFAULT NULL
created_at               TEXT NOT NULL DEFAULT ''
FOREIGN KEY milestone_id → milestones(id)
```

---

#### `rework_briefs` (V30)
```
id            TEXT PRIMARY KEY
milestone_id  TEXT NOT NULL DEFAULT ''
slice_id      TEXT NOT NULL DEFAULT ''
task_id       TEXT NOT NULL DEFAULT ''
created_at    TEXT NOT NULL DEFAULT ''
updated_at    TEXT NOT NULL DEFAULT ''
```
- Index: `idx_rework_briefs_task` (milestone_id, slice_id, task_id)
- Default ID when omitted by the caller: `RB-<milestoneId>-<sliceId>-<taskId>`

---

#### `rework_brief_findings` (V30)
```
brief_id              TEXT NOT NULL
finding_id            TEXT NOT NULL
severity              TEXT NOT NULL DEFAULT 'blocking'
description           TEXT NOT NULL DEFAULT ''
required_fix          TEXT NOT NULL DEFAULT ''
verification_commands TEXT NOT NULL DEFAULT '[]'
status                TEXT NOT NULL DEFAULT 'pending'
evidence              TEXT NOT NULL DEFAULT ''
decision_ref          TEXT NOT NULL DEFAULT ''
updated_at            TEXT NOT NULL DEFAULT ''
PRIMARY KEY (brief_id, finding_id)
FOREIGN KEY brief_id → rework_briefs(id)
```
- Index: `idx_rework_findings_status` (brief_id, severity, status)
- `severity = 'blocking'` and `status = 'pending'` gates `gsd_task_complete` for the linked task until the finding is resolved or explicitly deferred with an override.

---

#### `assessments` (V8)
```
path         TEXT PRIMARY KEY
milestone_id TEXT NOT NULL DEFAULT ''
slice_id     TEXT DEFAULT NULL
task_id      TEXT DEFAULT NULL
status       TEXT NOT NULL DEFAULT ''
scope        TEXT NOT NULL DEFAULT ''
full_content TEXT NOT NULL DEFAULT ''
created_at   TEXT NOT NULL DEFAULT ''
FOREIGN KEY milestone_id → milestones(id)
```

---

#### `quality_gates` (V12, repaired V22)
```
milestone_id TEXT NOT NULL
slice_id     TEXT NOT NULL
gate_id      TEXT NOT NULL
scope        TEXT NOT NULL DEFAULT 'slice'   ← V22
task_id      TEXT NOT NULL DEFAULT ''        ← V22 (was broken)
status       TEXT NOT NULL DEFAULT 'pending'
verdict      TEXT NOT NULL DEFAULT ''
rationale    TEXT NOT NULL DEFAULT ''
findings     TEXT NOT NULL DEFAULT ''
evaluated_at TEXT DEFAULT NULL
PRIMARY KEY (milestone_id, slice_id, gate_id, task_id)
FOREIGN KEY (milestone_id, slice_id) → slices
```
- Index: `idx_quality_gates_pending`

---

#### `slice_dependencies` (V14)
```
milestone_id        TEXT NOT NULL
slice_id            TEXT NOT NULL
depends_on_slice_id TEXT NOT NULL
PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id)
FOREIGN KEY (milestone_id, slice_id) → slices
FOREIGN KEY (milestone_id, depends_on_slice_id) → slices
```
- Index: `idx_slice_deps_target`
- Maintained from the milestone `ROADMAP.md` slice `depends` declarations. The
  ADR-017 `roadmap-divergence` reconciliation repair re-imports the roadmap as
  the source of truth, then refreshes this junction table so dependency checks
  see the same edges as the markdown projection.

---

#### `gate_runs` (V15)
```
id            INTEGER PRIMARY KEY AUTOINCREMENT
trace_id      TEXT NOT NULL
turn_id       TEXT NOT NULL
gate_id       TEXT NOT NULL
gate_type     TEXT NOT NULL DEFAULT ''
unit_type     TEXT DEFAULT NULL
unit_id       TEXT DEFAULT NULL
milestone_id  TEXT DEFAULT NULL
slice_id      TEXT DEFAULT NULL
task_id       TEXT DEFAULT NULL
outcome       TEXT NOT NULL DEFAULT 'pass'
failure_class TEXT NOT NULL DEFAULT 'none'
rationale     TEXT NOT NULL DEFAULT ''
findings      TEXT NOT NULL DEFAULT ''
attempt       INTEGER NOT NULL DEFAULT 1
max_attempts  INTEGER NOT NULL DEFAULT 1
retryable     INTEGER NOT NULL DEFAULT 0
evaluated_at  TEXT NOT NULL DEFAULT ''
```
- Indexes: `idx_gate_runs_turn`, `idx_gate_runs_lookup`

---

#### `turn_git_transactions` (V15)
```
trace_id      TEXT NOT NULL
turn_id       TEXT NOT NULL
unit_type     TEXT DEFAULT NULL
unit_id       TEXT DEFAULT NULL
stage         TEXT NOT NULL DEFAULT 'turn-start'
action        TEXT NOT NULL DEFAULT 'status-only'
push          INTEGER NOT NULL DEFAULT 0
status        TEXT NOT NULL DEFAULT 'ok'
error         TEXT DEFAULT NULL
metadata_json TEXT NOT NULL DEFAULT '{}'
updated_at    TEXT NOT NULL DEFAULT ''
PRIMARY KEY (trace_id, turn_id, stage)
```
- Index: `idx_turn_git_tx_turn`

---

#### `audit_events` (V15)
```
event_id     TEXT PRIMARY KEY
trace_id     TEXT NOT NULL
turn_id      TEXT DEFAULT NULL
caused_by    TEXT DEFAULT NULL
category     TEXT NOT NULL
type         TEXT NOT NULL
ts           TEXT NOT NULL
payload_json TEXT NOT NULL DEFAULT '{}'
```
- Indexes: `idx_audit_events_trace`, `idx_audit_events_turn`

---

#### `audit_turn_index` (V15)
```
trace_id    TEXT NOT NULL
turn_id     TEXT NOT NULL
first_ts    TEXT NOT NULL
last_ts     TEXT NOT NULL
event_count INTEGER NOT NULL DEFAULT 0
PRIMARY KEY (trace_id, turn_id)
```

---

#### `milestone_commit_attributions` (V26)
```
commit_sha   TEXT NOT NULL
milestone_id TEXT NOT NULL
slice_id     TEXT DEFAULT NULL
task_id      TEXT DEFAULT NULL
source       TEXT NOT NULL DEFAULT 'recorded'
confidence   REAL NOT NULL DEFAULT 1.0
files_json   TEXT NOT NULL DEFAULT '[]'
created_at   TEXT NOT NULL DEFAULT ''
PRIMARY KEY (commit_sha, milestone_id)
```
- Index: `idx_milestone_commit_attr_milestone`

---

### 3b. Memory & Knowledge Layer (V3, V18–V21)

#### `memories` (V3)
```
seq               INTEGER PRIMARY KEY AUTOINCREMENT
id                TEXT NOT NULL UNIQUE
category          TEXT NOT NULL
content           TEXT NOT NULL
confidence        REAL NOT NULL DEFAULT 0.8
source_unit_type  TEXT
source_unit_id    TEXT
created_at        TEXT NOT NULL
updated_at        TEXT NOT NULL
superseded_by     TEXT DEFAULT NULL
hit_count         INTEGER NOT NULL DEFAULT 0
scope             TEXT NOT NULL DEFAULT 'project'   ← V18
tags              TEXT NOT NULL DEFAULT '[]'         ← V18, JSON
structured_fields TEXT DEFAULT NULL                  ← V21, JSON
last_hit_at       TEXT DEFAULT NULL                  ← V28, set by incrementMemoryHitCount
```
- Index: `idx_memories_active` (superseded_by), `idx_memories_scope` (scope)
- View: `active_memories` WHERE superseded_by IS NULL
- FTS: `memories_fts` virtual table (V19)
- V28: `queryMemoriesRanked` applies `memoryDecayFactor(last_hit_at)` — linear decay from 1.0 (≤0 days) to 0.7 floor (≥90 days)

---

#### `memory_processed_units` (V3)
```
unit_key     TEXT PRIMARY KEY
activity_file TEXT
processed_at TEXT NOT NULL
```

---

#### `memory_sources` (V18)
```
id           TEXT PRIMARY KEY
kind         TEXT NOT NULL
uri          TEXT
title        TEXT
content      TEXT NOT NULL
content_hash TEXT NOT NULL UNIQUE
imported_at  TEXT NOT NULL
scope        TEXT NOT NULL DEFAULT 'project'
tags         TEXT NOT NULL DEFAULT '[]'
```
- Indexes: `idx_memory_sources_kind`, `idx_memory_sources_scope`

---

#### `memory_embeddings` (V19)
```
memory_id  TEXT PRIMARY KEY
model      TEXT NOT NULL
dim        INTEGER NOT NULL
vector     BLOB NOT NULL
updated_at TEXT NOT NULL
```

---

#### `memory_relations` (V20)
```
from_id    TEXT NOT NULL
to_id      TEXT NOT NULL
rel        TEXT NOT NULL
confidence REAL NOT NULL DEFAULT 0.8
created_at TEXT NOT NULL
PRIMARY KEY (from_id, to_id, rel)
```
- Indexes: `idx_memory_relations_from`, `idx_memory_relations_to`

---

#### `memories_fts` (V19, Virtual)
```
FTS5 virtual table
Content: memories.content
Tokenizer: porter unicode61
Triggers: memories_ai, memories_ad, memories_au (keep in sync)
Fallback: LIKE scan if FTS5 unavailable
```

---

### 3c. Auto-Mode Coordination (V24)

#### `workers`
```
worker_id              TEXT PRIMARY KEY
host                   TEXT NOT NULL
pid                    INTEGER NOT NULL
started_at             TEXT NOT NULL
version                TEXT NOT NULL
last_heartbeat_at      TEXT NOT NULL
status                 TEXT NOT NULL
project_root_realpath  TEXT NOT NULL
```

---

#### `milestone_leases`
```
milestone_id   TEXT PRIMARY KEY
worker_id      TEXT NOT NULL
fencing_token  INTEGER NOT NULL
acquired_at    TEXT NOT NULL
expires_at     TEXT NOT NULL
status         TEXT NOT NULL
FOREIGN KEY worker_id → workers(worker_id)
FOREIGN KEY milestone_id → milestones(id)
```

---

#### `unit_dispatches`
```
id                      INTEGER PRIMARY KEY AUTOINCREMENT
trace_id                TEXT NOT NULL
turn_id                 TEXT
worker_id               TEXT NOT NULL
milestone_lease_token   INTEGER NOT NULL
milestone_id            TEXT NOT NULL
slice_id                TEXT
task_id                 TEXT
unit_type               TEXT NOT NULL
unit_id                 TEXT NOT NULL
status                  TEXT NOT NULL
attempt_n               INTEGER NOT NULL DEFAULT 1
started_at              TEXT NOT NULL
ended_at                TEXT
exit_reason             TEXT
error_summary           TEXT
verification_evidence_id INTEGER
next_run_at             TEXT
retry_after_ms          INTEGER
max_attempts            INTEGER NOT NULL DEFAULT 3
last_error_code         TEXT
last_error_at           TEXT
FOREIGN KEY worker_id → workers
FOREIGN KEY verification_evidence_id → verification_evidence(id)
```
- Indexes: `idx_unit_dispatches_active`, `idx_unit_dispatches_trace`
- Unique partial index: `idx_unit_dispatches_active_per_unit` ON unit_id WHERE status IN ('claimed','running') — prevents double-claim

---

#### `cancellation_requests`
```
id              INTEGER PRIMARY KEY AUTOINCREMENT
requested_at    TEXT NOT NULL
requested_by    TEXT NOT NULL
scope           TEXT NOT NULL
scope_id        TEXT NOT NULL
dispatch_id     INTEGER
reason          TEXT NOT NULL
status          TEXT NOT NULL
acked_at        TEXT
acked_worker_id TEXT
FOREIGN KEY dispatch_id → unit_dispatches(id)
FOREIGN KEY acked_worker_id → workers(worker_id)
```

---

#### `command_queue`
```
id           INTEGER PRIMARY KEY AUTOINCREMENT
target_worker TEXT     ← NULL = broadcast to all workers
command      TEXT NOT NULL
args_json    TEXT NOT NULL DEFAULT '{}'
enqueued_at  TEXT NOT NULL
claimed_at   TEXT
claimed_by   TEXT
completed_at TEXT
result_json  TEXT
```
- Index: `idx_command_queue_pending` (target_worker, claimed_at)
- Claiming is a read-then-write path and uses `immediateTransaction()` so WAL workers serialize before selecting the pending row instead of failing a deferred write upgrade with `SQLITE_BUSY_SNAPSHOT`.

---

### 3d. Soft State (V25)

#### `runtime_kv`
```
scope      TEXT NOT NULL    ← 'global' | 'worker' | 'milestone'
scope_id   TEXT NOT NULL DEFAULT ''
key        TEXT NOT NULL
value_json TEXT NOT NULL
updated_at TEXT NOT NULL
PRIMARY KEY (scope, scope_id, key)
```
Non-correctness-critical state: UI cursors, dashboard caches, resume pointers. Safe to lose.

---

### 3e. Additive Canonical Foundation (V31)

V31 creates these tables on fresh databases and transactionally upgrades V30
databases. It is schema-only in this release: existing runtime read/write paths
are not routed through these tables yet, and no import, projection worker,
lifecycle API, or legacy deletion ships with this migration.

#### `project_authority`
```
singleton            INTEGER PRIMARY KEY CHECK (singleton = 1)
project_id           TEXT NOT NULL UNIQUE
project_root_realpath TEXT NOT NULL DEFAULT ''
revision             INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
authority_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0)
created_at           TEXT NOT NULL DEFAULT ''
updated_at           TEXT NOT NULL DEFAULT ''
```
- Exactly one row is seeded with a generated 32-character lowercase hex
  `project_id`; fresh and upgraded databases begin at revision/epoch `0`.
- `schema_version` remains the DDL compatibility version and is not this domain
  revision.

#### `workflow_operations`
```
operation_id             TEXT PRIMARY KEY
project_id               TEXT NOT NULL
operation_type           TEXT NOT NULL
idempotency_key          TEXT NOT NULL
expected_revision        INTEGER NOT NULL CHECK (expected_revision >= 0)
resulting_revision       INTEGER NOT NULL CHECK (resulting_revision = expected_revision + 1)
expected_authority_epoch INTEGER NOT NULL CHECK (expected_authority_epoch >= 0)
resulting_authority_epoch INTEGER NOT NULL
actor_type               TEXT NOT NULL
actor_id                 TEXT DEFAULT NULL
source_transport         TEXT NOT NULL
trace_id                 TEXT DEFAULT NULL
turn_id                  TEXT DEFAULT NULL
request_hash             TEXT NOT NULL
created_at               TEXT NOT NULL
FOREIGN KEY project_id → project_authority(project_id)
```
- `resulting_authority_epoch` must equal the expected epoch or advance it by
  exactly one.
- `(project_id, idempotency_key)` and `(project_id, resulting_revision)` are
  unique. The composite operation/project/result revision/result epoch key binds
  emitted events to the exact recorded operation result.
- Index: `idx_workflow_operations_created` (project_id, created_at, operation_id)

#### `workflow_domain_events`
```
event_id          TEXT PRIMARY KEY
operation_id      TEXT NOT NULL
event_index       INTEGER NOT NULL DEFAULT 0 CHECK (event_index >= 0)
project_id        TEXT NOT NULL
project_revision  INTEGER NOT NULL CHECK (project_revision > 0)
authority_epoch   INTEGER NOT NULL CHECK (authority_epoch >= 0)
event_type        TEXT NOT NULL
entity_type       TEXT NOT NULL
entity_id         TEXT NOT NULL
caused_by_event_id TEXT DEFAULT NULL
payload_json      TEXT NOT NULL DEFAULT '{}'
created_at        TEXT NOT NULL
```
- `(operation_id, event_index)` is unique.
- The composite foreign key to `workflow_operations` requires every event's
  project revision and Authority Epoch to match its operation result exactly;
  `caused_by_event_id` may link to another domain event.
- Update and delete triggers abort with `workflow domain events are immutable`.
- Index: `idx_workflow_domain_events_entity`
  (project_id, entity_type, entity_id, project_revision, event_index)

#### `workflow_outbox`
```
outbox_id        INTEGER PRIMARY KEY AUTOINCREMENT
event_id         TEXT NOT NULL
destination      TEXT NOT NULL
available_at     TEXT NOT NULL DEFAULT ''
attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
claimed_by       TEXT DEFAULT NULL
claim_expires_at TEXT DEFAULT NULL
delivered_at     TEXT DEFAULT NULL
last_error       TEXT DEFAULT NULL
FOREIGN KEY event_id → workflow_domain_events(event_id)
```
- `(event_id, destination)` is unique.
- Index: `idx_workflow_outbox_pending` (delivered_at, available_at, outbox_id)

These four tables are deliberately distinct from existing narrower concepts:
`audit_events` remains optional operational telemetry,
`milestone_commit_attributions` remains Git-specific attribution, and
`command_queue`/`runtime_kv` remain coordination/cache surfaces rather than
operation provenance, domain history, or an outbox.

---

### 3f. Additive Lifecycle Foundation (V32)

V32 creates these tables on fresh databases and transactionally upgrades V31
databases. Like V31, it is schema-only: the existing hierarchy statuses and
coordination ledgers retain their runtime meaning, and no backfill, dual-write,
Markdown inference, lifecycle API, or runtime cutover ships with this migration.

#### `workflow_item_lifecycles`
```
lifecycle_id          TEXT PRIMARY KEY
project_id            TEXT NOT NULL
item_kind             TEXT NOT NULL    ← 'milestone' | 'slice' | 'task'
milestone_id          TEXT NOT NULL
slice_id              TEXT DEFAULT NULL
task_id               TEXT DEFAULT NULL
lifecycle_status      TEXT NOT NULL    ← 'pending' | 'ready' | 'in_progress' |
                                         'paused' | 'completed' | 'cancelled'
state_version         INTEGER NOT NULL DEFAULT 0
created_at            TEXT NOT NULL
updated_at            TEXT NOT NULL
last_operation_id     TEXT NOT NULL
last_project_revision INTEGER NOT NULL
last_authority_epoch  INTEGER NOT NULL
```
- Partial unique indexes enforce one lifecycle per fully scoped milestone,
  slice, or task identity. Kind-specific checks require exactly the applicable
  identity columns.
- Updates preserve identity, increment `state_version` by one, and permit only
  `pending → ready|cancelled`, `ready → in_progress|paused|cancelled`,
  `in_progress → paused|completed|cancelled`, `paused → ready|in_progress|cancelled`,
  or `completed|cancelled → ready`. Operation/revision/Authority Epoch
  provenance must advance; deletes are rejected as durable-history loss.
- Indexes: `idx_workflow_lifecycle_milestone`,
  `idx_workflow_lifecycle_slice`, and `idx_workflow_lifecycle_task`.

#### `workflow_execution_attempts`
```
attempt_id                TEXT PRIMARY KEY
project_id                TEXT NOT NULL
lifecycle_id              TEXT NOT NULL
attempt_number            INTEGER NOT NULL
retry_of_attempt_id       TEXT DEFAULT NULL
attempt_state             TEXT NOT NULL    ← 'claimed' | 'running' | 'settled'
coordination_dispatch_id  INTEGER DEFAULT NULL UNIQUE
worker_id                 TEXT DEFAULT NULL
milestone_lease_token     INTEGER DEFAULT NULL
claimed_at                TEXT NOT NULL
started_at                TEXT DEFAULT NULL
ended_at                  TEXT DEFAULT NULL
claim_operation_id        TEXT NOT NULL
claim_project_revision    INTEGER NOT NULL
claim_authority_epoch     INTEGER NOT NULL
settle_operation_id       TEXT DEFAULT NULL
settle_project_revision   INTEGER DEFAULT NULL
settle_authority_epoch    INTEGER DEFAULT NULL
```
- `(lifecycle_id, attempt_number)` is unique, attempt numbers are contiguous,
  and every retry points to the immediately preceding Attempt for that
  lifecycle. A partial unique index permits only one `claimed` or `running`
  Attempt per lifecycle.
- Worker-bound inserts and transitions require the current unexpired held
  milestone lease. Dispatch attribution must match the lifecycle's complete
  milestone/slice/task scope, worker, fencing token, and active dispatch state.
- Only `claimed → running|settled` and `running → settled` are valid.
  Claim identity and timestamps are preserved, settlement provenance must
  advance causally, and settled Attempts and all deletes are immutable.
- Index: `idx_workflow_attempt_active` (lifecycle_id), limited to `claimed` and
  `running` rows.

#### `workflow_attempt_results`
```
result_id         TEXT PRIMARY KEY
project_id        TEXT NOT NULL
lifecycle_id      TEXT NOT NULL
attempt_id        TEXT NOT NULL UNIQUE
outcome           TEXT NOT NULL    ← 'succeeded' | 'failed' | 'interrupted'
failure_class     TEXT NOT NULL DEFAULT 'none'
summary           TEXT NOT NULL DEFAULT ''
output_json       TEXT NOT NULL DEFAULT '{}'
created_at        TEXT NOT NULL
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
```
- Exactly one Result may exist per Attempt, and only after that Attempt is
  settled. Its operation, revision, and Authority Epoch must exactly match the
  Attempt's settlement provenance.
- Updates and deletes are rejected. Result outcome does not mutate lifecycle
  status or requirement disposition.

#### `workflow_blockers`
```
blocker_id               TEXT PRIMARY KEY
project_id               TEXT NOT NULL
lifecycle_id             TEXT NOT NULL
blocker_kind             TEXT NOT NULL    ← 'missing_authority' | 'missing_access' |
                                              'external_dependency' | 'consent' |
                                              'ambiguous_intent' | 'subjective_uat' |
                                              'user_limit'
resolution_owner         TEXT NOT NULL    ← 'user' | 'external'
blocker_status           TEXT NOT NULL    ← 'open' | 'resolved' | 'dismissed'
description              TEXT NOT NULL
requested_action         TEXT NOT NULL DEFAULT ''
resolution               TEXT NOT NULL DEFAULT ''
opened_at                TEXT NOT NULL
resolved_at              TEXT DEFAULT NULL
opened_operation_id      TEXT NOT NULL
opened_project_revision  INTEGER NOT NULL
opened_authority_epoch   INTEGER NOT NULL
resolved_operation_id    TEXT DEFAULT NULL
resolved_project_revision INTEGER DEFAULT NULL
resolved_authority_epoch INTEGER DEFAULT NULL
```
- Blockers represent only user- or external-owned impediments and remain
  separate from lifecycle and execution outcomes.
- Opening facts are immutable. An open Blocker may become `resolved` or
  `dismissed` with causally newer operation provenance; terminal records and
  deletes are immutable.

#### `workflow_waivers`
```
waiver_id              TEXT PRIMARY KEY
project_id             TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
requirement_id         TEXT DEFAULT NULL
blocker_id             TEXT DEFAULT NULL
waiver_status          TEXT NOT NULL    ← 'active' | 'revoked' | 'expired'
scope                  TEXT NOT NULL
rationale              TEXT NOT NULL
granted_by_actor_type  TEXT NOT NULL    ← 'user' | 'policy'
granted_by_actor_id    TEXT DEFAULT NULL
granted_at             TEXT NOT NULL
expires_at             TEXT DEFAULT NULL
ended_at               TEXT DEFAULT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
ended_operation_id     TEXT DEFAULT NULL
ended_project_revision INTEGER DEFAULT NULL
ended_authority_epoch  INTEGER DEFAULT NULL
```
- User grants require an actor ID. At most one active Waiver may reference a
  Blocker, and requirement/blocker references must resolve to canonical rows.
- Grant facts are immutable. An active Waiver may become `revoked` or
  `expired` with causally newer provenance; terminal records and deletes are
  immutable. A Waiver cannot terminate while it still authorizes the current
  waived disposition.
- Index: `idx_workflow_waiver_active_blocker` (blocker_id), limited to active
  rows with a Blocker.

#### `workflow_requirement_dispositions`
```
disposition_id             TEXT PRIMARY KEY
project_id                 TEXT NOT NULL
requirement_id             TEXT NOT NULL
disposition                TEXT NOT NULL    ← 'unsatisfied' | 'satisfied' | 'waived'
waiver_id                  TEXT DEFAULT NULL
supersedes_disposition_id  TEXT DEFAULT NULL UNIQUE
rationale                  TEXT NOT NULL
created_at                 TEXT NOT NULL
operation_id               TEXT NOT NULL
project_revision           INTEGER NOT NULL
authority_epoch            INTEGER NOT NULL
```
- Rows form an immutable, single-head history per requirement. Every successor
  must supersede the current head with causally newer revision/Authority Epoch
  provenance.
- Only `waived` rows carry a Waiver. That Waiver must belong to the same
  project and requirement, be active and unexpired, and precede the disposition
  revision. Updates and deletes are rejected.
- Index: `idx_workflow_requirement_disposition_history`
  (requirement_id, project_revision, disposition_id)

Every V32 table is linked to the V31 authority root and exact
`workflow_operations` provenance. The separation of lifecycle, execution
history, Results, Blockers, Waivers, and requirement truth prevents one concept
from silently fabricating another.

---

### 3g. Additive Guided-Conversation Foundation (V33)

V33 transactionally adds durable conversation facts without backfilling or
changing runtime routing. Prompts, Markdown, process caches, and legacy
decision rows retain their current behavior until the later cutover slice.

| Table | Durable responsibility |
|---|---|
| `workflow_milestone_contexts` | Append-only Milestone Kind and advisory planning-horizon history. Kinds are `discovery`, `research`, `requirements`, `roadmap`, `delivery`, or `remediation`; reforecasts supersede the current head without changing readiness or lifecycle state. |
| `workflow_open_questions` | Focused question identity and its explicit `open` → `answered|withdrawn` lifecycle. Answered transitions require the accepted Answer from the same operation. |
| `workflow_question_dependencies` | The exact lifecycle scope a question may inform or cause to be revalidated. |
| `workflow_interactions` | Presented conversational turns. Interaction Kinds are `open`, `choice`, `clarification`, `recap`, `consent`, and `subjective-uat`; every answer-requiring turn carries recommendation text and rationale. |
| `workflow_interaction_options` | Up to three ordered options; `choice` Interactions require two or three. Presentation is rejected unless the declared recommendation belongs to the Interaction and is ordinal one. |
| `workflow_answers` | Immutable verbatim user language stored separately from normalized interpretation. Response Kinds are `answer`, `pushback`, `correction`, `clarification`, and `consent`. Only one Answer per Interaction may be accepted; conflicting revisions remain append-only facts. |
| `workflow_conversation_decisions` | Immutable Decisions derived from accepted Answers. Corrections form a causally advancing, single-head supersession chain. |
| `workflow_decision_impacts` | Immutable, dependency-reachable `inform`, `revalidate`, or `invalidate` effects. Inform-only dependencies reject revalidation and invalidation; unrelated work is always rejected. |
| `workflow_work_checkpoints` | Restart-safe, append-only conversation/work summaries with one ordered head per scope. Kinds cover `discovery`, `research`, `requirements`, `roadmap`, `delivery`, `answer`, `pause`, `correction`, `recap`, and `handoff`. Narrative fields are resumability aids; canonical Answer and Decision heads remain the machine truth. |

#### `workflow_milestone_contexts`
```
context_id             TEXT PRIMARY KEY
project_id             TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
milestone_id           TEXT NOT NULL
milestone_kind         TEXT NOT NULL
planned_start_at       TEXT DEFAULT NULL
planned_end_at         TEXT DEFAULT NULL
review_at              TEXT DEFAULT NULL
horizon_note           TEXT NOT NULL DEFAULT ''
supersedes_context_id  TEXT DEFAULT NULL UNIQUE
created_at             TEXT NOT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
```
- The lifecycle must identify the same milestone. Each later context supersedes
  the current head with causally newer provenance; updates and deletes fail.

#### `workflow_open_questions`
```
question_id                 TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
lifecycle_id                TEXT NOT NULL
question_text               TEXT NOT NULL
question_status             TEXT NOT NULL    ← 'open' | 'answered' | 'withdrawn'
state_version               INTEGER NOT NULL DEFAULT 0
accepted_answer_id          TEXT DEFAULT NULL
created_at / updated_at     TEXT NOT NULL
created_operation_id        TEXT NOT NULL
created_project_revision    INTEGER NOT NULL
created_authority_epoch     INTEGER NOT NULL
last_operation_id           TEXT NOT NULL
last_project_revision       INTEGER NOT NULL
last_authority_epoch        INTEGER NOT NULL
```
- Questions begin open at version zero. The only transition is from `open` to
  `answered` or `withdrawn`, with a one-step version increment and newer causal
  provenance. Answering requires an accepted Answer created by that same final
  operation; withdrawal carries no Answer. Deletes fail.

#### `workflow_question_dependencies`
```
question_id       TEXT NOT NULL
lifecycle_id      TEXT NOT NULL
project_id        TEXT NOT NULL
dependency_kind   TEXT NOT NULL DEFAULT 'revalidate' ← 'inform' | 'revalidate'
created_at        TEXT NOT NULL
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
PRIMARY KEY (question_id, lifecycle_id)
```
- Dependencies are immutable and bound to an existing Question, lifecycle,
  Domain Operation, revision, and Authority Epoch.

#### `workflow_interactions`
```
interaction_id              TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
question_id                 TEXT NOT NULL
sequence                    INTEGER NOT NULL
interaction_kind            TEXT NOT NULL
presentation_state          TEXT NOT NULL    ← 'prepared' | 'presented'
focused_prompt              TEXT NOT NULL
requires_answer             INTEGER NOT NULL
option_count                INTEGER NOT NULL DEFAULT 0
recommended_option_id       TEXT DEFAULT NULL
recommendation_text         TEXT NOT NULL DEFAULT ''
recommendation_rationale    TEXT NOT NULL DEFAULT ''
recommendation_evidence     TEXT NOT NULL DEFAULT ''
recommendation_confidence   REAL DEFAULT NULL
recommendation_uncertainty  TEXT NOT NULL DEFAULT ''
revisit_condition           TEXT NOT NULL DEFAULT ''
presented_at                TEXT NOT NULL DEFAULT ''
operation_id                TEXT NOT NULL
project_revision            INTEGER NOT NULL
authority_epoch             INTEGER NOT NULL
```
- Interactions begin `prepared`. The only update presents the immutable turn
  after validating its exact option count and ordinal-one recommendation.
  `choice` requires two or three options. Every Kind except `recap` requires an
  Answer and non-empty recommendation text and rationale.

#### `workflow_interaction_options`
```
interaction_id    TEXT NOT NULL
option_id         TEXT NOT NULL
project_id        TEXT NOT NULL
ordinal           INTEGER NOT NULL    ← 1..3
label             TEXT NOT NULL
description       TEXT NOT NULL DEFAULT ''
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
PRIMARY KEY (interaction_id, option_id)
```
- Options may be added only while the Interaction is prepared. Ordinals are
  unique within an Interaction; updates and deletes fail.

#### `workflow_answers`
```
answer_id                  TEXT PRIMARY KEY
project_id                 TEXT NOT NULL
question_id                TEXT NOT NULL
interaction_id             TEXT NOT NULL
response_kind              TEXT NOT NULL
verbatim_response          TEXT NOT NULL
selected_option_id         TEXT DEFAULT NULL
normalized_interpretation  TEXT NOT NULL
interpretation_confidence  REAL NOT NULL    ← 0..1
answer_disposition         TEXT NOT NULL    ← 'accepted' | 'revision-conflict'
observed_project_revision  INTEGER NOT NULL
created_at                 TEXT NOT NULL
operation_id               TEXT NOT NULL
project_revision           INTEGER NOT NULL
authority_epoch            INTEGER NOT NULL
```
- An accepted Answer must target a presented Interaction at the observed
  revision; recaps accept only corrections. The resulting revision must advance
  beyond the observed revision. The optional selected option must belong to the
  Interaction. Updates and deletes fail.
- Unique partial index: `idx_workflow_answer_accepted` permits one accepted
  Answer per Interaction.

#### `workflow_conversation_decisions`
```
decision_id             TEXT PRIMARY KEY
project_id              TEXT NOT NULL
question_id             TEXT NOT NULL
answer_id               TEXT NOT NULL
decision_text           TEXT NOT NULL
supersedes_decision_id  TEXT DEFAULT NULL UNIQUE
created_at              TEXT NOT NULL
operation_id            TEXT NOT NULL
project_revision        INTEGER NOT NULL
authority_epoch         INTEGER NOT NULL
```
- A Decision requires an accepted Answer from the same operation. A successor
  must derive from a correction Answer and supersede the causally older current
  head for that Question. Updates and deletes fail.

#### `workflow_decision_impacts`
```
decision_id       TEXT NOT NULL
lifecycle_id      TEXT NOT NULL
project_id        TEXT NOT NULL
effect            TEXT NOT NULL    ← 'revalidate' | 'invalidate' | 'inform'
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
PRIMARY KEY (decision_id, lifecycle_id)
```
- The target lifecycle must be a declared dependency of the Decision's
  Question. `inform` works with either dependency Kind; `revalidate` and
  `invalidate` require a `revalidate` dependency. Updates and deletes fail.
- Index: `idx_workflow_decision_impacts_lifecycle` (lifecycle_id, effect)

#### `workflow_work_checkpoints`
```
checkpoint_id          TEXT PRIMARY KEY
project_id             TEXT NOT NULL
scope_key              TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
checkpoint_kind        TEXT NOT NULL
sequence               INTEGER NOT NULL
previous_checkpoint_id TEXT DEFAULT NULL UNIQUE
confirmed_context      TEXT NOT NULL DEFAULT ''
unresolved_summary     TEXT NOT NULL DEFAULT ''
evidence_summary       TEXT NOT NULL DEFAULT ''
suggested_next_action  TEXT NOT NULL DEFAULT ''
created_at             TEXT NOT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
```
- A scope begins at sequence one. Each later checkpoint extends the current
  head for the same project, scope, and lifecycle with the next sequence and
  causally newer provenance. Updates and deletes fail.
- Index: `idx_workflow_checkpoints_scope` (project_id, scope_key, sequence)

Index `idx_workflow_questions_open` supports open-Question lookup by project,
lifecycle, and status.

All nine tables bind to the exact V31 Domain Operation, project revision, and
Authority Epoch that created the fact. Identity and historical content are
immutable; only the Open Question close and Interaction presentation
transitions update existing rows. Planning dates remain advisory data and have
no triggers into Blockers, Attempts, readiness, or lifecycle status.
V33 validates each relational fact but does not yet promise an atomic
multi-table conversation bundle; S06 Domain Operations add that commit boundary
before runtime cutover.

---

## 4. Entity Relationship Diagram

```
milestones ──┐
  │ id        │ (depends_on → milestones.id, via JSON)
  │           │
  ▼           │
slices ───────┘
  │ (milestone_id, id) PRIMARY KEY
  │
  ├──► slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
  │
  ▼
tasks
  │ (milestone_id, slice_id, id) PRIMARY KEY
  │
  ├──► verification_evidence (milestone_id, slice_id, task_id)
  ├──► quality_gates (milestone_id, slice_id, gate_id, task_id)
  └──► unit_dispatches.task_id (via coordination layer)

milestones ──► replan_history (milestone_id)
milestones ──► assessments (milestone_id)
milestones ──► milestone_leases (milestone_id) ◄── workers
milestones ──► unit_dispatches (milestone_id) ◄── workers
milestones ──► milestone_commit_attributions (milestone_id)

memories ──► memories_fts (FTS5 virtual, via triggers)
memories ──► memory_embeddings (memory_id)
memories ──► memory_relations (from_id, to_id)
memory_sources ──► (imported content, feeds memories)

unit_dispatches ──► cancellation_requests (dispatch_id)
unit_dispatches ──► verification_evidence (verification_evidence_id)

decisions  (independent, supersedable)
requirements  (independent, supersedable)
artifacts  (independent, keyed by path)
gate_runs  (audit, keyed by trace_id + turn_id + gate_id)
turn_git_transactions  (audit, keyed by trace_id + turn_id + stage)
audit_events  (append-only audit log)
audit_turn_index  (turn-level index into audit_events)
runtime_kv  (soft state KV)

project_authority ──► workflow_operations (project_id)
workflow_operations ──► workflow_domain_events
  (operation_id + project_id + resulting revision + resulting Authority Epoch)
workflow_domain_events ──► workflow_domain_events (caused_by_event_id)
workflow_domain_events ──► workflow_outbox (event_id)

milestones/slices/tasks ──► workflow_item_lifecycles
workflow_item_lifecycles ──► workflow_execution_attempts
workflow_execution_attempts ──► workflow_attempt_results
workflow_item_lifecycles ──► workflow_blockers
workflow_item_lifecycles ──► workflow_waivers
requirements ──► workflow_waivers
requirements ──► workflow_requirement_dispositions
workflow_waivers ──► workflow_requirement_dispositions
workflow_blockers ──► workflow_waivers

workflow_item_lifecycles ──► workflow_milestone_contexts
workflow_item_lifecycles ──► workflow_open_questions
workflow_open_questions ──► workflow_question_dependencies ──► workflow_item_lifecycles
workflow_open_questions ──► workflow_interactions ──► workflow_interaction_options
workflow_interactions ──► workflow_answers ──► workflow_conversation_decisions
workflow_conversation_decisions ──► workflow_decision_impacts ──► workflow_item_lifecycles
workflow_item_lifecycles ──► workflow_work_checkpoints

workflow_operations ──► all V32 lifecycle records
  (operation + project + revision + Authority Epoch provenance)
workflow_operations ──► all V33 guided-conversation records
  (operation + project + revision + Authority Epoch provenance)
```

---

## 4b. Recovery And Worktree Merge Surfaces

`.gsd/state-manifest.json` snapshots DB-backed correctness state: requirements,
artifacts, milestones, slices, tasks, decisions, replan history, assessments,
quality gates, verification evidence, and milestone commit attributions. Restore
rebuilds decision mirror memories from the restored decisions and preserves
optional rows when reading older manifests that predate the extended arrays.
The additive V31 canonical-foundation, V32 lifecycle-foundation, and V33
guided-conversation tables are
not yet part of this legacy manifest surface because runtime reads/writes have
not cut over to them.

`reconcileWorktreeDb` merges hidden-worktree correctness rows back into the main
DB, including hierarchy, requirements, artifacts, memories, replan history,
assessments, quality gates, slice dependencies, verification evidence, gate
runs, and milestone commit attributions. Runtime-only/audit substrates such as
`runtime_kv`, `turn_git_transactions`, `audit_events`, and `audit_turn_index`
remain outside manifest restore. The V31 canonical-foundation, V32
lifecycle-foundation, and V33 guided-conversation tables likewise remain outside worktree reconciliation
until a later runtime-routing slice.

---

## 5. Complete gsd_* Tool → Table Map

| Tool | Tables READ | Tables WRITTEN | Disk Artifacts |
|------|------------|----------------|----------------|
| `gsd_decision_save` | memories | memories (`category = "architecture"`) | DECISIONS.md (projection) |
| `gsd_requirement_save` | requirements | requirements | REQUIREMENTS.md |
| `gsd_requirement_update` | requirements | requirements | REQUIREMENTS.md |
| `gsd_summary_save` | milestones, slices, tasks | artifacts | M##/S##/T## artifact files |
| `gsd_milestone_generate_id` | milestones | milestones (INSERT OR IGNORE, queued) | — |
| `gsd_plan_milestone` | milestones, slices | milestones, slices | ROADMAP.md |
| `gsd_plan_slice` | milestones, slices, tasks | slices metadata; tasks only when a non-empty `tasks` payload performs full replacement/update | NN-MM-PLAN.md with embedded task planning when tasks exist |
| `gsd_plan_task` | slices, tasks | one task planning row, task gate seeds | re-renders NN-MM-PLAN.md; task PLAN paths resolve to the slice plan |
| `gsd_task_complete` | tasks, slices, rework_briefs, rework_brief_findings | tasks, verification_evidence, rework_brief_findings | S##-T##-SUMMARY.md; toggles checkbox in NN-MM-PLAN.md; reads legacy T##-SUMMARY.md |
| `gsd_slice_complete` | tasks, slices | slices, tasks (cascade skipped) | S##-SUMMARY.md, S##-UAT.md; toggles checkpoint in ROADMAP.md |
| `gsd_uat_result_save` | slices, artifacts | artifacts, assessments, quality_gates, gate_runs | S##-ASSESSMENT.md; UAT attempt JSON |
| `gsd_complete_milestone` | milestones, slices, tasks | milestones | M##-SUMMARY.md |
| `gsd_validate_milestone` | milestones, slices, tasks | assessments, quality_gates, gate_runs | VALIDATION.md |
| `gsd_reassess_roadmap` | milestones, slices | milestones, slices, assessments | ROADMAP.md, ASSESSMENT.md |
| `gsd_replan_slice` | slices, tasks | slices, tasks, replan_history, quality_gates | NN-MM-PLAN.md, NN-MM-REPLAN.md |
| `gsd_replan_task` | slices, tasks | one pending task planning row, replan_history | re-renders the task/slice PLAN projection |
| `gsd_rework_brief_save` | rework_briefs, rework_brief_findings | rework_briefs, rework_brief_findings | — |
| `gsd_skip_slice` | slices, tasks | slices, tasks | STATE.md (via rebuildState) |
| `gsd_task_reopen` | tasks, slices, milestones | tasks | deletes S##-T##-SUMMARY.md and legacy T##-SUMMARY.md |
| `gsd_slice_reopen` | slices, tasks, milestones | slices, tasks | deletes S##-SUMMARY.md, UAT, all S##-T##-SUMMARY.md and legacy T##-SUMMARY.md |
| `gsd_milestone_reopen` | milestones, slices, tasks | milestones, slices, tasks | deletes all summaries |
| `gsd_save_gate_result` | quality_gates | quality_gates, gate_runs (same transaction) | — |
| `capture_thought` | memories | memories | KNOWLEDGE.md projection for Patterns/Lessons (both backfilled and newly captured) |
| `memory_query` | memories, memories_fts, memory_embeddings | memories (hit_count++) | — |

`gsd_replan_task` updates exactly one existing pending task after rework. MCP callers may omit `projectDir`; the server defaults it to the current project/worktree root. Required fields are `milestoneId`, `sliceId`, `taskId`, `title`, `description`, `estimate`, `files`, `verify`, `inputs`, and `expectedOutput`; `reworkBriefRef` is optional and records the structured brief that triggered the replan. The handler rejects missing tasks and closed/completed tasks; completed tasks must be reopened with `gsd_task_reopen` before replanning.

`gsd_rework_brief_save` persists structured findings for a task. MCP callers may omit `projectDir`; the server defaults it to the current project/worktree root. Required fields are `milestoneId`, `sliceId`, `taskId`, and non-empty `findings`. Each finding requires `findingId`, `severity` (`blocking` or `advisory`), `description`, `requiredFix`, and `verificationCommands`; optional fields are `status`, `evidence`, and `decisionRef`.

`gsd_task_complete` treats the task summary and slice plan projection as closeout-critical. In flat-phase layout it writes `S##-T##-SUMMARY.md` at the phase root so duplicate task IDs in different slices cannot collide; readers still accept legacy flat `T##-SUMMARY.md` summaries. If writing the task summary or re-rendering `NN-MM-PLAN.md` fails, the tool returns an error after deleting the task's verification evidence and reverting its task row to `pending`; it does not leave a committed `complete` task with a stale plan projection. It also rejects completion when the task has pending blocking rework findings. To complete such a task, the caller must include `reworkResolution` entries with `findingId`, `status: "resolved"`, and non-empty `evidence`, or `status: "deferred-with-override"` with non-empty `evidence` and a `decisionRef`.

---

## 6. DB State → Dispatch Rule Mapping

`auto-dispatch.ts` reads DB state to decide which prompt to run. Here's exactly which tables each dispatch rule queries:

| Dispatch Rule | Tables Queried | Condition |
|--------------|----------------|-----------|
| `workflow-preferences` | — | PREFERENCES.md file missing |
| `discuss-project` | artifacts | PROJECT artifact absent |
| `discuss-requirements` | artifacts | REQUIREMENTS artifact absent |
| `research-decision` | runtime_kv | research-decision key absent/unresolved |
| `research-project` | artifacts, milestones | deep mode ON + RESEARCH absent |
| `discuss-milestone` | milestones, artifacts | active milestone + CONTEXT absent |
| `research-milestone` | milestones, artifacts | CONTEXT present + RESEARCH absent (if needed) |
| `plan-milestone` | milestones, slices | CONTEXT present + no slices exist |
| `parallel-research-slices` | slices, artifacts | slices exist + RESEARCH artifacts missing |
| `guided-discuss-slice` | slices, artifacts | slice CONTEXT absent |
| `plan-slice` | slices, tasks | CONTEXT present + no tasks |
| `refine-slice` | slices | `is_sketch = 1` |
| `reactive-execute` | tasks | ≥ 3 tasks WHERE status = 'pending' |
| `execute-task` | tasks | 1–2 tasks WHERE status = 'pending' |
| `gate-evaluate` | quality_gates | status = 'pending' |
| `run-uat` | slices, assessments | tasks all done + UAT absent |
| `complete-slice` | tasks, slices | all tasks complete + slice status ≠ 'complete' |
| `reassess-roadmap` | slices, milestones | slice just completed + roadmap needs update |
| `validate-milestone` | slices, milestones, assessments | all slices complete + VALIDATION absent |
| `complete-milestone` | milestones, assessments | VALIDATION present + milestone status ≠ 'closed' |

---

## 7. Write Path Invariants

1. **Single-writer rule**: all write SQL lives in the explicit single-writer *layer* — `db/engine.ts` for schema, migrations, lifecycle, and transaction primitives; `db/writers/**` for domain write subsystems; `gsd-db.ts` as the compatibility barrel and remaining mid-migration wrappers; the typed coordination/runtime writer modules `db/milestone-leases.ts`, `db/unit-dispatches.ts`, `db/auto-workers.ts`, `db/runtime-kv.ts`, and `db/command-queue.ts`; the schema/migration helpers `db-canonical-foundation-schema.ts`, `db-lifecycle-foundation-schema.ts`, `db-conversation-foundation-schema.ts`, `db-memory-fts-schema.ts`, `db-schema-metadata.ts`, and `db-verification-evidence-schema.ts`; and the ADR migration/backfill helper `memory-backfill.ts`. This is an allowlist, not permission for arbitrary raw writes under `db/`. `unit-ownership.ts` remains excluded because it owns a separate `.gsd/unit-claims.db`. `db/queries.ts` is the read-only Query Module and must contain no write SQL. No raw write SQL escapes to the adapter from anywhere else. Enforced by the structural `single-writer-invariant.test.ts`, which checks this allowlist.

2. **Transaction wrapping**: every multi-table write uses `transaction()` or `immediateTransaction()` when it needs SQLite's reserved writer lock up front. Rollback on any error. Re-entrant: nested calls increment the shared depth counter; no nested `BEGIN`. `gsd_save_gate_result` commits the `quality_gates` verdict update and matching `gate_runs` ledger insert together, so recovery never sees a completed gate without its audit row.

3. **Cascade semantics**: hierarchy status cascades are named **Domain Write Operations** in `db/writers/cascades.ts`, each owning its own `transaction()` so the milestone/slice/task subtree transitions atomically (callers keep only projection/file-cleanup/event logic):
   - `gsd_slice_complete` (`completeSliceCascade`) cascades `pending` tasks → `skipped`
   - `gsd_skip_slice` (`skipSliceCascade`) rejects closed slices (`complete`/`done`/`closed`) without clearing `completed_at`, re-skips `skipped` slices as a no-op, cascades `pending`/`active` tasks → `skipped`, and preserves closed tasks
   - `gsd_milestone_reopen` (`reopenMilestoneCascade`) cascades all slices → `in_progress`, all tasks → `pending`
   - `gsd_slice_reopen` (`reopenSliceCascade`) and `undo`'s reset (`resetSliceCascade`) reopen a slice's subtree atomically

4. **Conflict guards**: `insertSlice`, `insertTask` use `ON CONFLICT` to preserve existing completed status and non-empty fields. `insertTask` treats `complete`/`done`/`closed` as complete for `completed_at` stamping and preserves existing completion metadata when `preserveCompletionMetadata` is set; `skipped` stays terminal but does not get a completion timestamp.

5. **FTS fallback**: if FTS5 unavailable, `memory_query` falls back to LIKE scan on `memories.content`.

6. **Workspace isolation**: same `.gsd/gsd.db` for all worktrees of one project; separate `.gsd/gsd.db` per project root. Coordination tables assume single-host shared WAL. Multi-host needs external coordinator.

7. **Pre-migration backup**: file-backed migrations checkpoint WAL before replacing `.gsd/gsd.db.backup-vN` with the database being migrated. GSD attaches the copy, requires the expected schema version and a successful SQLite `quick_check`, then detaches it. Checkpoint, copy, or validation failures warn and propagate before any migration DDL runs.
