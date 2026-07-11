<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for two-altitude state-machine enforcement — Phase Transition Invariant, Status Transition Core, and a typed Status vocabulary. -->

# ADR-030: Two-Altitude State Machine — Phase Transition Invariant, Status Transition Core, Typed Vocabulary

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Amended.** The Single Writer chokepoint and typed transition vocabulary remain valid. In-memory phase authority, `skipped` as a completion-like status, and filesystem replay into authority are superseded by the persisted Lifecycle Kernel and database-only state.

**Status:** Accepted
**Date:** 2026-06-09
**Author:** GSD architecture review
**Related:** ADR-014 (deep Auto Orchestration module / `advance()`), ADR-015 (runtime invariant modules / Recovery Classification), ADR-017 (drift-driven State Reconciliation — the Phase guard runs *after* it), the Single Writer Layer decision (CONTEXT.md "Current decision in force" — the Status Transition Core lives under `db/writers/`)

## Context

A re-evaluation of "the state machine" found that GSD has **two** state machines speaking **two** vocabularies, joined only by a hardcoded mapping — and the one that looks like the state machine is dead code.

1. **`state-transition-matrix.ts` is a hypothetical seam.** It defines a 12-entry `STATE_TRANSITION_MATRIX` over the `Phase` type plus `findTransition`/`validateTransitionMatrix`, but it has **zero production imports** — only its own test file references it. It passes the deletion test: delete the file and nothing in production changes. That is the bad result, not the good one.

2. **The matrix speaks a vocabulary that is never stored.** Its `from`/`to` are milestone-lifecycle `Phase` values (`planning → executing → summarizing → validating-milestone → …`). `Phase` is **derived**, not persisted: `deriveState` (`state.ts`) recomputes it from row statuses on every call; `advance()` (`auto/orchestrator.ts:797`) never *chooses* a phase, it *discovers* one. So the matrix cannot be consulted on a status write — they are different alphabets. `advance()` does not retain the prior derived phase at all; it tracks orchestration status (`idle/running/paused`) and `lastAdvanceKey` (the `unitType:unitId`), the latter reset to `null` on pause/stop (`auto/orchestrator.ts:885,901,1115`).

3. **Status writes have no chokepoint.** 44 non-test call sites write entity status through three near-verbatim SQL pass-throughs — `updateTaskStatus` (`gsd-db.ts:530`), `updateSliceStatus` (`gsd-db.ts:584`), `updateMilestoneStatus` (`gsd-db.ts:762`). All three take `status: string`. Only `updateMilestoneStatus` carries a guard — the closed→open block at `gsd-db.ts:765` that forces an explicit reopen. Tasks and slices have no equivalent. Completion-timestamp, journal, and cache-invalidation rules are re-implemented or forgotten per call site.

4. **The status vocabulary is untyped and re-derived.** No `type Status` exists; every signature is `status: string`. The closed-status set is encoded in `isClosedStatus` (`status-guards.ts:13`) and again in `TERMINAL_STATUS_SQL` (`db/sql-constants.ts:8`) — they agree today by coincidence, not by construction — and is re-derived inline as `status === "complete" || …` across ~57 non-test files. The DB stores free-form strings with aliases and legacy/imported values (`done`/`closed` ≡ `complete`, `planned` ≡ `pending`), documented in the `status-guards.ts` header, which already pleads: *"Every inline `status === "complete" || …` should use `isClosedStatus()`."*

The matrix is structurally well-formed but earns nothing. The real transition logic lives scattered across `deriveState`, dispatch resolution, and 44 write sites.

## Decision

Treat the state machine as **two stacked altitudes sharing one typed vocabulary**, and give each altitude a real enforced seam. The Phase matrix is an **assertion**, not a decision-maker — `deriveState` keeps choosing the phase.

### 1. Phase Transition Invariant (Phase altitude)

`state-transition-matrix.ts` gains an **edge-keyed** predicate:

```ts
// true when (from → to) matches any matrix entry, honoring the "*" wildcard rows.
// Self-edges (from === to) are trivially legal — no transition to assert.
export function isLegalEdge(from: Phase, to: Phase): boolean;
```

`advance()` imports it and enforces it as an invariant guard:

- Carry `lastDerivedPhase` **in-memory**, tracked like `lastAdvanceKey`; reset to `null` on pause/stop. When `null` (cold start, first advance after resume), the edge check is **skipped** — there is no edge to assert yet.
- The guard runs **after** State Reconciliation (ADR-017), on the reconciled snapshot, **before** the Dispatch decision is recorded. Reconciliation repairs drift first; the guard only judges what survives repair.
- An illegal edge that **survives reconciliation** is not repairable drift. The guard detects; it does not decide. It hands a typed failure to Recovery Classification as a new kind **`illegal-transition`** (sibling to `reconciliation-drift`), which owns the retry/escalate/abort decision.

The deletion test now *fails the right way*: delete the matrix and `advance()` loses its legality net.

### 2. Status Transition Core (row altitude)

Introduce one `applyTransition` core in the Single Writer Layer (`db/writers/status.ts`) that every row-level status write funnels through. It owns:

- the write,
- the **closed→open guard, generalized** from milestone-only to task/slice/milestone,
- the completion-timestamp invariant,
- the transition journal entry,
- derived-cache invalidation.

`updateTaskStatus`/`updateSliceStatus`/`updateMilestoneStatus` — the single-row primitives the Single Writer decision keeps public — become **thin entity-typed faces** that delegate to the core. Their signatures are preserved, so all 44 existing callers gain the policy with **zero call-site churn and no bypass window**. The **Hierarchy Status Cascade** ops in `db/writers/cascades.ts` (`completeSliceCascade`, `reopenSliceCascade`, …) call the core once per row inside their existing `transaction()`, so multi-row changes inherit the same guard/timestamp/journal policy without each cascade re-deriving it. This matches the ADR-017 pattern: owning modules retain raw primitives, but the policy composition lives in one place.

### 3. Status vocabulary + normalization (shared)

Define the canonical typed set and a single parse seam:

```ts
export type Status =
  | "pending" | "in_progress" | "complete"
  | "skipped" | "blocked" | "active" | "parked" | "deferred";

// the single seam where free-form DB strings enter the typed domain.
// maps aliases to canonical (done/closed → complete, planned → pending);
// quarantines unknown values instead of forcing a data migration.
export function toStatus(raw: string): Status;
```

- The closed-status predicates **and** `TERMINAL_STATUS_SQL` derive from this one source, replacing the coincidentally-agreeing duplicates and the ~57 inline re-derivations.
- The DB column **stays free-form `string`** so legacy/imported values still load. The typed vocabulary governs the in-memory domain.
- The Status Transition Core (2) writes canonical, so the store **converges to canonical over time** without a data migration — respecting the DB-is-source-of-truth drift invariant (ADR-017).

### Sequencing

3 → 2 → 1. The vocabulary (3) is what the others lean on; the core (2) consumes `Status`/`toStatus`; the Phase guard (1) is independent and can land anytime. Typing the faces as `Status` in step 2 turns every site that writes an alias (`"done"`, etc.) into a compile error — each a latent bug surfaced, which is bounded, valuable churn.

## Implementation status (updated 2026-07-02)

Landed:

- **③ Vocabulary** — `Status`, `toStatus`, `RAW_CLOSED_STATUSES` in `status-guards.ts`; `TERMINAL_STATUS_SQL` derived from the single source. `isClosedStatus` is behavior-preserving.
- **② Core** — `applyStatusTransition` in `db/writers/status.ts`; the three `update*Status` faces delegate; the milestone closed→open guard moved into the core. Behavior-neutral.
- **① Phase guard** — `isLegalEdge` + `IllegalPhaseTransitionError` in `state-transition-matrix.ts`; `illegal-transition` recovery kind recognized by class; `advance()` carries `lastDerivedPhase` (reset on start/resume/stop) and checks the edge after reconciliation.
- **Read-side SQL adoption** — active milestone/slice/task selection and slice task counts in the Query Module now use `TERMINAL_STATUS_SQL` instead of re-deriving partial closed-status literals, so `closed`/`skipped` aliases cannot drift from `isClosedStatus`.

Deferred, with reasons (each a clean follow-up):

- **Phase guard runs in ADVISORY mode, not enforcing.** The matrix is a sparse hardening spec, not a complete legal-edge graph; `deriveState` emits edges the matrix never enumerates (`planning→replanning-slice`, `executing→escalating-task`, `executing→evaluating-gates`, …). Enforcing now would false-positive and stall the loop. `advance()` logs `phase-transition-advisory` telemetry instead of throwing. Enforcement is a one-line flip (`throw violation;`) once the matrix is expanded into a validated graph against observed phase sequences.
- **closed→open guard stays milestone-only.** Four legitimate reopen callers (`undo`, `tools/reopen-task`, `auto-post-unit`, `tools/plan-slice`) move task/slice entities to open statuses through the generic faces. Generalizing safely needs sanctioned `reopenTaskStatus`/`reopenSliceStatus` faces first, mirroring `updateMilestoneStatus`/`reopenMilestoneStatus`.
- **No write-normalization via `toStatus`.** `workflow-reconcile` replays journal events that write raw `"done"`/`"in-progress"`, and tests assert those stored values; converging on write is a separate, behavior-sensitive change (normalize the replay/import sources first). `toStatus` is wired and tested for read-side adoption.

## Consequences

- `state-transition-matrix.ts` becomes live code with a real caller; its test surface shifts from "matrix is well-formed" to "`advance()` rejects illegal edges and routes them to Recovery Classification."
- Recovery Classification gains the `illegal-transition` kind in its taxonomy (`recovery-classification.ts`).
- `advance()` gains one field (`lastDerivedPhase`) and one guard step; the guard is a no-op on self-edges and on the first advance of a session.
- `db/writers/status.ts` gains the `applyTransition` core; the three update functions shrink to faces; `db/writers/cascades.ts` ops call the core per row. The closed→open guard now protects tasks and slices, not just milestones. The structural invariant (`tests/single-writer-invariant.test.ts`) is satisfied — the new write policy lives under `db/writers/`.
- A new `Status` type and `toStatus` parse land; `isClosedStatus`/`TERMINAL_STATUS_SQL` and the ~57 inline comparisons collapse onto the single source over time.
- The Phase guard's detector cost is one edge lookup per `advance()` tick — negligible.

## Alternatives considered

- **Delete the matrix.** `deriveState` + reconciliation already encode the guards the matrix states in prose, so the matrix is partly a cross-check of existing logic. Rejected: the cross-check has value (it catches illegal *derived* jumps such as `executing → complete` skipping validation that no single reconciliation repair would flag), and wiring it in is cheap. Deletion stays the fallback if the invariant proves noisy.
- **Re-express the matrix over entity status and enforce it at the write path.** Rejected as a category error: a task going `pending → complete` is not a Phase transition. Phase and status are genuinely different altitudes; collapsing them would force row writes through a milestone-lifecycle table.
- **Event-keyed guard** (keep `findTransition(from, event)`; have `deriveState` emit a transition event). Rejected: re-plumbs the matrix into the derivation path, pulling it back toward being a second decision-maker. The edge-keyed assertion needs no change to `deriveState`.
- **Recover `from` from the transition journal** so the first post-resume advance is still guarded. Rejected for now in favor of the in-memory field (reset on pause): simpler, matches the existing `lastAdvanceKey` lifecycle, and a skipped check on the first advance is low-risk. Revisit if post-resume illegal edges are observed.
- **Full per-entity status transition table** (a second matrix at row altitude). Rejected as likely shallow — an interface as wide as its implementation, most entries encoding transitions nothing attempts. Only the closed→open rule has demonstrated bug-history value; build that, not a speculative table.
- **Pure-plumbing chokepoint** (no row legality; lean on the Phase guard). Rejected: under-enforces — a wrongly-reset task status often will not surface as an illegal Phase edge.
- **One public `applyStatusTransition` verb; migrate all 44 sites.** Rejected: a large risky diff across recovery/undo/import/reconcile, plus a bypass window until every site is migrated. The faces-over-core shape gets the locality win immediately.
- **Strict `type Status` with a one-time DB migration to canonical.** Rejected: a data migration on user DBs is in direct tension with the DB-is-source-of-truth drift invariant and breaks tolerance for future legacy imports. Normalize-on-read converges without the migration.
- **Tolerant `string` + single source, no `type Status`.** Rejected as a partial win: kills the duplication but leaves writes able to pass a typo'd or non-canonical string. The typed vocabulary plus `toStatus` is the deeper seam.
