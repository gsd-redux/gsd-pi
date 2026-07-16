<!-- Project/App: gsd-pi -->
<!-- File Purpose: Research-only automated UAT, PR, exact-merge replay, and canonical closure plan for M003/S07/T07. -->

# M003/S07/T07 automated UAT and shipping research

> **Status:** Research-only snapshot at
> `a4100b234c57c7ec8b82473281921dd1d4668aa9`. Current closure protocol is
> owned by the
> [lifecycle integration runbook](lifecycle-command-integration-runbook.md#s07-semantic-shadow-dossier)
> and the generated [cutover dossier](m003-s07-cutover-dossier.json).

**Scope:** the safest automated path from a finished T07 implementation through
candidate UAT, `verify:merge`, no-mistakes, hosted CI, squash merge, exact-merge
replay, source-bound verdict publication, and canonical T07/S07 closure.

**Non-goals:** this record does not push, create or modify a PR, merge, change a
branch, write the project database, or implement T07. GitHub labels, Git tags,
release tags, and GitHub milestones are explicitly excluded as authority inputs.

## Executive recommendation

Use a two-phase evidence protocol and one explicit merge interlock:

1. On the clean candidate branch, generate the deterministic dossier, run the
   capstone and adjacent checks through `gsd_uat_exec`, save a candidate UAT
   attempt through `gsd_uat_result_save`, and pass `pnpm run verify:merge`.
2. Let no-mistakes own review, repair, push, PR creation, and hosted-check
   monitoring. When its current head is green, independently prove the PR head,
   base, conflict state, and expected check rollup. Then squash-merge with
   `--match-head-commit`; do not use unguarded auto-merge.
3. Read the merged PR's `mergeCommit.oid`, fetch without tags, and add a fresh
   detached worktree at that exact commit. Rerun the exact-source capstone there,
   save a second UAT attempt, publish the source-bound technical verdict, then
   close T07 and S07 only through canonical database operations.

The checked-in dossier must bind to the deterministic **source-content
revision**, not claim to know its future merge commit. The post-merge database
receipt binds that content revision and evidence digest to the actual GitHub
`mergeCommit.oid`. This avoids the impossible self-reference of changing a
versioned dossier to contain the commit that already contains it.

The successful T07 recommendation remains **NO-GO for legacy read-authority
cutover**. Shipping the convergence proof does not supersede D005.

## Current starting facts

Read-only inspection on 2026-07-15 found:

| Fact | Current value | Shipping implication |
| --- | --- | --- |
| Worktree | `gsd-pi-m003-s04-t06-final-convergence` | Keep it intact; do exact-merge replay elsewhere. |
| Branch / HEAD | `codex/refactor-m003-s07-semantic-shadow` / `a4100b234c57c7ec8b82473281921dd1d4668aa9` | Candidate identity only, not merged identity. |
| Base | `origin/main` at `66118950cd2505d7de4673f6fa3074901caf1757` | Current branch is 12 commits ahead and based on this commit. Recheck before shipping. |
| Worktree state | clean | Required before source capture and no-mistakes. |
| Remote branch | absent on `origin` | Expected pre-shipping state, not a blocker. |
| PR for branch | none | Expected pre-shipping state, not a blocker. |
| GitHub authentication | active account with `repo` and `workflow` scopes | No current credential blocker. |
| Main protection | repository rules reject deletion/non-fast-forward updates and code-quality errors; classic branch protection is absent | Hosted status checks are not enforced for us. The runbook must enforce `ci-gate` itself and must not rely on auto-merge. |
| Canonical work | T01-T06 complete; T07 pending; S07 pending | T07 and S07 must be closed after exact-merge proof, not before. |
| Live shadow observations | zero observation/loss audit rows; default production provenance can be `sourceRevision: "unavailable"` | Existing absence is diagnostic, not complete evidence. T07 must create fresh, explicit-source capstone evidence. |

There is no known external blocker and no additional user authority is required
beyond the standing developer approval. A missing remote branch or PR is simply
a stage that no-mistakes will create later.

## Authority and evidence boundaries

### What is database-backed

`gsd_uat_exec` produces fresh typed execution metadata and output under the
project's approved `.gsd/exec` evidence root. The execution tool rejects source
mutation, Git mutation, dependency installation, environment dumps, and other
unsafe scripts. It does **not** by itself make the command output a database row.

`gsd_uat_result_save` is the bridge into authoritative project state. It:

- validates every check and requires fresh `gsd_uat_exec` evidence;
- writes the rendered assessment as an `assessments` row;
- upserts the UAT `quality_gates` row;
- inserts a typed `gate_runs` row with outcome, failure class, attempt, and
  rationale; and
- writes the detailed `attempt-N.json` as a filesystem artifact.

Therefore the truthful description is: **a database-backed assessment/gate/run
receipt that references fresh typed filesystem evidence**. The attempt JSON and
exec metadata are durable artifacts, but are not themselves database rows.
Their hashes and stable evidence IDs belong in the dossier and verdict evidence.

Canonical Task technical verification adds the stronger source-bound chain:

```text
running Attempt
  -> settled succeeded Result
  -> immutable Technical Verdict(testSourceRevision, evidence)
  -> source re-capture and exact match
  -> canonical Task completion publication
```

The publication adapter fails if the current source aggregate no longer equals
the passing verdict's `tested_source_revision`. Task and Slice closure must use
this path; direct SQL updates or Markdown edits are forbidden.

### What is projection-only

The dossier JSON and runbook are review surfaces. UAT assessment Markdown,
SUMMARY files, ROADMAP/STATE output, and the typed UAT attempt JSON remain
projections/artifacts. They can make a problem visible, but cannot authorize a
Task, Slice, merge, or cutover.

### GitHub data: interlock versus authority

GitHub's PR head SHA, base branch, check conclusions, conflict state, merged
state, and `mergeCommit.oid` are shipping interlocks and source identity. They
do not decide the semantic-shadow product verdict. Labels, tags, milestones,
review labels, and release metadata are neither interlocks nor evidence and must
never be read by the dossier generator or closeout decision.

## Exact source identity without a self-reference loop

The repository verification snapshot hashes sorted tracked and non-ignored
untracked source contents, modes, symlink targets, and submodule revisions while
excluding `.gsd/**`. It confirms the snapshot twice and fails if source changes
during capture. Its aggregate SHA-256 is stable when a squash merge preserves
the candidate tree, even though the Git commit SHA changes.

Use two distinct fields:

| Identity | Owner | When known | Where persisted |
| --- | --- | --- | --- |
| `sourceContentRevision` | deterministic repository snapshot | pre-merge and post-merge | checked-in dossier, UAT evidence, Technical Verdict |
| `mergeCommitSha` | GitHub `mergeCommit.oid` | only after merge | exact-merge exec metadata, DB-backed UAT rationale/evidence, final verdict/summary |

The checked-in dossier must not contain a non-null future `mergeCommitSha`.
Either omit that field from the generated document or represent only that the
merge binding is published separately. Editing the dossier after merge would
create a new source tree and invalidate the exact commit just tested.

The exact-merge receipt must prove all of the following together:

- the detached worktree `HEAD` equals `mergeCommitSha`;
- the merge commit is reachable from fetched `origin/main` (equality is not
  required if another main commit landed afterward);
- the clean worktree's `sourceContentRevision` equals the dossier revision;
- the rerun evidence digest equals the digest published in the final receipt;
- the capstone cardinality, baseline 4/4, dossier `--check`, and no-cutover
  assertions pass.

## Automated sequence

### Stage 0 — freeze the candidate

1. Re-read `CONTRIBUTING.md`; confirm the current branch has not already merged.
2. Fetch `origin/main` without tags. If main advanced, integrate it, resolve
   conflicts, and restart candidate verification. An ordinary resolvable
   conflict is agent work, not a user blocker.
3. Require a clean working tree and record candidate HEAD, base SHA, source
   aggregate revision, dossier digest, and intended repository/base.
4. Confirm T01-T06 are complete and T07/S07 are pending from SQLite. Do not infer
   state from plan checkboxes or GitHub metadata.

Checkpoint: no later stage may silently substitute a different candidate HEAD.

### Stage 1 — build and verify the dossier

The generator should be local, deterministic, read-only with respect to
authority, and network-free. It must ignore `GH_*` and `GITHUB_*` inputs and
derive counts from ordered evidence rows rather than trust summary numbers.

The live-project and isolated-capstone namespaces must remain separate. The
current live database has no retained production observation envelopes; the
generator must report that fact and must not copy fixture rows into live audit
tables. The capstone must generate fresh coverage with an explicit verified
source aggregate instead of `"unavailable"`.

Minimum mechanical gates are:

- 6 modes x 2 transports = 12 unique envelopes;
- 5 classifications per envelope = 60 items;
- 12 items for each exact classification;
- repaired, rejected-with-no-residue, unresolved, and loss-accounted behaviors
  proven independently of classification;
- zero unaccounted observation loss and zero public-response changes;
- authority baseline 4/4;
- all commands, row counts, expected/observed counts, evidence hashes,
  compatibility witnesses, and deferred surfaces present;
- recommendation fixed to `NO-GO` while D005 and deferred surfaces remain.

The collector's `--check-dossier <path>` mode must recollect the source,
canonical database, capstone, and local gates in the same process before it
byte-compares canonical output. Bare dossier `--check` remains an internal
schema/hash check, not a freshness claim. No timestamp, duration, PR number,
label, tag, or hosted URL may enter an evidence hash.

### Stage 2 — candidate UAT receipts

Run the focused capstone and adjacent suites as separate `gsd_uat_exec` checks,
with expected counts in each request. Include at least:

1. semantic-shadow capstone plus mode matrix and soak witnesses;
2. workflow MCP parity and the no-cutover structural/behavioral gate;
3. dossier `--check` and the authority baseline 4/4; and
4. a source-identity check that emits the candidate Git SHA, deterministic
   source aggregate, dossier digest, and clean-state result.

Then call `gsd_uat_result_save` for `M003/S07`, `runtime-executable`, using only
fresh evidence IDs from this run. Save PASS only if every check passed and the
canonical tool presentation is valid. A failed check creates a truthful failed
attempt and returns to implementation; it is never rewritten into PASS.

Do **not** place `pnpm run verify:merge` inside `gsd_uat_exec`: that script runs
`pnpm install --frozen-lockfile`, and UAT execution intentionally rejects
dependency mutation. Run the merge gate separately in Stage 3.

### Stage 3 — local merge gate and no-mistakes

1. Run `pnpm run verify:merge` on the exact clean candidate.
2. Commit any remaining implementation/projection source changes. Re-run the
   smallest affected checks after every no-mistakes repair and rerun the full
   merge gate before declaring the new head ready.
3. Start no-mistakes with the original product intent:

   ```sh
   no-mistakes axi run --yes --intent "Publish the database-authoritative M003/S07 semantic-shadow dossier, preserve no-cutover boundaries, and prove exact-merged automated UAT before canonical closure."
   ```

4. Let AXI own its review/fix loop. Do not edit manually while a run is active;
   answer a gate through `no-mistakes axi respond --action fix|approve --yes`.
5. Keep a PR draft while AXI is still changing the branch. Mark it ready only
   after AXI reports its checks-ready/`checks-passed` state and the PR head still
   equals the verified local HEAD. If AXI did not create a PR, its reported
   failure must be understood before using a manual fallback.

Standing developer approval permits `--yes`, including automatic resolution of
ask-user findings. A finding that changes the accepted product route still
requires clarification; automatic consent is not permission to invent intent.

### Stage 4 — hosted checks and conflict convergence

For every new PR head, re-evaluate from scratch:

- `baseRefName == "main"`;
- `headRefOid` equals the locally verified candidate;
- PR is ready, open, and not superseded;
- `mergeable == MERGEABLE` and `mergeStateStatus` is clean after GitHub finishes
  computing it;
- the `CI / ci-gate` aggregate is present and successful; and
- every check actually started for this head is terminal pass/skipping, with no
  failure or cancellation hidden behind a stale prior run.

The CI workflow's blocking aggregate requires `fast-gates`, `build`,
`windows-portability`, and `node22-smoke` to succeed or be legitimately skipped.
Heavy changes also run build, typecheck, package validation, workspace/extension
coverage, unit, package, cloud-package, integration, E2E, and Node 22 smoke
inside those jobs. Conditional security or workflow-guard checks must also pass
when their changed-path trigger starts them.

Do not use `gh pr checks --required` as the only gate: main currently has no
classic required-status protection, so it can return an incomplete picture.
Watch the full rollup and explicitly require `ci-gate`. If a check fails, let
no-mistakes fix it, push a new head, and restart Stages 2-4. If the PR is dirty,
integrate current main, resolve safely, and restart the same gates.

### Stage 5 — guarded merge

Because hosted checks are not enforced by current branch protection, do not use
unguarded `--auto` and do not use `--admin`. Immediately before merging, capture
the final PR head and repeat the Stage 4 predicates. Then use the established
squash strategy with a head compare-and-swap:

```sh
gh pr merge <number> --repo open-gsd/gsd-pi --squash \
  --match-head-commit <verified-head-sha>
```

Do not delete the branch in the same command while an attached worktree still
uses it. Branch cleanup is a later safe cleanup step, not part of evidence.

### Stage 6 — exact merge checkout

After GitHub reports `state == MERGED`, read `mergeCommit.oid` from the PR. Do
not infer the result from the candidate head, local main, a tag, or the PR title.

1. Fetch `origin/main` with `--no-tags` and verify the merge commit object exists.
2. Require the merge commit to be an ancestor of fetched `origin/main`. Record
   the fetched main SHA separately in case main advanced after the merge.
3. Create a new temporary detached worktree at the exact merge commit. Never
   repurpose the main repository checkout or another active worktree.
4. Install frozen dependencies outside `gsd_uat_exec`, build only what the
   exact capstone requires, and require the source worktree to remain clean.
5. Resolve the exact worktree to the same canonical project/database identity
   before saving evidence. A different project identity must fail closed.

### Stage 7 — exact-merge UAT and verdict

From the detached worktree, rerun fresh checks through `gsd_uat_exec`. The first
check should fail unless `git rev-parse HEAD` exactly equals the recorded
`mergeCommit.oid`. Rerun:

- the deterministic capstone and its adjacent mode/transport/soak witnesses;
- no-cutover enforcement;
- dossier `--check`;
- authority baseline 4/4; and
- source aggregate/dossier/evidence digest verification.

Save a new `gsd_uat_result_save` attempt for M003/S07, linking the prior
candidate attempt where supported. Its rationale must name the exact merge SHA,
content revision, dossier digest, evidence IDs, observed counts, and the fact
that fixture coverage is not live production telemetry.

The host must then record a passing Technical Verdict for T07 against that same
content revision and durable exact-merge evidence, and publish Task completion
only after the publication adapter re-captures an equal source snapshot. A Git
SHA in prose without the source-bound Technical Verdict is insufficient.

### Stage 8 — canonical closure and final audit

Close in this order:

1. publish canonical T07 Task completion after its passing Technical Verdict;
2. complete S07 through `gsd_slice_complete` using the persisted PASS UAT/gate
   and summary facts; and
3. render readable projections from committed state.

Do not run Milestone completion merely because S07 finished; follow the
database roadmap and remaining Milestone slices. Do not update `tasks.status`,
`slices.status`, plan checkboxes, UAT Markdown, or summary files as authority.

The final read-only audit should prove:

- T07 legacy/canonical heads are terminal and semantically matched;
- S07 legacy/canonical heads are terminal and semantically matched;
- one settled succeeded Attempt/Result and current passing Technical Verdict
  exist for T07 at the tested content revision;
- the exact-merge UAT assessment, quality gate, and gate run are PASS;
- the receipt cites `mergeCommit.oid` and the checked-in dossier digest;
- the exact evidence artifacts exist and their hashes still match;
- operation/event/outbox/projection receipts exist without unexplained loss;
- projections are delivered or explicitly pending/retryable, never used to
  contradict database closure; and
- the published recommendation remains NO-GO for read cutover.

Only after those postconditions pass may the detached worktree and remote topic
branch be cleaned up.

## Recovery and stop policy

Most failures are autonomous repair work, not blockers:

| Condition | Automated response | Stop for user? |
| --- | --- | --- |
| Focused test, dossier, baseline, typecheck, build, or `verify:merge` failure | diagnose, fix, rerun affected gate, then restart from the last source checkpoint | No |
| UAT evidence missing/corrupt/stale or cardinality incomplete | record FAIL, regenerate fresh evidence, never edit the receipt into PASS | No |
| Projection obstruction or pending projection work | repair/replay projection delivery while preserving committed authority | No |
| Hosted CI failure or cancellation | inspect logs, fix/retry, push new head, restart candidate UAT and hosted convergence | No |
| Ordinary merge conflict | integrate current main, resolve according to accepted architecture, rerun all source-bound gates | No |
| PR head changed unexpectedly | refuse merge, identify owner/change, verify the new head from Stage 1 | Usually no |
| GitHub label/tag absent, changed, or contradictory | ignore it | No |
| no-mistakes asks a bounded implementation question | use standing approval and recommended route consistent with accepted decisions | No |

Genuine external blockers are limited to:

- authentication or repository permission is unavailable and cannot be repaired
  locally;
- GitHub/hosted CI is externally unavailable beyond bounded retry, so required
  source identity or check results cannot be obtained;
- repository policy newly requires a human review/merge action the authenticated
  agent cannot perform;
- a required external credential, service, device, or environment is unavailable
  and the acceptance test cannot be replaced by an equivalent automated proof;
- no-mistakes has no supported agent runtime and cannot start after local
  configuration repair; or
- two accepted product routes materially conflict and choosing one would change
  developer intent rather than implement it.

If one occurs, preserve the exact stage, HEAD, evidence IDs, failed predicate,
and recommended next action. Do not average conflicting evidence or downgrade a
gate to keep moving.

## Minimal implementation checkpoints

The implementation task is complete only when all are true:

- deterministic checked-in dossier and `--check` exist;
- checked-in dossier uses content revision, not a fictional future merge SHA;
- candidate capstone/adjacent UAT has fresh evidence and a DB assessment/gate/run;
- `verify:merge` passes on the final candidate head;
- no-mistakes reaches a clean checks-ready state;
- PR head/base/conflict/check predicates pass without labels or tags;
- guarded squash merge succeeds for the matched head;
- exact `mergeCommit.oid` detached-worktree replay passes;
- exact-merge UAT and Technical Verdict bind merge SHA, content revision, and
  dossier/evidence digests;
- T07 and S07 close through canonical database operations; and
- final verdict is NO-GO for legacy read cutover while deferred surfaces remain.

## Primary sources

- `.gsd/phases/03-lifecycle-command-integration-and-shadow/03-07-PLAN.md` — T07
  action, acceptance criteria, files, and verification command.
- `CONTRIBUTING.md` — branch, local gate, PR, and CI requirements.
- `docs/dev/uat-process.md` — UAT ordering, evidence policy, and closeout gates.
- `docs/dev/M003-S07-T07-CUTOVER-DECISION-RESEARCH.md` — live database snapshot,
  coverage cardinality, deferred blockers, and NO-GO rationale.
- `src/resources/extensions/gsd/tools/exec-tool.ts` — typed `gsd_uat_exec`
  metadata and mutation rejection.
- `src/resources/extensions/gsd/uat-run.ts` and
  `src/resources/extensions/gsd/tools/workflow-tool-executors.ts` — evidence
  validation and assessment/gate/run persistence.
- `src/resources/extensions/gsd/verification-source-integrity.ts` — stable
  content snapshot and source-change detection.
- `src/resources/extensions/gsd/task-verification-domain-operation.ts` and
  `src/resources/extensions/gsd/task-completion-compatibility-adapter.ts` —
  immutable source-bound Technical Verdict and publication guard.
- `scripts/verify-merge.sh` and `.github/workflows/ci.yml` — local/hosted merge
  gates and the explicit `ci-gate` aggregate.
- `.github/workflows/security-audit.yml` and
  `.github/workflows/agent-workflow-guard.yml` — conditional hosted checks.
- prior exact-merge S05/S06 summaries and UAT records in the canonical M003
  database — established `mergeCommit.oid` replay convention.
- `no-mistakes` AXI help and skill contract — autonomous review/fix/PR/check
  lifecycle and standing-consent behavior.
