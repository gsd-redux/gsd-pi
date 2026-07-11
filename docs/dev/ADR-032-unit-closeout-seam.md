<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for the Unit Closeout module — one closeout seam shared by the auto and interactive execution paths. -->

# ADR-032: Unit Closeout Module — One Seam, Two Adapters

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Superseded.** The diagnosis that all execution paths need one closeout boundary remains valid. The Unit Closeout module contract is replaced by persisted `prepareCloseout` and `settleCloseout`, with required effects proven by Settlement Receipts before completion unlocks dependencies.

**Status:** Accepted
**Date:** 2026-06-10
**Author:** GSD architecture review
**Related:** ADR-014 (Auto Orchestration deep module), ADR-016 (worktree safety fail-closed), ADR-025 (Closeout Consistency Gate), ADR-031 (worktree placement), CONTEXT.md "Worktree Lifecycle module"

## Context

### The closeout behaviour has one adapter

Everything that makes a Unit's completion *durable* lives only on the auto path:

| Behaviour | Owner | Invoked from |
|---|---|---|
| auto-commit | `auto-post-unit.ts:1012` (`autoCommitUnit`) | `postUnitPreVerification`, `auto/phases.ts` |
| state rebuild + projection | `auto-post-unit.ts:1322` (`rebuildState`) | `postUnitPreVerification` |
| artifact verification | `auto-post-unit.ts:2216` (`postUnitPostVerification`) | `auto/phases.ts runFinalize` |
| Post-Unit Hooks | `post-unit-hooks.ts:21` | `auto-post-unit.ts:2257` only |
| metrics / activity / memory extraction | `auto-unit-closeout.ts:82` (`closeoutUnit`) | auto loop + timers only |
| milestone merge / push / PR | `worktree-lifecycle.ts` (`exitMilestone`) → `milestone-merge-transaction.ts` default adapter → `auto-worktree.ts` legacy merge primitive | `auto/phases.ts` (4 sites) |

An interactive session completes the same Units through the same MCP tools
(`tools/complete-task.ts`, `complete-slice.ts`, `complete-milestone.ts`), which
are pure DB-write + projection executors. None of the table above runs.

### The failure this produces

Observed 2026-06-10 (`test-apps/357`): a project configured
`git.isolation: worktree` completed milestone M001 interactively. No worktree
was entered, no commit was made, no merge happened — the milestone "completed"
with every source file untracked on `main`, and the agent's closing message
asked the user to `git add` by hand. The isolation preference was read by
nothing on the path that ran.

This is the deletion test failing in the codebase's favour: the closeout
complexity demonstrably reappears (as a silent gap) on every execution path
that doesn't share the module.

### Why the fix is a seam, not a patch

Patching `tools/complete-milestone.ts` to also commit would create a second,
divergent copy of commit/projection/hook logic — and it would run in the wrong
process: the MCP workflow tools execute in the MCP server child, while git
ownership, the write-gate's in-memory state, and `closeoutUnit` all live in
the extension host (see the two-process write-gate sync issues, #4950). The
closeout belongs at a host-side seam both paths already cross.

## Decision

### 1. One Unit Closeout module

A new module owns the closeout pipeline behind one interface:

```ts
closeUnit(request: UnitCloseoutRequest): Promise<UnitCloseoutResult>

interface UnitCloseoutRequest {
  basePath: string;
  unitType: UnitType;
  unitId: string;            // "M001" | "M001/S01" | "M001/S01/T01"
  boundary: "task" | "slice" | "milestone";
  outcome: "complete" | "failed" | "skipped";
}
```

Behind the interface, in order: commit → state rebuild → projection →
artifact verification → Post-Unit Hooks → metrics/activity/memory
(`closeoutUnit`) → boundary git action (merge via `exitMilestone` when
`boundary === "milestone"`, then Publication per ADR-034).

### 2. Two adapters make the seam real

- **Auto Closeout adapter** — the existing pipeline
  (`postUnitPreVerification` / `postUnitPostVerification` /
  `runFinalize` choreography), re-housed behind `closeUnit`. Behaviour-neutral
  re-seating; the auto loop keeps its retry/recovery routing around the call.
- **Interactive Closeout adapter** — runs the durable subset: commit,
  state rebuild, projection, Post-Unit Hooks, `closeoutUnit`. For milestone
  boundaries under `git.isolation: worktree`/`branch` it applies the
  fail-closed rule (§4).

### 3. Trigger: host-side tool-completion hook, guarded by `isAutoActive()`

The MCP workflow tools run on *both* paths — in auto mode the engine performs
closeout after the tool returns. To avoid double-closeout:

- The interactive adapter attaches at the host's existing tool-observation
  seam (`register-hooks.ts`), reacting only to the milestone closeout tool
  (`gsd_complete_milestone`). Committing at every task/slice would sweep a
  developer's unrelated working-tree changes, and the durability gap that
  motivated this ADR is the milestone close.
- It is a no-op when `isAutoActive()` (auto.ts) — the engine owns closeout.
- `closeUnit` keeps no result cache. Re-entrancy is naturally safe: a re-fire
  commits an already-clean tree (`nothing-to-commit`) and `appendNotification`
  carries its own dedup window.

### 4. Fail-closed, not silent — the Closeout Git Verdict

Extending ADR-016's fail-closed principle to completion: when the interactive
adapter closes a milestone boundary and `git.isolation !== "none"`, it
computes a **Closeout Git Verdict**:

- Work already in a proven milestone worktree/branch → merge via the
  Worktree Lifecycle `exitMilestone` verb. Auto-mode closeout uses the same
  verb with its guarded merge option for preflight/postflight stash discipline.
- Work on the integration branch with uncommitted changes (the observed
  failure) → commit on the current branch, record the verdict as
  `isolation-bypassed`, and surface a **Needs Attention** notice naming the
  unhonoured preference. The milestone still completes — blocking a
  retroactive completion would strand state — but the gap is loud, recorded,
  and queryable instead of invisible.

### 5. What does NOT move

- Dispatch, recovery routing, and retry policy stay in the auto loop /
  Recovery Classification. `closeUnit` returns typed failures; it does not
  decide retry/escalate/abort.
- The DB writes inside the tool executors stay where they are (Single Writer
  Layer discipline). Closeout consumes their result; it does not re-do them.

## Consequences

- **Leverage:** one interface, two execution paths; future paths (parallel
  orchestrators already half-duplicate this) get closeout by adapter, not by
  copy.
- **Locality:** the commit→rebuild→project→verify→hooks→metrics dance has one
  home; #4704-class ordering bugs (memory-extractor racing the merge
  boundary) are fixed once.
- **Tests hit the interface:** closeout tests construct a
  `UnitCloseoutRequest` instead of an 800-line pipeline fixture; the
  interactive adapter is testable without the auto engine.
- **Migration order:** re-seat the auto pipeline first (behaviour-neutral),
  then add the interactive adapter. The Closeout Consistency Gate (ADR-025)
  applies to both adapters from day one.

## Implementation status (2026-06-10)

**Shipped this pass** (`unit-closeout.ts` + `tests/unit-closeout.test.ts` +
hook wiring in `bootstrap/register-hooks.ts`):

- The Unit Closeout module with `closeUnit(request)` — no result cache;
  re-entrancy is absorbed by git (a re-fire over a clean tree is
  `nothing-to-commit`) — and the **Interactive Closeout adapter**: triggered
  from the host's `tool_result` observation hook for the milestone closeout tool
  (`gsd_complete_milestone`) only, no-op while `isAutoActive()`, deps-injectable
  for tests. Task/slice completions are intentionally not committed interactively
  so a developer's unrelated working-tree changes are never swept; `closeUnit`
  itself stays general over all boundaries for the Auto Closeout adapter re-seat.
- The Closeout Git Verdict: commit on the current branch, then for milestone
  boundaries under non-`none` isolation either defer the merge to worktree
  tooling (`milestone-branch`) or fail closed loudly (`isolation-bypassed` —
  Needs Attention notice via the notification store naming the unhonoured
  preference). Commits use the canonical unit types so interactive closeout
  commits carry the same `GSD-Unit` evidence trailers verification looks for.

**Order deviation from §"Migration order", recorded deliberately:** the ADR
sketched re-seating the auto pipeline first. The interactive adapter shipped
first instead — it is the user-visible bug fix, it is bounded, and the
`isAutoActive()` guard means auto-mode behaviour is untouched. Re-seating the
auto choreography (`postUnitPreVerification` / `postUnitPostVerification` /
`runFinalize`) behind `closeUnit` is the remaining step, and is larger than
first sketched: the retry/dispatch routing *between* pre- and post-verification
in `runFinalize` has to stay outside the seam (closeout reports; Recovery
decides), so the re-seat needs a two-stage interface or a callback contract —
design that against ADR-014's `advance()` pipeline when it lands.

**Also deferred:** the interactive adapter's full-merge path for work already
on a milestone worktree/branch (calls into `exitMilestone` with its `chdir`
discipline are not safe from a tool hook without the auto machinery's state
sync), and interactive Post-Unit Hooks / `closeoutUnit` metrics (memory
extraction runs an LLM call — wrong cost profile for a synchronous tool hook).
