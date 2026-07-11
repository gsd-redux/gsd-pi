# GSD Cloud Monitor

A macOS 14+ menu bar app for monitoring the standalone `gsd-cloud` agent.
It shows the live WebSocket connection state, agent process, gateway, active
tool calls, reconnect history, message counts, byte totals, and current traffic
rates, plus a per-project dashboard (requests, errors, bytes, active tools,
and recent activity).

The app is intentionally menu-bar-only. It does not read or display the cloud
device token. It polls the token-free status file written by `gsd-cloud` once
per second — `~/.gsd/cloud-runtime-status.json` for the default
`~/.gsd/daemon.yaml` config. The menu bar app can track more than one runtime
configuration (including configs that share a directory); each non-default
config gets its own status/log file, namespaced by a hash of the config path,
managed from **Settings**.

From the dashboard toolbar you can **Start**, **Stop**, and **Reconnect** the
selected runtime, and **Export Diagnostics** to a failure-safe report for bug
reports — none of these actions touch the stored pairing credentials. Settings
also covers connection-change notifications, launch at login, and manual
update checks.

## Run

```bash
./script/build_and_run.sh
```

The script builds a SwiftPM executable, stages a real app bundle at
`dist/GSDCloudMonitor.app`, stops an older instance, and launches the new build.
The local Codex environment also exposes this command as its **Run** action.

Useful verification modes:

```bash
./script/build_and_run.sh --verify
./script/build_and_run.sh --preview
```

`--verify` confirms the menu bar process stays alive. `--preview` opens the same
monitor view in a temporary window with synthetic telemetry so the connected
layout can be inspected without modifying the live agent state.

## Test

```bash
swift run GSDCloudMonitorCoreTests
```

The dependency-free executable tests telemetry decoding, byte-rate calculation,
and counter reset behavior. The repository's `@opengsd/gsd-cloud` package tests
cover status-file permissions, credential exclusion, connection transitions,
and socket traffic accounting.

## Release

Create locally verifiable universal artifacts without Apple credentials:

```bash
swift run GSDCloudMonitorReleaseTests
```

Production packaging requires `DEVELOPER_ID_APPLICATION` plus either a
`NOTARYTOOL_PROFILE` or App Store Connect API key variables. A tag matching
`gsd-cloud-monitor-v*` runs the GitHub Actions release workflow and uploads the
notarized ZIP, DMG, and checksums to GitHub Releases.
