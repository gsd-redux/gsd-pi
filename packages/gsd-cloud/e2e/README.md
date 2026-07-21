# gsd-cloud local E2E harness (CAGT-05)

Automated end-to-end verification of the local cloud agent path, with **no
network access beyond 127.0.0.1** and no production dependency.

## Run

```sh
pnpm --filter @opengsd/gsd-cloud run test:e2e
```

The script builds `@opengsd/cloud-mcp-gateway` (and its workspace dependency
chain) and `@opengsd/gsd-cloud` first, then runs `e2e/run-e2e.mjs`.

This is intentionally **not** part of `pnpm test` (the unit-test run); it is a
separate gate you opt into locally or in CI.

## What it covers

1. Starts the real gateway (`createGatewayServer`) on an ephemeral loopback
   port with a temp `FileAuthStore` seeded with a random user token.
2. Mints a pairing code over `POST /pairing-codes` (user bearer token).
3. Runs the real CLI `gsd-cloud pair --gateway http://127.0.0.1:<port>` with a
   temp `HOME` and temp `--config`, asserting the device token + runtime id are
   written to the config.
4. Runs the real CLI `gsd-cloud connect --foreground` with
   `GSD_CLOUD_PROJECTS` pointing at a fixture project (minimal `.gsd`) and
   `GSD_WORKFLOW_MCP_COMMAND`/`ARGS` launching `fixture-gsd-mcp.mjs`, a stand-in
   for the workflow MCP server that speaks the executor's newline-delimited MCP
   stdio protocol.
5. Asserts the runtime registers in the gateway registry (alias, canonical
   path, `online: true`, `gsd` marker).
6. Drives the `/mcp` Streamable HTTP endpoint: `initialize`, `tools/list`
   (asserts `gsd_cloud_projects` and `gsd_query` are advertised),
   `gsd_cloud_projects` (asserts the fixture project is listed), and a
   forwarded `gsd_query` tool call (asserts the fixture's marker response came
   back through gateway → websocket → runtime → executor → stdio MCP → and
   return). It also forwards `gsd_status` to prove the workflow tool surface is
   available through the same path.
7. SIGTERMs the runtime, asserts a clean exit code and that the registry
   detaches, then tears everything down.

## Environment switches

| Variable | Effect |
| --- | --- |
| `GSD_CLOUD_E2E=0` / `false` | Skip the harness (exit 0) — for CI jobs that cannot build the full chain. |
| `GSD_CLOUD_E2E_TIMEOUT_MS` | Global watchdog timeout (default `120000`). |
| `GSD_CLOUD_E2E_GSD_CLI` | Path to a real `gsd` binary whose installed package contains the workflow MCP server (full-stack mode). |
| `GSD_CLOUD_E2E_KEEP_TMP=1` | Keep the temp root for debugging (the path is printed in the summary). |

## CI notes

- Loopback only: the gateway binds `127.0.0.1` on an ephemeral port; the CLI's
  SSRF guard allows plain HTTP exactly for loopback, so nothing leaves the
  machine.
- Hard timeouts: a global watchdog plus per-step timeouts bound the run; the
  runtime child is SIGKILLed on failure paths.
- Temp dirs (`$TMPDIR/gsd-cloud-e2e-*`) are removed in teardown unless
  `GSD_CLOUD_E2E_KEEP_TMP=1`.

For the manual production verification against cloud.opengsd.net, see
[`docs/dev/cloud-live-e2e-runbook.md`](../../../docs/dev/cloud-live-e2e-runbook.md).
