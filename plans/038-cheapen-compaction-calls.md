# Plan 038: Stop spending reasoning tokens and double calls on compaction summaries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 43033bb9..HEAD -- packages/gsd-agent-core/src/compaction/compaction.ts packages/gsd-agent-core/src/session/agent-session-compaction.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Result**: DONE (steps 1-3 executed on `advisor/038-cheapen-compaction`). Step 4
  (optional `summarizationModel` setting) was skipped — not required to satisfy the
  plan's done criteria and carries MED risk per the plan's own effort/risk split.
- **Priority**: P2
- **Effort**: S (steps 1–2) + optional M (step 4)
- **Risk**: LOW (steps 1–2) / MED (step 4)
- **Depends on**: none
- **Category**: perf (LLM token usage)
- **Planned at**: commit `43033bb9`, 2026-07-08

## Why this matters

Compaction summarizes conversation history into a fixed-template briefing — a
mechanical extraction task. Today that summarization call inherits the
session's extended-thinking level: a user running with thinking `high` pays
extended-reasoning tokens (often several × the summary's own output) every
time compaction fires, purely to reformat history. Additionally, when a large
session chunks its summarization input, any "degenerate" (too short) chunk
output triggers a full second summarization call per chunk — doubling cost on
exactly the sessions that are already the most expensive to summarize. Both
fixes are small and contained. A third, optional lever — running summarization
on a cheaper model — is specified as an opt-in setting.

## Current state

Files and their roles:

- `packages/gsd-agent-core/src/compaction/compaction.ts` — the compaction
  engine. `createSummarizationOptions` (~lines 610–620) copies the session
  thinking level into the summarization request. The degenerate-chunk retry
  is in `generateSummary` (~lines 758–768). Chunking budget at ~730–743.
- `packages/gsd-agent-core/src/session/agent-session-compaction.ts` — the
  session-side driver; passes `this.host.model` and `this.host.thinkingLevel`
  into `compact()` at ~87–96 (auto path) and ~350–359 (manual path).
- `packages/gsd-agent-core/src/compaction/branch-summarization.ts` and the
  caller in `agent-session-navigation.ts` (~323–327) — branch summaries, same
  model/thinking inheritance.
- No `summarizationModel`/`compactionModel` setting exists anywhere
  (verified by grep over `packages/gsd-agent-core/src` and
  `packages/pi-coding-agent/src` at planning time).

Excerpt — `packages/gsd-agent-core/src/compaction/compaction.ts:~610-620`:

```ts
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}
```

Excerpt — `packages/gsd-agent-core/src/session/agent-session-compaction.ts:~87-96`:

```ts
				const result = await compact(
					preparation,
					this.host.model,
					apiKey,
					headers,
					customInstructions,
					this.host._compactionAbortController.signal,
					this.host.thinkingLevel,
					this.host.agent.streamFn,
				);
```

Conventions: `gsd-agent-core` uses tabs in `compaction/` (vendored-adjacent
style) — match the file. Tests: `packages/gsd-agent-core/src/compaction/compaction.test.ts`,
`compaction-prompts.test.ts`, run via the package's `test` script
(node:test with strip-types). The package test command is
`cd packages/gsd-agent-core && pnpm test`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| agent-core tests | `cd packages/gsd-agent-core && pnpm test` | all pass |
| Typecheck (root program includes packages via references) | `pnpm run typecheck:extensions` | exit 0 |
| Boundary gates (if anything under vendored dirs changes) | `pnpm run verify:pi-boundary && pnpm run verify:pi-patches` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/gsd-agent-core/src/compaction/compaction.ts`
- `packages/gsd-agent-core/src/compaction/compaction.test.ts`
- Step 4 only (optional): `packages/gsd-agent-core/src/session/agent-session-compaction.ts`,
  the settings surface it reads, and `agent-session-navigation.ts`

**Out of scope** (do NOT touch, even though they look related):

- Compaction *thresholds* and token estimation (`estimateTokens`,
  `resolveThresholdContextTokens`) — a separate finding (COMPACT-03, unplanned;
  see `plans/README.md`).
- The summarization prompt templates and the previous-summary merge strategy
  (COMPACT-04, unplanned).
- `branch-summarization.ts` content logic — only its options plumbing if step
  4 is taken.

## Git workflow

- Branch: `advisor/038-cheapen-compaction`
- Conventional Commits, e.g. `perf(agent-core): pin compaction summarization reasoning to low`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Cap summarization reasoning at "low"

In `createSummarizationOptions` (compaction.ts), stop inheriting high thinking
levels: replace the direct copy with a cap —

```ts
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		// Summarization is a mechanical template-fill; extended reasoning adds
		// cost, not quality. Cap at "low" regardless of session thinking level.
		options.reasoning = "low";
	}
```

Confirm `"low"` is a valid `ThinkingLevel` member first
(`grep -n "ThinkingLevel" packages/gsd-agent-core/src --include="*.ts" -r | head`
and read the type). If the enum's floor is named differently (e.g.
`"minimal"`), use that. Apply the same cap to every other summarization
options path in this file (turn-prefix summary ~line 1049, and any branch
summary path that builds options here).

**Verify**: `cd packages/gsd-agent-core && pnpm test` → all pass. Update any
test asserting the old passthrough (search `compaction.test.ts` for
`reasoning`).

### Step 2: Bound the degenerate-chunk retry per compaction

In `generateSummary` (~758–768), the current logic retries `summarizeOnce`
once **per chunk** when `isDegenerateSummary` is true. Change to a
per-compaction budget: allow at most ONE degenerate retry across the entire
chunked run (a counter in `generateSummary` scope), and skip the retry
entirely when the chunk's serialized input is smaller than the degenerate
threshold itself (a tiny chunk legitimately yields a short summary).

**Verify**: `cd packages/gsd-agent-core && pnpm test` → all pass; add tests in
step 3 first if you prefer test-first.

### Step 3: Tests for both behaviors

In `compaction.test.ts` (follow its existing streamFn-stub pattern):

- Summarization options: session thinkingLevel `"high"` on a reasoning model →
  `options.reasoning === "low"`; thinkingLevel `"off"` → no `reasoning` key;
  non-reasoning model → no `reasoning` key.
- Degenerate retry: stub a streamFn returning degenerate output for 3 chunks →
  exactly 1 retry total occurs (count calls); tiny-chunk case → 0 retries.

**Verify**: `cd packages/gsd-agent-core && pnpm test` → all pass, new tests included.

### Step 4 (OPTIONAL — do only if the settings seam is clean): `summarizationModel` setting

1. Find the settings exemplar: `grep -rn "compaction" packages/pi-coding-agent/src/core/settings-manager.ts`
   and the compaction settings type it exposes.
2. Add optional `summarizationModel?: string` there; resolve it via the model
   registry at the `agent-session-compaction.ts` call sites (~87–96, ~350–359)
   and the branch-summary caller (`agent-session-navigation.ts:~323-327`),
   falling back to `this.host.model`. Auth: reuse the existing
   `getCompactionRequestAuth` path; if the substitute model's provider differs
   from the session's and auth resolution isn't already provider-keyed, STOP
   (see conditions) rather than plumbing new auth.
3. Default: unset (current behavior). Document in the setting's JSDoc that a
   fast/cheap model is recommended for large sessions.

**Verify**: `pnpm run typecheck:extensions` → exit 0;
`cd packages/gsd-agent-core && pnpm test` → pass; a test proves the model
override reaches `compact()`.

## Test plan

- New tests per step 3 in `compaction.test.ts` (pattern: existing tests in
  the same file — streamFn stubs, no network).
- If step 4 is taken: settings-resolution test modeled on the nearest
  settings-manager test in `pi-coding-agent`.

## Done criteria

- [ ] `cd packages/gsd-agent-core && pnpm test` exits 0 with the new tests
- [ ] `pnpm run typecheck:extensions` exits 0
- [ ] `grep -n "options.reasoning = thinkingLevel" packages/gsd-agent-core/src/compaction/compaction.ts` returns no matches
- [ ] Degenerate retry is provably ≤1 per compaction (test asserts call count)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (note whether step 4 was taken or skipped)

## STOP conditions

Stop and report back (do not improvise) if:

- `ThinkingLevel` has no low/minimal member below the session levels (only
  off/on semantics) — capping semantics would need product input.
- Any existing test asserts that summaries REQUIRE the session thinking level
  (would indicate a quality regression was already observed at low reasoning).
- Step 4: cross-provider auth for the substitute model is not already
  supported by `getCompactionRequestAuth` — do not build new auth plumbing;
  ship steps 1–3 and report.

## Maintenance notes

- If summary quality complaints appear after this lands, the first knob is
  raising the cap from `"low"` (one line), not reverting the whole change.
- Reviewers should scrutinize the retry-counter scope (per compaction run, not
  per process) and that the manual `/compact` path (~350–359) got the same
  treatment as auto-compaction.
- Deferred related findings (recorded in `plans/README.md`): threshold
  estimator counting untruncated tool results (COMPACT-03), summary-of-summary
  compounding (COMPACT-04), unchunked turn-prefix summarization (COMPACT-06),
  image tokens missing from the user-branch estimate (COMPACT-07).
