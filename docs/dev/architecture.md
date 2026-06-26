# Architecture Overview

GSD is a TypeScript application built on the [Pi SDK](https://github.com/badlogic/pi-mono). It embeds the Pi coding agent and extends it with the GSD workflow engine, auto mode state machine, and project management primitives.

## System Structure

```
gsd (CLI binary)
  └─ loader.ts          Sets PI_PACKAGE_DIR, GSD env vars, dynamic-imports cli.ts
      └─ cli.ts         Wires SDK managers, loads extensions, starts InteractiveMode
          ├─ onboarding.ts   First-run setup wizard (LLM provider + tool keys)
          ├─ wizard.ts       Env hydration from stored auth.json credentials
          ├─ app-paths.ts    ~/.gsd/agent/, ~/.gsd/sessions/, auth.json
          ├─ resource-loader.ts  Syncs managed resources to ~/.gsd/agent/
          └─ src/resources/
              ├─ extensions/gsd/    Core GSD extension
              ├─ extensions/...     22 supporting extensions
              ├─ agents/            scout, researcher, worker
              ├─ AGENTS.md          Agent routing instructions
              └─ GSD-WORKFLOW.md    Manual bootstrap protocol

gsd headless              Headless mode — CI/cron orchestration via RPC child process
gsd --mode mcp            MCP server mode — exposes tools over stdin/stdout

vscode-extension/         VS Code extension — chat participant (@gsd), sidebar dashboard, RPC integration
```

## Key Design Decisions

### DB-Authoritative Project State

GSD stores runtime workflow state in the project-root SQLite database. Auto mode derives phases, completion status, requirements, decisions, summaries, and hierarchy from that database, then renders markdown projections in `.gsd/` for human review, prompt context, and git-friendly history. No in-memory state survives across sessions. This enables crash recovery, multi-terminal steering, and session resumption while avoiding silent markdown re-imports during normal runtime.

Milestone queue position has one explicit file contract: `.gsd/QUEUE-ORDER.json`. `/gsd rethink` and `/gsd phase` use it as a durable reorder record, and state derivation mirrors that order into `milestones.sequence` before selecting the active milestone. Other generated `.gsd` artifacts remain projections unless an explicit import or recovery command reads them.

### Two-File Loader Pattern

`loader.ts` sets all environment variables with zero SDK imports, then dynamically imports `cli.ts` which does static SDK imports. This ensures `PI_PACKAGE_DIR` is set before any SDK code evaluates.

### `pkg/` Shim Directory

`PI_PACKAGE_DIR` points to `pkg/` (not project root) to avoid Pi's theme resolution colliding with GSD's `src/` directory. Contains only `piConfig` and theme assets.

### Managed Resource Sync

Bundled extensions, shared files, agents, and skills are synced to
`~/.gsd/agent/` on launch when the managed-resource manifest or content
fingerprint is stale. The `gsd-browser` skill is then overlaid from the
installed `@opengsd/gsd-browser` package, including package-relative support
files, so browser automation guidance tracks the browser package instead of a
duplicated Pi copy.

### Lazy Provider Loading

LLM provider SDKs (Anthropic, OpenAI, Google, etc.) are lazy-loaded on first use rather than imported at startup. This significantly reduces cold-start time — only the provider you actually connect to gets loaded.

### Fresh Session Per Unit

Every dispatch creates a new agent session. The LLM starts with a clean context window containing only the pre-inlined artifacts it needs. This prevents quality degradation from context accumulation.

### Workspace Roots, Not Ambient `cwd`

GSD workflow code must treat the active project/worktree as explicit state, not infer it from ambient `process.cwd()`. Prefer `AutoSession.scope`, `s.canonicalProjectRoot`, `s.basePath`, `s.originalBasePath`, hook `ctx.cwd`, or an explicit `basePath` parameter depending on the boundary. `cwd` remains valid as a subprocess/shell option in generic Pi tooling, but GSD identity, DB paths, workflow gates, auto-mode sessions, and dynamic tool execution should be rooted from explicit workflow state.

## Bundled Extensions

| Extension | What It Provides |
|-----------|-----------------|
| **GSD** | Core workflow engine — auto mode, state machine, commands, dashboard |
| **Browser Tools** | Browser Automation Contract adapter; browser-facing projects prefer the managed gsd-browser engine when proven, falling back to Playwright (ADR-037) |
| **Search the Web** | Brave Search, Tavily, or Jina page extraction |
| **Google Search** | Gemini-powered web search with AI-synthesized answers |
| **Context7** | Up-to-date library/framework documentation |
| **Background Shell** | Long-running process management with readiness detection |
| **Subagent** | Delegated tasks with isolated context windows |
| **Mac Tools** | macOS native app automation via Accessibility APIs |
| **MCP Client** | Native MCP server integration via @modelcontextprotocol/sdk |
| **Voice** | Real-time speech-to-text (macOS, Linux) |
| **Slash Commands** | Custom command creation |
| **Google CLI** | Local Google CLI providers (Gemini CLI, Antigravity) via external-cli auth — GSD never owns the OAuth flow |
| **Visual Brief** | Self-contained HTML briefs via `/gsd brief` (diagram, plan, diff, recap, table, slides) |
| **Async Jobs** | Background command execution with `async_bash`, `await_job`, `cancel_job` |
| **Remote Questions** | Discord, Slack, and Telegram integration for headless question routing |
| **TTSR** | Tool-triggered system rules — conditional context injection based on tool usage |
| **Universal Config** | Discovery of existing AI tool configurations (Claude Code, Cursor, Windsurf, etc.) |
| **AWS Auth** | AWS credential management and authentication |
| **Claude Code CLI** | Claude Code CLI integration |
| **cmux** | Context multiplexing for multi-session coordination |
| **GitHub Sync** | GitHub issue and PR synchronization |
| **Ollama** | Local Ollama model integration |
| **Shared** | Shared utilities across extensions |

## Bundled Agents

| Agent | Role |
|-------|------|
| **Scout** | Fast codebase recon — compressed context for handoff |
| **Researcher** | Web research — finds and synthesizes current information |
| **Worker** | General-purpose execution in an isolated context window |

## Native Engine

Performance-critical operations use a Rust N-API engine:

- **grep** — ripgrep-backed content search
- **glob** — gitignore-aware file discovery
- **ps** — cross-platform process tree management
- **highlight** — syntect-based syntax highlighting
- **ast** — structural code search via ast-grep
- **diff** — fuzzy text matching and unified diff generation
- **text** — ANSI-aware text measurement and wrapping
- **html** — HTML-to-Markdown conversion
- **image** — decode, encode, resize images
- **fd** — fuzzy file path discovery
- **clipboard** — native clipboard access
- **git** — libgit2-backed git read operations
- **parser** — GSD file parsing and frontmatter extraction

## Dispatch Pipeline

The auto-loop is a **linear** pipeline (`auto/loop.ts`), the replacement for the older recursive `dispatchNextUnit → resolveAgentEnd → dispatchNextUnit` chain. Each iteration flows through explicit stages (see [auto-mode.md](../user-docs/auto-mode.md) for the full description):

```
1. Pre-Dispatch  — derive state, run UOK guards, resolve model preferences, check captures
2. Dispatch      — build the prompt and execute the unit with the selected model
3. Post-Unit     — close out the unit, snapshot metrics, verify artifacts, persist state
4. Finalize      — milestone/slice completion and projection
5. Loop          — advance to the next unit
```

Model routing (complexity classification, budget pressure, routing history, capability scoring) is folded into the Pre-Dispatch stage via `auto-model-selection.ts` (`selectAndApplyModel`), not handled as standalone pipeline steps. Phase skipping (from a token profile) gates which unit types are dispatched.

## Key Modules

> The auto-mode kernel lives under the `auto/` subdirectory (`auto/orchestrator.ts`, `auto/loop.ts`, `auto/phases.ts`, `auto/pre-dispatch.ts`, `auto/dispatch.ts`, `auto/finalize.ts`, `auto/detect-stuck.ts`, `auto/dispatch-key.ts`, `auto/dispatch-history.ts`, and `workflow-kernel.ts`). Pre-dispatch invariants are enforced by the `uok/` deep module (`uok/flags.ts`, `uok/gate-runner.ts`) wired into the orchestrator. The flat `auto-*.ts` modules below are the older, surrounding surface.

| Module | Purpose |
|--------|---------|
| `auto.ts` | Auto-mode state machine and orchestration |
| `auto/session.ts` | `AutoSession` class — all mutable auto-mode state in one encapsulated instance |
| `auto-dispatch.ts` | Declarative dispatch table (phase → unit mapping) |
| `auto/dispatch-key.ts` | Completed-key checks, skip loop detection, key eviction |
| `auto/detect-stuck.ts` | Stuck loop recovery and unit retry escalation |
| `auto-start.ts` | Fresh-start bootstrap — git/state init, crash lock detection, worktree setup |
| `auto-post-unit.ts` | Post-unit processing — commit, doctor, state rebuild, hooks |
| `auto-verification.ts` | Post-unit verification gate (lint/test/typecheck with auto-fix retries) |
| `auto-prompts.ts` | Prompt builders with inline level compression |
| `auto-worktree.ts` | Worktree lifecycle (create, enter, merge, teardown) |
| `auto-recovery.ts` | Expected artifact resolution, completed-key persistence, self-healing |
| `auto-timeout-recovery.ts` | Timed-out unit recovery and continuation |
| `auto-timers.ts` | Unit supervision — soft/idle/hard timeouts, continue-here monitor |
| `complexity-classifier.ts` | Unit complexity classification (light/standard/heavy) |
| `model-router.ts` | Dynamic model routing with cost-aware selection |
| `model-cost-table.ts` | Built-in per-model cost data for cross-provider comparison |
| `routing-history.ts` | Adaptive learning from routing outcomes |
| `captures.ts` | Fire-and-forget thought capture and triage classification |
| `triage-resolution.ts` | Capture resolution (inject, defer, replan, quick-task) |
| `visualizer-overlay.ts` | Workflow visualizer TUI overlay |
| `visualizer-data.ts` | Data loading for visualizer tabs, including active memory-store rows |
| `visualizer-views.ts` | Tab renderers (progress, timeline, deps, metrics, health, agent, changes, knowledge, memories, captures, export) |
| `metrics.ts` | Token and cost tracking ledger |
| `state.ts` | DB-authoritative state derivation with explicit legacy markdown fallback for tests/recovery, plus QUEUE-ORDER.json replay into milestone sequence |
| `session-lock.ts` | OS-level exclusive session locking (proper-lockfile) |
| `crash-recovery.ts` | Lock file management for crash detection and recovery |
| `guidance.ts` | Single catalog mapping typed findings (recovery kinds, milestone blockers, doctor issue codes, crash unit classes) to user-facing remediation prose |
| `stop-notice.ts` | Single owner of the auto/step-mode stop/pause notice vocabulary — formatters and headless exit-code classifiers stay in lockstep |
| `preferences.ts` | Preference loading, merging, validation |
| `git-service.ts` | Git operations — commit, merge, worktree sync, completed-units cross-boundary sync |
| `unit-id.ts` | Centralized `parseUnitId()` — milestone/slice/task extraction from unit IDs |
| `error-utils.ts` | `getErrorMessage()` — unified error-to-string conversion |
| `roadmap-slices.ts` | Roadmap parser with prose fallback for LLM-generated variants |
| `memory-extractor.ts` | Extract reusable knowledge from session transcripts |
| `memory-store.ts` | Persistent memory store for cross-session knowledge |
| `queue-order.ts` | Durable milestone queue ordering contract and DB sequence mirroring |
| `context-masker.ts` | Context masking for model routing optimization |
| `phase-anchor.ts` | Phase anchoring for dispatch pipeline |
| `slice-parallel-orchestrator.ts` | Slice-level parallelism with dependency-aware dispatch |
| `slice-parallel-eligibility.ts` | Slice parallel eligibility checks |
| `slice-parallel-conflict.ts` | Slice parallel conflict detection |
| `preferences-models.ts` | Model preferences configuration |
| `preferences-validation.ts` | Preferences validation |
| `preferences-types.ts` | Preferences type definitions |

## External Integrations

| Integration | Location | Description |
|-------------|----------|-------------|
| **Hermes Agent** | [`integrations/hermes/`](../../integrations/hermes/) | Open GSD plugin (`open-gsd-hermes`) — gateway slash commands, `pre_llm_call` project snapshots, background supervisor, cron headless, memory provider. Uses `gsd-mcp-server` for orchestration (not `gsd --mode mcp`). See [`hermes-integration-plan.md`](hermes-integration-plan.md). |
