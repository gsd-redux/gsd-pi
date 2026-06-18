# ADR-036: Tool Surface Readiness — close the MCP startup race at two altitudes

**Status:** Accepted (implemented)
**Date:** 2026-06-10
**Deciders:** Jeremy McSpadden
**Related:** ADR-008 (workflow tools over MCP for provider parity), ADR-015 (runtime invariant modules: Tool Contract, Recovery Classification)

## Context

The workflow MCP server (`packages/mcp-server`) registers the 29-tool workflow surface for SDK-driven Claude Code sessions, but it connects **asynchronously after session start**. A Unit whose prompt requires `gsd_uat_exec` could begin its first model turn before the server finished registering; the model then hit `No such tool available: mcp__gsd-workflow__gsd_uat_exec` mid-Unit and improvised (e.g. running UAT checks through Bash, silently skipping the typed evidence and journal writes that `gsd_uat_exec` owns).

Four independent gaps let the race through:

1. The ADR-008 phase-5 pre-dispatch gate (`getWorkflowTransportSupportError`) is **static** — it proves the MCP launch config is discoverable and the required names belong to a compiled-in surface list. It never observes the live session's registered tools, because at pre-dispatch time the session does not exist yet.
2. `"No such tool available"` was pattern-matched (`auto-tool-tracking.ts`) but lumped into the **deterministic** invocation-error bucket: auto-mode paused with "retrying cannot resolve this deterministic failure" — exactly backwards for a transient startup race. Recovery Classification had no kind for it.
3. The MCP server **lazy-loaded** its executor and write-gate bridges on first tool call, so a broken bridge connected cleanly and advertised tools that all error mid-Unit.
4. Tool **naming knowledge** was spread across four homes (contracts package, hand-maintained per-Unit string lists, two MCP-prefix parser implementations, hardcoded test strings), so drift between a Unit's required list and the real surface failed at runtime, not typecheck.

## Decision

Enforce tool availability at **two altitudes**, classify the race as **transient**, and make the server **fail closed**:

1. **Static altitude (unchanged seam).** `getWorkflowTransportSupportError` stays the pre-dispatch fast path: launch-config discoverability and name membership.
2. **Runtime altitude — Tool Surface Readiness.** The Tool Contract module gains a runtime face, `getToolSurfaceReadinessError` (`tool-surface-readiness.ts`). The claude-code stream adapter checks the SDK init message's live `tools` and `mcp_servers` statuses against the Unit's required workflow tools and **aborts before the first model turn** when the workflow server failed or has not registered a required tool. The init message is the one observation point where the session reports its live surface.
3. **`tool-unavailable` Recovery kind.** The readiness abort and the raw `No such tool available` error both classify as `tool-unavailable` → `retry` (own exit reason / telemetry bucket). `error-classifier` treats the readiness phrase as transient (same-model retry, short delay); post-unit verification routes the raw error into the existing **bounded** verification retry instead of pausing. The system retries; the model never improvises.
4. **Workflow bridge warm-up (fail closed).** The stdio CLI eagerly loads and shape-checks the executor and write-gate bridges at startup (`warmWorkflowToolBridges`). A broken bridge fails the spawn with the actionable bridge error — visible in the SDK's MCP server status, where the runtime gate (2) turns it into a typed pre-turn failure. A healthy spawn pre-pays the bridge import, shrinking the race window.
5. **One naming seam.** Per-Unit tool lists are typed against the literal `CanonicalWorkflowToolName` union derived from `WORKFLOW_TOOL_CONTRACTS`, so name drift fails `tsc`. MCP tool-name parsing has one implementation (`@gsd/pi-ai`); the gsd extension re-exports a typed face over it.

The cross-module phrase contract (`workflow tool surface not ready` recognized by `isToolUnavailableError`, `classifyError`, and `classifyFailure`) is pinned by `tests/tool-surface-readiness.test.ts`.

## Why this decision

- **The interface is the test surface.** Readiness is testable with fake observations (`{tools, mcpServers}`) — no live SDK session needed. The classification chain is table-driven.
- **Deletion test.** Deleting the readiness face re-scatters availability knowledge across the stream adapter, four dispatch sites, and post-unit recovery — where it lived before, as bugs.
- **Fail closed matches the Worktree Safety posture** (ADR-016): a server that cannot execute its advertised mutation tools must not present that surface.
- A retry-after-abort costs one session spawn; an improvised mid-Unit fallback costs silent evidence loss and a human triage loop.

## Trade-offs accepted

- **Amended 2026-06-16:** the workflow surface is now required before Claude Code proceeds. The gate aborts on any non-`connected` workflow server status, including `pending`, and routes the abort through `tool-unavailable` retry classification. This supersedes the 2026-06-10 temporary pending pass-through and restores the pre-turn invariant that a Unit cannot begin while its required workflow MCP tools are still pending.
- The stdio CLI now refuses to start when the workflow bridge is unloadable, even for read-only/session-control use. Every supported launch path (stream-adapter env injection, `gsd mcp init` config, repo checkout, built package) has a loadable bridge; a hand-rolled config without one gets the actionable remediation at spawn time instead of a dead tool surface.
- The stdio CLI registers a single live MCP process per `GSD_WORKFLOW_PROJECT_ROOT` in `$GSD_HOME/mcp-instances.json`, terminates verified stale GSD MCP PIDs for the same project at startup, unregisters on shutdown, and exits orphaned stdio children after five minutes of input idle time.
- The four static-gate call sites are not folded into one helper this pass — they share `getWorkflowTransportSupportError` already; folding their option-plumbing is cosmetic and touches four hot dispatch paths. Deferred.

## Implementation status

| Piece | Status | Evidence |
|---|---|---|
| Tool Surface Readiness gate | ✅ | `src/resources/extensions/gsd/tool-surface-readiness.ts`; wired in `claude-code-cli/stream-adapter.ts` (`case "system"`) |
| `tool-unavailable` Recovery kind | ✅ | `recovery-classification.ts`; transient routing in `auto-post-unit.ts`; `error-classifier.ts` |
| Workflow bridge warm-up | ✅ | `packages/mcp-server/src/workflow-tools.ts` (`warmWorkflowToolBridges`); `packages/mcp-server/src/cli-runner.ts` fails spawn before connect on broken bridge |
| MCP PID registry and orphan watchdog | ✅ | `packages/mcp-server/src/pid-registry.ts`; `packages/mcp-server/src/stdio-watchdog.ts`; wired through `packages/mcp-server/src/cli-runner.ts` |
| Probe-mode stdio (no PID registry side effects) | ✅ | `packages/mcp-server/src/probe-mode.ts`; `testMcpServerConnection` sets `GSD_MCP_PROBE=1`; `cli-runner.ts` skips register/unregister in probe sessions |
| Typed naming seam | ✅ | `@opengsd/contracts` `CanonicalWorkflowToolName`; `unit-tool-contracts.ts` typed lists; parser delegated to `@gsd/pi-ai` |
| Static-gate call-site fold | ⏸ deferred | see trade-offs |
