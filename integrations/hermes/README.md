# open-gsd-hermes

Hermes Agent plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as the structured delivery engine.

## Install

If GSD Pi was installed from an npm package that includes this integration, use the
one-command installer:

```bash
gsd hermes install --project /absolute/path/to/your/project
hermes plugins list   # should show open-gsd-hermes enabled
```

The installer copies the bundled plugin into `$HERMES_HOME/plugins/open-gsd-hermes`,
installs the Python package into the Hermes environment when possible, creates a
starter `$HERMES_HOME/gsd.yaml` if one does not exist, and runs
`hermes plugins enable open-gsd-hermes`.

From a source checkout, the manual development path is still supported:

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
