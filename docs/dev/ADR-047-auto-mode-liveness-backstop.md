# ADR-047: Auto-mode liveness backstop — every blocked state has a reachable exit

- **Status:** Accepted
- **Date:** 2026-08-08
- **Driver:** Wayfinder map [#1645](https://github.com/open-gsd/gsd-pi/issues/1645), design ticket [#1647](https://github.com/open-gsd/gsd-pi/issues/1647)
- **Evidence:** [Stuck-state taxonomy](https://gist.github.com/jeremymcs/2baae11a01895130426df9d061c11ecc) — 19 wedge issues since v1.12.0 collapsed into 10 root-cause groups

## Context

Since the v1.12.0 durable-attempt authority cutover (#1447/#1451/#1480) made gating mandatory and terminal, auto mode has wedged permanently in the field roughly once a day. The taxonomy over 19 issues shows the guards are almost always *correct*; what fails is the exit. Recovery operations are read-only no-ops (#1622, #1626, #1641), resume keys are minted but never surfaced (#1593), the sanctioned repair tool is hard-blocked by the very unit tool-contract that dispatched the unit (#1615, #1626), drift repairs regenerate the exact state the detector flags (#1619, #1623, #1634), the escape-hatch command enforces a false invariant of its own (#1618), and detectors count the engine's own writes as violations (#1590, #1629).

The existing stuck-loop detector ("Rule 1" over the dispatch ledger) failed to contain any of this: its ledger is per-session (a restart resets the ring — #1622, #1626 looped for hours under it), its consecutive-≥3 rule provably never fires on two-state oscillations (#1623, #1634), and it once tripped on fabricated input because the signature came from the dispatcher's label, not the guard's reading (#1564).

The common design gap: **no layer guarantees that when a guard blocks progress, a sanctioned, state-mutating exit is reachable from the context where the block fires.** Guards land independently with no liveness obligation.

## Decision

Auto mode gains a single **liveness invariant**, enforced centrally:

> A block signature may not recur with unchanged inputs. Either some reachable operation changes the inputs the guard reads, or auto mode escalates to a surfaced, acknowledged pause. Silent infinite wedging is structurally impossible.

Five locked design points:

### 1. Enforcement seam: a centralized backstop in the dispatch loop

The invariant lives in one place — the auto dispatch loop — not as per-guard contracts. Every guard stays dumb; the loop guarantees liveness for present and future guards alike. A per-guard "declared exit" registry was considered and rejected: declarations cannot prove reachability (the exit in #1615 *existed* but was tool-scope-blocked), and the per-family exit repairs are already discrete fix tickets. If backstop pause reports keep naming the same missing exit, a build-time lint can be added later.

### 2. The backstop only pauses and surfaces — it never mutates workflow state

On trip: persist the evidence, name the guard, print the sanctioned exit, stop. No auto-repair inside the backstop. Repairs that re-produce the detected state *are* the loop (#1619, #1622); self-healing belongs in the per-family fixes, where a correct repair advances state, the input hash changes, and the backstop simply never trips.

### 3. Block signature and trip rule

**Signature** = (guard/gate id, unit type, target identity — milestone/slice/task — hash of the inputs the guard actually read: verdict payload, drift record, failing command + exit code). The guard/gate id is a stable literal owned by the semantic guard; mutable reason text contributes only to the input payload and never defines identity. Building the signature from what the guard *read* rather than what the dispatcher *labeled* eliminates the #1564 false-positive class by construction.

**Trip rule:** per-signature occurrence count ≥ 2 with an identical input hash, **interleaving-blind** — other dispatches between occurrences do not reset anything. This is what makes A-B-A-B oscillations (#1623, #1634) visible; a consecutive-only rule never fires on them. There is no legitimate run in which a guard reads byte-identical inputs twice with dispatches in between, so threshold 2 is safe.

**Counter lifecycle:** a signature's counter clears only when its input hash changes (state genuinely advanced) or on explicit acknowledged resume. The ledger is **DB-persisted** — process restarts do not reset it.

### 4. The ledger records every non-advancing outcome, announced or silent

Ledger entries are not limited to explicit guard blocks. Any dispatch outcome that does not advance state gets a signature: guard blocks, gate failures, recovery routes, unit breaks, and **completed-no-advance** dispatches (unit returned, none of the target rows it was dispatched to move changed — hashed as the signature input). The hottest loop in the taxonomy (#1626, 37 ms zero-work re-dispatches) never hit an explicit block surface; a progress-blind ledger never sees it.

"Every" includes the loop's own non-advancing exits, not just dispatch outcomes: the preflight stops (iteration ceiling, memory pressure, missing command context) are inside the adjudication boundary, and all stop/teardown requests are deferred until that boundary has persisted the pending signature. The same ordering applies to custom-engine dispatch, verification, reconciliation, and post-unit slice-cadence stops. Custom-engine signatures keep the semantic guard stable while hashing the dispatch or reconcile reason and the verification policy's structured failure evidence. That evidence must be as fine-grained as the read it stands for, and a turn that reads more than once hashes **every** read, in read order. Content-heuristic verification carries ordered evidence for each output it checked before the failure: existence, size when size was read, and a digest when content was read. Thus changing one output while another keeps failing is a different signature without hashing file contents directly. Host verification reports its final decision evidence on every path that does not advance — a stored verdict, its recovery route, a missing verification repository, source drift before or after the policy ran, the human-review pause, a caught policy error, or an ordinary policy failure — naming the stable identity it read (stored verdict and blocker ids, recovery route, missing repository targets, both source revisions, the error message). Signature evidence excludes identifiers and timestamps minted by the current evaluation, including fresh Attempt, verdict, and evidence ids; those operation outputs are not inputs the guard read and would make identical failures hash differently. The custom-engine verification signature then **composes** the policy read and each host decision in emission order rather than keeping whichever was written first, so a later decisive read — an interactive human-review resolution rerouting a policy failure, for instance — can never be shadowed by the stale read that preceded it, while an identical sequence of identical reads still hashes identically and trips at occurrence two (#1674). A trip preserves a queued stop's detail and teardown options while adding the canonical blocked marker before the original request runs against the live session after persistence. The idempotent "unit already active" skip is ledgered whenever the execution-owned in-flight flag is clear, independent of a stale current-unit marker, so only genuinely running units retain the skip exemption (#1672).

### 5. Resume contract: explicit acknowledgment, Rule 1 deleted

On trip, the backstop persists a **wedge record** — id, signature, occurrence count, the sanctioned exit for that guard, forensics bundle path — and auto exits with the existing blocked exit code (10). While an unacknowledged wedge record exists, `gsd auto` **refuses to re-enter** and reprints the exit instructions; restarting is no longer a silent counter reset. The explicit command `gsd auto --resume-wedge <id>` acknowledges the wedge, clears that signature's counter, and re-enters. A correct repair changes the input hash and the backstop stays quiet; a wrong one re-trips at 2.

Acknowledgment is always explicit — from a human, or from an orchestrator knowingly passing the flag. Headless runs do **not** auto-acknowledge: exit code 10 already means "blocked, human needed," and a wedge is exactly that.

**Naming the exit is part of the record, not the guard's obligation.** The persisted `sanctioned_exit` must be the owning guard's real, state-mutating recovery operation (`/gsd rebuild markdown` for projection drift, `gsd_task_recovery_resume` for a terminal task-recovery abort, `/gsd doctor fix` for `.gsd/` state, `/gsd status` for a lease held elsewhere) plus the failure payload the guard read — a restart can only reprint what the wedge stored, so generic text there is a broken promise (#1672). Because the loop's shared adjudication boundary sees only the guard id, the loop-level mapping from guard id to that guard's already-published instruction lives centrally in `auto/loop-sanctioned-exits.ts`. Aggregate phases preserve their semantic guard ids end to end while carrying their read inputs separately: stop/backtrack directives carry the capture, evaluation failures carry the error, budget halt/pause carries the budget figures, and context-window pause carries the measured usage and threshold. This is notice text, not the per-guard *declared exit registry* rejected in §1: it makes no reachability claim, imposes nothing on guard sites, and is never consulted to decide whether to trip.

**Rule 1 is deleted, not paralleled.** The backstop strictly subsumes it, and two detectors in tension was itself a root-cause group (#1623).

## Consequences

- Every current and future wedge converts into: at most 2 identical blocked dispatches, then a persisted, surfaced, resumable pause with the sanctioned exit named. The failure mode "auto mode silently loops/hangs forever" ceases to exist as a class.
- The six per-family fix tickets ([#1649](https://github.com/open-gsd/gsd-pi/issues/1649)–[#1654](https://github.com/open-gsd/gsd-pi/issues/1654)) implement the *exits* — settling terminal Attempts, unblocking repair tools in unit scopes, converging drift repair, scoping verification, preserving projections, expiring stale pause pins. The backstop makes their absence visible instead of fatal.
- The implementation lives in the auto dispatch loop and DB-backed signature/wedge ledger, the `gsd auto` entry gate, and the resume flag. Rule 1 and its dispatch-history module are removed; guards remain responsible for their own state-mutating exits.
- The deterministic [acceptance bed](../../tests/acceptance-bed/README.md) exercises trip-at-2, interleaving-blind detection, restart persistence, and re-entry refusal at this seam.

## Rejected alternatives

- **Per-guard exit contracts / registry obligation** — declarations can't prove reachability; heavy touch on every guard site; deferred to an optional lint informed by real wedge reports.
- **Auto-repair inside the backstop** — reintroduces the repair-regenerates-the-state loop class the backstop exists to end.
- **Headless auto-acknowledge** — same mistake as auto-repair, wearing autonomy clothing; exit 10 is the designed handoff.
- **Keeping Rule 1 alongside** — two liveness detectors in tension reproduce root-cause group G3's detector-fight shape at the meta level.
