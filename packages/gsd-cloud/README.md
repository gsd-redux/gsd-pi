# @opengsd/gsd-cloud

Connect a local GSD runtime to [GSD Cloud](https://cloud.opengsd.net) so you can
monitor and control your GSD projects from any browser.

This is a thin wrapper over `@opengsd/daemon`'s cloud runtime commands. Its only
added behavior is defaulting the gateway to `https://cloud.opengsd.net` for the
`login` and `pair` commands, so you never have to type `--gateway`. All
device-flow, pairing, and connection logic is provided by the daemon.

## Usage

```bash
# Browser-based pairing against GSD Cloud (recommended). Opens an approval URL,
# polls for authorization, then auto-connects. No --gateway needed.
npx @opengsd/gsd-cloud login

# Show current cloud runtime configuration and connection status.
npx @opengsd/gsd-cloud status

# Start the daemon using a previously paired device token.
npx @opengsd/gsd-cloud connect

# Remove cloud runtime configuration from the local config file.
npx @opengsd/gsd-cloud disconnect
```

`login` (and `pair`) default to `https://cloud.opengsd.net`. To target a
different gateway, pass `--gateway <url>` explicitly — the explicit flag always
wins. The `status`, `connect`, and `disconnect` commands do not use a gateway.

## Requirements

- Node.js >= 22
