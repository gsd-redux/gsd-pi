# M003/S07/T06 no-cutover gate research

> **Status:** Historical pre-implementation design snapshot. Current behavior
> is owned by the
> [semantic-shadow contract](M003-S07-SEMANTIC-SHADOW-RESEARCH.md) and the
> [lifecycle integration runbook](lifecycle-command-integration-runbook.md#s07-semantic-shadow-dossier).

## Question

How should T06 reject an accidental canonical lifecycle read/eligibility/retry
cutover, public response expansion, legacy compatibility deletion, and GitHub
label/tag authority without recreating a brittle source-string manifest?

## Governing boundary

The answer is a lean, behavior-first hybrid gate: execute real disagreement
fixtures for every observable authority decision, and use AST inspection only
for the few import/call boundaries and local-input rules that behavior cannot
make structurally visible.

This follows the canonical decisions:

- Direct maintainer instruction, not GitHub labels, tags, or review metadata,
  is the governing authority (`.gsd/DECISIONS.md:9`).
- M003 keeps legacy handler reads and responses authoritative; canonical
  lifecycle state remains shadow evidence and must not block or reroute
  production (`.gsd/DECISIONS.md:13`).
- R019 requires zero unexplained semantic drift while legacy reads/responses
  remain authoritative, with a structural no-read-cutover proof
  (`.gsd/state-manifest.json:258-266`).
- The frozen S07 boundary expressly forbids canonical lifecycle read,
  dependency-eligibility, or retry authority; public response changes; legacy
  or named-fixture deletion; Markdown fallback authority; and GitHub label/tag
  input (`docs/dev/M003-S07-SEMANTIC-SHADOW-RESEARCH.md:151-168`).

The gate should therefore answer two separate questions:

1. Can canonical lifecycle evidence flow into a production decision sink?
2. Do the real legacy and compatibility behaviors still execute and return the
   frozen contract?

Neither a constant array that asserts itself nor a raw `source.includes(...)`
test answers either question.

## Primary source findings

### The milestone-status seam already separates the two data paths

`executeMilestoneStatus` obtains the public milestone and slice fields through
the legacy hierarchy queries `getMilestone` and `getSliceStatusSummary`, while
the canonical snapshot is separately named `shadowSnapshot`
(`src/resources/extensions/gsd/tools/workflow-tool-executors.ts:7-21` and
`:2088-2123`). The observation is built and emitted only after the read
transaction, and the function returns the prebuilt response
(`src/resources/extensions/gsd/tools/workflow-tool-executors.ts:2124-2131`).

This is the correct structural seam. The gate should prove that canonical
lifecycle values cannot reach `content`, `details`, or the intermediate
success `result`; it should not forbid the canonical snapshot itself, because
that would also forbid the required observer.

The behavioral contract is stronger than a field manifest. A deliberate
legacy/canonical disagreement and contradictory ROADMAP projection must still
return the exact legacy `active` response through both native Pi and the shared
workflow executor (`src/resources/extensions/gsd/tests/semantic-shadow-contract.test.ts:318-360`).
The full production registration matrix repeats the byte/deep-equal response
check for all six modes and both transports while also proving all five shadow
classifications (`src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts:451-510`).

### Eligibility and retry have narrow current decision sources

Parallel milestone eligibility is derived from `deriveState(...).registry`;
completion and dependency checks use registry status and `dependsOn`
(`src/resources/extensions/gsd/parallel-eligibility.ts:98-169`). Slice dispatch
eligibility uses the legacy hierarchy functions `getMilestone` and
`getMilestoneSliceSummaries`, including the historical skipped-status behavior
(`src/resources/extensions/gsd/dispatch-guard.ts:68-149`).

Retry suppression is based on `unit_dispatches` through `getLatestForUnit` and
its attempt/backoff fields, not on `workflow_item_lifecycles`
(`src/resources/extensions/gsd/auto/detect-stuck.ts:7-58`). The rule registry's
retry trigger is local/persisted hook state rather than a lifecycle-head read
(`src/resources/extensions/gsd/rule-registry.ts:9-31`, `:996-1036`).

These are suitable structural boundaries: a canonical lifecycle query may
exist elsewhere for command settlement and shadow evidence, but its return
value must not become a dependency, dispatch, or retry decision in these
functions during S07.

### The repository already has useful gate conventions

The lifecycle writer suite uses the TypeScript parser to collect real import,
export, and dynamic-import declarations, then enforces a leaf boundary
(`src/resources/extensions/gsd/tests/lifecycle-command-writers.test.ts:1224-1293`).
The silent-catch audit likewise walks typed AST nodes rather than matching raw
file text (`src/resources/extensions/gsd/tests/silent-catch-diagnostics.test.ts:129-184`).
These are the structural conventions to reuse.

The workflow authority baseline supplies the orchestration convention: a fixed
set of real test programs is spawned in isolated children, each result is
reported, and any child failure makes the gate fail
(`scripts/workflow-authority-baseline.mjs:10-31`, `:44-119`). Its own test
demonstrates controlled sabotage with an imported child-process hook and
expects a nonzero report (`src/tests/workflow-authority-baseline.test.ts:86-137`).

The repository explicitly rejects tests that merely read product source and
regex/string-match it (`scripts/check-source-grep-tests.sh:1-10`, `:76-91`). A
T06 test that invokes an exported AST analyzer is a legitimate structural
linter, but it should include the required `allow-source-grep` explanation on
any line that loads production source. All response and compatibility claims
must still come from executing behavior.

## Recommended implementation

### 1. One script with a closed local input surface

Implement `scripts/semantic-shadow-no-cutover-gate.mjs` as an importable CLI:

- Accept only `--json`; reject every unknown argument.
- Compute the repository root from `import.meta.url`.
- Read only the checked-out source tree and local child-test results.
- Never accept a GitHub payload, label list, tag, PR metadata path, SHA supplied
  by environment, or network result.
- Remove `NODE_TEST_CONTEXT` before child execution, following the authority
  baseline. Also remove `GITHUB_*`/`GH_*` variables from child environments so
  the behavioral result is demonstrably independent of hosted metadata.
- Emit a deterministic report containing `schemaVersion`, `verdict`,
  `structuralChecks`, `behavioralChecks`, and `githubMetadataUsed: false`.
- Exit nonzero for a parse error, missing source/test, failed structural check,
  missing named behavioral witness, child error, timeout, or nonzero child
  status.

Add a package script such as:

```json
"gate:semantic-shadow-no-cutover": "node scripts/semantic-shadow-no-cutover-gate.mjs"
```

This matches the existing direct script entries for the workflow authority and
legacy cleanup gates (`package.json:74-82`).

### 2. Prove authority with deliberate disagreement fixtures

Add three focused cases to `semantic-shadow-no-cutover.test.ts`. Each fixture
must seed the legacy decision source and canonical lifecycle head with opposite
answers, call the real exported production function, and assert the legacy
answer wins:

1. `executeMilestoneStatus`: legacy hierarchy says `active`, canonical
   lifecycle says `completed`; the exact existing public response remains
   `active` and contains no extra fields.
2. `analyzeParallelEligibility`/`getPriorSliceCompletionBlocker`: legacy
   registry/slice rows say a dependency is satisfied or skipped while the
   canonical lifecycle says otherwise; eligibility/dispatch retains the legacy
   result. Repeat with the disagreement reversed so the fixture cannot pass by
   always returning one constant.
3. `detectStuck`: `unit_dispatches` says the retry is inside its backoff window
   while the canonical lifecycle has an opposing status; stuck suppression
   follows the dispatch ledger. Repeat after expiring `next_run_at` and expect
   the opposite result. The existing retry test already demonstrates the
   ledger-driven seam (`src/resources/extensions/gsd/tests/detect-stuck-respects-retry.test.ts:29-163`).

These cases are the primary cutover proof. A renamed helper or harmless
refactor does not weaken them.

### 3. Keep the structural analyzer narrow

Use `typescript` AST nodes and resolved import/call bindings. Do not compare
whole function text, count token occurrences, or freeze line positions. Avoid
a repository-wide or transitive call-graph engine; the deliberate disagreement
fixtures already prove runtime authority.

For `executeMilestoneStatus`:

1. Locate the exported function declaration by AST.
2. Resolve local import bindings and the local success-response initializers.
3. Inspect the success response's `content`, `details`, and the object
   serialized into them.
4. Require legacy witnesses from `getMilestone` and
   `getSliceStatusSummary` in that dependency closure.
5. Fail if the closure reaches a canonical lifecycle snapshot/comparison,
   repair, or `workflow_item_lifecycles` SQL source.
6. Allow canonical data only in a `shadowSnapshot` branch that flows to
   `buildLifecycleShadowObservation`/`emitLifecycleShadowObservation` and is
   absent from the public response dependency closure.

For eligibility and retry, inspect direct import/call boundaries in these named
decision functions:

- `analyzeParallelEligibility`
- `getPriorSliceCompletionBlocker`
- `resolveDispatch` only at its closed-status/dispatch eligibility guards
- `rowInsideRetryBudget` and `retryBudgetSuppresses`

Fail if those decision branches directly import/call the lifecycle
shadow/comparison/repair modules, a lifecycle writer read, or an AST string
literal that queries `workflow_item_lifecycles`. Keep current legacy witnesses:
`deriveState`/registry for milestone dependencies,
`getMilestoneSliceSummaries` for slice dispatch, and `getLatestForUnit` for
retry/backoff. This is a call-boundary rule, not a ban on canonical lifecycle
code elsewhere in the same application.

For the gate itself, AST-inspect its external inputs. Reject:

- imports from GitHub/Octokit/hosted-review clients;
- `process.env.GITHUB_*` or `process.env.GH_*` reads;
- child-process invocations whose executable can be `gh` or whose arguments
  request labels, tags, releases, or PR metadata; and
- external evidence-file arguments beyond the local root implied by the
  script.

This directly encodes the authority boundary without scanning the repository
for the common words “label” or “tag,” which have many legitimate uses.

### 4. Run real named compatibility witnesses

The gate should parse test declarations only to verify that each named witness
still exists, then execute every unique test file. A file existing without its
case is a failure; a test title existing but failing is also a failure.

Recommended witnesses:

| Compatibility promise | Executable witness |
|---|---|
| Frozen public response and contradictory projection | `semantic-shadow-contract.test.ts` — “keeps milestone status byte/deep-equal across native Pi and the shared workflow executor” (`:318-360`) |
| All modes/transports and frozen response | `semantic-shadow-mode-matrix.test.ts` — “all supported modes and transports preserve the frozen response and exact observation identity” (`:451-510`) |
| Unadopted Markdown import | `md-importer-adopted-authority.test.ts` — “unadopted re-import keeps existing checkbox completion behavior” (`:281-304`) |
| Unadopted reconcile | `workflow-reconcile.test.ts` — “unadopted legacy Milestone completion remains an explicit reconciliation compatibility path” (`:326-340`) |
| Same-status repair | `adopted-lifecycle-bypass-closure.test.ts` — “same-status completion timestamp repair remains available when adopted state is aligned” (`:135-156`) |
| Park and unpark | `park-db-sync.test.ts` — the park/unpark DB cases at `:32-153` |
| Discard | `park-milestone.test.ts` — “discardMilestone removes DB rows, worktree, and milestone branch” (`:240-270`) |
| Legacy skipped dependency/dispatch behavior | `dispatch-guard-closed-status.test.ts` — “skipped prior DB slices do not block later slice dispatch” (`:33-41`) |

The adopted import/reconcile protection cases in the same first two suites
should remain in the run as adjacent protection. The no-cutover gate does not
need to duplicate their assertions.

Run each file as a real Node test child using the same resolver command as the
authority baseline (`scripts/workflow-authority-baseline.mjs:44-62`). Do not use
a list that is only asserted back against itself; the list is useful solely as
an execution plan and missing-witness check.

### 5. Keep public-shape proof behavioral

Do not AST-freeze a literal list of response fields. The existing fixture
constructs the expected object independently and asserts byte-equal text and
deep-equal structured details (`src/resources/extensions/gsd/tests/semantic-shadow-contract.test.ts:318-357`).
The production mode/transport matrix independently repeats that contract
(`src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts:451-473`).
Running those suites catches additions, removals, ordering changes in serialized
content, and transport-specific expansion better than a source manifest.

## Controlled sabotage plan

`semantic-shadow-no-cutover.test.ts` should import the analyzer/runner API and
exercise mutations in memory or in a temporary copied fixture. It must never
edit the working tree.

1. **Canonical read cutover:** change the success response dependency from
   `milestone.status` to a canonical snapshot status. Expect the response-taint
   check to fail; restore the pristine source and expect pass.
2. **Observer leak:** spread `shadowSnapshot` into `details`. Expect the
   response-taint check to fail.
3. **Public expansion:** use an injected child runner (or a controlled
   `NODE_OPTIONS` preload as in the authority baseline test) to make the frozen
   response fixture fail. Expect the CLI report and exit code to fail, then run
   the unmodified child successfully.
4. **Eligibility cutover:** inject a canonical lifecycle snapshot import/call
   into `analyzeParallelEligibility` or `getPriorSliceCompletionBlocker` and
   use it in a branch condition. Expect the decision-provenance check to fail.
5. **Retry cutover:** replace the `getLatestForUnit` decision source with a
   lifecycle-head read. Expect the retry-provenance check to fail.
6. **Legacy deletion:** omit one named compatibility file or its exact test
   declaration from a temporary fixture. Expect a missing-witness failure
   before child execution.
7. **Compatibility regression:** inject a nonzero child status for each
   compatibility suite in turn. Expect the report to name that suite and fail.
8. **GitHub input:** inject `process.env.GITHUB_REF`, an Octokit import, or a
   `gh ... --label/--tag` child command into a temporary gate source. Expect the
   local-input check to fail. Separately show that setting arbitrary
   `GITHUB_*` and `GH_*` values does not change the pristine report.

Every sabotage assertion should immediately re-run the pristine analyzer or
child and prove restoration. That avoids a false-positive test that only knows
how to fail.

## What not to build

- No hash of entire source files: harmless refactors would invalidate it.
- No manifest whose only test is `assert.deepEqual(MANIFEST, [...same values])`.
- No regex/substring scan for identifiers or response fields.
- No repository-wide ban on words such as `label`, `tag`, `retry`, or
  `lifecycle`; the boundary is authority flow at named sinks.
- No replacement status/eligibility abstraction merely to make the gate easy.
- No network or GitHub API fallback when local evidence is missing. Missing or
  ambiguous local evidence is a failing gate.

## Recommended verification

```sh
pnpm exec tsx --test \
  src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts
node scripts/semantic-shadow-no-cutover-gate.mjs
pnpm run baseline:workflow-authority
pnpm run typecheck:extensions
```

The authority baseline remains a separate 4/4 proof; the no-cutover gate should
report it as adjacent evidence rather than silently replacing or reimplementing
it.
