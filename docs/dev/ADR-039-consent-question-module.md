# ADR-039: Consent Question module with per-kind fail policy

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Superseded.** Explicit question kinds and a narrow, fail-closed consent boundary remain valid. The process-local consent-question lifecycle and broad pause routing are replaced by persisted Interaction kinds, durable answers and decisions, and branch-scoped human blocking.

## Status

Accepted (2026-06-12)

## Context

The consent-question lifecycle had no home: detection was regex prose-mining in `user-input-boundary.ts`; pause promotion rode a hard-coded allowlist of 4 discussion unit types (`USER_APPROVAL_UNIT_TYPES`) and bailed for interactive mode (#682 — consent points elsewhere rendered as un-gated prose menus); answer validation was fail-closed only for gate-id questions, so an empty `selected` passed as a real answer for every other question kind (#528); cancellation was handled inline per gate. Three modules each knew a slice of the lifecycle; none owned it.

## Decision

Consent questions deepen behind `consent-question.ts`:

- Taxonomy: `QuestionKind = gate | consent | decision | informational` with gate sub-kinds (`depth-verification | approval | destructive-confirm`). **Fail policy is a property of the kind**, not the call site: informational is the only fail-open kind.
- `classifyQuestion` — gates classify by id convention (write-gate's predicates); any other structured question is consent; prose classifies via the moved regex detectors.
- `evaluateAnswer` / `evaluateAskUserQuestionsRound` — the single policy point. Empty/missing `selected` on any fail-closed kind → `waiting` (auto pauses and re-asks; never `answered`). Round outcome is the most blocking per-question outcome (`cancelled > waiting > declined > verified > answered`).
- Gate verdicts live in a dependency leaf, `consent-verdict.ts` (`evaluateGateAnswer` + the structural `isDepthConfirmationAnswer` validator, re-exported by write-gate for the MCP child's module contract). Both `evaluateAnswer` and write-gate's `applyAskUserQuestionsGateResult` consume it, so there is exactly one verdict engine: write-gate keeps only persistence/arming side effects, and a declined or unanswered gate means the same thing everywhere (`declined` / `waiting` — an empty selection never resolves a gate). The leaf imports nothing from either consumer, avoiding the consent-question ↔ write-gate cycle.
- `shouldPauseForQuestion` replaces the unit-type allowlist: a classified consent/decision/gate question pauses regardless of unit type, including interactive mode (no test documented the old bail-out as deliberate). Because it now runs on every `message_update` for every unit type, it bails before classification when the visible text has no `?` and no explicit wait phrase.
- `user-input-boundary.ts` is deleted; importers use `consent-question.ts` directly. `register-hooks` routes every `ask_user_questions` round through the module and gains one unified cancellation handler.

## Consequences

- #528 and #682 are fixed by construction; the policy matrix (kind × answer shape → outcome) is pinned by a table-driven test.
- New consent points declare a kind and inherit the right policy — no per-site fail-open/closed reasoning.
- Interactive promotion without a gate id pauses/notifies but cannot arm a durable write-gate (no gate id to arm); synthetic gates for non-discuss units would touch gate-state sync (ADR-040 territory) and are deliberately out of scope.
- Post-Unit Gate semantics (ADR-022/025) are untouched — this governs user questions only.
