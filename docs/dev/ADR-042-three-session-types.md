# ADR-042: Three Session Types — SessionManager, AgentSession, AutoSession

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Amended and retained.** Session-type separation and host lifecycle ownership remain valid. `AutoSession` and other process-local session state cannot own durable workflow lifecycle; the project database and Lifecycle Kernel do.

**Status:** Accepted  
**Date:** 2026-06-28  
**Context:** Pi/TUI state refactor Phase 0

## Problem

The codebase uses "session" for three distinct concepts. Conflating them leads to god objects, module-level TUI state, and unsafe merges between persistence, runtime, and GSD workflow layers.

## Decision

Keep three separate types with explicit boundaries. Do **not** merge them into a single Session class.

### 1. `SessionManager` (pi-coding-agent)

- **Owns:** JSONL session file on disk, entry tree (id/parentId), migrations, leaf navigation, compaction entries.
- **Does not own:** LLM streaming, tool execution, extension UI, GSD workflow flags.
- **Location:** `packages/pi-coding-agent/src/core/session-manager.ts` (+ `session-manager-types.ts` for types).

### 2. `AgentSession` (agent-core / pi-coding-agent)

- **Owns:** In-memory agent runtime — model, tools, message list for the current turn, event bus (`AgentSessionEvent`), subscribe/handle pipeline.
- **References:** A `SessionManager` for persistence; writes messages and metadata back to JSONL.
- **Does not own:** TUI widgets, RPC protocol framing, GSD phase/sketch state.

### 3. `AutoSession` (GSD extensions)

- **Owns:** GSD workflow state — phases, sketch flags, tool surface snapshot, reconciliation with project DB.
- **References:** Project DB and extension dispatch; may observe `AgentSession` events but does not replace it.
- **Does not own:** Chat transcript rendering or JSONL entry structure.

## Naming rules

| Term | Meaning |
|------|---------|
| `sessionManager` | Persistence handle (`SessionManager`) |
| `session` (in TUI) | Usually `AgentSession` — check import |
| `autoSession` | GSD workflow object only |

When adding fields, ask: *Is this durable on disk, live runtime, or GSD workflow?* Put it in the matching layer.

## TUI streaming state

Per-turn transcript walker state (`StreamingRenderState`) belongs on `InteractiveMode`, not module scope in `chat-controller.ts`. It is presentation state keyed to one TUI instance, not any of the three Session types above.

## Consequences

- Phase 0 extracts types and instance-scoped TUI state without merging Session concepts.
- Phase 1 may split `SessionManager` implementation files; types stay in `session-manager-types.ts`.
- RPC and web bridges share `ExtensionUiSnapshot` for extension chrome; that snapshot is UI transport, not session persistence.

## Related

- Web state refactor (workspace store, transcript-store)
- ADR-010 (pi clean seam)
- ADR-017 (drift-driven reconciliation / AutoSession)
