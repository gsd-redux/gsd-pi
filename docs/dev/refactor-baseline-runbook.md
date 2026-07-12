# gsd-pi Refactor Baseline Runbook

Project/App: gsd-pi
File Purpose: Operator runbook for Phase 0 baseline measurement and comparison during the long-running refactor.

## Purpose

Use this runbook to capture repeatable before/after measurements for the long-running refactor. The baseline harness is read-only unless `--output` is provided, and it does not change production behavior.

## Quick Start

Run a human-readable baseline:

```bash
npm run baseline:refactor
```

Run a JSON baseline:

```bash
npm run baseline:refactor -- --json
```

Persist a baseline outside the repo:

```bash
npm run baseline:refactor -- --json --output /tmp/gsd-refactor-baseline-before.json
```

Compare the current checkout against a previous baseline:

```bash
npm run baseline:refactor -- --compare /tmp/gsd-refactor-baseline-before.json
```

## Optional Timed Commands

Command timings are opt-in because they can be slower and may create ignored build/test output. Use `--command label=command` for each command to time:

```bash
npm run baseline:refactor -- \
  --command test-compile='npm run test:compile' \
  --command baseline='npm run baseline:refactor -- --json'
```

Startup timing should be captured after build output exists:

```bash
npm run baseline:refactor -- \
  --command startup='GSD_STARTUP_TIMING=1 node dist/loader.js --version'
```

## Report Shape

The JSON report includes:

- `schemaVersion`
- `schema.requiredMetrics`
- `prompt`
- `context`
- `distTest`
- `workspace`
- `commands`
- `metrics`
- `comparison`, when `--compare` is provided

The flat `metrics` map is the stable comparison surface for later phases. Prefer comparing values from `metrics` instead of reading nested fields directly.

## Required Metrics

Phase 0 requires these scalar metrics:

- `prompt.fileCount`
- `prompt.totalChars`
- `prompt.totalBytes`
- `prompt.totalLines`
- `context.fileCount`
- `context.totalChars`
- `context.totalBytes`
- `context.totalLines`
- `distTest.exists`
- `distTest.fileCount`
- `distTest.bytes`

Later phases may add metrics, but they must not remove or rename these without increasing `schemaVersion`.

## Phase Gates

Before starting a phase that changes behavior, capture a baseline:

```bash
npm run baseline:refactor -- --json --output /tmp/gsd-refactor-before-phase-N.json
```

After the phase is implemented and verified, compare:

```bash
npm run baseline:refactor -- --compare /tmp/gsd-refactor-before-phase-N.json
```

For Phase 2 token/context work, the prompt metrics are the primary gate. For Phase 3 build/test speed work, use opt-in command timings.

## Verification

### Workflow authority gate

Run the database-authority and fault-safety corpus in human-readable mode:

```bash
pnpm run baseline:workflow-authority
```

The four fixed invariants run in this stable order: `db-authority-fixture`,
`projection-conflict`, `fault-harness-contract`, and `fault-boundary-matrix`.
Together they cover the real SQLite fixture, contradictory projections, the
one-shot fault controller, and the production fault-boundary matrix. Each row
reports its verdict, duration, and exact rerunnable command.

Capture the machine-readable report outside the repository:

```bash
pnpm --silent run baseline:workflow-authority -- --json \
  > /tmp/gsd-workflow-authority-before.json
```

Durations are diagnostic and vary by machine. Compare the stable schema,
verdict, invariant order, commands, exit codes, signals, and errors after
removing duration fields:

```bash
jq 'del(.durationMs) | .invariants |= map(del(.durationMs))' \
  /tmp/gsd-workflow-authority-before.json \
  > /tmp/gsd-workflow-authority-before.stable.json

pnpm --silent run baseline:workflow-authority -- --json \
  | jq 'del(.durationMs) | .invariants |= map(del(.durationMs))' \
  > /tmp/gsd-workflow-authority-after.stable.json

diff -u \
  /tmp/gsd-workflow-authority-before.stable.json \
  /tmp/gsd-workflow-authority-after.stable.json
```

The v1 JSON object contains `schemaVersion`, `verdict`, `durationMs`, and
`invariants`. Each invariant contains `id`, `name`, `command`, `verdict`,
`exitCode`, `durationMs`, `signal`, and `error`, in that order.

The runner executes every invariant and exits with the first failing child's
nonzero status. Each child has a fixed 60-second timeout; a timeout, signal, or
spawn error produces a failing row and exits 1 when no nonzero child status is
available. `--json` is the only CLI option. The contract test also sabotages one
fixed child through the package-script path to prove that controlled sabotage
cannot produce a passing baseline. Do not weaken or edit an authority assertion
to clear this gate; rerun the exact command printed for the failed invariant and
repair the underlying behavior.

A baseline regression is ordinary agent-remediated work. Escalate only when
repair requires missing authority or access, irreversible/public consent, or a
materially ambiguous product decision. Do not commit captured JSON reports.

Run the focused baseline fixture gate:

```bash
npm run baseline:refactor:gate
```

Run the full Phase 0 gate:

```bash
npm run baseline:refactor:phase0
```

Run the compiled test path:

```bash
npm run test:compile
node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/tests/refactor-baseline.test.js
```
