<!-- GSD Pi - Project overview and setup guide -->

# GSD Pi

GSD Pi is a local-first coding agent for planning, implementing, verifying, and tracking project work from the command line.

It combines a terminal agent, project workflow tools, worktree-aware Git automation, and optional UI integrations so a project can move from idea to reviewed implementation with less manual coordination.

## Status

This repository is starting a new development baseline at version `1.0.0` under the `GSD-redux/gsd-pi` project.

Older release history has been archived outside the active changelog so new work can be reviewed from a clean project surface.

## Install

```bash
npm install -g gsd-pi
```

## Quick Start

```bash
gsd
```

Run the setup flow, choose your preferred model provider, and open a project directory. GSD stores project planning and runtime state in `.gsd/`.

For a full first-run walkthrough, see [Getting Started With GSD2](./docs/user-docs/getting-started.md).

## Common Session Commands

Start GSD from your shell:

```bash
gsd
```

Then use slash commands inside the GSD session:

```text
/gsd config
/gsd auto
/gsd quick "Describe the task"
/gsd status
```

## What GSD Pi Does

- Plans work into milestones, slices, and tasks.
- Runs coding sessions with project context and verification steps.
- Uses Git worktrees to isolate implementation work.
- Tracks project state in a local database with markdown projections for review.
- Supports extension-based tools and provider integrations.
- Produces artifacts such as plans, summaries, validation notes, and reports.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/` | Core runtime resources and bundled extensions |
| `packages/` | Workspace packages used by the CLI, agent, TUI, RPC, and native bridge |
| `native/` | Native engine packaging and platform binaries |
| `studio/` | Desktop studio app |
| `web/` | Web UI and API surface |
| `vscode-extension/` | VS Code integration |
| `docs/` | User and developer documentation |
| `scripts/` | Build, release, migration, and maintenance scripts |

## Development

```bash
npm ci
npm run build
npm test
```

Before opening a pull request, run:

```bash
npm run verify:pr
```

## Versioning

The active public baseline starts at `1.0.0`.

Historical tags and archived refs may exist for traceability, but active release notes should be written from this baseline forward.

## Community

Join the [GSD Discord community](https://discord.com/invite/nKXTsAcmbT).

## License

MIT
