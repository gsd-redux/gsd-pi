# Closeout Consistency Gate

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Retained and generalized.** Fail-closed canonical database proof remains required. One project database replaces worktree-database reconciliation, and persisted Closeout Plans, fencing, and Settlement Receipts must prove required effects before completion unlocks dependencies.

Closeout finalization, worktree merge, and all-complete stop paths must prove canonical DB closeout after any deterministic reconciliation attempt. Markdown summaries and projections may explain or support recovery, but they cannot authorize destructive closeout actions when the canonical DB still shows open milestones, slices, tasks, or quality gates.

In worktree mode, the canonical DB for this gate is the project-root DB after worktree DB reconciliation, not the worktree DB alone. If reconciliation fails or the project-root DB still shows open closeout state, the gate fails closed even when the worktree DB or markdown artifacts look complete.

Failures surface as Needs Attention with a `closeout-consistency-blocked` recovery reason after at most one deterministic reconciliation attempt. They must not enter generic provider retry handling or be reported as ordinary git merge failures.

This intentionally rejects permissive recovery from success-looking artifacts in favor of failing closed before merge or all-complete notification. The trade-off is that rare transient DB lag may require an explicit retry or recovery step, but the runtime will not silently merge or stop from a split-brain state.
