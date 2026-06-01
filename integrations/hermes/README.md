# open-gsd-hermes

Hermes Agent plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as the structured delivery engine.

## Install

```bash
pip install -e integrations/hermes
hermes plugins enable open-gsd-hermes
```

## Configuration

`~/.hermes/gsd.yaml` — see [`docs/setup.md`](docs/setup.md) for Slack/Telegram gateway checklist.

**Before gateway testing:**

```bash
bash integrations/hermes/scripts/preflight.sh
```

## Slash commands

- `/gsd bind <path>` — bind session to project
- `/gsd status` — show progress
- `/gsd auto` — start auto mode via MCP
- `/gsd cancel` — cancel running session
- `/gsd reply <text>` — resolve blocker

## Requirements

- `gsd >=2.53,<3` (override `gsd_version_min` in `~/.hermes/gsd.yaml` per release train)
- `gsd-mcp-server` on PATH or configured in `gsd.yaml`
