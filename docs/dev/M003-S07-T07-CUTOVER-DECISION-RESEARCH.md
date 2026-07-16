<!-- Project/App: gsd-pi -->
<!-- File Purpose: Research and runbook contract for the M003/S07/T07 cutover dossier. -->

# M003/S07/T07 cutover decision research

> **Status:** Historical decision research snapshot. Current behavior is owned
> by the
> [Architecture Overview](architecture.md#semantic-shadow-evidence-and-cutover-boundary),
> the [lifecycle integration runbook](lifecycle-command-integration-runbook.md#s07-semantic-shadow-dossier),
> and the generated [cutover dossier](m003-s07-cutover-dossier.json).

## Decision

The T07 dossier must recommend **NO-GO for production read-authority cutover**.
T07 may prove M003 semantic-shadow convergence and close S07, but it may not
reverse D005. A future cutover requires a separate, explicit decision after the
deferred authority and compatibility surfaces below are implemented and proven.

The authority rule is unambiguous:

- SQLite is the runtime source of truth for adopted lifecycle commands and
  their evidence.
- Legacy hierarchy reads and public responses remain authoritative under D005.
- Canonical lifecycle reads are comparison evidence only during M003.
- Markdown files are readable, repairable projections only. They are not
  dossier evidence, fallback authority, completion authority, or cutover input.
- GitHub labels, tags, review state, mergeability, and hosted metadata are not
  inputs. Direct maintainer instruction and database-backed evidence are the
  governing inputs.

This composes R019, D004, and D005. R019 requires cross-mode convergence with
zero unexplained drift; D004 places comparison at semantic handlers and status
reads; D005 explicitly retains legacy read and response authority.

## Sources reviewed

This recommendation is based on the canonical R019/D004/D005 records, the S07
plan and T01-T06 summaries, the semantic-shadow contract, the three T06 research
records, the no-cutover gate and behavioral witnesses, the lifecycle integration
runbook, the architecture overview, and read-only inspection of the live
canonical database.

The source checkout inspected for this research was clean at
`a4100b234c57c7ec8b82473281921dd1d4668aa9`. That is a research snapshot, not
the required exact merge SHA. T07 cannot publish a promotable verdict until the
capstone is rerun against the actual merged source and that SHA is bound into
database-backed evidence.

## Live canonical snapshot

Read-only inspection captured this state at the database authority timestamp
`2026-07-15T08:06:48.664Z`:

| Fact | Observed |
|---|---:|
| Project ID | `f0a972e10334469c8b4d2f884213ba43` |
| Authority revision / epoch | `195 / 0` |
| M003 hierarchy rows | 49 |
| `match` | 0 |
| `semantic_match_exact_delta` | 49 |
| `missing_shadow` | 0 |
| `extra_shadow` | 0 |
| `status_mismatch` | 0 |
| Lifecycle-shadow repair operations | 33 |
| Repair events / outbox rows / Projection Work rows | `33 / 33 / 33` |
| `advanced` repair receipts | 10 |
| `repaired` repair receipts | 23 |
| `unresolved` repair receipts | 0 |
| Repair receipts originating from `missing_shadow` | 11 |
| Repair receipts originating from `status_mismatch` | 22 |
| Durable repair evidence references / distinct evidence digests | `33 / 23` |
| Repair Projection Work rows still `pending` | 33 |
| Current non-superseded pending repair projections | 23 |
| `lifecycle-shadow-observed` audit rows | 0 |
| `lifecycle-shadow-observation-loss` audit rows | 0 |
| Runtime loss spool | absent |
| Emergency loss journal | absent |
| SQLite `quick_check` / `integrity_check` | `ok / ok` |

The current hierarchy has no unexplained semantic drift. Its raw aliases remain
visible: completed legacy rows are `complete` while canonical rows are
`completed`; the active Milestone and pending S07 rows compare semantically with
canonical `ready`. That is why all 49 rows are
`semantic_match_exact_delta`, not `match`.

The repair lineage is complete and evidence-backed. Ten historical Tasks needed
an explicit `ready -> in_progress` advance followed by completion, so 33 repair
operations legitimately refer to 23 distinct completion evidence digests. No
repair invented an Attempt or Result. Pending repair projections do not weaken
database authority, but they must remain visible in the dossier and reinforce
that projection delivery/retirement is later work.

### Current reproducible digests

The dossier generator must sort rows by stable identity/revision, encode JSON
with recursively sorted object keys and no insignificant whitespace, and prefix
SHA-256 values with `sha256:`. The equivalent read-only research queries produced:

| Dataset | SHA-256 |
|---|---|
| Ordered M003 hierarchy comparison rows | `sha256:75900105d448b34bb8d79a77c8189697d39ebeb87aca2ea2de96c9d8fb428c2c` |
| Ordered lifecycle-shadow repair event records | `sha256:155574093501a27684e55703d696eb3e7718af7048cafa72881d03f3a3556892` |
| Canonical JSON array of live observation/loss payloads | `sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |

The last digest is the digest of `[]`. It proves absence, not completeness.
These snapshot values are diagnostic anchors; the T07 generator must recompute
them and fail if its internally reported counts and digests disagree.

## The live-observation provenance gap

T05 proved all runtime modes and transports in temporary, isolated fixture
databases. Those tests are valid contract evidence, but their observation rows
are not present in the live canonical project database. The live database has
zero observation envelopes and therefore cannot currently answer:

- which production mode/transport cells were observed here;
- how many observations belonged to each classification here;
- whether a live sink loss accompanied any omitted observation; or
- which exact source revision produced a complete live observation set.

The production observer also defaults source provenance to
`sourceRevision: "unavailable"` when an exact runtime context cannot be
resolved. An exact-source capstone fixes the provenance of the isolated test
run only; it does not create or retroactively identify retained production
telemetry. A future read-cutover decision therefore needs a bounded production
retention policy and exact runtime source provenance in addition to this
capstone.

The dossier must not relabel fixture evidence as live telemetry. It needs two
separate sections:

1. `liveProjectSnapshot`: actual hierarchy, repair, projection, observation,
   and loss rows from the canonical project database.
2. `capstoneFixtureCoverage`: deterministic disagreement fixtures executed by
   the exact source revision in isolated databases.

Until the exact-merged capstone exists and its artifact digest is attached to a
database-backed UAT and verification verdict, the coverage provenance and
cardinality gate is incomplete. Even afterward, absent exact-source production
observation retention remains a later-cutover blocker. These facts require a
current NO-GO verdict.

## Required capstone cardinality

The exact-source capstone must create one observation envelope for every pair of
six runtime modes and two transports. Every envelope must contain one item for
each exact classification.

| Dimension | Expected count |
|---|---:|
| Modes | 6: `auto`, `interactive`, `guided`, `uok`, `custom`, `legacy` |
| Transports | 2: `native_pi`, `workflow_mcp` |
| Mode/transport cells | 12 |
| Observation envelopes | 12 |
| Items per envelope | 5 |
| Total classified items | 60 |
| Count per classification | 12 |
| Unaccounted observation losses | 0 |
| Public response changes | 0 |
| Authority-baseline invariants | 4/4 |

The generator must fail if a cell, classification, trace/turn identity, source
revision, project revision, Authority Epoch, raw status, normalized status, or
repair disposition field is missing. It must also fail for duplicate cell or
item cardinality, a classification alias, any fallback, corrupt evidence, an
authority downgrade, or any nonzero unaccounted loss.

Repair outcomes must not be conflated with classifications. The repair ledger
uses `advanced`, `repaired`, and `unresolved`. A rejected repair creates no
receipt and must be proven by an unchanged before/after authority snapshot.
Observation loss is likewise accounting, not a repair disposition. The
capstone must independently prove repaired, unresolved, rejected-with-no-residue,
and loss-accounted behavior.

## Machine-readable dossier contract

`docs/dev/m003-s07-cutover-dossier.json` should be generated, never hand-edited,
with this top-level structure:

```text
schemaVersion
generatedAt
recommendation                 # always NO-GO in M003
governingRequirements          # R019
governingDecisions             # D004, D005
source
  candidateRevision
  exactMergedRevision
  clean
  sourceManifestHash
liveProjectSnapshot
  projectId
  capturedAuthorityRevision
  authorityEpoch
  hierarchyCounts
  hierarchyDigest
  observationCounts
  observationLossCounts
  observationDigest
  repairCounts
  repairEvidenceCounts
  repairDigest
  projectionDeliveryCounts
capstoneFixtureCoverage
  expected
  observed
  countsByMode
  countsByTransport
  countsByClassification
  countsByDisposition
  lossCauses
  publicResponseDigest
  evidenceDigest
compatibilityInventory
verification
  commands
  authorityBaseline
  hostedChecks
  exactMergedUat
deferredBlockers
inputs
  markdownUsedAsAuthority: false
  githubMetadataUsed: false
```

Counts must be derived from row-level records, not accepted as independent
numbers. The generator should first build ordered row arrays, derive counts from
those arrays, compute their canonical hashes, and then validate expected versus
observed cardinality. Volatile durations and generation timestamps may be
reported, but they must not enter evidence identity hashes.

The dossier collector's `--check-dossier <path>` mode must recollect local
evidence and regenerate the report in memory before byte-comparing it with the
checked-in JSON. The collector must bind the database to the local source
project, access no network, and ignore/remove `GITHUB_*` and `GH_*` environment
values. GitHub labels and tags are never evidence inputs.

## Attaching exact-source evidence without overstating telemetry

T07 should use this sequence:

1. On the pre-merge candidate, run every capstone check through `gsd_uat_exec`.
   Keep the command, working directory, exit code, exact source revision,
   structured observation, and durable output reference.
2. Generate the dossier from the read-only live snapshot plus the isolated
   capstone records. Do not copy fixture audit rows into the live audit table.
3. Save the aggregate S07 UAT result through `gsd_uat_result_save`, citing the
   `gsd_uat_exec` evidence IDs and dossier digest. This gives the live database
   a structured UAT/gate receipt without claiming that fixture observations
   occurred in the live project.
4. Run the canonical Milestone validation path. Its Attempt, Result, criteria,
   Technical Verdict, and Verification Evidence must bind the dossier digest,
   durable output reference, observed authority revision, and tested source
   revision.
5. Run hosted checks and merge without using their labels or tags as authority.
6. In a clean checkout of the exact merge SHA, rerun the capstone, dossier
   `--check`, authority baseline, and merge gate. Save new DB-backed evidence and
   a new exact-source verdict. Pre-merge evidence cannot substitute for this.
7. Close S07 only through canonical Task/Slice operations. Rendered SUMMARY,
   UAT, ROADMAP, STATE, and this research Markdown remain projections.

The durable evidence reference should identify the checked-in dossier and its
hash, for example `repo://docs/dev/m003-s07-cutover-dossier.json@<merge-sha>`.
The evidence observation should explicitly say that capstone rows came from
isolated fixture databases and that the live project observation count was zero
at the captured revision.

## Compatibility inventory

The no-cutover gate must continue to execute these named behavioral witnesses.
Existence checks alone are insufficient.

| Promise | Required witness | Cutover status |
|---|---|---|
| Legacy status response wins a disagreement | `semantic-shadow-no-cutover.test.ts` — legacy milestone status remains public | Retain |
| Frozen Pi/MCP response and contradictory projection | `semantic-shadow-contract.test.ts` — byte/deep-equal status response | Retain |
| Six modes and two transports | `semantic-shadow-mode-matrix.test.ts` — complete production matrix | Retain |
| Unadopted Markdown import | `md-importer-adopted-authority.test.ts` — unadopted re-import behavior | Retain explicitly |
| Unadopted worktree reconcile | `workflow-reconcile.test.ts` — unadopted Milestone completion | Retain explicitly |
| Same-status timestamp repair | `adopted-lifecycle-bypass-closure.test.ts` — aligned same-status repair | Retain documented rule |
| Park and unpark | `park-db-sync.test.ts` — DB status synchronization | Deferred surface |
| Discard | `park-milestone.test.ts` — hierarchy/worktree/branch removal | Deferred surface |
| Legacy skipped dependency | `dispatch-guard-closed-status.test.ts` — skipped predecessor permits dispatch | Deferred until Waiver-backed eligibility |
| Database unavailable | `milestone-status-tool.test.ts` — graceful DB-unavailable response | Retain; never Markdown fallback |

Adjacent adopted import/reconcile protection cases must run with the inventory.
The gate also keeps behavioral disagreement cases for dependency eligibility,
Slice dispatch, and retry/backoff so canonical shadow state cannot silently
become routing authority.

## Deferred blockers requiring NO-GO

Even after a green exact-merged capstone, M003 must remain NO-GO for read
cutover because these surfaces are explicitly outside S07:

1. Production status reads and public responses still intentionally originate
   from the legacy hierarchy.
2. Milestone dependency eligibility, Slice dispatch eligibility, and retry
   suppression still intentionally use legacy registry/hierarchy/dispatch
   ledgers.
3. Active-Slice selection still recognizes legacy `skipped`; a later cutover
   must consume its canonical Waiver instead of inferring satisfaction from the
   alias.
4. Unadopted Markdown import and worktree reconciliation remain compatibility
   authority paths. Adopted history is protected, but retirement is not done.
5. Park, unpark, and discard are named deferred lifecycle surfaces.
6. Prepared/settled closeout effects and merge/publication settlement remain
   later work.
7. Slice completion does not yet bind one integrated Slice source snapshot, and
   structured post-completion UAT identity is not part of `slice.completed`.
8. Projection-worker redesign, the 23 current pending repair projection heads,
   and compatibility projection retirement remain later work.
9. Legacy cascade deletion and broader compatibility retirement are forbidden
   until a later deletion-safety gate.
10. The live project currently contains zero semantic-shadow observation audit
    rows; exact-merged capstone evidence has not yet been attached to a live
    DB-backed UAT/verdict receipt.
11. Production observation source provenance remains `unavailable` when an
    exact context is absent, and no bounded retained production observation set
    currently exists. Fixture capstone provenance cannot substitute for this.
12. Hosted checks and exact-merged DB UAT do not yet exist for T07.
13. D005 has not been superseded by a separate explicit read-cutover decision.

No average of these blockers is acceptable. A green test matrix proves the
shadow system; it does not silently authorize a new source of truth.

## Exact runbook update

Add a new `S07 cutover dossier (NO-GO)` section immediately after `S07 and later
boundaries` in `docs/dev/lifecycle-command-integration-runbook.md`. It should:

1. Repeat the authority statement: legacy reads/responses remain authoritative;
   Markdown is projection only; GitHub labels/tags are not inputs.
2. Show the two evidence namespaces (`liveProjectSnapshot` and
   `capstoneFixtureCoverage`) and forbid presenting fixture rows as live
   telemetry.
3. List the expected 12 envelopes, 60 items, 12 of each classification, zero
   unaccounted loss, and baseline 4/4.
4. Include the read-only live queries for authority revision, comparison counts,
   observation/loss counts, repair disposition/evidence counts, and current
   Projection Work heads.
5. Document dossier generation and `--check`, pre-merge UAT evidence capture,
   hosted verification, exact-merge rerun, and DB-backed verdict attachment.
6. Define fail-closed recovery: repair database access or evidence generation;
   never edit Markdown, copy fixture telemetry into the live audit table, waive
   cardinality, or infer success from a checked projection.
7. End with the fixed M003 recommendation: `NO-GO for read cutover`; S07 closure
   means convergence evidence is complete, not that D005 changed.

The existing `Automated UAT and closeout` section should link to this dossier
sequence and clarify that only the exact-merged, database-backed receipt closes
T07 evidence. The existing projection-obstruction diagnostics remain valid.

## Exact architecture update

Add a `Semantic shadow authority boundary` subsection under
`DB-Authoritative Project State` in `docs/dev/architecture.md` with this data
flow:

```text
legacy hierarchy ───────────────> frozen public status response
       │
       └─ same read transaction ─┐
canonical lifecycle shadow ─────┴─> pure comparison
                                      │
                                      └─ after read transaction
                                         audit_events
                                           └─ JSONL / spool / emergency loss accounting
```

The subsection must state that no comparison or repair value flows back into
the response, dependency eligibility, dispatch eligibility, or retry decision
during M003. Evidence-backed repair is a separate Domain Operation that may
advance canonical state but never rewrites legacy rows or invents execution
history.

Extend the key-module table with:

- `lifecycle-shadow-observation.ts` — typed observation and loss accounting;
- `milestone-status-observation-context.ts` — exact per-turn mode/transport
  capability identity;
- `lifecycle-shadow-repair-domain-operation.ts` — replay-safe forward repair;
- `scripts/semantic-shadow-no-cutover-gate.mjs` — local behavioral/structural
  D005 enforcement; and
- `scripts/m003-s07-cutover-dossier.mjs` — deterministic evidence aggregation,
  not an authority switch.

Finally, replace any wording that says Milestone lifecycle commands have not
cut over if it is stale after S06, while preserving the separate statement that
Milestone **read authority** has not cut over. Command-write integration and read
authority are different facts.

## Reproducible decision procedure

The final T07 decision is mechanical:

1. Require a clean exact merge SHA.
2. Recompute the live snapshot and all canonical hashes read-only.
3. Run the 12-cell capstone and derive, rather than assert, all coverage counts.
4. Reject any missing/duplicate cell, classification, disposition proof, loss,
   fallback, corrupt digest, response change, authority mutation by repeat read,
   or GitHub metadata input.
5. Require the no-cutover gate, authority baseline 4/4, hosted checks, dossier
   `--check`, and exact-merged UAT.
6. Persist the exact-source UAT/verdict/evidence receipt in the canonical DB.
7. Publish **NO-GO for read cutover** with the deferred blockers above.

If every evidence gate passes, S07 may close. The recommendation does not become
GO: the successful outcome of M003 is a trustworthy, measured shadow with legacy
reads still authoritative.
