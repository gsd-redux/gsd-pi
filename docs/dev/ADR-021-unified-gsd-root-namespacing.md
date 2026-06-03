# ADR-021: Unified `.gsd/` root with platform sub-namespaces for cross-platform compatibility

**Status:** Proposed
**Date:** 2026-06-02
**Related:** open-gsd/gsd-pi#430 (originating enhancement) · open-gsd/gsd-core#627 + gsd-core `docs/adr/627-unified-gsd-root-namespacing.md` (sibling decision) · ADR-002 (external-state-directory) · ADR-016 (worktree-lifecycle-and-projection) · ADR-016 (worktree-safety-fail-closed)
**Deciders:** gsd-pi maintainers, gsd-core maintainers

> This is the gsd-pi side of a coordinated, two-repo decision. The gsd-core sibling is open-gsd/gsd-core#627 (ADR committed there as `docs/adr/627-unified-gsd-root-namespacing.md`). Both must stay in lockstep on the `.gsd/<platform>/` convention.

## Context

gsd-pi and gsd-core are sibling platforms in the GSD family. Each persists its long-horizon runtime state in a different top-level directory at the repo root:

- gsd-pi → `.gsd/`.
- gsd-core → `.planning/` — gitignored, local-only, resolved through a single path-projection seam (gsd-core ADR-0006).

These roots are conceptually parallel — both are "the agent's long-horizon working memory" — but they share no convention. A single repository cannot cleanly host both platforms, and a user who wants to move a project from gsd-core to gsd-pi (or run both) has no defined migration path; they end up with two unrelated top-level directories. Both platforms are built around autonomous, long-running operation, which makes a durable, predictable on-disk home for state — and for the worktrees agents run in — a shared concern.

Separately, agent worktree storage that lands in `/tmp` is not durable across reboots (a poor fit for multi-hour autonomous runs) and is not guaranteed to share a filesystem with the repo.

## Decision

Adopt a **single `.gsd/` root at the repo root, partitioned by platform**, shared by convention across the GSD family:

```
.gsd/
├── gsd-core/                 # gsd-core runtime state (formerly .planning/)
├── gsd-pi/                   # gsd-pi runtime state
└── gsd-worktree/             # shared, gitignored, ephemeral agent worktrees
    ├── gsd-core/agent-<id>/  # per-platform leaf
    └── gsd-pi/agent-<id>/
```

1. **gsd-pi formalizes its state under `.gsd/gsd-pi/`** — the per-platform namespace — rather than the bare `.gsd/` root, reserving the root for the shared convention.
2. **gsd-core relocates `.planning/` → `.gsd/gsd-core/`** behind its existing projection seam (its side; gsd-core#627).
3. **Agent worktrees move to a per-platform leaf `.gsd/gsd-worktree/<platform>/`** — gitignored, co-located on the repo filesystem, platform-neutral — replacing `/tmp`. Keeping the leaf namespaced per platform means each platform's garbage collection only ever touches its own worktrees and can never reap a concurrent platform's live worktree.

Keeping the **root shared and the leaf namespaced** is what lets both platforms occupy the same working tree without collision and gives migration tooling a deterministic mapping (`.gsd/gsd-core/ ⇄ .gsd/gsd-pi/`).

### Worktree location — options evaluated

| Option | Pros | Cons |
|---|---|---|
| **`/tmp` / `$TMPDIR`** | OS auto-cleanup; never git-tracked | Lost on reboot (kills resumable long runs); possibly different filesystem; not co-located; not a portable cross-platform concept |
| **Tool-specific dir** (e.g. an agent harness's own worktree dir) | Co-located, same filesystem | Harness-specific; not portable across platforms |
| **Single shared `.gsd/gsd-worktree/` pool** | Co-located; one directory | One platform's GC can reap the other's live worktree |
| **`.gsd/gsd-worktree/<platform>/`** (chosen) | Co-located & same filesystem (fast adds, no cross-device edge cases); unified under the shared root; platform-neutral; per-platform GC isolation; gitignorable; reboot-durable; visible for debugging | Must be gitignored; nested-worktree-in-repo needs care; not OS-cleaned — needs explicit lock/heartbeat GC |

**Chosen: `.gsd/gsd-worktree/<platform>/`** — the only option that is co-located (same filesystem as the repo), reboot-durable, and platform-neutral at once, with per-platform GC isolation.

### Worktree garbage collection — lock/heartbeat

The OS gave `/tmp` free liveness (reboot wipes it); a repo-local directory does not, so GC needs an explicit liveness signal to avoid deleting a worktree a concurrent run is using:

- The owning agent writes a **lock/heartbeat file** into its worktree for the life of its run.
- A **GC sweep runs at the start of any worktree-creating command**, scoped to the current platform's leaf only, and removes an `agent-<id>/` directory only when **both** its owning branch is merged/absent **and** its lock is stale/dead.
- **mtime-TTL is a crash backstop** for locks orphaned by a hard kill — not the primary signal.

Chosen over branch-state-only (cannot distinguish a live-but-unmerged run from an abandoned one) and TTL-only (reaps a long quiet run mid-flight).

## Consequences

- **Positive.** One cross-platform on-disk contract both platforms honor; a real migration path between them; reboot-durable worktrees on a guaranteed-local filesystem; per-platform GC isolation; one worktree convention.
- **Negative / cost.** gsd-pi must formalize state under `.gsd/gsd-pi/` and point worktrees at `.gsd/gsd-worktree/gsd-pi/`; add `.gsd/gsd-worktree/` to ignore rules; add lock/heartbeat GC (this directory is not OS-cleaned). On the gsd-core side, a one-time local relocation of `.planning/` (no committed-history break — it is gitignored).
- **Coordination.** Both platforms must keep the `.gsd/<platform>/` convention in lockstep; this ADR and the gsd-core sibling (open-gsd/gsd-core#627) are the coordination record.

## Alternatives Considered

- **Status quo (`.gsd/` for pi, `.planning/` for core, separate).** No migration cost, but permanently blocks interop and migration — the whole motivation.
- **Both platforms share a bare `.gsd/` root with no sub-namespace.** State collides; dual-hosting is impossible. The `gsd-pi/`/`gsd-core/` leaf is what prevents collision.
- **Symlink / dual-read compatibility shim** as the end state. Solves cross-clone propagation of a committed path — not a problem for gitignored local-only state — at the cost of fragility (Windows, archives, CI) or two code paths.
- **Worktrees on `/tmp`, or under a tool-specific dir, or in a single shared pool.** Rejected for the reasons in the options table above (reboot-fragility, non-portability, and cross-platform GC cross-talk respectively).
- **Worktree GC by branch-state-only or mtime-TTL-only.** Rejected as primary signals in favor of lock/heartbeat (TTL kept as a crash backstop).

## Validation

- Decision shape and the worktree-location trade-offs were stress-tested via a grilling pass against the gsd-core codebase (confirmed `.planning/` is gitignored/local-only, which is what makes gsd-core's migration a local `fs.rename` rather than a git operation).
- Cross-checked against gsd-pi's existing worktree ADRs (ADR-016 lifecycle/projection and worktree-safety-fail-closed) and external-state ADR-002.

## Action Items

- [ ] Confirm gsd-pi's state-directory resolution centralizes on `.gsd/gsd-pi/` (single seam), mirroring gsd-core ADR-0006.
- [ ] Point gsd-pi agent worktrees at `.gsd/gsd-worktree/gsd-pi/`; add ignore rule for `.gsd/gsd-worktree/`.
- [ ] Implement lock/heartbeat GC scoped to the gsd-pi leaf.
- [ ] Keep the `.gsd/<platform>/` convention synchronized with gsd-core (open-gsd/gsd-core#627).
