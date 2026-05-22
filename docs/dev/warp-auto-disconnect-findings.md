# Warp Auto Disconnect Investigation

Date: 2026-04-27

Issue: https://github.com/open-gsd/gsd-pi/issues/5086

## Issue

When running GSD auto-mode in Warp.app, the terminal can return to a shell prompt while the GSD task/process keeps running. The visible symptom is a disconnected terminal: the foreground UI is gone, but work continues in the background.

## Observed Evidence

- In the `a64353464` project, S01 finished at `2026-04-27T16:33:19Z`.
- GSD immediately dispatched the next unit, `plan-slice-M001-S02`, at `2026-04-27T16:33:21Z`.
- No new S02 session file was created.
- The prior session then recorded `Claude Code process aborted by user` at `2026-04-27T16:33:21Z`.
- A process scan also showed multiple orphaned `gsd` processes with `PPID=1` and `TTY=??`, matching the user's report that the PID/task was still running while the terminal was no longer attached.

## Root Cause Hypothesis

The auto-mode unit handoff resolves the current unit from the `agent_end` extension event handler. The auto loop then immediately calls `ctx.newSession()` for the next unit.

`AgentSession.newSession()` currently always calls `abort()` before disconnecting from the current agent. That order is correct when a user switches sessions while a turn is still active, because the old turn must emit `agent_end` before the event bus is disconnected.

However, during the auto-mode handoff, `newSession()` can be called while the prior `agent_end` event is still being processed. In that state, the provider turn has already emitted enough completion signal for auto-mode to advance, but the agent loop may not have fully settled. Calling `abort()` at that moment can turn the just-completed provider turn into an aborted assistant message, which matches the recorded `Claude Code process aborted by user` event.

## Secondary Finding

There is also a shell-entry routing risk in `src/cli.ts`: plain `gsd auto` is currently routed through headless mode before the later TTY-aware piped-output gate. If a user launches `gsd auto` directly from a terminal, this path can bypass the interactive TUI lifecycle entirely. This is related but distinct from the observed `agent_end` handoff abort.

## Sunday Night PR Review

The regression window matches the Sunday night PRs pushed on 2026-04-26 and just after midnight on 2026-04-27:

| PR | Merge Time (CT) | Relevance |
| --- | --- | --- |
| #5051 `fix/worktree-root-normalization` | 2026-04-26 20:00 | Medium. Changed worktree root detection and lock/report base paths under auto-mode. This altered the path context used by later auto units. |
| #5058 `fix/safety-harness-bash-evidence-race` | 2026-04-26 22:06 | Low. Persists bash evidence earlier in the tool-call lifecycle. Important for false positives, but it does not explain terminal detachment. |
| #5055 `feat/worktree-tui-commands` | 2026-04-26 22:13 | Low. Adds worktree TUI commands; no direct auto unit/session lifecycle changes. |
| #5060 `chore/expose-bundled-skills` | 2026-04-26 22:22 | Low to medium. Can influence model behavior and tool-selection prompts, but does not change session ownership. The trace did show unavailable lowercase `bash`/`read` tool attempts, which may be prompt/model fallout rather than the disconnect trigger. |
| #5062 `fix/worktree-path-injection` | 2026-04-27 00:33 | High. Moves cwd anchoring immediately before `newSession()` in `auto/run-unit.ts` and hook dispatch. This is the closest code change to the observed failure point: auto completed S01, dispatched S02, then recorded an aborted provider turn before a new S02 session file existed. |

Most likely regression path: #5051 changed the worktree/root substrate, then #5062 made every auto unit session switch depend on a synchronous cwd anchor immediately followed by `ctx.newSession()`. That exposed the existing `newSession()` behavior of always aborting the current turn, even when called from inside the prior turn's `agent_end` handling.

## Implemented Fix

Added a narrow lifecycle distinction in `AgentSession`:

- If `newSession()` or `switchSession()` is called during `agent_end` extension processing, wait for the already-ending provider loop to become idle instead of aborting it.
- Preserve the existing abort-before-disconnect behavior for normal user-initiated session switches while a turn is genuinely active.

This keeps the existing #4243 ordering guarantee while preventing auto-mode from aborting a turn that already reached `agent_end`.

Also tightened `src/cli.ts` so `gsd auto` only redirects to headless when stdin or stdout is not a TTY. Terminal launches stay on the interactive path, preserving Warp/iTerm/Terminal foreground ownership.

## Reproduction And Verification

- Added a regression test that simulates `newSession()` being called while an `agent_end` extension handler is in progress.
- Confirmed the test failed before the fix because `newSession()` called `abort()`.
- Added a CLI source-level regression test proving terminal `gsd auto` is not unconditionally routed to headless.
- Confirmed the CLI test failed before the TTY-gated redirect fix.
- Confirmed both focused suites pass after the fix.
