<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for finishing Worktree Lifecycle ownership of the merge verb and extracting the Publication module (push/PR). -->

# ADR-034: Finish the Merge Verb; Split Publication Out

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Amended and retained.** Merge and publication remain separate mechanics. Required source, worktree, and Git effects settle with receipts before completion; publication remains non-authoritative and follows explicit consent and policy.

**Status:** Accepted
**Date:** 2026-06-10
**Author:** GSD architecture review
**Related:** ADR-016 (worktree lifecycle and projection), ADR-025 (Closeout Consistency Gate), ADR-031 (worktree placement), ADR-032 (Unit Closeout module)

## Context

### The recorded owner and the actual owner disagree

CONTEXT.md names the Worktree Lifecycle module "sole owner of worktree
create/enter/teardown/merge verbs." `exitMilestone` shipped
(`worktree-lifecycle.ts`) and callers route through it — but the verb's
production runner still reaches `mergeMilestoneToMain` through
`createDefaultMilestoneMergeTransaction()`: an inner function that owns, in one
implementation:

- dirty-state commit
- the squash merge itself, conflict handling
- publication handoff to `publishMilestone` when `prefs.auto_push` /
  `prefs.auto_pr` apply

Above it, the auto closeout adapter still translates merge outcomes into loop
policy, but the stash-restore choreography itself now enters the Worktree
Lifecycle module through the `exitMilestone(..., { merge: true, guardedMerge })` interface.
The lifecycle verb owns the preflight → merge → postflight ordering, including
the invariant that a successful local merge is recorded before a postflight
stash recovery stop.

### Two distinct concerns fused

Merging a milestone branch into the integration branch is a *worktree
lifecycle* concern: it needs the worktree, the branch, the lease, the stash
discipline. Pushing and opening a PR are *publication* concerns: they need a
remote, credentials, and preferences — and nothing from the worktree beyond
the resulting commit. Fusing them means publication cannot be tested without
a full merge fixture, and no other path (notably the interactive adapter of
ADR-032) can publish without dragging the merge machinery along.

## Decision

### 1. The merge verb's full contract moves inside Worktree Lifecycle

The Worktree Lifecycle module absorbs the stash-restore choreography that the
auto closeout path used to carry inline. The guarded path now enters through
`exitMilestone(..., { merge: true, guardedMerge })`, so the merge verb owns preflight
dirty/conflict checks, always-attempted postflight stash restore after an
attempted merge, and typed merge/postflight results. The remaining end-state is
to move the merge implementation (dirty-commit, squash, conflict
classification) out of `auto-worktree.ts`, making the CONTEXT.md ownership
statement true.

Conflict outcomes remain typed results handed to Recovery Classification —
the verb reports; it does not decide retry/stop.

### 2. Publication becomes its own module

```ts
// publication.ts
publish(request: PublicationRequest): Promise<PublicationResult>

interface PublicationRequest {
  basePath: string;
  branch: string;           // what to push
  milestoneId: string;
  prefs: { autoPush: boolean; autoPr: boolean };
}
// PublicationResult: { pushed, prCreated, prUrl?, error? }
```

`exitMilestone` stops knowing about remotes. The Unit Closeout module
(ADR-032) calls `publish` after a successful milestone merge — on either
adapter. Publication failures are non-fatal to the merge: the milestone is
merged locally; the result records what publication achieved.

### 3. Substitutability

Two adapters justify the seam: the real `gh`/git-push implementation in
production, and an in-memory recorder in tests. Merge tests stop needing
network/credential stubs; publication tests stop needing merge fixtures.

## Consequences

- **Locality:** merge bugs (stash, dirty-tree, conflict ordering — the #4704
  class) concentrate in the Worktree Lifecycle module; publication bugs
  (auth, remote, `gh` availability) concentrate in Publication.
- **Lifecycle-owned guard ordering.** The preflight/merge/postflight stash
  discipline is now shared behind the Worktree Lifecycle seam instead of being
  open-coded in auto closeout.
- **`mergeMilestoneToMain` shrinks** from 875 lines to a merge core; the
  push/PR tail (~100 lines) moves behind `publish`.
- **Interactive parity:** ADR-032's interactive adapter publishes through the
  same seam auto mode uses — `auto_push`/`auto_pr` stop being auto-only
  preferences in practice.
- **Migration order:** extract Publication first (mechanical tail-split, low
  blast radius), move the stash choreography behind the Lifecycle seam, fold it
  into `exitMilestone`, then relocate the merge core. Each step is
  independently shippable and behaviour-neutral.

## Implementation status (2026-06-10)

**Shipped 2026-06-10:** step 1 of the migration — `publication.ts`
(`publishMilestone`, `gitRemoteExists`) extracted from the tail of
`mergeMilestoneToMain`, behaviour-neutral (same gating truth table, same
non-fatal failure handling, same log messages). Tested against local bare-
remote git fixtures (`tests/publication.test.ts`) — push, suppression under
auto-PR, nothing-to-commit short-circuit, missing remote.

**Shipped 2026-07-02:** the stash guard moved behind the Worktree Lifecycle
seam. Auto closeout first consumed it through the internal
`runGuardedMilestoneMerge` helper, then the guard was folded into the
`exitMilestone(..., { merge: true, guardedMerge })` interface. Auto closeout now consumes
the lifecycle verb's typed result instead of owning the merge transaction
ordering directly, and marks the milestone merge complete before stopping for
postflight stash recovery so a resume does not re-run an already completed
merge.

**Shipped 2026-07-02:** production construction of the merge transaction moved
behind `createDefaultMilestoneMergeTransaction()`. Auto-mode wiring and the
orchestrator no longer import the legacy `auto-worktree.ts` merge primitive
directly; the Milestone Merge Transaction module is now the single production
adapter that knows how to build the lifecycle-compatible runner from the legacy
implementation.

**Remaining:** relocate the merge core out of `auto-worktree.ts` into the
Worktree Lifecycle module.
