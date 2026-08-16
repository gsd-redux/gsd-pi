---
id: T015
title: Fail-closed legacy:cleanup:evidence redesign + static no-caller/no-importer proof
wave: 3
deps: [T002, T007]
status: done
agent: build_T015
commit: 16ab84dfa25034bdd68f4b9caaf9fe75eef94556
base: 291e71c154aac359be01cc38a34dccd992ab47b4
worktree: .worktrees/gsd-path-T015
task_branch: gsd-path/T015
files:
  - scripts/legacy-cleanup-evidence.mjs
  - scripts/legacy-cleanup-gate.mjs
  - scripts/legacy-state-path-proof.mjs
  - src/tests/legacy-cleanup-evidence.test.ts
  - src/tests/legacy-cleanup-gate.test.ts
  - package.json
---

# T015 — Fail-closed evidence pipeline + static state-path proof (NO new counters)

## Context

The deletion-proof strategy is settled: re-base the proof on STATIC evidence,
NOT on building the missing runtime counter. The live derive seam already
refuses markdown fallback (post-T007 it is unreachable), so the honest proof
is: (a) a static no-caller/no-importer AST proof for the legacy state-read
path, (b) the `parsers-legacy` importer-registry test driven to zero
production importers, (c) a redesigned `legacy:cleanup:evidence` that FAILS
CLOSED — today `ensureTelemetryReport` (scripts/legacy-cleanup-evidence.mjs:73-87)
fabricates an all-zero report when no telemetry file exists, so green is
satisfiable by construction and proves nothing (T001 confirmed this at
HEAD). The five existing counters (`legacy.workflowEngineUsed`,
`legacy.uokFallbackUsed`, `legacy.mcpAliasUsed`,
`legacy.componentFormatUsed`, `legacy.providerDefaultUsed`) keep their
current categories; NO `legacy.markdownFallbackUsed` counter is added —
that decision is settled, do not revisit it.

## Steps

1. Read `scripts/legacy-cleanup-evidence.mjs`, `scripts/legacy-cleanup-gate.mjs`,
   `src/tests/legacy-cleanup-evidence.test.ts`,
   `src/tests/legacy-cleanup-gate.test.ts`.
2. Fail-closed redesign of `legacy-cleanup-evidence.mjs`: when the telemetry
   file is missing (ENOENT) the command MUST exit non-zero with a
   `telemetry evidence missing — cannot prove zero usage` error; delete the
   `ensureTelemetryReport` fabrication path. When the file exists but was
   not produced during this invocation's evidence commands (compare the
   report `ts` against the run start), exit non-zero with a stale-evidence
   error. Green now requires real, fresh telemetry output from the evidence
   commands plus zero non-zero counters.
3. New `scripts/legacy-state-path-proof.mjs` — the static proof, modeled on
   the AST utilities already in the retiring gate style: (a) AST-scan (use
   the `typescript` package like
   `scripts/semantic-shadow-no-cutover-gate.mjs` does, or the importer
   registry's regex discipline — pick one and justify in a comment) proving
   zero production callers of `_deriveStateImpl` and zero production
   importers of `parsers-legacy` outside `tests/`; (b) exit non-zero
   listing every offending file:line; (c) a `--json` report mode. Until
   T020/T022 land, this proof reports the remaining known importers — wire
   it so `legacy:cleanup:gate` runs it and BLOCKS while any production
   importer/caller exists. This makes the gate honest: green ⇔ zero legacy
   state-path usage, provable statically.
4. `legacy-cleanup-gate.mjs`: integrate the static proof — the gate fails
   when the proof lists any offender, when telemetry is missing/stale, or
   when any counter is non-zero/missing. Keep the existing counter
   categories unchanged.
5. `package.json`: add `"legacy:cleanup:proof": "node
   scripts/legacy-state-path-proof.mjs"`; keep existing script names
   unchanged.
6. Update `src/tests/legacy-cleanup-evidence.test.ts` and
   `src/tests/legacy-cleanup-gate.test.ts`: missing telemetry ⇒ non-zero;
   stale telemetry ⇒ non-zero; fabricated all-zero reports no longer occur;
   fresh zero telemetry + clean static proof ⇒ pass. Update the gate test
   for the new static-proof integration. Any test that asserted the
   fabricated-report behavior is removed (AGENTS.md).

## Acceptance criteria

1. `legacy:cleanup:evidence` exits non-zero on missing or stale telemetry —
   green is no longer satisfiable by construction.
2. `legacy:cleanup:proof` exits non-zero listing offenders while any
   production `_deriveStateImpl` caller or `parsers-legacy` importer
   exists, and zero when none exist (test with a fixture offender).
3. `legacy:cleanup:gate` composes telemetry + static proof; the five
   counter categories are unchanged; no new runtime counter exists
   anywhere.
4. Both script test files updated and green.

## Verify

```bash
TMP=$(mktemp -u)/none.json; ! node scripts/legacy-cleanup-evidence.mjs --file "$TMP" >/dev/null 2>&1 && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/legacy-cleanup-evidence.test.ts src/tests/legacy-cleanup-gate.test.ts && grep -q "legacy:cleanup:proof" package.json && ! grep -rn "markdownFallbackUsed" scripts/ src/resources/extensions/gsd --include="*.mjs" --include="*.ts" | grep -v tests
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — planner (T024 split repair): heads-up from T025 — once the gates pass, the `ensureTelemetryReport` fabrication path becomes REACHABLE (the default evidence command `baseline:refactor:gate` passes but writes no telemetry file, so a bare `legacy:cleanup:evidence` run fabricates an all-zero green). This task's fail-closed redesign must account for the now-live path; evidence recorded in `.project/plan/wave2-gate-baseline.md`.
- 2026-08-05 — coder: fail-closed redesign + static proof implemented.
  - `scripts/legacy-cleanup-evidence.mjs`: deleted `ensureTelemetryReport` (fabrication path gone — no writer of telemetry remains in the script). `collectLegacyCleanupEvidence` records a run start, runs the evidence commands, then loads telemetry through the new fail-closed loader (`notBeforeMs`), and composes the static proof (`opts.proofRoot` seam for tests).
  - `scripts/legacy-cleanup-gate.mjs`: new `loadTelemetryEvidence` throws `telemetry evidence missing — cannot prove zero usage` on ENOENT, and stale errors for an unparseable `ts`, a `ts` predating the run, or a `ts` older than `--max-age-ms` (default 24h). `evaluateLegacyCleanupGate(report, proof)` now also fails when the proof is absent (`proofMissing`) or lists offenders; the five counter categories are unchanged and no new counter was added.
  - `scripts/legacy-state-path-proof.mjs` (new): line-scoped regex scan (comments stripped) of `src/resources/extensions` excluding `tests/` and `*.test.ts`, reporting `deriveStateImplCaller` and `parsersLegacyImporter` offenders as file:line, `--root`/`--json`, exit 2 on offenders. Regex over TS-AST is justified in a file comment: `typescript` is not a scripts/ runtime dependency and both bans are lexical; this matches the existing importer-registry discipline. Note: `scripts/semantic-shadow-no-cutover-gate.mjs` (cited in the task) does not exist at this base, so the alternative the task explicitly allowed was taken.
  - Live run: `node scripts/legacy-state-path-proof.mjs` exits 2 and lists the 9 remaining production `parsers-legacy` importers (zero `_deriveStateImpl` production callers) — the gate blocks until T020/T022 land, as intended.
  - `package.json`: added `"legacy:cleanup:proof": "node scripts/legacy-state-path-proof.mjs"`; existing script names untouched.
  - Tests: removed the `ensureTelemetryReport` fabrication test (behavior deleted); added missing/stale/fresh-pass evidence tests and gate tests for proof-missing, proof-offenders, `loadTelemetryEvidence`, and fixture-driven proof offender/clean cases.
  - Verify (exact): all 16 tests pass — `ℹ tests 16 / ℹ pass 16 / ℹ fail 0`; full command chain exited 0 (`VERIFY_EXIT=0`).
- 2026-08-05 — orchestrator Verify rerun (authoritative, isolated worktree):
  full chain exit 0 — missing-evidence path fails closed, tests 16 / pass 16 /
  fail 0, `legacy:cleanup:proof` present in package.json, zero non-test
  `markdownFallbackUsed` references. Diff scope check: 6 declared files (one
  new, scripts/legacy-state-path-proof.mjs) plus the task file; zero paths
  outside `files`.
