# @opengsd/gsd-cloud

Connect a local GSD runtime to [GSD Cloud](https://cloud.opengsd.net) so you can
monitor and control your GSD projects from any browser.

This is a **self-contained** agent. Its only runtime dependencies are `ws` and
`yaml` — no `@opengsd/daemon`, `@opengsd/mcp-server`, or `@opengsd/gsd-pi`. It
runs the RFC 8628 device-flow login, opens a persistent WebSocket to the cloud
gateway, and forwards each requested GSD workflow tool to a workflow MCP server.
That server is resolved through the configured, installed-package, and `PATH`
routes described under [Environment](#environment). Startup fails before the
cloud connection is opened when none of those routes resolves a server.
The gateway default of `https://cloud.opengsd.net` is injected for `login`/`pair`
so you never have to type `--gateway`.

`node-pty` is an **optional** native dependency used only for browser terminal
sessions. It is loaded dynamically at runtime; if it is not installed (for
example when its prebuilt binary is unavailable for your platform), the core CLI
still works and only the cloud terminal feature is unavailable.

See [Requirements](#requirements) for local prerequisites and
[Environment](#environment) for discovery overrides.

## Usage

```bash
# Browser-based pairing against GSD Cloud (recommended). Run this from the GSD
# project directory to advertise. After approval, the connection continues in
# the background and the terminal prompt returns. No --gateway needed.
npx @opengsd/gsd-cloud login

# Show current cloud runtime configuration, connection status, and telemetry.
npx @opengsd/gsd-cloud status

# Start or restart the background runtime using saved credentials and projects.
npx @opengsd/gsd-cloud connect

# Stop the background runtime without removing saved credentials.
npx @opengsd/gsd-cloud stop

# Remove cloud runtime configuration from the local config file.
npx @opengsd/gsd-cloud disconnect
```

`login` (and `pair`) default to `https://cloud.opengsd.net`. To target a
different gateway, pass `--gateway <url>` explicitly — the explicit flag always
wins. The `status`, `connect`, `stop`, and `disconnect` commands do not use a
gateway. `disconnect` also stops the runtime; `stop` leaves pairing intact so a
later `connect` reconnects with the same credentials.

`status` reports a token-free `telemetry` object (connection state, traffic
counters, per-project activity) read from the runtime's status file — this is
the same file the GSD Cloud Monitor macOS app polls. See
[`apps/gsd-cloud-monitor`](../../apps/gsd-cloud-monitor/README.md).

## Run as a background service

`connect` detaches the runtime from your terminal, but it does not start again
after a logout/reboot or a crash. To keep the cloud agent always running —
start at login and restart on failure — install it as an OS service (macOS and
Linux only):

```bash
# Install and start the service: a launchd LaunchAgent on macOS
# (~/Library/LaunchAgents/net.opengsd.gsd-cloud.plist, RunAtLoad + KeepAlive)
# or a systemd user unit on Linux
# (~/.config/systemd/user/gsd-cloud.service, Restart=on-failure).
npx @opengsd/gsd-cloud service install

# Show whether the service is installed, loaded, and running.
npx @opengsd/gsd-cloud service status

# Stop and remove the service. Pairing and credentials are kept.
npx @opengsd/gsd-cloud service uninstall
```

Pair with `login` first — the service runs `connect --foreground`, so `status`
and `stop` see the service-managed runtime exactly like a `connect` session.
`service install` copies `GSD_CLI_PATH` / `GSD_BIN_PATH`, `GSD_WORKFLOW_PATH`,
and the `GSD_WORKFLOW_MCP_*` variables into the service definition; run it again
after changing those values.
On macOS the service appends stdout/stderr to the same `cloud-runtime.log`
artifact that `connect` uses; on Linux it logs to the journal
(`journalctl --user -u gsd-cloud`). On headless Linux servers, run
`loginctl enable-linger` once so the user unit starts at boot without an
interactive login.

A clean stop (`stop`/`disconnect`) exits successfully, so neither supervisor
restarts the runtime afterwards. If you installed the service and want to
disconnect permanently, run `service uninstall` before `disconnect` — otherwise
the service supervisor starts the runtime again at the next login. On
unsupported platforms (e.g. Windows) `service` exits with a clear error; use
`connect` there instead.

## Live session events

While connected, the runtime also streams `session_event` frames over the same
WebSocket so the dashboard can render GSD sessions live. For each advertised
project it polls `gsd_status` every 3 seconds through that project's workflow
MCP server and normalizes the deltas into a fixed event
vocabulary: `session_started`, `turn_started`, `assistant_text`, `tool_call`,
`tool_result`, `blocker_pending`, `blocker_resolved`, `session_idle`,
`session_ended`, and `error`, plus a `snapshot` every 30 seconds per active
session. Each frame carries a per-session monotonically increasing `seq`
(starts at 1); the last 500 events per session are buffered and a bounded tail
is re-sent after reconnects — the relay deduplicates on
`(device, session, seq)`. Events are capped at 8 KB after JSON serialization
(long strings are truncated; frames that still do not fit are skipped and
logged), and at most 20 sessions are tracked concurrently per runtime (extras
are skipped and logged). Tool-call forwarding is unchanged. Set
`GSD_CLOUD_SESSION_EVENTS=0` (or `false`, or `cloud.session_events: false` in
`~/.gsd/daemon.yaml`) to disable; it is on by default.

## Environment

- `GSD_CLOUD_PROJECTS` — path-delimiter separated list of project directories to
  advertise to the cloud (default: the current working directory).
- `GSD_CLI_PATH` / `GSD_BIN_PATH` — path to the `gsd` binary (default: `gsd` on
  `PATH`). `GSD_CLI_PATH` takes precedence when both ambient variables are set.
- `GSD_WORKFLOW_PATH` — additional installed-package discovery anchor. The
  daemon walks upward from this path looking for `packages/mcp-server/dist/cli.js`.
- `GSD_WORKFLOW_MCP_COMMAND` — workflow MCP server command. By default the
  daemon discovers `packages/mcp-server/dist/cli.js` from the resolved `gsd`
  installation or `GSD_WORKFLOW_PATH`, then falls back to `gsd-mcp-server` on
  `PATH`.
- `GSD_WORKFLOW_MCP_ARGS` — optional JSON array of arguments for
  `GSD_WORKFLOW_MCP_COMMAND`.
- `GSD_WORKFLOW_MCP_ENV` — optional JSON object of environment variables for an
  explicit workflow MCP server, including nested `GSD_CLI_PATH` or
  `GSD_BIN_PATH` overrides.
- `GSD_WORKFLOW_MCP_CWD` — optional working directory for an explicit workflow
  MCP server.
- `GSD_CLOUD_EXECUTOR` — backend adapter: `gsd-pi` (default). `codex` and
  `claude` adapters are stubbed for future use.
- `GSD_CLOUD_SESSION_EVENTS` — live session-event streaming: `0` or `false`
  disables it (default: on). See "Live session events" above.

The project directory used by `login` is persisted in `~/.gsd/daemon.yaml`.
Set `GSD_CLOUD_PROJECTS` before `login` to advertise more than one project. Use
`--foreground` with `login` or `connect` only when debugging the runtime in the
current terminal.

## Requirements

- Node.js >= 22
- A workflow MCP server discoverable from a local `@opengsd/gsd-pi`
  installation, as `gsd-mcp-server` on `PATH`, or through
  `GSD_WORKFLOW_MCP_COMMAND`
- The `gsd` CLI available to that server on `PATH` or through `GSD_CLI_PATH` /
  `GSD_BIN_PATH`
