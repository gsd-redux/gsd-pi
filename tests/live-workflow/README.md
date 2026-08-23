# gsd-pi live-workflow tests

End-to-end tests that drive the **real `gsd` binary** to dispatch a **real
agent** through the **real dispatch + verification gates** against a **real
model** — no fake-LLM transcript.

This is the live counterpart to the other two test layers:

| Layer | Dir | Agent | Network | In CI |
| --- | --- | --- | --- | --- |
| Fake-LLM e2e | `tests/e2e` | scripted JSONL transcript | none | yes (required gate) |
| Provider smoke | `tests/live` | real API, transport only | yes | no (manual) |
| **Workflow** | `tests/live-workflow` | **real agent, one unit or full `auto`** | yes | optional release CI + manual |

These exist to answer one question the other layers can't: *does a real agent,
given a real plan, actually execute through gsd's real gates to a correct,
durable outcome?* They are slow and cost real tokens, so they never run in the
default suite. Production release CI runs them as a non-blocking optional smoke
against the configured live workflow model.

Two scenarios:

| Script | Seed | Command | Proves | Default budget |
| --- | --- | --- | --- | --- |
| `test-tiny-milestone.ts` | 1 slice / 1 task | `gsd headless next` | one real agent turn passes the dispatch + verification gates and exits 0 | 300 s |
| `test-multi-slice-auto.ts` | S01 → S02 → S03, 5 tasks | `gsd headless auto` | the whole loop — every execute-task, every complete-slice (in dependency order), milestone closeout — finishes headlessly: exit 0, all five per-task verifications pass, M001 + all slices + all tasks are `complete` in `.gsd/gsd.db`, ≥5 new commits, no liveness/wedge/pause/error lines on stderr | 1800 s |

The `auto` scenario is the one that matches what a user runs. A real agent's
closeout does complete headlessly on `main` (verified 2026-08-23 with
`kimi-for-coding`: the 1-task seed closed M001 in 273 s with 0 wedge lines).
`next` stays as the fast, cheap smoke of a single dispatch.

Status of the multi-slice scenario on `main` (2026-08-23, `kimi-for-coding`):
S01 → S02 → S03 all completed in order, but milestone validation returned
`needs-remediation` (the agent's own S03 UAT invented a `formatAnswer(7)` check
that the fixture never specified), `gsd_reassess_roadmap` added S04, and
plan-slice S04 failed pre-execution checks twice with identical inputs
(planning artifacts listed as task inputs) — liveness backstop wedge, exit 10.
The scenario fails until that closeout path is fixed; on failure it saves
`gsd.db` next to the transcript for post-mortem.

## Running

```bash
# 1. Build the binary the test will drive.
npm run build:core && chmod +x dist/loader.js

# 2. Export a provider credential (any vendor) and run.
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY, or any *_API_KEY / *_OAUTH_TOKEN
GSD_LIVE_TESTS=1 \
GSD_SMOKE_BINARY="$(pwd)/dist/loader.js" \
npm run test:live-workflow
```

Without `GSD_LIVE_TESTS=1` the runner is a no-op. With it set but no provider
credential in the environment, each test **skips** (POSIX exit 77) rather than
failing.

If your credentials live in `~/.gsd/agent/auth.json` (no `*_API_KEY` in the
shell), opt in to forwarding your real HOME so the child authenticates exactly
like you do:

```bash
GSD_LIVE_TESTS=1 GSD_LIVE_WORKFLOW_USE_HOME=1 \
GSD_SMOKE_BINARY="$(pwd)/dist/loader.js" \
node --experimental-strip-types tests/live-workflow/test-multi-slice-auto.ts
```

### Env knobs

| Var | Default | Purpose |
| --- | --- | --- |
| `GSD_LIVE_TESTS` | — | Must be `1` or the suite is skipped entirely. |
| `GSD_SMOKE_BINARY` | `gsd` on PATH | Built binary to drive (recommended). |
| `*_API_KEY` / `*_OAUTH_TOKEN` | — | Provider credential, forwarded to the child. At least one required. Provider-agnostic. |
| `GSD_LIVE_WORKFLOW_MODEL` | auto-resolved (`openai/gpt-5.4-mini` in optional release CI) | Force a model id. Unset = gsd picks the default for whichever provider's credential is present. |
| `GSD_LIVE_WORKFLOW_USE_HOME` | — | `1` forwards your real `HOME` so the child reads `~/.gsd/agent/auth.json` and prefs. Counts as a credential source. Off by default: the child normally gets an isolated, fresh home. |
| `GSD_LIVE_WORKFLOW_TIMEOUT_MS` | `300000` (`next`) / `1800000` (`auto`) | Per-run dispatch timeout (wall-clock budget). Overrides the scenario default. Raise for slower models. |
| `GSD_LIVE_WORKFLOW_RUNNER_TIMEOUT_MS` | — | Optional extra per-test deadline for `run.ts`. Unset = none; each scenario already kills its own gsd child at its budget. |
| `GSD_LIVE_WORKFLOW_OUTPUT` | `text` | Output format. `text` = readable transcript; `stream-json` = machine-parseable JSONL. |

## How it works

Each `test-*.ts` script:

1. **Seeds a milestone** in a throwaway git project — one slice/one task for
   `next`, three dependent slices/five tasks for `auto` — where every task's
   verification is a runnable command (`node --test ...`). The bundled tests
   *fail* until the agent does the work. A `package.json` `test` script is
   included so gsd's verification gate has a host-owned check to discover and
   run. After seeding it runs the **two-step** `gsd headless recover`: the
   first call prints an import preview and a `--preview=sha256:<hash>` hint
   (exit non-zero), the second call with that hash applies it. The result is
   committed so the pre-dispatch `git diff --check` guard sees a clean tree.
2. **Forwards credentials from the environment.** Any `*_API_KEY` /
   `*_OAUTH_TOKEN` in your shell is passed to the child; nothing reads or
   touches your real `~/.gsd`. The child keeps the e2e harness's isolated,
   fresh agent home, so the test behaves identically locally and in CI.
   Provider-agnostic by construction — no vendor is named anywhere.
   (`GSD_LIVE_WORKFLOW_USE_HOME=1` is the opt-in exception, see above.)
3. **Dispatches**: `gsd headless --output-format text --verbose
   --timeout <T> --max-restarts 0 [--model <M>] <next|auto>`. `next` runs a
   single real agent turn (execute-task) through the verification gate, then
   exits; `auto` keeps dispatching until the milestone is closed.
4. **Asserts on durable outcomes only** — never on agent prose, which drifts:
   - exit code `0` (success; `10`=blocked, `1`=error/timeout, `11`=cancelled),
   - the task's own verification command now **passes**,
   - the agent added at least one git commit,
   - (`auto` only) every per-task verification passes, `milestones`/`slices`/
     `tasks` rows for M001 and all seeded slices/tasks read `complete` in
     `.gsd/gsd.db`, slices' `completed_at` respects the `depends` order,
     commits grew by at least the task count, and the child's **stderr** has
     no line matching `/liveness|wedge|Cannot dispatch|paused|error/i`
     (stdout, where the agent's tool output lands, is not scanned).

Artifacts (transcript + raw streams) are written under `test-results/e2e/` for
post-mortem.

## Seeing the output

By default the run uses `--output-format text --verbose`, so you get a
**readable transcript** — gsd's own progress renderer (assistant text, tool
calls with summarized args, status/notify lines, cost). It is **streamed live**
to your terminal as the agent works (the harness tees the child's
stdout/stderr via `runStreaming`), bracketed by `─── live transcript ───`
markers, and also saved for post-mortem:

```bash
# the test prints this path near the end as `transcript: <path>`
cat test-results/e2e/<timestamp>_live-tiny-milestone/transcript.txt   # clean, ANSI-stripped
# raw streams are kept alongside it:
#   dispatch.stdout.log   dispatch.stderr.log
```

Want machine-readable JSONL instead (e.g. to post-process events)? Set:

```bash
GSD_LIVE_WORKFLOW_OUTPUT=stream-json GSD_LIVE_TESTS=1 npm run test:live-workflow
# then, for just the assistant prose:
jq -rc 'select(.type=="agent_end") | .messages[]
        | select(.role=="assistant") | .content[]?
        | select(.type=="text") | .text' \
  test-results/e2e/<timestamp>_live-tiny-milestone/dispatch.stdout.log
```

## Writing a new live-workflow test

1. Create `tests/live-workflow/test-<name>.ts`. The `test-*.ts` glob is what
   `run.ts` executes.
2. Import seeding/credential helpers from `./harness.ts` and process helpers
   from `../e2e/_shared/index.ts`.
3. Skip with `process.exit(77)` when prerequisites are missing; fail with a
   non-zero exit otherwise. Use `try/finally` to clean up the tmp project
   (these are standalone scripts, not `node:test` files).
4. **Assert on durable state, not words.** Re-run a verification command,
   read the DB/markdown/git — never `assert.match` on what the model said.

## Anti-patterns

- ❌ Asserting on agent response text. It changes every run — you'll flake.
- ❌ Large/open-ended milestones. Keep tasks trivial and unambiguous; this is a
   smoke test of the *loop*, not a benchmark of model capability.
- ❌ Running in the default test suite or a required CI gate. Cost + nondeterminism.
