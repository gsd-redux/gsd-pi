<!-- Project/App: gsd-pi -->
<!-- File Purpose: Primary-source design for the deterministic M003/S07/T07 cutover dossier. -->

# M003/S07/T07 deterministic cutover dossier research

> **Status:** Historical design snapshot from before exact source-revision
> propagation landed. Current behavior is owned by
> [Architecture Overview](architecture.md#semantic-shadow-evidence-and-cutover-boundary),
> the [lifecycle integration runbook](lifecycle-command-integration-runbook.md#s07-semantic-shadow-dossier),
> and the generated [cutover dossier](m003-s07-cutover-dossier.json).

## Outcome

T07 should publish a deterministic **NO-GO** dossier from two distinct evidence
planes and must never imply that ephemeral test output is canonical history:

1. the project database supplies immutable S07 Task receipts, the 33 historical
   `lifecycle.shadow.repair` operations, current M003 drift, and the final
   source-bound T07 verdict/evidence receipt; and
2. a fresh capstone canonical-schema database supplies the 12 production
   mode/transport observations, five classifications per cell, and isolated
   disposition/loss proofs. The capstone emits normalized machine evidence;
   `gsd_uat_exec` and the T07 Technical Verdict persist its durable output
   reference, exact source revision, and dossier hash in the project database.

The live project database currently contains 1,493 audit events but **zero**
`lifecycle-shadow-observed` or `lifecycle-shadow-observation-loss` events. T05's
observations were intentionally created in temporary fixture databases and then
deleted. The dossier therefore cannot query the live `audit_events` table and
claim that it contains the 12-cell proof. T07 must rerun and persist fresh
capstone evidence, then bind that evidence to the canonical T07 verdict.

No GitHub label, tag, review state, mergeability field, PR payload, or hosted
metadata is an input. A local source snapshot and local Git commit may be
reported as evidence, but direct maintainer instruction and the database remain
authority ([D001, D004, D005](../../.gsd/DECISIONS.md),
[the frozen S07 contract](M003-S07-SEMANTIC-SHADOW-RESEARCH.md)).

## Primary-source findings

### The observation matrix is 12 envelopes and 60 item rows

The production matrix owns six modes and two transports. Each cell persists one
`lifecycle-shadow-observed` envelope containing exactly five items, one for each
frozen classification
([semantic-shadow-mode-matrix.test.ts](../../src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts),
[lifecycle-shadow-observation.ts](../../src/resources/extensions/gsd/lifecycle-shadow-observation.ts)).

The exact expected cardinalities are:

| Dimension | Expected |
| --- | ---: |
| Modes | 6 |
| Transports | 2 |
| Mode/transport cells | 12 |
| Observation envelopes | 12 |
| Items per envelope | 5 |
| Flattened classification rows | 60 |
| Rows for each mode | 10 |
| Rows for each transport | 30 |
| Rows for each classification | 12 |
| Rows for each mode/transport/classification tuple | 1 |
| Clean matrix `repairDisposition` | 12 `not_attempted` envelopes |
| Clean matrix loss | 0 |

Classification and disposition are not a Cartesian product. The 60 matrix
items prove semantic classification; their enclosing read has
`repairDisposition: "not_attempted"`. Repair/disposition behavior is a separate
proof plane. Multiplying the repair outcomes across the 60 observation rows
would manufacture evidence the product never emits.

The capstone disposition inventory should contain one independently exercised
case for each behavior that T05/T06 promise:

| Disposition proof | Required evidence |
| --- | --- |
| `advanced` | One committed legal ready-to-in-progress repair edge |
| `repaired` | One committed repair receipt and one exact replay of it |
| `unresolved` | One immutable unresolved receipt with no lifecycle mutation |
| `rejected` | One stable-evidence or changed-key rejection with an exact no-residue snapshot |
| `observation_loss` | One response-neutral fault whose terminal loss record is durably accounted |

These five capstone cases are expected once each; they are not added to or
renamed into the three stored repair payload dispositions (`advanced`,
`repaired`, `unresolved`).

### Historical repair counts are durable and already exact

The project database has 33 immutable T02 repair operations, revisions 138
through 170. Each owns exactly one event, one outbox destination, and one
Projection Work row. Their stored facts are:

| Event / payload disposition | Original comparison | Count |
| --- | --- | ---: |
| `lifecycle.shadow.advanced` / `advanced` | `status_mismatch` | 10 |
| `lifecycle.shadow.repaired` / `repaired` | `missing_shadow` | 11 |
| `lifecycle.shadow.repaired` / `repaired` | `status_mismatch` | 12 |
| **Total** |  | **33** |

Thus event counts are repaired=23 and advanced=10, while original comparison
counts are missing_shadow=11 and status_mismatch=22. These are historical M003
repair counts, not the capstone's five-class observation coverage. T02's writer
stores before/after state, exact comparison, evidence digest, and disposition in
the immutable domain event
([lifecycle-shadow-repair-domain-operation.ts](../../src/resources/extensions/gsd/lifecycle-shadow-repair-domain-operation.ts)).

### Historical gap: `sourceRevision: "unavailable"`

At this research stage, production observation attribution hard-coded
`sourceRevision: "unavailable"` in native Pi and Claude pump context creation
([query-tools.ts](../../src/resources/extensions/gsd/bootstrap/query-tools.ts),
[stream-adapter.ts](../../src/resources/extensions/claude-code-cli/stream-adapter.ts)).
T05 proved private context propagation, but it deliberately accepted the
unavailable value. T07 cannot call that exact-source evidence.

The narrow fix is to reuse
`captureMilestoneVerificationSourceRevision()` from
[verification-source-integrity.ts](../../src/resources/extensions/gsd/verification-source-integrity.ts).
It resolves the configured `project` repository target, hashes tracked and
untracked source while excluding `.gsd`, sorts repositories and paths, and
confirms a stable snapshot twice. Compute it once per native status invocation
and once when a Claude pump begins, then carry the resulting aggregate through
the existing private observation context/token. A source-capture failure must
remain response-neutral but set `sourceRevision: "unavailable"` plus context
loss; the dossier rejects that observation. Do not add source revision to the
public tool arguments or trust an environment-provided revision.

For capstone generation, capture the aggregate before the 12 cells, require all
12 observations to contain it, capture again afterward, and reject any change.
This uses the same exact `project` target that host verification uses. It avoids
the T05 error where a repository identity named `root` produced a valid hash for
the wrong target.

### The checked dossier and final merged verdict are necessarily two-phase

A checked-in JSON file cannot contain the hash/revision of a final source tree
that includes that same JSON file and then be regenerated to the same value.
Likewise, it cannot contain its own T07 completion receipt before that receipt
exists. Avoid a self-reference workaround.

The correct causal sequence is:

1. Generate and check the candidate JSON from T01-T06 canonical history plus a
   fresh exact-source capstone. Its `evidenceSourceRevision` names the source
   actually exercised and its `dossierHash` omits only the `dossierHash` field.
2. Commit the generated JSON and documentation, run the required local gates,
   and open/monitor the PR.
3. After merge, capture the exact merged `project` source aggregate and local
   merge commit, rerun the capstone through `gsd_uat_exec`, and record the T07
   passing Technical Verdict/Evidence in the canonical DB. Put the candidate
   `dossierHash`, normalized capstone hash, baseline result, local merge commit,
   and exact merged source aggregate in `environment_json`; point
   `durable_output_ref` at the `gsd_uat_exec` evidence.
4. Publish T07 only after a read-only query proves that current verdict/evidence
   head is a pass for that exact source. This DB-only publication receipt is the
   final exact-merged verdict; the checked candidate does not pretend to contain
   it.

The existing verification schema makes the second phase canonical:
`workflow_technical_verdicts.tested_source_revision` is joined to
`workflow_verification_evidence.source_revision`; evidence has a content hash,
durable output reference, observed project revision, and immutable operation
provenance
([task-verification-domain-operation.ts](../../src/resources/extensions/gsd/task-verification-domain-operation.ts),
[task-verification writer](../../src/resources/extensions/gsd/db/writers/task-verification.ts)).

## Exact canonical query sketches

All queries are read-only. Every dossier query must use one read transaction so
the authority head, operations, and receipts come from one SQLite snapshot.

### S07 Task receipt and current verification heads

This query deliberately keeps every Attempt visible (T05 has two), while
marking only the unsuperseded verdict head. Before T07 finalization it should
find T01-T06 completed, seven settled succeeded Attempts, and a current passing
head for the latest successful Attempt of each of those six Tasks. T07's final
exact-source row is checked after merge, not embedded in its own candidate.

```sql
SELECT lifecycle.task_id,
       lifecycle.lifecycle_status,
       attempt.attempt_number,
       attempt.attempt_id,
       attempt.attempt_state,
       result.outcome,
       verdict.verdict_id,
       verdict.verdict,
       verdict.tested_source_revision,
       evidence.evidence_id,
       evidence.observation,
       evidence.content_hash,
       evidence.durable_output_ref,
       evidence.environment_json,
       verdict.project_revision AS verdict_revision
FROM workflow_item_lifecycles lifecycle
LEFT JOIN workflow_execution_attempts attempt
  ON attempt.lifecycle_id = lifecycle.lifecycle_id
 AND attempt.project_id = lifecycle.project_id
LEFT JOIN workflow_attempt_results result
  ON result.attempt_id = attempt.attempt_id
 AND result.project_id = attempt.project_id
LEFT JOIN workflow_technical_verdicts verdict
  ON verdict.attempt_id = attempt.attempt_id
 AND verdict.project_id = attempt.project_id
 AND NOT EXISTS (
   SELECT 1 FROM workflow_technical_verdicts successor
   WHERE successor.supersedes_verdict_id = verdict.verdict_id
 )
LEFT JOIN workflow_verification_evidence evidence
  ON evidence.verdict_id = verdict.verdict_id
 AND evidence.attempt_id = attempt.attempt_id
 AND evidence.project_id = attempt.project_id
WHERE lifecycle.item_kind = 'task'
  AND lifecycle.milestone_id = 'M003'
  AND lifecycle.slice_id = 'S07'
ORDER BY lifecycle.task_id, attempt.attempt_number,
         verdict.project_revision, evidence.evidence_id;
```

Finalization additionally requires exactly one current T07 pass and binds it to
the candidate:

```sql
SELECT verdict.tested_source_revision, verdict.verdict,
       evidence.source_revision, evidence.observation,
       evidence.content_hash, evidence.durable_output_ref,
       json_extract(evidence.environment_json, '$.dossierHash') AS dossier_hash,
       json_extract(evidence.environment_json, '$.capstoneEvidenceHash') AS capstone_hash,
       json_extract(evidence.environment_json, '$.authorityBaseline') AS baseline,
       json_extract(evidence.environment_json, '$.localMergeCommit') AS merge_commit
FROM workflow_item_lifecycles lifecycle
JOIN workflow_execution_attempts attempt
  ON attempt.lifecycle_id = lifecycle.lifecycle_id
 AND attempt.project_id = lifecycle.project_id
JOIN workflow_technical_verdicts verdict
  ON verdict.attempt_id = attempt.attempt_id
 AND verdict.project_id = attempt.project_id
JOIN workflow_verification_evidence evidence
  ON evidence.verdict_id = verdict.verdict_id
 AND evidence.source_revision = verdict.tested_source_revision
WHERE lifecycle.milestone_id = 'M003'
  AND lifecycle.slice_id = 'S07'
  AND lifecycle.task_id = 'T07'
  AND verdict.verdict = 'pass'
  AND evidence.observation = 'passed'
  AND NOT EXISTS (
    SELECT 1 FROM workflow_technical_verdicts successor
    WHERE successor.supersedes_verdict_id = verdict.verdict_id
  )
ORDER BY attempt.attempt_number DESC, verdict.project_revision DESC;
```

Fail unless this returns exactly one row and both source revision columns equal
the exact post-merge aggregate. `dossier_hash` and `capstone_hash` must be
lowercase `sha256:` values and must equal the recomputed candidate/capstone
hashes. `baseline` must equal `4/4`. The local merge commit is evidence, never a
GitHub metadata input.

### Historical repair lineage and cardinality

```sql
WITH repairs AS (
  SELECT operation.operation_id,
         operation.resulting_revision,
         operation.idempotency_key,
         event.event_id,
         event.event_type,
         event.event_index,
         event.payload_json,
         (SELECT COUNT(*) FROM workflow_domain_events sibling
          WHERE sibling.operation_id = operation.operation_id) AS event_count,
         (SELECT COUNT(*) FROM workflow_outbox outbox
          JOIN workflow_domain_events owned ON owned.event_id = outbox.event_id
          WHERE owned.operation_id = operation.operation_id) AS outbox_count,
         (SELECT COUNT(*) FROM workflow_projection_work work
          WHERE work.enqueue_operation_id = operation.operation_id) AS projection_count
  FROM workflow_operations operation
  JOIN workflow_domain_events event
    ON event.operation_id = operation.operation_id
   AND event.project_id = operation.project_id
  WHERE operation.operation_type = 'lifecycle.shadow.repair'
    AND operation.idempotency_key LIKE 'internal:m003:s07:t02:repair:%'
)
SELECT resulting_revision, operation_id, idempotency_key,
       event_id, event_type, event_index,
       json_extract(payload_json, '$.disposition') AS disposition,
       json_extract(payload_json, '$.comparison.kind') AS comparison_kind,
       json_extract(payload_json, '$.evidence.evidenceDigest') AS evidence_digest,
       event_count, outbox_count, projection_count
FROM repairs
ORDER BY resulting_revision, event_index, event_id;
```

Fail unless there are exactly 33 rows at revisions 138-170; each has
`event_index=0`, counts 1/1/1, valid JSON, a 71-character lowercase SHA-256
evidence digest, and the exact event/disposition/comparison counts above.
`lifecycle.shadow.advanced` must carry `advanced`;
`lifecycle.shadow.repaired` must carry `repaired`. Unknown enum values, a
missing receipt, or extra matching operation are corruption, not drift to
average away.

### Fresh capstone observation coverage

Run this against the fresh capstone database before it is closed. The database
must contain only this capstone's observation evidence, so reruns cannot hide a
duplicate behind a latest-row query.

```sql
WITH observations AS (
  SELECT event_id,
         json_extract(payload_json, '$.mode') AS mode,
         json_extract(payload_json, '$.transport') AS transport,
         json_extract(payload_json, '$.sourceRevision') AS source_revision,
         json_extract(payload_json, '$.repairDisposition') AS repair_disposition,
         json_extract(payload_json, '$.observationLossAccounting.lossCount') AS loss_count,
         json_extract(payload_json, '$.observationLossAccounting.persistedCount') AS persisted_count,
         payload_json
  FROM audit_events
  WHERE type = 'lifecycle-shadow-observed'
), flattened AS (
  SELECT observation.event_id, observation.mode, observation.transport,
         observation.source_revision, observation.repair_disposition,
         observation.loss_count, observation.persisted_count,
         json_extract(item.value, '$.classification') AS classification,
         json_extract(item.value, '$.itemIdentity.itemKind') AS item_kind,
         json_extract(item.value, '$.itemIdentity.milestoneId') AS milestone_id,
         json_extract(item.value, '$.itemIdentity.sliceId') AS slice_id,
         json_extract(item.value, '$.itemIdentity.taskId') AS task_id,
         json_extract(item.value, '$.rawLegacyStatus') AS raw_legacy_status,
         json_extract(item.value, '$.rawCanonicalStatus') AS raw_canonical_status,
         json_extract(item.value, '$.normalizedLegacyStatus') AS normalized_legacy_status,
         json_extract(item.value, '$.normalizedCanonicalStatus') AS normalized_canonical_status
  FROM observations observation, json_each(observation.payload_json, '$.items') item
)
SELECT mode, transport, classification, COUNT(*) AS observed
FROM flattened
GROUP BY mode, transport, classification
ORDER BY CASE mode
           WHEN 'auto' THEN 0 WHEN 'interactive' THEN 1 WHEN 'guided' THEN 2
           WHEN 'uok' THEN 3 WHEN 'custom' THEN 4 ELSE 5 END,
         CASE transport WHEN 'native_pi' THEN 0 ELSE 1 END,
         CASE classification
           WHEN 'match' THEN 0
           WHEN 'semantic_match_exact_delta' THEN 1
           WHEN 'missing_shadow' THEN 2
           WHEN 'extra_shadow' THEN 3
           ELSE 4 END;
```

Join the result to a `VALUES` cross product of the six modes, two transports,
and five classifications. Every one of the 60 expected tuples must have count
1; there must be no extra tuple. Also require 12 envelopes, five items per
envelope, one exact source revision, `repairDisposition='not_attempted'`,
`lossCount=0`, and `persistedCount=1`. Validate all raw/normalized status and
identity fields before counting; a row with merely the right classification
string is not sufficient evidence.

### Current live M003 drift

Read raw pairs from the authoritative hierarchy/lifecycle tables, then apply the
exact exported comparator vocabulary. Do not consult ROADMAP, PLAN, SUMMARY,
JSONL, Git, or GitHub.

```sql
WITH hierarchy AS (
  SELECT 'milestone' AS item_kind, id AS milestone_id,
         NULL AS slice_id, NULL AS task_id, status AS legacy_status
  FROM milestones WHERE id = 'M003'
  UNION ALL
  SELECT 'slice', milestone_id, id, NULL, status
  FROM slices WHERE milestone_id = 'M003'
  UNION ALL
  SELECT 'task', milestone_id, slice_id, id, status
  FROM tasks WHERE milestone_id = 'M003'
), identities AS (
  SELECT item_kind, milestone_id, slice_id, task_id FROM hierarchy
  UNION
  SELECT item_kind, milestone_id, slice_id, task_id
  FROM workflow_item_lifecycles
  WHERE project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
    AND milestone_id = 'M003'
)
SELECT identity.item_kind, identity.milestone_id,
       identity.slice_id, identity.task_id,
       hierarchy.legacy_status,
       lifecycle.lifecycle_id,
       lifecycle.lifecycle_status AS canonical_status
FROM identities identity
LEFT JOIN hierarchy
  ON hierarchy.item_kind = identity.item_kind
 AND hierarchy.milestone_id = identity.milestone_id
 AND hierarchy.slice_id IS identity.slice_id
 AND hierarchy.task_id IS identity.task_id
LEFT JOIN workflow_item_lifecycles lifecycle
  ON lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
 AND lifecycle.item_kind = identity.item_kind
 AND lifecycle.milestone_id = identity.milestone_id
 AND lifecycle.slice_id IS identity.slice_id
 AND lifecycle.task_id IS identity.task_id
ORDER BY identity.milestone_id,
         CASE identity.item_kind WHEN 'milestone' THEN 0 WHEN 'slice' THEN 1 ELSE 2 END,
         identity.slice_id, identity.task_id;
```

The live research snapshot has 49 M003 rows and all are
`semantic_match_exact_delta`; T07 is still legacy `pending`/canonical `ready`.
The final dossier allows `match` and inspectable
`semantic_match_exact_delta`. Any `missing_shadow`, `extra_shadow`, unknown
normalization, or `status_mismatch` is unexplained drift and fails the dossier.
The expected total is derived from the unioned identities, not hard-coded to 49,
because T07 finalization changes status but does not add hierarchy identity.

### Loss accounting across DB and fallback sinks

`emitLifecycleShadowObservation` first writes `audit_events`, then JSONL; primary
failure falls through audit JSONL, runtime spool, and emergency journal. A
projection failure after a DB insert writes a second authoritative loss event
([uok/audit.ts](../../src/resources/extensions/gsd/uok/audit.ts)). A primary
sink failure cannot, by definition, be proven by querying the failed DB alone.

The capstone collector must therefore normalize all four sinks into logical
observations before hashing:

- DB `audit_events`;
- `.gsd/audit/events.jsonl`;
- `.gsd/runtime/lifecycle-shadow-observation-loss.jsonl`; and
- `.gsd/lifecycle-shadow-observation-loss.jsonl`.

Group `lifecycle-shadow-observation-loss` by its `causedBy` root. Use the terminal
record with the complete cumulative `observationLossAccounting`, but reject
multiple competing terminal records. Require `lossCount` to equal the number of
listed causes, every reason to be one of the four exact loss reasons, every
error hash to be lowercase SHA-256, and `persistedCount` to be 0 or 1 with the
expected sink semantics. A projection-loss record must name a persisted parent
observation. A primary-loss fallback may name an absent parent because the
parent insert is the failed action, but the fallback record itself must exist in
exactly one durable sink.

Clean 12-cell coverage requires zero loss. The isolated loss case is reported in
`dispositionProof` and must be fully accounted. If all destinations are
unwritable, there is no durable record; capstone detects the obstruction and the
dossier fails rather than calling it zero loss.

## Deterministic generator design

Implement `scripts/m003-s07-cutover-dossier.mjs` as an importable local CLI with
a closed argument surface. Recommended options are `--check`, `--json`, and
explicit local paths for the canonical DB/output when needed by tests. Reject
unknown arguments, network inputs, and every GitHub/hosted metadata input. Do
not read `GITHUB_*` or `GH_*`; scrub them from child gates as T06 does.

The generator should:

1. open the project DB read-only and begin one read transaction;
2. collect T01-T06 receipt heads, historical repair lineage, authority revision
   and epoch, and live M003 raw pairs;
3. run the capstone child once to obtain normalized exact-source machine
   evidence, or consume the exact local capstone evidence emitted by the
   enclosing `gsd_uat_exec` run;
4. run/import the no-cutover report and workflow-authority baseline, requiring
   every check in the no-cutover gate's closed structural and behavioral
   inventories, and baseline 4/4;
5. build one report with fixed enum inventories, expected/observed counts,
   commands, compatibility inventory, source identity, losses, repair history,
   deferred blockers, and `recommendation: "NO_GO"`;
6. sort every array by a defined semantic key before hashing or rendering;
7. canonicalize object keys recursively and hash UTF-8 canonical JSON with
   SHA-256; and
8. write two-space JSON plus one trailing newline. `--check` builds the same
   normalized report and byte-compares it to the checked file, while separately
   recomputing the embedded hashes.

Stable enum order:

```text
modes:          auto, interactive, guided, uok, custom, legacy
transports:     native_pi, workflow_mcp
classifications: match, semantic_match_exact_delta, missing_shadow,
                 extra_shadow, status_mismatch
proof outcomes: advanced, repaired, unresolved, rejected, observation_loss
```

Stable row order is mode, transport, classification; repair rows are
`resulting_revision,event_index,event_id`; receipt rows are
`task_id,attempt_number,verdict_revision,evidence_id`; compatibility entries
use their fixed contract ID. Never rely on default database row order.

Use three hashes with different meanings:

- `capstoneEvidenceHash`: normalized matrix, disposition, loss, no-cutover, and
  baseline evidence. Omit UUIDs, timestamps, durations, temp paths, and process
  IDs, but retain semantic identities, exact statuses, source revision, counts,
  commands, verdicts, and durable loss reasons.
- `canonicalHistoryHash`: exact stable project-DB receipt/repair rows, including
  their immutable IDs and revisions.
- `dossierHash`: canonical JSON of the complete dossier with only
  `dossierHash` omitted. Never hash a placeholder value and call it a self-hash.

Raw `gsd_uat_exec` stdout/stderr/meta remain the source-bound durable evidence;
their canonical Technical Verdict evidence envelope receives its own existing
`content_hash`. The dossier reports that DB hash separately from its three
semantic hashes.

Dynamic values such as elapsed milliseconds and generated timestamps belong in
the raw UAT receipt, not the checked deterministic JSON. Command strings and
exit/verdict results belong in the dossier. This mirrors the importable,
deterministic report style of
[workflow-authority-baseline.mjs](../../scripts/workflow-authority-baseline.mjs)
and [semantic-shadow-no-cutover-gate.mjs](../../scripts/semantic-shadow-no-cutover-gate.mjs).

## Recommended dossier shape

```json
{
  "schemaVersion": 1,
  "milestoneId": "M003",
  "sliceId": "S07",
  "recommendation": "NO_GO",
  "evidenceSourceRevision": "sha256:...",
  "authority": { "projectRevision": 0, "authorityEpoch": 0 },
  "expectedCoverage": { "envelopes": 12, "items": 60 },
  "observationCoverage": [],
  "dispositionProof": [],
  "observationLosses": [],
  "repairHistory": {},
  "taskReceipts": [],
  "compatibilityInventory": [],
  "noCutover": {},
  "authorityBaseline": {},
  "commands": [],
  "deferredCutoverBlockers": [],
  "hashes": {
    "capstoneEvidenceHash": "sha256:...",
    "canonicalHistoryHash": "sha256:...",
    "dossierHash": "sha256:..."
  }
}
```

The authority revision shown in the candidate is the project DB snapshot used
to collect prior history, not the independent fixture DB revisions. Each
observation row retains its own fixture revision/epoch in normalized evidence.

## Fail-closed rules

Generation or `--check` fails for any of the following:

- fewer or more than 12 clean envelopes or 60 flattened items;
- a missing/duplicate mode, transport, classification, or tuple;
- an unknown enum, missing identity/status field, corrupt JSON, or invalid
  normalized/raw pair;
- mixed, blank, or `unavailable` source revision, or a source snapshot that
  changes during the capstone;
- any clean-matrix loss, any unaccounted loss, competing loss terminal records,
  or loss evidence absent from all durable sinks;
- a missing/corrupt repair operation, event, outbox, Projection Work row, or
  evidence digest; counts other than 33/23/10/11/22;
- live `missing_shadow`, `extra_shadow`, `status_mismatch`, or unknown
  normalization;
- a missing/superseded/nonpassing S07 receipt head, except the deliberately
  post-candidate T07 final receipt;
- any structural or behavioral inventory entry in the no-cutover gate failing,
  or authority baseline other than exactly 4/4;
- missing named unadopted import/reconcile, same-status repair,
  park/unpark/discard, skipped dependency, or DB-unavailable compatibility;
- a response expansion, Markdown fallback authority, canonical read/
  eligibility/retry cutover, legacy deletion, or authority downgrade;
- any GitHub label/tag/metadata or network result used as an input;
- hash mismatch, nondeterministic ordering, stale checked JSON, or missing
  DB-backed capstone provenance; or
- a recommendation other than `NO_GO` while deferred surfaces remain.

The deferred blocker inventory should remain explicit: production read
authority, canonical dependency eligibility, integrated Slice source/UAT
identity, prepared/settled closeout effects, merge/publication settlement,
park/unpark/discard adoption, Projection Work redesign, legacy cascade deletion,
and compatibility retirement. This is why a green S07 proof is still NO-GO for
read cutover
([architecture](architecture.md),
[lifecycle runbook](lifecycle-command-integration-runbook.md)).

## Minimal RED matrix

| RED case | Expected rejection |
| --- | --- |
| Happy fixture generated twice with shuffled input rows | Byte-identical JSON and all three hashes identical |
| Remove one mode/transport envelope | Missing expected cell |
| Duplicate one envelope | Duplicate cell/cardinality |
| Remove or duplicate one classification item | Tuple count is not one |
| Rename a classification or translate to `exact_match` | Unknown frozen enum |
| Set one source revision to `unavailable` or a second hash | Incomplete/mixed exact-source evidence |
| Add clean-cell `lossCount: 1` | Clean coverage is incomplete |
| Delete the only primary-loss fallback record | Unaccounted observation loss |
| Corrupt a repair evidence digest or remove its outbox/projection row | Corrupt canonical repair lineage |
| Change repair expected count 23/10 or comparison count 11/22 | Historical cardinality drift |
| Seed a live M003 missing/extra/mismatch pair | Unexplained live drift |
| Make one no-cutover witness fail or baseline 3/4 | Structural/authority gate failure |
| Remove one named compatibility witness | Compatibility inventory incomplete |
| Inject a `GITHUB_*` input, Octokit import, or network result | Closed-local-input violation |
| Flip recommendation to GO or remove a deferred blocker | Forbidden cutover recommendation |
| Change candidate JSON without updating hashes | Dossier hash mismatch |
| Omit T07 `gsd_uat_exec` ref/hash from final Technical Verdict environment | Missing DB-backed provenance |
| Persist a final verdict for a pre-merge source aggregate | Exact-merged source mismatch |

Every sabotage must operate on an in-memory or temporary copy, then immediately
rerun the pristine generator/gate. Tests must not mutate the working tree.

## Implementation sequence

1. Add RED capstone fixtures and an importable generator validator. First prove
   the current `unavailable` source revision and absent live observation rows
   fail honestly.
2. Populate exact observation source identity through the existing private
   context/token using the stable verification-source helper; add no public
   argument or new authority store.
3. Emit normalized capstone evidence from fresh canonical-schema fixture DBs;
   keep raw temporary audit databases until normalization and hashing complete.
4. Generate the checked candidate JSON and runbook/architecture projection from
   the same report object. Do not hand-maintain a second count table.
5. Run the capstone, mode matrix, soak, MCP parity, no-cutover gate, baseline
   4/4, and `verify:merge` through the normal verification/UAT path.
6. After merge, rerun the exact-source capstone via `gsd_uat_exec`, persist the
   current T07 Technical Verdict/Evidence and publication receipt, then execute
   the final read-only query above against the exact merge source.

This design adds no dossier database schema and no replacement orchestration
abstraction. The project DB remains authority, the JSON and runbook remain
inspectable projections, and missing evidence fails loud.
