# Plan 037: Keep only the latest GSD context injection in the model payload

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 43033bb9..HEAD -- src/resources/extensions/gsd/bootstrap/system-context.ts src/resources/extensions/gsd/provider-payload-policy.ts src/resources/extensions/gsd/context-masker.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/036-stabilize-prompt-cache-prefix.md (same payload-policy seam; land 036 first to avoid conflicts and so the new filter follows the quantized-mask pattern)
- **Category**: perf (LLM token usage)
- **Planned at**: commit `43033bb9`, 2026-07-08

## Why this matters

Every turn in a GSD project, the extension injects a context user-message
(memory block, guided-execute context, or forensics context) capped at ~4,000
chars (~1,000 tokens). These are appended as persisted history messages and
**never pruned**: the always-on "critical memories" set (up to 8 memories) is
near-identical turn over turn, so an N-turn session carries ~N duplicate
memory blocks, all re-sent to the API on every subsequent request, inflating
input cost linearly and triggering compaction earlier (which itself costs LLM
calls). Typing "continue" during guided execution likewise re-injects the full
task plan each time, stacking verbatim copies. The design intent (route
volatile content out of the cached system prefix, #5019) is right; the gap is
that superseded injections stay live in the payload. Fix: filter all but the
latest injection of each kind out of the outgoing provider payload, mirroring
the existing observation-mask mechanism.

## Current state

Files and their roles:

- `src/resources/extensions/gsd/bootstrap/system-context.ts` — builds the
  per-turn context. `buildContextMessage` (lines ~442–471) returns a
  `{ customType, content, display: false }` message with `customType` one of
  `"gsd-guided-context"`, `"gsd-forensics"`, `"gsd-memory"`. `loadMemoryBlock`
  (~514–555) assembles the memory block each turn (CRITICAL_CAP=8,
  CHAR_BUDGET=4000). The memory content begins with the marker line
  `[MEMORY — Critical and prompt-relevant memories from the GSD memory store]`.
- `packages/pi-agent-core/src/harness/messages.ts:133-140` — `convertToLlm`
  converts `role: "custom"` messages to plain `role: "user"` messages
  (customType is dropped at conversion).
- `src/resources/extensions/gsd/provider-payload-policy.ts` — the
  `before_provider_request` payload shaping (observation masking, display
  truncation, source-context block). This is the seam where the new filter
  belongs.
- `src/resources/extensions/gsd/context-masker.ts` — exemplar for
  payload-level message rewriting (`createObservationMask`) — copy its
  structure and test approach.
- `src/resources/extensions/gsd/commands-context.ts` (~283–285) — counts
  accumulated "Memory injection" messages for the /context display; useful to
  confirm the accumulation and, after the fix, to report live vs superseded.

Excerpt — `system-context.ts:442-471` (`buildContextMessage`, abridged):

```ts
export function buildContextMessage(opts: {
  memoryBlock: string;
  injection: string | null;
  forensicsInjection: string | null;
}): { customType: string; content: string; display: false } | null {
  const contextCharLimit = getContextMessageCharLimit();
  const memoryContent = markMemoryContextSupplied(opts.memoryBlock.trim());
  if (opts.injection) {
    ...
    return { customType: "gsd-guided-context", content, display: false as const };
  }
  if (opts.forensicsInjection) {
    ...
    return { customType: "gsd-forensics", content, display: false as const };
  }
  if (memoryContent) {
    return {
      customType: "gsd-memory",
      content: limitContextMessageContent(memoryContent, contextCharLimit),
      display: false as const,
    };
  }
  return null;
}
```

Key uncertainty the executor must resolve first (step 1): whether the
`before_provider_request` payload messages still carry `customType` (pi-ai
message format) or are already LLM-converted `role:"user"` messages. Evidence
cuts both ways: the observation masker matches `role === "toolResult"`
(pi-ai format) **and** "bash-result user messages (converted from
bashExecution by convertToLlm)". Both filter strategies are specified below —
pick by what you observe.

Conventions: 2-space indent, double quotes in `bootstrap/`; tests in
`src/resources/extensions/gsd/tests/`, exemplars `context-masker.test.ts` and
`before-provider-context-management.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck extensions | `pnpm run typecheck:extensions` | exit 0 |
| Targeted tests | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/before-provider-context-management.test.ts src/resources/extensions/gsd/tests/context-masker.test.ts` | all pass |
| Changed-file tests | `node scripts/verify-changed-src-tests.mjs` | pass |

## Scope

**In scope** (the only files you should modify):

- `src/resources/extensions/gsd/provider-payload-policy.ts` (new filter)
- `src/resources/extensions/gsd/context-masker.ts` OR a new sibling module
  (e.g. `context-injection-filter.ts`) — follow where the masking helpers live
- `src/resources/extensions/gsd/bootstrap/system-context.ts` (only if adding
  a stable marker constant the filter matches on)
- `src/resources/extensions/gsd/commands-context.ts` (optional: label
  superseded injections in the /context report)
- Test files for the above

**Out of scope** (do NOT touch, even though they look related):

- Session persistence / history storage — superseded injections must REMAIN
  in stored history (resume, forensics, and session replay read them); this
  plan only filters the outgoing provider payload.
- `packages/pi-agent-core/src/harness/messages.ts` (vendored conversion layer).
- `loadMemoryBlock` ranking/budget logic — how memories are chosen is not the
  problem; duplication across turns is.
- The guided-execute injection trigger conditions
  (`system-context.ts:680-731`) — dedupe at payload level makes re-injection
  harmless; don't also change trigger logic.

## Git workflow

- Branch: `advisor/037-dedupe-context-injections`
- Conventional Commits, e.g. `perf(gsd): filter superseded context injections from provider payload`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Determine the payload message shape at the filter seam

Read `provider-payload-policy.ts` and the hook registration
(`grep -rn "before_provider_request\|onPayload\|applyProviderPayloadPolicy" src/resources/extensions/gsd/ | head`)
and determine whether `payload.messages` entries retain `customType`.
Fastest check: find the existing test fixtures in
`before-provider-context-management.test.ts` and see what shape they build.

Record the answer in your report. Strategy A (customType present): filter by
`m.customType`. Strategy B (already-converted user messages): filter by a
stable content marker — the content starts with either the memory marker line
`[MEMORY — Critical and prompt-relevant memories from the GSD memory store]`
or the guided/forensics injection headers (read
`buildGuidedExecuteContextInjection` / the forensics builder in
`system-context.ts` for their exact leading lines). If markers are not stable
enough, add an explicit sentinel prefix constant (e.g.
`GSD_CONTEXT_MESSAGE_SENTINEL`) to `buildContextMessage` output and match that
(export the constant from one module; no magic strings in two places).

**Verify**: you can state which strategy applies, with the file:line evidence.

### Step 2: Implement `filterSupersededContextInjections`

New pure function (in `context-masker.ts` or a sibling module, matching step
1's decision): given the payload messages array, identify all GSD context
injection messages (per step 1's detection), and return a new array where all
but the **latest** injection are removed entirely (removal, not masking — an
empty placeholder would still spend tokens and break byte-stability when its
position shifts).

Handle both payload shapes the policy already handles (`payload.messages` and
`payload.input` for the Responses API) — mirror how
`applyObservationBudget` does it.

Cache-stability note (this is why 036 lands first): removing a message from
the middle of history invalidates the cache prefix from that point. The
injections being removed are at most one per turn and the newest ones sit near
the tail, so the invalidation is bounded to roughly the last turn — same
accepted cost as the source-context block. Do NOT try to preserve old
injections to protect the cache; the linear duplicate growth costs more.

Wire it into `applyProviderPayloadPolicy` for **all** sessions (not just
auto-mode — interactive sessions accumulate the same duplicates; note the
memory injection fires per turn regardless of auto).

**Verify**: `pnpm run typecheck:extensions` → exit 0.

### Step 3: Tests

New test file (or extend `before-provider-context-management.test.ts`):

- Three injections of the same kind across simulated turns → payload contains
  only the last one; stored history input array is not mutated
  (function is pure — assert input unchanged).
- Mixed kinds (memory + guided) → latest of the stream survives per the
  product rule you confirm in step 1 (note: `buildContextMessage` emits ONE
  message per turn of a single kind — guided > forensics > memory-only — so
  "keep the latest context injection overall" is the correct rule; the latest
  one already embeds the memory block when present. Assert that.)
- No injections present → array returned unchanged (identity or deep-equal).
- Responses-API `payload.input` variant covered.

**Verify**: targeted tests command → all pass.

### Step 4: Optional /context visibility

If cheap (<20 lines): in `commands-context.ts`, split the "Memory injection"
context count into live vs superseded-filtered so users can see the savings.
Skip if the seam is awkward; note the skip.

**Verify**: `pnpm run typecheck:extensions` → exit 0;
`node scripts/verify-changed-src-tests.mjs` → pass.

## Test plan

- New tests as in Step 3, modeled on `context-masker.test.ts` (pure-function
  fixtures) and `before-provider-context-management.test.ts` (policy wiring).
- Regression: existing masking/truncation tests must stay green — the new
  filter must compose with `applyObservationBudget` and
  `applyDisplayTruncation` (run order: filter superseded injections FIRST,
  then masking, so the mask boundary math sees the final message list).

## Done criteria

- [x] `pnpm run typecheck:extensions` exits 0
- [x] New filter tests pass; existing `context-masker` / `before-provider-context-management` tests pass
- [x] A simulated 5-turn session payload contains exactly 1 GSD context injection message
- [x] Stored session history still contains all injections (no persistence change — filter is pure, operates only on the outgoing payload array)
- [x] No files outside the in-scope list are modified (`git status`)
- [x] `plans/README.md` status row updated

## Execution notes

- Step 1: payload messages at the `before_provider_request` hook are
  already-converted (post-`convertToLlm`) `role: "user"` messages —
  `customType` does not survive. Confirmed via `messages.ts:133-140`
  (`convertToLlm` drops `customType` on the `"custom"` branch) and the
  existing `context-masker.test.ts` fixtures, which build plain
  `{role:"user", content:[...]}` shapes. Strategy B applied: added an
  explicit sentinel constant `GSD_CONTEXT_MESSAGE_SENTINEL` (exported from
  `system-context.ts`) rather than relying on the memory marker line, since
  guided/forensics-only injections (no memory block) don't carry that line.
- Step 2: implemented `filterSupersededContextInjections` /
  `filterSupersededResponsesContextInjections` in `context-masker.ts`,
  wired into `applyProviderPayloadPolicy` unconditionally (all sessions),
  running before observation budgeting per the plan's ordering note.
- Step 4 (optional `/context` visibility): skipped — not required for done
  criteria and no live issue to demonstrate; can be added later if desired.

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows the payload messages carry NEITHER `customType` NOR any stable
  content marker, and adding a sentinel to `buildContextMessage` doesn't
  surface in the payload (would mean the injection travels a different path
  than assumed — report the actual path).
- Forensics or resume flows read context injections FROM THE PAYLOAD (not
  from stored history) — search `gsd-forensics` usages; if a consumer depends
  on historical payload copies, report it.
- Removing mid-history messages breaks an API invariant (e.g. Anthropic
  tool_use/tool_result pairing) in any existing test — the filter must never
  remove messages between a tool_use and its tool_result.

## Maintenance notes

- Anyone adding a new `customType` context injection must add it to the
  filter's detection list — leave a pointer comment at `buildContextMessage`.
- Reviewers should scrutinize: filter ordering vs masking (superseded-filter
  first), and that the Responses-API input path got the same treatment.
- Follow-up recorded in `plans/README.md`: gating the heavy system blocks
  (system.md/knowledge/codebase, ~8–9K tokens) on actual workflow activity
  instead of mere `.gsd` directory presence (SYSPROMPT-02).
