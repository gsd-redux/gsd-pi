# ADR-022: Post-Unit Gate Enforcement Belongs to Orchestration

**Status:** Accepted
**Date:** 2026-06-03

> **ADR-046 disposition:** [ADR-046](./ADR-046-database-authoritative-workflow-lifecycle.md)
> retains shared progression enforcement, typed Recovery Classification,
> explicit remediation routing, and stable finding deduplication. The shared
> Lifecycle Kernel replaces Auto-specific enforcement; fresh database
> Verification Evidence and Technical Verdicts replace artifact-derived gate
> authority; machine-fixable failures create remediation, and only the narrow
> human-only taxonomy may pause. The body below is retained as history.

Post-Unit Gates block Unit progression, so gate enforcement belongs to Auto Orchestration and post-unit finalization rather than the hook registry. The registry should identify configured Post-Unit Hooks, preserve hook state, and provide active hook metadata; it should not decide whether auto-mode may advance.

Failed, cancelled, timed-out, or unverified gate execution should flow through Recovery Classification so runtime failures produce the same retry, pause, or remediation behavior as other Unit failures. This keeps progression decisions in the orchestration layer while still allowing Advisory Post-Unit Hooks to record outcomes without blocking advancement.

Gate success requires both clean hook execution and verified required output. Artifact existence is evidence that output exists, not proof that the gate completed successfully.

Rework may default to retrying the trigger Unit for compatibility with existing `retry_on` behavior. The routing action is named `retry-unit` because hooks can fire after task, slice, milestone, and UAT Units; `retry-task` is only a task-level compatibility alias.

Remediation that creates new workflow work must be routed explicitly. Without an explicit route, orchestration pauses instead of mutating the task or slice graph.

Task-level remediation stays inside the current slice. Work that changes slice boundaries or crosses slice scope must be routed as slice-level remediation.

Slice-level remediation uses the existing reassess-roadmap mutation path instead of introducing a second roadmap mutation surface.

Scheduled remediation is deduped by hook name, trigger Unit, and a stable finding fingerprint so reruns, resumes, and artifact reprocessing do not create duplicate tasks or slices.

Status surfaces such as `/gsd status` should show the blocking gate name, trigger Unit, verdict or execution failure, scheduled remediation, and next recovery action using user-facing commands.

Gate reruns use the configured hook cycle budget for the trigger Unit. Once that budget is exhausted, orchestration pauses with the gate name, trigger Unit, and recovery context instead of continuing progression or looping indefinitely.
