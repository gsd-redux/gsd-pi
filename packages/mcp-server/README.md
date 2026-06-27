# @opengsd/mcp-server

MCP server exposing GSD orchestration tools for Claude Code, Cursor, and other MCP-compatible clients.

Start GSD auto-mode sessions, poll progress, resolve blockers, and retrieve results — all through the [Model Context Protocol](https://modelcontextprotocol.io/).

This package exposes three tool surfaces:

- session/read tools for starting and inspecting GSD sessions
- MCP-native interactive tools for structured user input
- headless-safe workflow tools for planning, completion, validation, reassessment, metadata persistence, and journal reads

## Installation

```bash
npm install @opengsd/mcp-server
```

Or with the monorepo workspace:

```bash
# Already available as a workspace package
npx gsd-mcp-server
```

## Configuration

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "gsd-mcp-server"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

## Tools

### Workflow tools

The workflow MCP surface includes:

- `gsd_decision_save`
- `gsd_requirement_update`
- `gsd_requirement_save`
- `gsd_milestone_generate_id`
- `gsd_plan_milestone`
- `gsd_plan_slice`
- `gsd_plan_task`
- `gsd_replan_slice`
- `gsd_slice_complete`
- `gsd_skip_slice`
- `gsd_complete_milestone`
- `gsd_validate_milestone`
- `gsd_reassess_roadmap`
- `gsd_save_gate_result`
- `gsd_summary_save`
- `gsd_task_complete`
- `gsd_task_reopen`
- `gsd_slice_reopen`
- `gsd_milestone_reopen`
- `gsd_milestone_status`
- `gsd_checkpoint_db`
- `gsd_journal_query`
- `gsd_exec`
- `gsd_exec_search`
- `gsd_resume`
- `gsd_capture_thought`
- `gsd_memory_query`
- `gsd_memory_graph`

**Aliases (kept for backwards compatibility — prefer the canonical name above):** `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_requirement`, `gsd_save_summary`, `gsd_generate_milestone_id`, `gsd_milestone_plan`, `gsd_slice_plan`, `gsd_task_plan`, `gsd_slice_replan`, `gsd_complete_task`, `gsd_complete_slice`, `gsd_milestone_validate`, `gsd_milestone_complete`, `gsd_roadmap_reassess`, `gsd_reopen_task`, `gsd_reopen_slice`, `gsd_reopen_milestone`.

These tools use the same GSD workflow handlers as the native in-process tool path wherever a shared handler exists.

`gsd_decision_save` and its `gsd_save_decision` alias persist new decisions to the ADR-013 memory store, not to the legacy `decisions` table. The assigned `D###` ID is recorded in `memories.structured_fields.sourceDecisionId`, and `.gsd/DECISIONS.md` is refreshed as a projection from memory-backed decisions. The legacy table may still be read by compatibility and inspection paths during the cutover window, but it is no longer a write target.

`gsd_summary_save` computes artifact paths from the supplied IDs. `milestone_id` is required for milestone-, slice-, and task-scoped artifact types (`SUMMARY`, `RESEARCH`, `CONTEXT`, `ASSESSMENT`, `CONTEXT-DRAFT`) and should be omitted only for root-level `PROJECT`, `PROJECT-DRAFT`, `REQUIREMENTS`, and `REQUIREMENTS-DRAFT` artifacts. The `content` field has a schema `maxLength` of 50,000 characters per save; callers that produce larger artifacts should save incrementally by writing a substantive draft, then re-save the enriched artifact as more detail is available. For final `REQUIREMENTS` saves, the tool renders content from active database requirement rows; callers must create those rows with `gsd_requirement_save` first.

### Interactive tools

The packaged server exposes `ask_user_questions` through MCP form elicitation. This keeps the existing GSD answer payload shape while allowing Claude Code CLI and other elicitation-capable clients to surface structured user choices.

The packaged server also exposes `secure_env_collect` through MCP form elicitation. Secret values are written directly to the selected destination and are not included in tool output. For dotenv writes, `envFilePath` must resolve inside the validated project directory; parent traversal and symlink escapes are rejected.

`secure_env_collect` refuses to set variables that control the MCP server runtime itself, including `GSD_WORKFLOW_EXECUTORS_MODULE`, `GSD_WORKFLOW_WRITE_GATE_MODULE`, `GSD_WORKFLOW_PROJECT_ROOT`, `GSD_CLI_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES`. These values must be configured by the operator in the MCP server environment, not collected from an MCP tool call.

Secret handling differs by destination:

- `dotenv`: accepted values are written to the project env file and hydrated into the current MCP server process so the active session can use them.
- `vercel` and `convex`: accepted values are pushed to the remote destination but are not added to `process.env`; restart or configure the consuming runtime normally if the current process needs that value.

Current support boundary:

- when running inside the GSD monorepo checkout, the MCP server auto-discovers the shared workflow executor module
- outside the monorepo, set `GSD_WORKFLOW_EXECUTORS_MODULE` to an importable `workflow-tool-executors` module path if you want the mutation tools enabled
- `ask_user_questions` and `secure_env_collect` require an MCP client that supports form elicitation
- session/read tool implementations do not use this bridge, but the packaged CLI still warms it at startup so Claude Code never sees a partial workflow surface

If the executor bridge cannot be loaded, the packaged CLI fails startup with a precise configuration error instead of silently degrading.

Startup is fail-closed for the workflow bridge: `gsd-mcp-server` loads the workflow executor and write-gate bridge before it connects over stdio. If bridge warm-up fails, the MCP host sees a startup failure instead of a partially advertised tool surface.

The server also keeps a per-project PID registry at `$GSD_HOME/mcp-instances.json` (default `~/.gsd/mcp-instances.json`). On startup it terminates a previously registered `gsd-mcp-server` process for the same project when the saved PID still belongs to an MCP server, then records the current PID. On normal shutdown it removes only its own entry. Corrupt registry files are preserved as `.corrupt-<timestamp>` backups before a new registry is written.

For stdio hosts that leave child processes behind, the server watches stdin activity. If stdin is idle for five minutes and the original parent process is gone, it cleans up sessions, unregisters its PID, and exits.

### `gsd_execute`

Start a GSD auto-mode session for a project directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |
| `command` | `string` | | Command to send (default: `"/gsd auto"`) |
| `model` | `string` | | Model ID override |
| `bare` | `boolean` | | Run in bare mode (skip user config) |

**Returns:** `{ sessionId, status: "started" }`

### `gsd_status`

Poll the current status of a running GSD session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:**

```json
{
  "status": "running",
  "progress": { "eventCount": 42, "toolCalls": 15 },
  "recentEvents": [ ... ],
  "pendingBlocker": null,
  "cost": { "totalCost": 0.12, "tokens": { "input": 5000, "output": 2000, "cacheRead": 1000, "cacheWrite": 500 } },
  "durationMs": 45000
}
```

### `gsd_result`

Get the accumulated result of a session. Works for both running (partial) and completed sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:**

```json
{
  "sessionId": "abc-123",
  "projectDir": "/path/to/project",
  "status": "completed",
  "durationMs": 120000,
  "cost": { ... },
  "recentEvents": [ ... ],
  "pendingBlocker": null,
  "error": null
}
```

### `gsd_cancel`

Cancel a running session. Aborts the current operation and stops the agent process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |

**Returns:** `{ cancelled: true }`

### `gsd_cancel_by_project`

Cancel the active session for a project directory when `sessionId` is unavailable (e.g. Hermes `/gsd cancel`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |

**Returns:** `{ cancelled: true, projectDir: "..." }`

### `gsd_query`

Query GSD project state from the filesystem without an active session. Returns STATE.md, PROJECT.md, requirements, and milestone listing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectDir` | `string` | ✅ | Absolute path to the project directory |
| `query` | `string` | ✅ | What to query (e.g. `"status"`, `"milestones"`) |

**Returns:**

```json
{
  "projectDir": "/path/to/project",
  "state": "...",
  "project": "...",
  "requirements": "...",
  "milestones": [
    { "id": "M001", "hasRoadmap": true, "hasSummary": false }
  ]
}
```

### `gsd_resolve_blocker`

Resolve a pending blocker in a session by sending a response to the blocked UI request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | ✅ | Session ID from `gsd_execute` |
| `response` | `string` | ✅ | Response to send for the pending blocker |

**Returns:** `{ resolved: true }`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_CLI_PATH` | Absolute path to the GSD CLI binary. If not set, the server resolves `gsd` via `which`. |
| `GSD_WORKFLOW_EXECUTORS_MODULE` | Optional absolute path or `file:` URL for the shared GSD workflow executor module used by workflow mutation tools. |
| `GSD_WORKFLOW_WRITE_GATE_MODULE` | Optional absolute path or `file:` URL for the shared write-gate module used by workflow mutation tools. |
| `GSD_WORKFLOW_PROJECT_ROOT` | Canonical project root for workflow tools and the per-project MCP PID registry key. Defaults to the server's current working directory. |
| `GSD_HOME` | Global GSD directory. Also controls where `mcp-instances.json` is stored. |

The server also hydrates supported model-provider and tool credentials from `~/.gsd/agent/auth.json` on startup. Keys saved through `/gsd config` or `/gsd keys` become available to the MCP server process automatically, and any explicitly-set environment variable still wins.

Remote secrets pushed by `secure_env_collect` to Vercel or Convex are not hydrated into the MCP server process after the push. Use explicit MCP `env` configuration or a process restart when an operator-level value must be visible to the running server.

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────┐
│  MCP Client     │ ◄────────────► │  @opengsd/mcp-server │
│  (Claude Code,  │    JSON-RPC    │                  │
│   Cursor, etc.) │                │  SessionManager  │
└─────────────────┘                │       │          │
                                   │       ▼          │
                                   │  @opengsd/rpc-client │
                                   │       │          │
                                   │       ▼          │
                                   │  GSD CLI (child  │
                                   │  process via RPC)│
                                   └──────────────────┘
```

- **@opengsd/mcp-server** — MCP protocol adapter. Translates MCP tool calls into SessionManager operations.
- **SessionManager** — Manages RpcClient lifecycle. One session per project directory. Tracks events in a ring buffer (last 50), detects blockers, accumulates cost.
- **@opengsd/rpc-client** — Low-level RPC client that spawns and communicates with the GSD CLI process via JSON-RPC over stdio.

## License

MIT
