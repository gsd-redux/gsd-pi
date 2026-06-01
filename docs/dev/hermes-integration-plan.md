# Hermes × GSD Platform Integration Plan

## Objective

Ship a **supported, tested integration** where [Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) is the universal front door (gateway, cron, CLI) and **GSD Pi** is the structured delivery engine (auto mode, DB state, verification gates, git history).

First usable outcome (6a): from Slack/Telegram, a user can `/gsd bind`, `/gsd auto`, see progress notifications, `/gsd cancel`, and `/gsd reply` to unblock—without reimplementing GSD auto mode in Python.

## Git Workflow

**Branch:** `feat/hermes-integration` (from `main`)

- Phase 6a/6b/6c commits land on this branch only
- Open a single PR from `feat/hermes-integration` → `main` when 6a is ready for review
- Rebase or merge `main` into the feature branch before PR if `main` has moved

## Non-Goals

- Reimplementing GSD auto mode inside Hermes Python
- Replacing Hermes gateway with GSD `remote-questions`
- Using `gsd --mode mcp` (agent tool surface)—orchestration uses **`gsd-mcp-server` only**
- Upstream ownership transfer of the plugin to Nous (docs + example config PR only)
- Full Docker E2E gateway CI on every PR

## Locked Architecture Decisions

| Area | Decision |
|------|----------|
| Success criterion | Full platform play: gateway + cron + supervision |
| Hermes integration | Deep general plugin: slash commands, `pre_llm_call` injection, memory provider (6c), background supervisor |
| Project binding | Tiered: cron explicit → slash argument → `/gsd bind` session binding → channel/thread map → profile default → fail closed |
| Read path | MCP sidecar (6a) → `gsd read --json` CLI (6c); TTL cache ~45s |
| Execution | Gateway: MCP `gsd_execute`/`gsd_status`; Cron: `gsd headless auto` |
| Plugin home | Start in `integrations/hermes/`; extract `open-gsd-hermes` pip package at 6c |
| Credentials | Config `credential_source: gsd \| hermes`; 6a=`gsd`, 6b=Hermes passthrough (allowlist) |
| Memory | Federated read (Hermes `MEMORY.md` + GSD memories); **writes only to GSD DB** |
| Notifications | Unit transitions + blockers + failures; configurable levels in 6b |
| Versioning | Bundled release train + semver range; `integration_version` when read CLI lands |

## Critical Hermes API

- **Do not** use `ContextEngine` for project snapshots — inject via **`pre_llm_call`** returning `{"context": "..."}`.
- **Do not** use `ctx.inject_message` for supervisor push — use **`ctx.dispatch_tool("send_message", ...)`** with a stored `DeliveryTarget`.

## GSD Surfaces

- Session: `gsd_execute`, `gsd_status`, `gsd_result`, `gsd_cancel`, `gsd_cancel_by_project`, `gsd_resolve_blocker`
- Read: `gsd_progress`, `gsd_roadmap`, `gsd_doctor`, `gsd_memory_query`, `gsd_memory_graph`
- Cron: `gsd headless auto --json`
- CLI (6c): `gsd read progress|roadmap|memory --json --project <path>`

## Phase 6a — Gateway MVP

Plugin at `integrations/hermes/` with binding resolver, MCP sidecar client, snapshot injection, supervisor FSM, `/gsd` slash router, gateway setup checklist.

## Phase 6b — Cron + Credentials

`cron.py`, Hermes credential passthrough, notification levels (`quiet` | `normal` | `verbose`).

## Phase 6c — Memory + Read CLI

`gsd read --json`, `MemoryProvider`, extract `open-gsd-hermes` pip package, upstream Hermes docs PR steps.

## Release Train

| Package | GSD range | Milestone |
|---------|-----------|-----------|
| `open-gsd-hermes` 1.0.x | `gsd >=2.51,<3` | 6a gateway |
| `open-gsd-hermes` 1.1.x | `gsd >=2.52,<3` | 6b cron + Hermes creds |
| `open-gsd-hermes` 1.2.x | `gsd >=2.53,<3` | 6c memory + read CLI |

## Testing

| Layer | When | What |
|-------|------|------|
| PR | Every push | Binding, snapshot golden, supervisor FSM mocks |
| Nightly | Scheduled | Real `gsd-mcp-server` + headless smoke on fixture |
| Pre-release | Manual | Gateway checklist on Slack/Telegram |

## Key References

- [`packages/mcp-server/README.md`](../../packages/mcp-server/README.md)
- [`packages/mcp-server/src/session-manager.ts`](../../packages/mcp-server/src/session-manager.ts)
- [`packages/mcp-server/src/readers/state.ts`](../../packages/mcp-server/src/readers/state.ts)
- [`src/headless.ts`](../../src/headless.ts)
- [Hermes plugin guide](https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin)
