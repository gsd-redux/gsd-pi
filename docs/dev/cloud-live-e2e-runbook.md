# Cloud live E2E runbook — publish-day verification

Manual end-to-end verification of the GSD Cloud agent path against the
production service (cloud.opengsd.net). Run this on publish day after the
`@opengsd/gsd-cloud` npm release and the cloud deployment are both live.

The automated, no-production equivalent of this runbook is the local harness:
`pnpm --filter @opengsd/gsd-cloud run test:e2e` (see
`packages/gsd-cloud/e2e/README.md`). The local harness covers the pairing-code
path; this runbook covers the browser device-flow path, which only exists on
the SaaS (`/api/device/*` endpoints are not part of the standalone gateway).

## Prerequisites

- Node.js >= 22 on the test machine.
- The local prerequisites in the [`@opengsd/gsd-cloud` requirements](../../packages/gsd-cloud/README.md#requirements);
  use its [environment reference](../../packages/gsd-cloud/README.md#environment)
  for non-default discovery.
- A local GSD project directory (contains `.gsd/`). `cd` into it — it becomes
  the advertised project.
- A cloud.opengsd.net account you can log into in a browser.
- The published version you are verifying:
  `npm view @opengsd/gsd-cloud version`.

## 1. Login (device flow)

```bash
npx @opengsd/gsd-cloud@latest login
```

Expected terminal output:

- A `gsd-cloud: Cloud Login` banner with a verification URL
  (`https://cloud.opengsd.net/...?user_code=...`) and a `Your code: XXXX-XXXX`
  line.
- A `Waiting for approval...` spinner with an expiry countdown (~10 minutes).

If the CLI instead errors immediately, check the message: plain-HTTP gateways
are rejected unless loopback, and unreachable hosts surface as network errors —
both point at environment, not the release.

## 2. Approve in the browser

- Open the verification URL (or go to cloud.opengsd.net and enter the code
  manually).
- Sign in if prompted, review the requested device name, and approve.

Expected: the CLI spinner is replaced by `gsd-cloud: Authorization approved!`,
then `gsd-cloud: cloud runtime rt_<id> paired — connecting...`, then
`connected in the background (PID <n>)` with the advertised project path and
log file path. The shell prompt returns; the runtime stays up in the
background.

Denying the request instead must print `Device request denied by user.` and
exit 1 — verify this path once if the approval UI changed in this release.

## 3. Machine appears online on the dashboard

- In the browser, open the cloud.opengsd.net dashboard (machines/devices
  view).

Expected:

- The new machine appears with the runtime name (default: machine hostname)
  and shows **online** within ~30 seconds of the CLI reporting `connected`.
- The advertised project (the directory you ran `login` from) is listed under
  the machine.

If the machine shows offline, check the runtime log first (path printed by
`login`, also shown by `status`), then the gateway health:
`curl -s https://cloud.opengsd.net/healthz` should return `{"ok":true}`.

## 4. Status shows connected

```bash
npx @opengsd/gsd-cloud@latest status
```

Expected JSON output:

- `configured: true`, `enabled: true`, `gateway_url` pointing at the resolved
  gateway, `runtime_id: "rt_<id>"`, and `device_token: "[redacted]"` (never a
  raw token).
- `background.running: true` with the background PID.
- `telemetry` present (connection state / traffic counters); no secrets in it.

## 5. Exercise a cloud read path

From the dashboard, open the advertised project and trigger a read-only view
that goes through the gateway → runtime → local workflow MCP server loop
(project state/roadmap view). Expected: project state renders; the runtime log
on the machine records the forwarded tool call and its `tool_result`.

This is the production equivalent of the local harness's forwarded
`gsd_query` assertion.

## 6. Cleanup

```bash
# Stop the background runtime, keep pairing (reconnectable via `connect`).
npx @opengsd/gsd-cloud@latest stop

# Full cleanup: stop the runtime and remove local cloud credentials.
npx @opengsd/gsd-cloud@latest disconnect
```

Expected after `disconnect`:

- CLI prints `background runtime stopped and cloud credentials removed.`
- `status` shows `configured: false` and `background.running: false`.
- The dashboard marks the machine **offline** within ~1 minute (heartbeat
  sweep) — verify this, it is the production teardown signal.
- `~/.gsd/daemon.yaml` no longer contains a `cloud:` section.

If the verification machine is throwaway, also remove any test project
directories you created.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `login` spinner never completes | Approval not given, or code expired (10 min TTL) | Re-run `login`; approve promptly. |
| `Authorization approved!` then immediate exit | `gateway_url` returned by the server failed CLI validation | Check stderr for `ignoring invalid server-supplied relay URL`; verify the deployment's relay URL config. |
| `connected in the background` but machine offline on dashboard | WebSocket to relay rejected (device token) or relay unreachable | Read the runtime log from `status`; check `https://cloud.opengsd.net/healthz`. |
| `status` shows `running: false` after `login` | Background child died after ready | Read the log file path from `status`; for executor discovery errors, follow the package environment requirements linked above. |
| Dashboard project view errors | Local workflow MCP server failed in the project dir | Run `gsd-mcp-server` manually in the project dir and check it initializes, or test the command configured by `GSD_WORKFLOW_MCP_COMMAND`. |

## Rollback signals

Stop the publish and investigate if any of these fail in a clean environment:

1. `login` cannot complete an approved device flow.
2. An approved machine never appears online on the dashboard.
3. `disconnect` leaves the machine showing online after the heartbeat sweep.

Do not attempt fixes from this runbook; capture the CLI output, the runtime
log, and the dashboard state, and hand them to the release owner.
