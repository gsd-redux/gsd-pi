<!-- GSD Pi - Project overview and setup guide -->

# GSD Pi

GSD Pi is a local-first coding agent for planning, implementing, verifying, and tracking project work from the command line.

It combines a terminal agent, project workflow tools, worktree-aware Git automation, and optional UI integrations so a project can move from idea to reviewed implementation with less manual coordination.

## Status

This repository is starting a new development baseline at version `1.0.0` under the `open-gsd/gsd-pi` project.

Older release history has been archived outside the active changelog so new work can be reviewed from a clean project surface.

## Install

GSD installs and updates from the scoped npm package `@opengsd/gsd-pi`.

```bash
npm install -g @opengsd/gsd-pi@latest
```

The source repository is [`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi), but user installs should use npm rather than cloning the repo.

## Upgrade From Older GSD-2 Installs

If your existing `gsd` command came from the old package location, clear stale local update/resource state and install the scoped package directly:

macOS / Linux:

```bash
rm -f ~/.gsd/.update-check ~/.gsd/agent/managed-resources.json
npm install -g @opengsd/gsd-pi@latest
```

Windows PowerShell:

```powershell
Remove-Item "$env:USERPROFILE\.gsd\.update-check" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.gsd\agent\managed-resources.json" -Force -ErrorAction SilentlyContinue
npm install -g @opengsd/gsd-pi@latest
```

Windows Command Prompt:

```bat
del "%USERPROFILE%\.gsd\.update-check" 2>nul
del "%USERPROFILE%\.gsd\agent\managed-resources.json" 2>nul
npm install -g @opengsd/gsd-pi@latest
```

Or run the installer from the new package on any OS:

```bash
npx @opengsd/gsd-pi@latest
```

After that, future upgrades can use either command:

```bash
gsd upgrade
gsd update
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
