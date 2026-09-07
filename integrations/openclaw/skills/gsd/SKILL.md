---
name: gsd
description: Read a GSD Pi project's delivery state with the gsd_status tool and explain the /gsd commands that drive supervised runs from chat.
---

# GSD (Get Stuff Done) from OpenClaw

GSD Pi is a structured delivery engine: a project under `.gsd/` is broken into
milestones, slices and tasks, and `gsd auto` executes them. This plugin binds a
chat conversation to one project and lets the operator run it from chat.

## Reading state: `gsd_status`

Call `gsd_status` before advising on delivery work or when asked how the project
or a run is going. It is read-only and returns:

- phase, active milestone / slice / task, counts, blockers, next action
- the run line: `Run: none`, `Run: gsd-<pid> running since <time> (<command>)`,
  `Waiting for input: <title> — reply with /gsd reply <n or text>`, or the last
  finished run's summary

Pass `project` (an absolute path) only when the user names a project explicitly;
otherwise the tool resolves the conversation's binding, then the configured
`defaultProject`. If it reports that no project is bound, tell the user to run
`/gsd bind <absolute path>`; do not guess a path.

## Driving runs: `/gsd` commands (operator-only)

Runs are started by the operator with slash commands, not by you:

- `/gsd auto [path] [--model <id>]` — supervised `gsd auto`
- `/gsd new-milestone <brief...> | --file <absolute path> [--auto]`
- `/gsd quick <task...>`
- `/gsd reply <number or text>` — answers the pending question; `cancel` skips it
- `/gsd cancel [path]` — stops the run
- `/gsd status [path]`, `/gsd bind <path>`, `/gsd unbind`, `/gsd help`

One run per project at a time. Progress notices, questions (blockers) and the
final summary are posted to the chat that started the run. When a run is
blocked, relay the question and the exact `/gsd reply` form; a multi-select can
only take one option from chat. Secret prompts are never shown in chat: the run
reports that the step needs an interactive gsd session.
