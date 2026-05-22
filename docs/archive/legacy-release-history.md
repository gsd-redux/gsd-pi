<!-- GSD Pi - Legacy release history archive note -->

# Legacy Release History

The active changelog starts at the `GSD-redux/gsd-pi` ownership baseline.

Older release history is intentionally not copied into the active documentation tree. Keeping it out of `CHANGELOG.md` avoids mixing the new project baseline with previous release trains, old repository links, and stale ownership context.

For traceability, the legacy changelog is preserved in Git at:

```text
refs/archive/pre-initial-main/2026-05-22:CHANGELOG.md
```

To inspect it locally:

```bash
git show refs/archive/pre-initial-main/2026-05-22:CHANGELOG.md
```

To recover it into a temporary file for audit:

```bash
git show refs/archive/pre-initial-main/2026-05-22:CHANGELOG.md > /tmp/gsd-pi-legacy-changelog.md
```

New release notes should be added to the root `CHANGELOG.md` from version `1.0.0` forward.
