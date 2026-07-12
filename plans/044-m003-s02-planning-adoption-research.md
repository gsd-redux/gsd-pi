# M003/S02 planning and adoption research

## Objective

Route planning and replan mutations through semantic Domain Operations so the
legacy hierarchy row, canonical lifecycle head, events, outbox, and Projection
Work commit atomically. Legacy reads and public response objects remain the
compatibility surface during M003. Markdown and JSONL remain projections.

## Semantic handler seams

Instrument command handlers, not generic database helpers or the global status
core:

- `persistMilestonePlan`
- `handlePlanSlice`
- `handlePlanTask`
- `handleReplanSlice`
- `handleReplanTask`
- `handleReassessRoadmap`

Each already separates a synchronous guard/write transaction from asynchronous
rendering. Extract the synchronous mutation into the Domain Operation callback.
Rendering, cache invalidation, manifests, and compatibility event files remain
post-commit projection work.

Do not instrument `insertMilestone`, `insertSlice`, `insertTask`, or
`applyStatusTransition` globally. Bootstrap, import, recovery, and completion
use those helpers with different semantic intent.

## Planning invocation envelope

Idempotency belongs to the transport invocation, not to model-visible params:

```ts
interface PlanningInvocation {
  idempotencyKey: string;
  sourceTransport: "pi-tool" | "workflow-mcp" | "internal";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}
```

- Pi tools use the canonical tool name plus the existing tool-call ID.
- MCP uses the canonical tool name plus a required nonblank private
  `io.opengsd/idempotency-key` request-metadata value. It fails before mutation
  when that replay-stable identity is absent; SDK session/request identity and
  server-generated UUIDs cannot converge a lost-response retry.
- Aliases normalize to the canonical operation type.
- Internal callers provide an explicit key.
- Payload hashing is forbidden: a legitimate A -> B -> A edit would collide.
- Handler-generated UUIDs are forbidden: a lost-response retry would not
  replay.

MCP SDK `RequestHandlerExtra` exposes `requestId`, `sessionId`, and loose
request `_meta`; the project's current local server type erases everything but
`signal` even though its wrapper forwards the runtime object. Widen that private
type only. A client that retries across a new request or server process must
resend the private metadata key; no planning tool schema field is added.

The envelope stays separate from conversational schemas. A replay reloads or
deterministically derives response/projection data because the mutation callback
does not run on an exact replay.

## Canonical planning semantics

- A fully planned milestone, slice, or task is canonical `ready`.
- Legacy `active` or `pending` remains unchanged; the comparator records an
  accepted semantic exact delta.
- A sketch/placeholder slice remains `pending`.
- Historical adoption maps the observed legacy status through the shared
  normalizer and normally creates state version zero without execution history.
  If first adoption also cancels active legacy work, it records that legal
  observed-to-cancelled transition at state version one.
- A replan that only changes planning metadata preserves lifecycle ID, status,
  state version, and last-operation provenance.
- No adoption fabricates an Attempt, Result, Kernel checkpoint, Blocker,
  Waiver, or Disposition.

## Durable removal

Canonical lifecycle rows reference hierarchy rows, and lifecycle deletion is
forbidden. Existing physical task/slice deletion cannot coexist with adoption.
Planning removal therefore becomes a cancellation:

- retain the legacy hierarchy identity;
- write legacy `skipped` and canonical `cancelled` in one Domain Operation;
- exclude cancelled planning entries from the active plan projection while
  retaining their database history;
- preserve the public handler/MCP result shape;
- require explicit reopen before a cancelled identity can be reused.

Completed work remains protected from removal as it is today.

## Compatibility paths that must be hardened first

Broad adoption would otherwise break or strand durable history:

- `restoreManifest`, `bulkInsertLegacyHierarchy`, and `clearEngineHierarchy`
  delete hierarchy parents referenced by lifecycle rows;
- worktree reconciliation uses `INSERT OR REPLACE`, which deletes and reinserts
  identities, and does not merge Domain Operations or canonical lifecycle
  tables;
- first `.planning` capture logs import failure but still activates its marker;
- Markdown migration/recovery still infers statuses from projection files.

S02 must:

1. replace destructive reconcile replacement with identity-preserving UPSERT;
2. fail closed when a restore/recover path would destroy adopted hierarchy;
3. prevent canonical operations from being stranded in a worktree database;
4. activate `.planning` compatibility only after import succeeds; and
5. keep reverse-authority recovery/import paths explicitly outside ordinary
   planning operations.

Later slices remove file-derived completion and compensation behavior. S02 only
prevents those paths from bypassing or destroying newly adopted lifecycle heads.

## Transaction and projection contract

Within one Domain Operation, parent first:

1. validate guards without rereading Markdown;
2. write or update legacy hierarchy/planning rows;
3. adopt or transition canonical lifecycle heads;
4. compare raw and normalized legacy/canonical statuses;
5. record one semantic event and durable projection targets; and
6. commit authority with compare-and-swap.

Guard failures throw inside the callback so the operation reservation rolls
back, then translate to the existing handler error. No JSONL or Markdown write
occurs before commit. A synchronous render obstruction leaves the database
operation committed and Projection Work retryable; it never compensates state.

## RED and verification matrix

The executable contract must cover:

1. fresh milestone/slice/task planning with exact existing response objects;
2. fully planned `ready` deltas and sketch `pending` behavior;
3. historical legacy adoption for every supported alias;
4. task/slice replan metadata preservation and history ordering;
5. durable cancellation for removed pending work and completed-work guards;
6. exact lost-response replay after unrelated revision advance;
7. changed-semantics conflict under the same invocation key;
8. projection obstruction after commit followed by replay repair;
9. all pre-commit fault points with no residue;
10. restart replay and a real two-process same-fence race;
11. Pi canonical/alias, MCP canonical/alias, executor, auto-lease, and worktree
    projection-root entry convergence; and
12. structural proof that legacy reads/responses remain authority and no generic
    status chokepoint is instrumented.

Snapshots include hierarchy, lifecycle heads, operations, events, outbox,
Projection Work, replan history, and zero invented execution/evidence rows.

## Non-goals

- no lifecycle read-authority cutover;
- no task claim/settlement integration (S03);
- no blocker, waiver, disposition, or general reopen policy (S04);
- no slice/milestone completion integration (S05/S06);
- no copying canonical rows between independent authorities; and
- no new schema family unless an executable contract proves the v31-v35 model
  cannot express the required identity-preserving behavior.
