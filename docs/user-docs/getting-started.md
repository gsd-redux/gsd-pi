<!-- GSD Pi - Getting started guide -->

# Getting Started With GSD2

GSD2, published from this repository as GSD Pi, is a local-first coding agent for planning, implementing, and verifying project work from your terminal.

This guide gets you from a clean machine to your first GSD session.

## Prerequisites

Install these first:

| Requirement | Minimum | Recommended |
| --- | --- | --- |
| Node.js | 22.0.0 | 24 LTS |
| npm | Bundled with Node.js | Latest bundled LTS version |
| Git | 2.20 | Latest stable |
| Model provider credentials | One supported provider | The provider your team already uses |

Verify the basics:

```bash
node --version
npm --version
git --version
```

## Install GSD Pi

Install the CLI globally:

```bash
npm install -g gsd-pi
```

Confirm the command is available:

```bash
gsd
```

If `gsd` is not found, your npm global bin directory is probably not on `PATH`.

```bash
npm prefix -g
```

Add that directory's `bin` folder to your shell profile, then open a new terminal.

## Configure GSD

Start GSD:

```bash
gsd
```

Then run the setup wizard inside the GSD session:

```text
/gsd config
```

The wizard walks through:

- model provider setup
- optional tool credentials
- default model and reasoning preferences
- local project/runtime settings

You can rerun it any time from inside GSD:

```text
/gsd config
```

## Start In A Project

Move into the repository you want GSD to work on:

```bash
cd path/to/your-project
```

Start GSD:

```bash
gsd
```

On first run for a project, GSD creates local project state under `.gsd/`. This state tracks plans, milestones, tasks, decisions, session history, and runtime metadata.

## Create Your First Task

For a small change, start GSD and use a quick task command:

```bash
gsd
```

```text
/gsd quick "Update the README with local setup instructions"
```

For planned work, start an interactive session:

```bash
gsd
```

Inside the session, describe what you want to build. GSD can help shape the request into milestones, slices, and tasks before implementing.

## Run Auto Mode

Auto mode lets GSD continue through planning, implementation, verification, and handoff until it needs input or finishes the current unit of work.

```bash
gsd
```

```text
/gsd auto
```

Use auto mode when:

- the task is clearly described
- the project has a clean Git state
- you are comfortable letting GSD create isolated worktrees and commits

Pause or stop auto mode from the session controls or with the relevant `/gsd` command in the interactive UI.

## Check Status

Use status commands inside GSD when you want to inspect progress before continuing:

```text
/gsd status
```

In an interactive session, common commands include:

```text
/gsd status
/gsd auto
/gsd next
/gsd stop
/gsd help
```

## Recommended First Workflow

1. Open a clean project checkout.
2. Run `gsd`.
3. Run `/gsd config`.
4. Ask GSD to inspect the project and suggest the next small improvement.
5. Approve one focused task.
6. Let GSD implement and verify it.
7. Review the Git diff and generated planning notes.

## Working With Git

GSD expects Git to be the source of truth for code changes.

Before starting meaningful work:

```bash
git status
```

Start from a clean worktree when possible. GSD can create task worktrees for isolated implementation, but your base checkout should still be understandable before you begin.

## Local Project State

GSD stores project state in `.gsd/`. Depending on your workflow, some generated markdown files may be useful to commit and review, while runtime/cache files should stay local.

When in doubt:

```bash
git status --short
```

Review generated files before committing them.

## Troubleshooting

If setup fails:

```bash
gsd
```

```text
/gsd doctor
```

If the CLI cannot find your provider credentials, rerun:

```text
/gsd config
```

If a session gets stuck, check status first:

```text
/gsd status
```

Then inspect logs or use the debugging tools documented in [Troubleshooting](./troubleshooting.md).

## Next Steps

- [Commands Reference](./commands.md) - learn the available `/gsd` commands.
- [Configuration](./configuration.md) - tune model, reasoning, Git, and token settings.
- [Provider Setup](./providers.md) - connect the model provider your team uses.
- [Git Strategy](./git-strategy.md) - understand worktrees, branches, and merge behavior.
- [Auto Mode](./auto-mode.md) - run longer autonomous workflows safely.
- [Working in Teams](./working-in-teams.md) - configure shared-project workflows.
- [Skills](./skills.md) - discover and use bundled or custom skills.
- [Subagents](./subagents.md) - delegate isolated work when a task can split cleanly.
- [Parallel Orchestration](./parallel-orchestration.md) - run multiple milestones with worker isolation.
- [Cost Management](./cost-management.md) - set budgets and review usage.
- [Web Interface](./web-interface.md) - use the browser-based project surface.
- [Troubleshooting](./troubleshooting.md) - diagnose setup, provider, Git, and runtime issues.
