# open-gsd-openclaw

[OpenClaw](https://docs.openclaw.ai) plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as the structured delivery engine. Plugin id `open-gsd-openclaw`, npm package `@opengsd/open-gsd-openclaw`.

Read a bound project's progress and drive supervised `gsd headless` runs from any OpenClaw chat channel (Telegram, Discord, Slack, WhatsApp, WebChat, and the others OpenClaw supports). The `/gsd` command is handled by the OpenClaw Gateway before any model or agent runtime is selected, so it behaves identically on every first-party runtime and provider. The agent gets a read-only `gsd_status` tool and a `gsd` skill.

## Install

```bash
openclaw plugins install npm:@opengsd/open-gsd-openclaw --pin
openclaw config set plugins.entries.open-gsd-openclaw.config.defaultProject /absolute/path/to/project
openclaw plugins enable open-gsd-openclaw
openclaw gateway restart
```

From a gsd-pi source checkout, build the package and link it instead of installing it from npm:

```bash
pnpm run build:integrations
openclaw plugins install --link /path/to/gsd-pi/integrations/openclaw --force
```

Verify the running registration:

```bash
openclaw plugins inspect open-gsd-openclaw --runtime --json
```

The `gsd` CLI must be on the Gateway process PATH, or set `plugins.entries.open-gsd-openclaw.config.cliPath` to its absolute path.

## Commands

| Command | Behaviour |
| --- | --- |
| `/gsd status [path]` | Project snapshot: phase, active milestone/slice/task, counts, blockers, next action, plus the run line (active run, pending question, or last result) |
| `/gsd auto [path] [--model <id>]` | Start a supervised `gsd headless auto` run in the project |
| `/gsd new-milestone <brief...>` or `--file <absolute path>` `[--auto]` | Create a milestone from a brief (`--auto` chains execution) |
| `/gsd quick <task...>` | Run a quick task; the text is passed to gsd as one argument |
| `/gsd reply <number or text>` | Answer the run's pending question; `cancel` skips it |
| `/gsd cancel [path]` | SIGTERM the active run (also a run orphaned by a Gateway restart, via its lockfile) |
| `/gsd bind <absolute path>` | Bind this conversation to a GSD project |
| `/gsd unbind` | Remove the binding |
| `/gsd help` | Command list |

Project resolution order: explicit path argument, then the conversation binding, then `defaultProject`. Nothing is inferred from a working directory; with no match the command fails closed and says so.

### Supervised runs

One run per project at a time; a second `/gsd auto` is refused until the first finishes or is cancelled. The child is `gsd headless <command> --supervised --output-format stream-json --max-restarts 0 --timeout 0 --response-timeout 86400000` with the project as working directory. Once `.gsd/` exists the lockfile `.gsd/runtime/openclaw-run.json` records its pid (a lock older than the current boot is ignored); a legacy `.planning/`-only project has no cross-restart guard until gsd bootstraps `.gsd/`.

When gsd asks a question (select, confirm, input, editor) the run is parked as *blocked* and the question is posted to the chat; `/gsd reply` writes the answer to the child's stdin. A multi-select can only receive one option from chat. Secure prompts (secret values) are never posted: the plugin cancels them locally and reports that the step needs an interactive gsd session.

Because the headless parser recognises its own `--flags` anywhere in argv, chat text is always passed as a single argument and any other `-`-prefixed token is rejected with a usage error. `--model` must match `[\w.:/-]+`; `--file` must be an absolute path to an existing regular file.

Bindings are keyed by conversation route (channel, account, conversation, thread), so a native slash command and a typed `/gsd` in the same chat share one binding. They are stored under the plugin's state directory as `open-gsd-openclaw/bindings.json`.

## Authorization

`/gsd` declares `requiredScopes: ["operator.write"]`. OpenClaw enforces it: Gateway clients (the Control UI, the CLI) need that scope, and chat senders must be command owners. The plugin keeps no allowlist of its own.

Who counts as an owner follows OpenClaw's rules: `commands.ownerAllowFrom` when set, otherwise the channel's explicit `allowFrom` entries. A channel whose allowlist is empty or a wildcard has no owners, so set `commands.ownerAllowFrom` to use `/gsd` from such a channel:

```json5
{ commands: { ownerAllowFrom: ["telegram:123456789"] } }
```

### What a sender can reach

Treat every command owner as trusted with the Gateway host's GSD projects:

- `/gsd status <absolute path>` and `/gsd bind <absolute path>` both accept any directory the Gateway process can read that contains `.gsd/` or `.planning/`. There is no allowlist of project roots, so an owner (or anyone holding a compromised or over-broad owner identity) can read the derived state of any GSD project on the host; `defaultProject` is a default, not a restriction.
- What `status` exposes is what `gsd read progress --json` reports: phase, milestone, slice, and task titles, counts, blocker text, and the next action. The plugin never reads project files directly.
- `/gsd auto`, `/gsd new-milestone`, and `/gsd quick` start `gsd headless` in the resolved project with the Gateway process's environment and credentials, so an owner can run GSD's coding agent against any GSD project on the host; `--file` reads any regular file the Gateway can read and passes it to gsd as the milestone brief.
- The snapshot posted to chat is project-derived content and is not redacted; only the `gsd` CLI's stderr is redacted before it reaches a channel. If milestone titles or blocker text can contain sensitive material, keep the chat channels that carry `/gsd` as private as the project itself.
- The owner allowlist is the only control: keep `commands.ownerAllowFrom` narrow.

## Notifications

Progress notices, questions and the final summary go to the chat that started the run. Channels with an outbound adapter (Telegram, Discord, Slack, ...) get a direct message on the same route (account, conversation, thread). WebChat and the CLI have no outbound adapter, and a provider may decline a send: in both cases the text is queued as a system event on the originating session and the session's heartbeat is woken so the agent relays it. With no session key either, the text is only logged.

## Agent tool and skill

The plugin registers one agent tool, `gsd_status` (declared in `contracts.tools`), returning the same snapshot as `/gsd status` plus the run line, with structured `details` (`projectDir`, `phase`, `activeMilestone`, `activeSlice`, `activeTask`, `blockers`, `nextAction`, `run`). It resolves the project from an optional `project` argument, then the binding of the tool's delivery route, then `defaultProject`; it is read-only and starts nothing. The command's `agentPromptGuidance` already tells the model to use it before advising on delivery work.

The package also ships `skills/gsd/SKILL.md`, a longer briefing on the tool and the `/gsd` commands. It is not declared in the manifest's `skills` field on purpose: on OpenClaw 2026.8.2 a plugin that declares `skills` has its typed `/gsd` commands skipped by text-command matching (the message goes to the model instead). Load it as a shared skill directory instead, pointing at the installed package:

```json5
{ skills: { load: { extraDirs: ["<openclaw state dir>/npm/projects/<open-gsd-openclaw project>/node_modules/@opengsd/open-gsd-openclaw/skills"] } } }
```

`openclaw plugins inspect open-gsd-openclaw --json` prints the install path.

## Configuration

```json5
{
  plugins: {
    entries: {
      "open-gsd-openclaw": {
        enabled: true,
        config: {
          cliPath: "/usr/local/bin/gsd", // optional; defaults to `gsd` on PATH
          defaultProject: "/home/me/code/myapp",
        },
      },
    },
  },
}
```

## Scheduling runs

OpenClaw automations run command payloads inside the Gateway with no model call, so a nightly `gsd headless auto` needs no plugin code:

```bash
openclaw automations create "0 2 * * *" \
  --name "Nightly GSD auto" \
  --command-argv '["gsd","headless","auto","--json"]' \
  --command-cwd /absolute/path/to/project \
  --timeout-seconds 7200 \
  --announce --channel telegram --to "<chat id>"
```

Raise `--timeout-seconds` to cover a milestone-length run; the default command timeout is ten minutes.

## Development

The package is a pnpm workspace member (`integrations/openclaw`) built by `pnpm run build:integrations`, outside the core build chain, and published with the other workspace packages.

```bash
pnpm --filter @opengsd/open-gsd-openclaw run build
pnpm --filter @opengsd/open-gsd-openclaw test
```

Offline compatibility check against the OpenClaw plugin contract:

```bash
npm install --no-save --no-audit --no-fund @openclaw/plugin-inspector
./node_modules/.bin/plugin-inspector ci --plugin-root integrations/openclaw --no-openclaw --runtime --mock-sdk --allow-execute
```

## License

MIT
