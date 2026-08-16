# Web Interface

GSD includes a browser-based interface for project management and real-time progress monitoring.

## Quick Start

```bash
gsd --web
```

This starts a local web server and opens the dashboard in your default browser.

## CLI Flags

```bash
gsd --web --host 0.0.0.0 --port 8080 --allowed-origins "https://example.com"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `3000` | Port |
| `--allowed-origins` | (none) | Comma-separated CORS origins |
| `--no-auth` | disabled | Disable the built-in bearer token gate |

`--no-auth` leaves the web interface unprotected unless another layer controls access.

**Unauthenticated LAN interlock.** `--no-auth` (or `GSD_WEB_NO_AUTH=1`) disables the built-in bearer token. On a non-loopback bind such as `--host 0.0.0.0`, that would expose terminal and file APIs to anyone who can reach the host. GSD therefore refuses startup unless `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1` is also set. Loopback hosts (`127.0.0.1`, `localhost`, `::1`, other `127.x.x.x` addresses) are exempt — `--no-auth` works there without the override.

To deliberately run unauthenticated web mode on a LAN-facing host, set `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1` in the same environment (see [CLI flags](../reference/cli-flags.md) for POSIX, PowerShell, and CMD examples):

```bash
GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1 gsd --web --host 0.0.0.0 --no-auth
```

This exposes terminal and file APIs to any client that can reach the server unless trusted external access control is already in place. Use the override only behind authentication you control, such as a reverse proxy, VPN, or private network boundary. Headless launches can set `GSD_WEB_NO_AUTH=1`.

## Features

- **Project management** — view milestones, slices, and tasks in a visual dashboard
- **Real-time progress** — live updates as auto mode executes
- **Multi-project support** — manage multiple projects from one browser tab via `?project=` URL parameter
- **Change project root** — switch directories from the web UI without restarting
- **Onboarding flow** — API key setup and provider configuration in the browser
- **Model selection** — switch models and providers from the web UI

## Local Architecture

See the authoritative [Web Interface architecture guide](../../docs/user-docs/web-interface.md#architecture).

## Platform Notes

- **macOS/Linux** — Full support
- **Windows** — Web build is skipped due to Next.js compatibility issues; CLI remains fully functional
