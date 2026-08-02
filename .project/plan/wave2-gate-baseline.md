# Wave 2 gate baseline — re-baseline at clean HEAD (T025)

- Date: 2026-08-02 (UTC)
- HEAD: `c6935a65bd224bd8416cb8552da97af14c1f5904` (`git rev-parse HEAD` in the T025
  worktree; tree clean except the two T025 source edits:
  `src/tests/fixtures/prompt-golden-fixtures.ts`, `packages/native/src/native.ts`)
- Environment: pnpm 10.12.1, node v24.15.0, cargo 1.96.0 (darwin-arm64)

## Procedure

1. `pnpm install --frozen-lockfile --ignore-scripts` — clean (exit 0).
2. Confirmed `packages/contracts/dist` absent (T024's source redirect covers
   `@opengsd/contracts`; nothing builds it and nothing needs to).
3. `pnpm run build:native:dev` — NEW STEP (T025). Builds the local dev addon
   `native/addon/gsd_engine.dev.node` from the Rust source. Required because
   the pinned npm binary `@opengsd/engine-darwin-arm64` v1.11.0 lags the Rust
   source and has no `ProjectionRootIdentityLock` export; post-T025 the loader
   (`packages/native/src/native.ts`) prefers a present local addon over the
   pinned npm package automatically — no `GSD_NATIVE_PREFER_LOCAL=1` needed.
4. Gates run bare, exactly as specified in T001.

## Gate results

### 1. `pnpm run baseline:refactor:gate` — PASS (exit code 0)

34 tests, 34 pass, 0 fail. The T024 re-run's surviving red leg
(`prompt golden fixtures meet Phase 2 reduction gate`, 9454/15400) is resolved
by an evidence-backed reference update (see "Leg 1 resolution" below).

### 2. `pnpm run baseline:refactor:phase0` — PASS (exit code 0)

140 tests, 140 pass, 0 fail (includes the embedded gate-1 run plus the four
phase-0 test files).

### 3. `pnpm run gate:semantic-shadow-no-cutover` — PASS (exit code 0)

```
Status: PASS
Structural: 8/8
Behavioral: 15/15
GitHub metadata used: no
```

All 15 behavioral witnesses execute and pass, including `discard` (the T024
re-run's surviving red leg). No witness skipped; the fail-closed native-lock
policy in `managed-projection-history.ts` is unchanged.

### 4. `legacy:cleanup:gate` probes — honest both ways

- Zero-counters telemetry file (all five `legacy.*` counters = 0):
  `node scripts/legacy-cleanup-gate.mjs --file "$TMPD/t.json"` — exit code 0.
- Nonexistent telemetry file:
  `node scripts/legacy-cleanup-gate.mjs --file "$TMPD/nonexistent.json"` —
  exit code 1 with raw `ENOENT` (no fabricated green).

## Leg 1 resolution (prompt-golden Phase-2): evidence-backed reference update

Exactly one resolution landed: **reference update** (deliberate growth / stale
reference), per the task's branch 1. The 0.6 factor and the test logic are
unchanged; no builder code changed.

Evidence (rendered via the test's exact fixture harness at both SHAs):

- `04f3ba14e` (last baseline adjustment, comment claimed "~9154"): rendered
  complete-slice = **9418 chars** — the gate was already over cap at that SHA
  (`floor(15400*0.6) = 9240`). The "~9154" note was a short-tmp-path Linux
  measurement: the fixture embeds the absolute tmp working-directory path 5
  times, and this macOS prefix is 44 chars longer than Linux `/tmp`
  (9418 - ~220 ≈ 9198 ≈ the recorded "~9154").
- HEAD `c6935a65b`: rendered complete-slice = **9454 chars**.
- Net growth since the last adjustment: **+36 chars**. Diff of the two renders
  shows deliberate content additions — DB-authoritative milestone lifecycle
  wording (#1476, step 6) and terminal-handoff stop-rule strengthening
  (step 4, #846 lineage) — mostly offset by #1475 prompt compression. Not
  accidental bloat; no duplication or uncompressed block found.

Change: `complete-slice.phase2StartChars` **15400 → 15900** (old/new recorded
in the fixture comment). `floor(15900*0.6) = 9540`, restoring the ~86-char
headroom convention the #846 adjustment used (15400 allowed ~9154).
Other units unaffected (plan-slice 10566 ≤ 11555; execute-task 8314 ≤ 8592;
aggregate 28334 ≤ floor(49479*0.6) = 29687).

## Leg 2 resolution (discard witness / native lock): environmental, mirrors CI

Root cause (confirmed by planner, re-confirmed here): pinned npm binary
`@opengsd/engine-darwin-arm64` v1.11.0 loads (95 exports) but lacks
`ProjectionRootIdentityLock`; the lock was added to the Rust engine after the
pinned binary was published. CI handles this skew by building from source.

Fix, confined to `packages/native/src/native.ts`:

- When a local addon build exists on disk (`native/addon/gsd_engine.<platform>.node`
  or `gsd_engine.dev.node`), the loader now prefers it over the pinned npm
  package. `GSD_NATIVE_PREFER_LOCAL=1` remains as an explicit override; the
  npm package remains the fallback for production installs (no `native/addon`
  there); the graceful JS-fallback proxy on load failure is unchanged.
- Stale-engine diagnostics: when a successfully loaded addon lacks exports the
  source tree expects (`SqliteFileIdentityLock`,
  `ProjectionRootIdentityLock`), the loader now writes a stderr warning naming
  the source and the missing exports, instead of letting it surface later as a
  bare "unavailable" error.

`managed-projection-history.ts` and `tests/park-milestone.test.ts` needed no
changes — the availability check and the witness were correct; only the engine
binary was stale. Fail-closed policy untouched; no JS re-implementation added.

## T015 flag: `legacy:cleanup:evidence` fabrication path is NOW REACHABLE

`ensureTelemetryReport` (`scripts/legacy-cleanup-evidence.mjs:73-87`) still
fabricates an all-zero counters report when the telemetry file is missing.
Pre-T025 this was latent because the default evidence command
(`baseline:refactor:gate`) failed before the fabrication ran. Post-T025 the
evidence command passes but writes no telemetry file, so a bare
`pnpm run legacy:cleanup:evidence` run WILL fabricate an all-zero green.
Owned by wave-3 T015 (fail-closed redesign), which is already scoped for
exactly this.

## Verdict

VERDICT: BASELINE GREEN
