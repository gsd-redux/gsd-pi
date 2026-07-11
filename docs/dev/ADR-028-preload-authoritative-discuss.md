# Preload-Authoritative Guided Discuss

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Amended and retained.** Bounded grounded context and question discipline remain valid. Workflow facts must come from one canonical database snapshot plus current code evidence; `.gsd` files are projections and cannot be authoritative preload input.

Guided-discuss Units (milestone, project, requirements, slice) used to ground their questions by having the agent survey the codebase — `rg`/`find`/`scout` before the first question round. That instruction has lived in the discuss prompts since the initial commit and was reasonable when the prompt carried no other context.

In June 2026 a Discuss Preload was added (`fix(gsd): preload milestone discuss context`): existing `.gsd/` artifacts (milestone ROADMAP, CONTEXT, RESEARCH, the Decisions Register, prior-milestone SUMMARYs) are now assembled into the prompt under a "preloaded — do not re-read these files" banner, and a bounded Preparation Snapshot (≤5 source files) is appended on top. The pre-existing survey instruction was never reconciled with the new preload. The result is three independent context readers stacked in one prompt — preload, snapshot, and open-ended survey — none aware of the others. The agent is told both "you already have everything, do not re-read" and "go survey the code," so it surveys: many unbounded file-read round-trips before the first question, which is slow, repetitive, and the opposite of the intended "feed context, guide small steps" design. A follow-up commit 30 minutes after the preload landed had to "cap inlined context and deduplicate preparation" — the signature of context that ballooned on contact.

## Decision

The Discuss Preload is the authoritative plan/decision context for guided discuss; the Preparation Snapshot is its bounded codebase-reality complement. Guided-discuss Units ask questions grounded in those two inputs and must NOT open-endedly survey the codebase before the first question round. A Unit reads a specific file only when a question's answer hinges on it (targeted, on-demand) — never a survey. `resolve_library` / `get_library_docs` lookups for unfamiliar libraries remain permitted and bounded; they are external and cheap, and are not "investigation" in the surveying sense.

This is captured in `CONTEXT.md` as the **Grounded Questioning (no upfront survey)** invariant, alongside the **Discuss Preload (Inlined Context)** and **Preparation Snapshot** terms that name the previously-anonymous readers.

The reframe applies to every guided-discuss prompt that carries a preload: `guided-discuss-milestone.md`, `guided-discuss-project.md`, `guided-discuss-requirements.md`, `guided-discuss-slice.md`, and `discuss.md` (which carries the Preparation Snapshot via `{{preparationContext}}`). The injected guidance string in `buildDiscussPreparationContext` (`guided-flow.ts`) is updated so it no longer re-licenses surveying ("After investigation…" → "After grounding in the preloaded context…").

`discuss-headless.md` is explicitly out of scope. It carries no preload and has no user to ask, so its investigation is the only mechanism that grounds its autonomous decisions; the preload-redundancy rationale does not apply and removing its survey would degrade quality with no upside.

## Consequences

- The first user-facing question round arrives after preload + snapshot consultation, not after an unbounded file survey — restoring the small-steps cadence and cutting the dominant source of discuss latency.
- The Preparation Snapshot is retained (≤5 files, ≤8KB each, ≤3000-char brief, in-process, ~milliseconds); it covers current code reality the `.gsd/` preload does not, and it is not the slow path.
- On-demand reads remain available, so a question that genuinely hinges on a file is not blocked — the agent just reads that file rather than surveying the tree.
- The `discuss_preparation: false` preference still disables the snapshot entirely for users who want a pure-preload discuss.
- Prompt regression tests that assert the "scout the code" wording must be updated to assert the grounded-questioning wording instead.

## Alternatives Considered

- **Drop both the survey AND the Preparation Snapshot (preload-only).** Rejected: the snapshot is cheap and bounded and supplies brownfield code reality the `.gsd/` artifacts lack; cutting it saves milliseconds and loses grounding. The slowness is the open-ended survey, not the snapshot.
- **Gate surveying on an empty preload.** Rejected: keeps the slow path alive behind a condition and adds a "preload present but thin" failure mode. The uniform invariant — preload + snapshot is always enough to ask grounded questions, never survey — is simpler to reason about and matches the small-steps philosophy; the on-demand escape hatch handles the thin-preload case.
- **Apply the reframe to `discuss-headless.md` too (literal "all variants").** Rejected: headless has no preload and no user fallback, so its survey is load-bearing rather than redundant.
