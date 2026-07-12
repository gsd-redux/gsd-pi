# Switching between gsd-core and gsd-pi

Both `@opengsd/gsd-core` and `@opengsd/gsd-pi` read and write the same `.gsd/` directory. You can open a project in either tool, switch freely, and even interleave them across sessions. This doc explains the workflow and what to do when the two tools disagree.

## The shared contract

`.gsd/*.md` files are the interchange contract between the two tools. gsd-core treats them as the source of truth. gsd-pi imports eligible external edits into SQLite during bootstrap, then treats the database as runtime authority and projects back to the same `.md` files. Once planning has adopted a milestone's canonical lifecycle, bulk Markdown hierarchy replacement is refused; use gsd-pi's planning or reopen tools for further structural and lifecycle changes. For pre-adoption status checkboxes, gsd-pi scopes Markdown authority to the drifted file's recorded milestone entities, so unrelated stale projections keep the DB status.

## Recommended workflow: commit before switching

Git is the integration layer. Before switching tools, commit:

```bash
git add .gsd/
git commit -m "wip: switching to gsd-pi"
```

Then open the other tool. If anything goes wrong, `git reset --hard` restores the pre-switch state. This is the simplest and safest workflow.

## What gsd-pi does on startup

When you open a project in gsd-pi, it runs a reconciliation pass that:

1. Compares every `.gsd/*.md` file against its recorded baseline in `.gsd/.compat.json`.
2. Imports eligible files that changed since the last gsd-pi session (e.g., gsd-core edits), with status changes scoped to the milestone entities recorded for that drifted file. It refuses a hierarchy replacement that would erase adopted canonical lifecycle history.
3. Re-projects all markdown from the DB.
4. Updates `.gsd/.compat.json` with the new baseline.

This is automatic — you don't need to do anything special. gsd-pi will not silently overwrite gsd-core edits.

## `/gsd sync` — mid-session switch

If you switch tools while gsd-pi is running (e.g., a teammate edits `.gsd/plan.md` via gsd-core and pushes), run:

```
/gsd sync
```

This re-runs the reconciliation pipeline, imports eligible external edits, and re-projects. Use `--dry-run` to preview what would change:

```
/gsd sync --dry-run
```

## `/gsd doctor` — check compat health

`/gsd doctor` includes a compat-health line that tells you whether the marker is present and whether any files have drifted:

```
Compat health:      OK
```

or

```
Compat health:      2 file(s) drifted — run /gsd sync
```

## What gsd-core sees

gsd-core is unaware of gsd-pi. It sees `.gsd/*.md` as ordinary markdown and edits them directly. gsd-pi's `.gsd/.compat.json` and `gsd.db` files are ignored by gsd-core (it preserves unknown files, so they won't be deleted).

## `.planning/` projects

If your project uses gsd-core's `.planning/` layout (flat `phases/NN-name/` directories, root `ROADMAP.md` / `STATE.md`), gsd-pi projects DB state back to `.planning/` automatically — you don't need to run `/gsd migrate`.

- The first time gsd-pi sees a `.planning/` project, it imports the hierarchy into the database and records the layout in `.gsd/.compat.json` under `planning.layout` only after that import succeeds. A failed import leaves compatibility inactive so later projection cannot overwrite the unimported `.planning/` content.
- On every projection, gsd-pi writes back to `.planning/` using that recorded layout. Cancelled slices and tasks are omitted, and obsolete tracked phase plan files are removed.
- `/gsd sync` imports gsd-core's `.planning/` edits; `/gsd doctor` reports `.planning/` drift separately from `.gsd/` drift.

**Un-modeled docs** (phase `DISCUSSION-LOG.md`, `PATTERNS.md`, `REVIEWS.md`, `codebase/`, `research/`) are pass-through: gsd-pi detects edits to them but never overwrites them. They are gsd-core-owned.

**v1 limitation:** only the `flat-phases` layout is supported for round-trip projection. `multi-milestone` and `legacy-milestone-dir` layouts will be supported after fixtures validate the reverse-mapping. For those layouts today, run `/gsd migrate` once to move to `.gsd/`.

## Conflicts: same entity edited in both

Before canonical lifecycle adoption, if both tools edit the *same* entity (e.g., both change the status of slice `S01`) between syncs, the last imported writer wins and gsd-pi surfaces the resolution in `/gsd sync`. After adoption, the database lifecycle wins: sync refuses a Markdown hierarchy replacement rather than reopening, cancelling, or deleting adopted work. Use the matching gsd-pi planning or reopen tool, then re-project before switching back. A stale projection that did not drift is never allowed to reopen or close unrelated DB rows. Git review remains the final safety net — that's why the "commit before switching" workflow matters.

## Troubleshooting

**`gsd doctor` says "no baseline"**: run `/gsd sync` once to establish the marker.

**`.gsd/.compat.json.bad-*` files appear**: gsd-pi quarantined a malformed marker and started fresh. Safe to delete the `.bad-*` file after reviewing it.

**`/gsd sync` reports drift every time you open the project**: this means gsd-pi's projection isn't idempotent — a real bug. The round-trip property test suite in CI catches most of these; report the fixture if you hit one in the wild.
