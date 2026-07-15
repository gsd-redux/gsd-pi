<!-- Project/App: gsd-pi -->
<!-- File Purpose: M003/S07 semantic-shadow convergence and no-cutover contract. -->

# M003/S07 semantic-shadow contract

## Outcome

S07 measures whether legacy lifecycle reads and canonical lifecycle shadows mean
the same thing across every supported runtime mode. It does not change which
representation answers production reads. The current recommendation is
**NO-GO for read cutover** until S07's later repair, observation, mode-matrix,
soak, and exact-merged dossier gates all pass and a separate decision explicitly
revisits D005.

This record composes R019 with D004 and D005:

- R019 requires zero unexplained semantic drift across auto, interactive,
  guided, UOK, custom, and legacy execution.
- D004 places comparison at semantic command handlers and milestone-status
  reads. The generic status writer is not an instrumentation seam because it
  also serves import, reconciliation, recovery, planning, and undo.
- D005 keeps legacy reads and handler responses authoritative in M003.
  Canonical lifecycle facts and comparisons are shadow evidence only.

No GitHub label, tag, review state, or mergeability field is an authority input.

## Existing seams

`db/lifecycle-shadow-comparison.ts` already provides a pure comparison of raw
legacy and canonical status values plus their normalized meanings.
`executeMilestoneStatus` reads the legacy milestone, slice, and task tables in a
read transaction and returns one stable text/details response. Native Pi calls
that executor through `bootstrap/query-tools.ts`; workflow MCP calls the same
executor and maps `details` to protocol `structuredContent`. Neither surface
may fall back to Markdown when the database is unavailable.

The existing UOK audit surface writes to the database when available and then
best-effort mirrors JSONL. That behavior is insufficient by itself for S07:
milestone-status observation must be persisted after the read snapshot, and
every sink failure must appear in durable retry/fallback state or an explicit
loss counter consumed by the dossier. Observation failure must never alter the
public response.

## Frozen comparison vocabulary

The only classification values are:

1. `match`
2. `semantic_match_exact_delta`
3. `missing_shadow`
4. `extra_shadow`
5. `status_mismatch`

`semantic_match_exact_delta` preserves a meaningful raw-value difference even
when normalization says the states are compatible. There is no `exact_match`
alias and no translation layer. Raw legacy status, raw canonical status, both
normalized statuses, and the exact classification travel together.

## Frozen status response

For a found milestone, public text remains the pretty-printed JSON object with
these fields and order:

1. `milestoneId`
2. `title`
3. `status`
4. `createdAt`
5. `completedAt`
6. `sliceCount`
7. `slices`

Each Slice contains `id`, `status`, and `taskCounts`; task counts contain
`total`, `done`, and `pending`. Native Pi `details` adds only
`operation: "milestone_status"` before that same object. Workflow MCP exposes
the same deep-equal object as `structuredContent`. A canonical mismatch or a
contradictory ROADMAP/PLAN projection must not change content, field order,
details, errors, Slice ordering, or task counts.

The not-found and database-unavailable responses also remain legacy
compatibility responses. Observation must not expand them or turn an
observation failure into a tool error.

## Required matrix

The six required runtime modes are `auto`, `interactive`, `guided`, `uok`,
`custom`, and `legacy`. The required transport surfaces are `native_pi` and
`workflow_mcp`. Later matrix work must identify unsupported mode/transport
combinations explicitly; it may not silently omit them. Every supported cell
must use the same comparison vocabulary and preserve the frozen response.

Every matrix must independently exercise all five classifications. A
classification and its later repair disposition are different facts: a
`missing_shadow` observation can be repaired, rejected, or unresolved without
renaming the classification.

## Complete observation

An observation is complete only when it records:

- item identity, including hierarchy identity and lifecycle identity when one
  exists;
- raw legacy and canonical statuses;
- normalized legacy and canonical statuses;
- exact classification;
- runtime mode and transport;
- source revision and Authority Epoch;
- trace and turn identity;
- repair disposition; and
- explicit observation-loss accounting.

The hierarchy and lifecycle snapshot must be internally consistent: wholly
before or wholly after a concurrent commit. Persistence happens outside the
read transaction. Successful observation cannot mutate hierarchy, lifecycle,
operation, outbox, or Projection Work authority. Sink failure is response
neutral but must durably increment retry/fallback or loss state. The dossier
must fail for missing expected observations, duplicate cardinality, or any loss
that is neither persisted nor explicitly counted.

## Evidence-gated forward repair

Repair is narrow and additive:

- Durable terminal evidence is required before adopting a missing historical
  terminal shadow.
- A ready bootstrap head may advance only through observable legal
  transitions.
- Repair never invents Attempts or Results, rewrites a legacy row, moves a
  newer lifecycle head backward, or converts unexplained evidence into a
  match.
- `extra_shadow`, unexplained `status_mismatch`, and unsupported evidence stay
  actionable and unresolved.
- One immutable receipt records before state, target, evidence, and
  disposition. Exact replay returns that receipt; changed-payload key reuse
  conflicts.
- Pre-, mid-, and post-commit faults either leave the exact prior snapshot or
  one complete committed repair.

## Named compatibility cases

These cases remain visible throughout S07 and later cutover work:

| Case | M003 contract |
|---|---|
| Unadopted Markdown import | Preserve existing import behavior; do not imply canonical adoption or authority. |
| Unadopted worktree reconcile | Preserve existing reconciliation behavior; adopted history must not be overwritten or deleted. |
| Contradictory projection | Classify from the database snapshot; the projection cannot change the result. |
| Same-status repair | Allow only the already documented evidence/provenance repair behavior. |
| Park / unpark / discard | Remain deferred compatibility surfaces; S07 does not silently adopt, replace, or remove them. |
| Legacy skipped dependency | Remains a named compatibility alias until later eligibility cutover consumes its Waiver rather than inferring authority from text. |

## Structural no-cutover boundary

S07 must fail closed if a change does any of the following:

- makes canonical lifecycle state production read authority;
- makes canonical lifecycle state dependency-eligibility or retry authority;
- expands or changes the frozen public milestone-status response;
- deletes a legacy read, writer, cascade, import, reconciliation, or named
  compatibility fixture;
- treats Markdown as fallback authority when the database is unavailable;
- uses GitHub labels or tags as an input; or
- hides unexplained drift, corrupt evidence, or observation loss.

S07 may add comparison, evidence-gated repair, response-neutral observation,
and dossier gates. It may not add a replacement orchestration abstraction.
Production read authority, eligibility cutover, compatibility retirement,
projection-worker redesign, and legacy deletion require later explicit scope
and approval after this dossier is complete.

## T01 executable proof

`semantic-shadow-contract.test.ts` freezes the five exact classifications,
six modes, two transports, observation fields, repair rules, named
compatibility cases, and forbidden boundaries. Its milestone fixture creates a
deliberate canonical/legacy mismatch and a contradictory projection, then
proves all twelve mode/transport observations return byte-equal content and
deep-equal details without changing hierarchy, lifecycle, operation, event, or
Projection Work state.
