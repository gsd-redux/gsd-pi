# Web Interface

> GSD includes a browser-based web interface for project management, real-time progress monitoring, and multi-project support.

## Quick Start

```bash
gsd --web
```

This starts a local web server and opens the GSD dashboard in your default browser.

### CLI Flags

```bash
gsd --web --host 0.0.0.0 --port 8080 --allowed-origins "https://example.com"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address for the web server |
| `--port` | `3000` | Port for the web server |
| `--allowed-origins` | (none) | Comma-separated list of allowed CORS origins |
| `--no-auth` | disabled | Disable the built-in bearer token gate |

`--no-auth` leaves the web interface unprotected unless another layer controls access. By default, GSD only allows unauthenticated web mode on loopback hosts such as `127.0.0.1`, `localhost`, `::1`, or another `127.x.x.x` address. If you combine `--no-auth` or `GSD_WEB_NO_AUTH=1` with a non-loopback bind such as `--host 0.0.0.0`, startup is refused.

To deliberately run unauthenticated web mode on a LAN-facing host, set `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1` in the same environment:

```bash
GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1 gsd --web --host 0.0.0.0 --no-auth
```

This exposes terminal and file APIs to any client that can reach the server unless trusted external access control is already in place. Use the override only behind authentication you control, such as a reverse proxy, VPN, or private network boundary.

## Features

- **Project management** — view milestones, slices, and tasks in a visual dashboard
- **Real-time progress** — server-sent events push status updates as auto-mode executes
- **Multi-project support** — manage multiple projects from a single browser tab via `?project=` URL parameter
- **Change project root** — switch project directories from the web UI without restarting the server
- **Onboarding flow** — API key setup and provider configuration through the browser
- **Model selection** — switch models and providers from the web UI

## Local And Cloud Modes

`gsd --web` starts the local web interface. In local mode, `?project=` is a
local filesystem path. If `?project=` is omitted, the server falls back to
`GSD_WEB_PROJECT_CWD`. Each project gets a bridge that starts a local
`gsd --mode rpc` child process and talks to it over stdio.

Cloud mode is for the hosted `gsd-cloud` app, not for ordinary local
`gsd --web` sessions. Build the cloud image from the repository root:

```bash
docker build -f web/Dockerfile.cloud -t gsd-web:cloud .
```

Run it with the required gateway configuration:

```bash
docker run --rm -p 3000:3000 \
  -e GATEWAY_INTERNAL_URL="http://gateway.internal:9100" \
  -e GATEWAY_INTERNAL_TOKEN="replace-with-internal-token" \
  -e APP_BRIDGE_SECRET="replace-with-app-bridge-secret" \
  gsd-web:cloud
```

`web/Dockerfile.cloud` sets `GSD_CLOUD_MODE=1` and `PORT=3000` by default. The
server refuses to boot in cloud mode unless `GATEWAY_INTERNAL_URL`,
`GATEWAY_INTERNAL_TOKEN`, and `APP_BRIDGE_SECRET` are present.

In cloud mode, `?project=` is a project alias granted by the authenticated cloud
session, not a local path. There is no local filesystem scan or
`GSD_WEB_PROJECT_CWD` fallback. The web bridge uses `CloudTransport` instead of
the local stdio transport: the server mints an internal RPC token from
`POST {GATEWAY_INTERNAL_URL}/internal/rpc/token`, then opens a WebSocket to
`/rpc/connect?token=...` and forwards bridge NDJSON frames through the gateway.

File browsing uses the same cloud session and proxies project-relative reads,
stats, directory listings, and non-viewer writes through the gateway
`/internal/fs` endpoint. Local machine operations such as browsing host
directories, switching roots, creating local projects, local PTY terminals,
shutdown, update, and other local service routes are disabled in cloud mode.

### Cloud Authentication

Cloud entry starts at `/api/cloud/bootstrap?token=...`. The token is a
short-lived HMAC-signed app bridge token minted by the `gsd-cloud` SaaS with
`APP_BRIDGE_SECRET`. On success, the web app sets an httpOnly, SameSite=Lax
`gsd_cloud_session` cookie with an 8 hour lifetime and redirects to `/`.

Every other `/api/*` request in cloud mode requires that session cookie.
Requests with `?project=` are allowed only when the alias is listed in the
cookie's `projects` grant. The local bearer-token gate (`GSD_WEB_AUTH_TOKEN`)
is ignored in cloud mode. Keep `GATEWAY_INTERNAL_TOKEN` and
`APP_BRIDGE_SECRET` server-side only, and run the public app behind the cloud
SaaS or an equivalent authenticated TLS proxy.

## Architecture

The web interface is built with Next.js and communicates with the GSD backend via a bridge service. Each project gets its own bridge instance, providing isolation for concurrent sessions.

Key components:
- `ProjectBridgeService` — per-project command routing and SSE subscription
- `getProjectBridgeServiceForCwd()` — registry returning distinct instances per project path
- `LocalTransport` — local-mode stdio bridge to `gsd --mode rpc`
- `CloudTransport` — cloud-mode WebSocket bridge through the gateway relay
- `resolveProjectCwd()` — resolves local paths in local mode and cloud project aliases in cloud mode

## Configuration

The web server binds to `127.0.0.1:3000` by default. Use `--host`, `--port`, and `--allowed-origins` to override (see CLI Flags above).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_WEB_AUTH_TOKEN` | Optional local-mode bearer token required on every `/api/*` request |
| `GSD_WEB_PROJECT_CWD` | Default project path when `?project=` is not specified |
| `GSD_WEB_NO_AUTH` | Set to `1` to disable the built-in web bearer token gate on loopback hosts |
| `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN` | Set to `1` to explicitly allow unauthenticated web mode on non-loopback hosts |
| `GSD_CLOUD_MODE` | Set to `1` to enable cloud mode |
| `GATEWAY_INTERNAL_URL` | Required in cloud mode; server-to-server base URL for the cloud gateway |
| `GATEWAY_INTERNAL_TOKEN` | Required in cloud mode; bearer secret for gateway `/internal/rpc/token` and `/internal/fs` calls |
| `APP_BRIDGE_SECRET` | Required in cloud mode; HMAC secret for app bridge tokens and `gsd_cloud_session` cookies |

## Node v24 Compatibility

Node v24 introduced breaking changes to type stripping that caused `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on web boot. This is fixed in a recent release. If you encounter this error, upgrade GSD.

## Auth Token Persistence

the web UI persists the auth token in `sessionStorage` so it survives page refreshes (#1877). Previously, refreshing the page required re-authentication.

## Platform Notes

- **Windows**: The web build is skipped on Windows due to Next.js webpack EPERM issues with system directories. The CLI remains fully functional.
- **macOS/Linux**: Full support.
