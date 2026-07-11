# @opengsd/gsd-cloud

Connect a local GSD runtime to [GSD Cloud](https://cloud.opengsd.net) so you can
monitor and control your GSD projects from any browser.

This is a **self-contained** agent. It depends only on `ws` and `yaml` — no
`@opengsd/daemon`, no `@opengsd/mcp-server`, no `@opengsd/gsd-pi`. It runs the
RFC 8628 device-flow login, opens a persistent WebSocket to the cloud gateway,
and forwards each requested GSD workflow tool to your locally-installed `gsd`
CLI (via `gsd --mode mcp`). The gateway default of `https://cloud.opengsd.net`
is injected for `login`/`pair` so you never have to type `--gateway`.

Requires the `gsd` CLI (from `@opengsd/gsd-pi`) to be installed and on your
`PATH` (or set `GSD_CLI_PATH`).

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

## Environment

- `GSD_CLOUD_PROJECTS` — path-delimiter separated list of project directories to
  advertise to the cloud (default: the current working directory).
- `GSD_CLI_PATH` — path to the `gsd` binary (default: `gsd` on `PATH`).
- `GSD_CLOUD_EXECUTOR` — backend adapter: `gsd-pi` (default). `codex` and
  `claude` adapters are stubbed for future use.

The project directory used by `login` is persisted in `~/.gsd/daemon.yaml`.
Set `GSD_CLOUD_PROJECTS` before `login` to advertise more than one project. Use
`--foreground` with `login` or `connect` only when debugging the runtime in the
current terminal.

## Requirements

- Node.js >= 22
- The `gsd` CLI (`@opengsd/gsd-pi`) installed locally
