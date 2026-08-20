# Test confidence stack

This document maps **what protects what** across local scripts and CI. Use it when you need merge confidence, not just a green `verify:pr`.

## Quick reference

| When | Run locally | CI equivalent | Blocks merge? |
|------|-------------|---------------|---------------|
| Every push | `npm run verify:fast` | `fast-gates` | Yes |
| Fast iteration while editing | `npm run verify:pr` | Partial `build` job (`build:core` + unit tests) | No — not sufficient alone |
| **Before requesting PR review** | **`npm run verify:merge`** | `build` | Yes (when `heavy-code-changed`) |
| Full evaluation baseline | `npm run test:evaluation` | Partial (blocking tiers + auxiliary) | No |
| Repo-wide coverage report | `npm run test:coverage:full` | `Coverage report` workflow | Separate workflow |
| Coverage thresholds | `npm run test:coverage` | `Coverage report` workflow | Separate workflow |
| Docker paths changed | `npm run test:e2e:docker` | `build` Docker e2e step | Yes when triggered |
| Portability paths changed | Windows job + package tests | `windows-portability` | Yes when triggered |
| Windows smoke (experimental) | `npm run test:e2e:windows-smoke` | `windows-smoke-e2e` | **Warn only** (`continue-on-error`) |

**Node 26+:** `c8` depends on `yargs` v17, which breaks under Node 26’s module resolution. The repo pins `yargs@^18` via `package.json` `overrides` (CI uses Node 24).

Run the inventory anytime:

```bash
npm run audit:test-confidence
npm run audit:test-confidence -- --strict   # fail if tier map drifts from package.json
npm run audit:test-gaps                     # unwired tests, zero-test extensions, thin packages
npm run audit:test-gaps -- --strict-unwired # fail if any test file is unwired/unknown
npm run audit:test-matrix                   # per-source-file status matrix
npm run audit:test-matrix -- --strict       # fail unless the audit matrix is fully covered
npm run audit:test-matrix -- --write-report # regenerate docs/dev/test-evaluation-report.md
```

`audit:test-matrix --strict` is the repo audit definition for source coverage:
zero untested source files, zero critical/high untested files, zero source
files mapped only to unwired tests, zero unwired test files, and zero
unreachable test files. A source file can count as `indirect` when a reachable
suite-level test covers its package, root area, or extension even without a
same-stem test file.

## Test runners by code area

| Code area | Test runner | Invoked by | Notes |
|-----------|-------------|------------|-------|
| `src/` + GSD extension | `node --test` on compiled `dist-test/` | `test:unit` | Primary app unit tests; compile via `test:compile` |
| Extension integration suites | `node --test` + `resolve-ts.mjs` | `test:integration` | ollama, async-jobs, browser-tools, search-the-web, bg-shell, slash-commands |
| `packages/*` | `node --test` (compiled to dist-test) | `test:packages` | Every linkable package must have ≥1 test (`verify:workspace-coverage`) |
| `@gsd/pi-ai` vitest | `vitest --run` | `pnpm --filter @gsd/pi-ai test` | Wired into CI `build` and `verify:merge`; not covered by `test:packages` |
| Extensions with ≥5 source files | `tests/*.test.*` required | `verify:extension-coverage` | Enforced in `verify:merge` |
| `scripts/__tests__` | `node --test` | `verify:fast` | CI contract/policy regressions |
| `tests/e2e/` | `node --test` against built binary | `test:e2e` | Requires `GSD_SMOKE_BINARY=dist/loader.js` |
| Coverage (merged) | c8 across unit/integration/packages | `test:coverage:full` | Writes `coverage/lcov.info` + `coverage/file-index.json` |
| Coverage thresholds | c8 on GSD slice | `test:coverage` | Manual/scheduled coverage workflow |

## Enforcement philosophy

### Block merge (PR)

When `heavy-code-changed=true`, CI runs the Linux build and test stack in one job to avoid repeated checkout/setup/install/artifact restore overhead:

1. `build` — compile, web host, `validate-pack`, workspace coverage gate
2. `build` — compiled unit tests, package tests, `@gsd/pi-ai` vitest, integration tests, and e2e smoke
3. `build` — Docker e2e when `docker-changed=true`

Native package tests are skipped in the main Linux package-test step unless native/portability paths changed; otherwise a full Rust native rebuild can dominate unrelated CI runs.
Compiled package tests use Node's `--test-force-exit` so leaked handles in one package do not idle until the CI watchdog fires after all assertions pass.

Local parity: **`npm run verify:merge`** (runs the same npm scripts sequentially, including `verify:extension-coverage`). It also builds `pnpm run build:native:test` and stages `dist-test/native/addon/` with `GSD_NATIVE_PREFER_LOCAL=1`, matching the CI `build` job. Requires a local Rust toolchain.

`verify:fast` also runs:

- `scripts/__tests__/`
- `audit:test-gaps --strict-unwired`
- `audit:test-matrix --strict`

### Coverage workflow

- `test:coverage` — c8 thresholds (40/40/20/20) on the GSD slice
- `test:coverage:full` — merged coverage artifacts
- Runs manually, weekly, or on PRs labeled `coverage`

### Warn or path-gate

- **Windows e2e smoke** — runs when Windows-relevant paths change but does not block merge today
- **Docker e2e** — required when docker paths change, skipped otherwise
- **Doc-only PRs** — skip build/test jobs intentionally; `fast-gates` still runs

## Why `verify:pr` still exists

`verify:pr` is a **fast inner loop** (~5–15 min): `build:core` → `typecheck:extensions` → `test:unit`.

It is intentionally lighter than CI. Do not treat a passing `verify:pr` as merge-ready. Use `verify:merge` before requesting review.

`verify:full` is an alias for `verify:merge` (kept for backward compatibility).

## Known gaps (honest)

These are tracked limitations, not bugs to hide:

1. **Web UI** — many files rely on suite-level indirect coverage; use `audit:test-matrix` to separate named coverage from indirect coverage
2. **Windows smoke** — non-blocking until flake rate is acceptable
3. **Single-file extensions** — may rely on root-level suite coverage instead of dedicated extension-local tests

## Related docs

- [Test evaluation report](./test-evaluation-report.md) — regeneratable matrix snapshot
- [CI/CD Pipeline Guide](./ci-cd-pipeline.md) — promotion pipeline and workflow files
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — local development commands
