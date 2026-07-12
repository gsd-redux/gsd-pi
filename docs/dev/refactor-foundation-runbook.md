# Refactor Foundation Domain Operation Runbook

Project/App: gsd-pi
Scope: M002 S06, revision-checked Domain Operation foundation

## Boundary

S06 adds one database transaction primitive. A fresh request checks project
revision and Authority Epoch, reserves idempotency, runs one deterministic
database-only mutation, records provenance/events/outbox/Projection Work, and
advances authority in one `BEGIN IMMEDIATE` transaction. An exact replay
returns the stored receipt without rerunning the mutation.

This slice does **not** cut over production authority. Schema stays at v35. Do
not change runtime handlers, command routing, file-derived readiness,
completion, UAT or reconciliation reads, implicit import behavior, projection
delivery, closeout effects, lifecycle policy, or legacy compatibility. Those
are later milestones. Any such change is a stop condition, not incidental S06
cleanup.

## Focused loop

Use the same command for RED and GREEN. RED must fail for the missing Domain
Operation behavior before implementation; GREEN must pass without weakening
the test.

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/domain-operation.test.ts
```

Run fault and lost-response cases alone while changing transaction ordering:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  --test-name-pattern='fault|lost response' \
  src/resources/extensions/gsd/tests/domain-operation.test.ts
```

Run the real two-process writer race alone while changing reservation or CAS
behavior:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  --test-name-pattern='two real processes racing' \
  src/resources/extensions/gsd/tests/domain-operation.test.ts
```

Fault coverage must include `after-operation`, `after-mutation`,
`after-events`, `after-outbox`, `after-projections`, and `before-cas`. Each
pre-commit fault must leave the exact pre-operation snapshot. The
`after-commit` case must replay the original receipt after a simulated lost
response.

## Foundation matrix

Run all M002 schema families together. These suites cover fresh databases,
v30-to-v35 upgrades, intermediate migrations, backups, restored-backup
upgrades, rollback/retry, restart, and constraint failures.

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/db-canonical-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-lifecycle-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-conversation-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-recovery-evidence-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-projection-closeout-foundation.test.ts \
  src/resources/extensions/gsd/tests/db-engine-migrate-guards.test.ts \
  src/resources/extensions/gsd/tests/db-migration-backup.test.ts \
  src/resources/extensions/gsd/tests/domain-operation.test.ts \
  src/resources/extensions/gsd/tests/single-writer-invariant.test.ts
```

Run the extension typecheck and unchanged authority baseline:

```bash
pnpm run typecheck:extensions
pnpm run baseline:workflow-authority
pnpm --silent run baseline:workflow-authority -- --json \
  | jq 'del(.durationMs) | .invariants |= map(del(.durationMs))' \
  > /tmp/gsd-m002-s06-authority.stable.json
```

Before review, run the local PR-blocking parity verification:

```bash
pnpm run verify:merge
```

Do not commit temporary databases, backups, TAP output, or captured JSON.

## UAT evidence

Record automated UAT with this stable field set. Preserve array order, omit
durations and machine paths, and use exact commands from this runbook.

```json
{
  "schemaVersion": 1,
  "milestoneId": "M002",
  "sliceId": "S06",
  "gitCommit": "<full commit sha>",
  "verdict": "pass",
  "noCutover": true,
  "checks": [
    { "id": "domain-operation", "command": "<command>", "verdict": "pass", "exitCode": 0 },
    { "id": "foundation-matrix", "command": "<command>", "verdict": "pass", "exitCode": 0 },
    { "id": "typecheck-extensions", "command": "pnpm run typecheck:extensions", "verdict": "pass", "exitCode": 0 },
    { "id": "workflow-authority", "command": "pnpm run baseline:workflow-authority", "verdict": "pass", "exitCode": 0 },
    { "id": "verify-merge", "command": "pnpm run verify:merge", "verdict": "pass", "exitCode": 0 }
  ],
  "receipt": {
    "statuses": ["committed", "replayed"],
    "requestHashFormat": "sha256:<64 lowercase hex>",
    "stableFields": [
      "operationId",
      "projectId",
      "resultingRevision",
      "resultingAuthorityEpoch",
      "requestHash",
      "eventIds",
      "outboxIds",
      "projectionWorkIds"
    ],
    "reopenIdentityPreserved": true
  },
  "faults": {
    "precommitPoints": [
      "after-operation",
      "after-mutation",
      "after-events",
      "after-outbox",
      "after-projections",
      "before-cas"
    ],
    "precommitResidueCount": 0,
    "lostResponseReplayPassed": true
  },
  "race": { "committed": 1, "stale": 1, "sqliteBusy": 0 },
  "migration": {
    "freshV35": "pass",
    "v30ToV35": "pass",
    "restoredBackupToV35": "pass",
    "openImportedCanonicalRows": 0
  },
  "failures": []
}
```

The baseline JSON retains its existing v1 fields and invariant order. Remove
only `durationMs` before comparison; do not rewrite failed rows.

## Stop conditions

Stop promotion and repair locally when any of these occurs:

- stale revision or epoch commits, replay invokes mutation, or a reused key
  accepts changed semantics;
- a pre-commit fault leaves residue, receipt identity changes after reopen, or
  projection work falls outside the operation transaction;
- the writer race produces zero or two commits, exposes `SQLITE_BUSY`, or
  leaves orphan operations, events, outbox rows, or projections;
- migration/restore changes preserved rows, imports canonical rows merely by
  opening the database, produces an unhealthy backup, or fails `quick_check`;
- the authority baseline, foundation matrix, typecheck, or `verify:merge`
  regresses; or
- the diff crosses the no-cutover boundary above.

Escalate to the developer only for missing authority/access, irreversible or
public action, or a genuinely ambiguous product route. Test failures, races,
migration faults, and baseline regressions are agent-remediated work.
