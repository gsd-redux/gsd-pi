# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on **`open-gsd/gsd-pi`** (the `upstream` remote). Use the `gh` CLI for all operations.

This clone may have multiple remotes (`origin` is a personal fork, `upstream` is the canonical repo). Always pass `-R open-gsd/gsd-pi` so commands hit the canonical tracker rather than auto-resolving to the fork.

## Conventions

- **Create an issue**: `gh issue create -R open-gsd/gsd-pi --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R open-gsd/gsd-pi --json number,title,body,labels,comments --jq '{number, title, body, labels: [.labels[].name], comments: [.comments[].body]}'`.
- **List issues**: `gh issue list -R open-gsd/gsd-pi --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R open-gsd/gsd-pi --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R open-gsd/gsd-pi --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R open-gsd/gsd-pi --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `open-gsd/gsd-pi`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R open-gsd/gsd-pi --comments`.
