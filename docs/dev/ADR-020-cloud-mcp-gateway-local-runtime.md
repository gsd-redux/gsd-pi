# ADR-020: Cloud MCP Gateway with Local GSD Runtime

**Status:** Superseded
**Date:** 2026-05-25
**Superseded:** 2026-08-10

The Cloud MCP Gateway, standalone cloud agent, and monitor described by this
decision were retired from this repository. This ADR remains as historical
context and no longer describes a supported product surface.

GSD will introduce a Cloud MCP Gateway that mirrors the existing GSD MCP tool surface while forwarding execution to a paired Local GSD Runtime over an outbound WebSocket tunnel. This keeps source files, `.gsd` artifacts, provider credentials, git worktrees, and process execution local while giving remote MCP clients a stable Streamable HTTP endpoint.

The alternative was to run GSD workflows fully in the cloud, but that would force early decisions about hosted workspace custody, git credentials, sandboxing, secret storage, and multi-tenant execution. The hybrid gateway is intentionally a live routing layer, not a hosted execution service or durable job queue; if no Local GSD Runtime is connected, calls fail fast.
