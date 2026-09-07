# open-gsd-openclaw

[OpenClaw](https://docs.openclaw.ai) plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as the structured delivery engine. Plugin id `open-gsd-openclaw`, npm package `@opengsd/open-gsd-openclaw`.

Read a bound project's progress from any OpenClaw chat channel (Telegram, Discord, Slack, WhatsApp, WebChat, and the others OpenClaw supports). The `/gsd` command is handled by the OpenClaw Gateway before any model or agent runtime is selected, so it behaves identically on every first-party runtime and provider.

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
| `/gsd status [path]` | Project snapshot: phase, active milestone/slice/task, counts, blockers, next action |
| `/gsd bind <absolute path>` | Bind this conversation to a GSD project |
| `/gsd unbind` | Remove the binding |
| `/gsd help` | Command list |

Project resolution order: explicit path argument, then the conversation binding, then `defaultProject`. Nothing is inferred from a working directory; with no match the command fails closed and says so.

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
- What is exposed is what `gsd read progress --json` reports: phase, milestone, slice, and task titles, counts, blocker text, and the next action. The plugin never runs anything else in this phase and never reads project files directly.
- The snapshot posted to chat is project-derived content and is not redacted; only the `gsd` CLI's stderr is redacted before it reaches a channel. If milestone titles or blocker text can contain sensitive material, keep the chat channels that carry `/gsd` as private as the project itself.
- The owner allowlist is the only control: keep `commands.ownerAllowFrom` narrow.

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
