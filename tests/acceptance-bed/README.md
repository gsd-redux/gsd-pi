# Auto-Mode Acceptance Bed

A deterministic, standalone driver that answers one question: **can `gsd headless auto`
take a tiny, already-planned one-milestone project all the way to completion?**

It is the acceptance gate for the auto-mode stuck-state regression class tracked by
wayfinder map **#1645** — the map's destination is this bed printing `COMPLETED`.
With #1657–#1660 fixed it prints `COMPLETED` at HEAD (it printed `WEDGED` on v1.13).

## What it does

1. Scaffolds a scratch git project (tiny `src/answer.js` + `node:test` file — the same
   fixture the e2e suite uses) under the session scratchpad (`bed-run-<n>/project`).
2. Seeds milestone `M001` / slice `S01` / planned task `T01` as recovery markdown and
   imports it with `gsd headless recover` + `--preview=sha256:...` approval.
3. Runs the **real engine** — `gsd headless --model gsd-fake-model auto` — against a
   scripted fake-LLM transcript (`GSD_FAKE_LLM_TRANSCRIPT`) in which the "agent"
   edits the source, runs the test, and walks the closeout ladder
   (`gsd_task_complete` → `gsd_slice_complete` → `gsd_validate_milestone` →
   `gsd_complete_milestone`). The runtime executes every tool call for real; only
   the LLM tokens are scripted.
4. Prints a JSON verdict and preserves all artifacts in the run dir (never deleted):
   `transcript.jsonl`, `stdout.jsonl`, `stderr.log`, `notifications.log`,
   `verdict.json`, recover logs, and a `gsd-state/` copy of the project's `.gsd/`.

## Running it

```bash
pnpm run build:core                      # once; the bed spawns the built loader
export GSD_SMOKE_BINARY="$PWD/dist/loader.js"
node tests/acceptance-bed/auto-milestone-bed.mjs
```

Exit code: 0 = COMPLETED, 10 = WEDGED, 1 = INCONCLUSIVE/driver failure.

## Reading the verdict

```json
{ "result": "COMPLETED" | "WEDGED" | "INCONCLUSIVE", "firstBlock": { "guard", "message" } | null, "exitCode": ..., "runDir": "..." }
```

- **COMPLETED** — the engine drove the milestone end-to-end: exit 0 plus an
  `Auto-mode stopped` notification citing milestone/all-milestones completion.
  This is the pass state map #1645 is driving toward.
- **WEDGED** — the engine itself blocked, paused, or looped: exit 10 and/or a pause
  notification naming one of its own guards (verification gate, attempt/recovery
  pause, dispatch guard, drift check, ...). `firstBlock` cites the engine's own
  message — a wedge verdict is never just "didn't finish". The ADR-047 liveness
  backstop's trip/refusal notices ("Auto-mode blocked — liveness backstop
  tripped: ..." / "Auto-mode blocked — wedged (W-...): ...") flow under the same
  `Auto-mode blocked` prefix, so the classifier recognizes them unchanged; the
  resume path they print is `/gsd auto --resume-wedge <id>`.
- **INCONCLUSIVE** — the bed could not attribute the outcome to the engine, most
  often a transcript bug (`fake-llm:` expectation mismatch or exhaustion). Fix the
  transcript in `buildTranscript()` and re-run; this is a bed defect, not a finding.

## What the validate-milestone turns model

`gsd_validate_milestone` fail-closes on stale evidence: every
`verificationEvidence[].testedSourceRevision` must equal the source-content hash
(`verification-source-integrity.ts`, tracked+untracked files minus `.gsd/**`)
that the tool recomputes at validation time. A competent agent submits evidence
from verification it ran against the milestone's final source state, so the bed
precomputes that hash for the post-edit tree and scripts it into the
validate-milestone turn.

Two preconditions make the precomputed hash match the run-time recompute:

- `ensureGitignore(projectDir)` is applied first, because auto bootstrap
  (`auto-start.ts`) idempotently appends the GSD baseline block to the tracked
  `.gitignore`; hashing before that mutation makes the evidence legitimately
  stale (#1660).
- `src/answer.js` is temporarily set to its post-task content while hashing
  (task commits don't change the content hash; file contents do).

## Notes

- Runs are capped (~90s engine timeout, `--max-restarts 0`) so a loop terminates
  deterministically instead of spinning.
- The transcript ends with filler text turns so extra provider invocations can never
  masquerade as an engine wedge via fake-llm transcript exhaustion.
- The bed is intentionally outside the `*.e2e.test.ts` CI glob; it is run by hand
  (or by an agent) as an acceptance gate, not on every CI push.
