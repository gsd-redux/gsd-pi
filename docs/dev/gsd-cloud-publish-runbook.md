# @opengsd/gsd-cloud publish runbook

Human-run steps for publishing `@opengsd/gsd-cloud` (and the `@opengsd/daemon`
release it ships alongside) to public npm. The publish itself always runs through
`.github/workflows/npm-publish.yml` (OIDC trusted publishing) — **never** run
`npm publish` from a laptop: that bypasses the version bump, the changelog, the
workspace-resolution step, and the pre-release registry gate.

## What publishes, and how versions work

- Both packages are version-locked to the repo release version (e.g. root
  `1.11.0` → `@opengsd/daemon@1.11.0`, `@opengsd/gsd-cloud@1.11.0`). They have no
  independent version numbers.
- `scripts/lib/version-sync.cjs` (`RELEASE_WORKSPACE_PACKAGE_DIRS`) includes
  `packages/daemon` and `packages/gsd-cloud`, so any version bump — manual
  (`node scripts/bump-version.mjs <X.Y.Z>`) or the release workflow's
  `pipeline:version-stamp` / `bump-version.mjs` steps — updates both.
- `@opengsd/gsd-cloud` is **self-contained**: its only runtime dependencies are
  `ws` and `yaml`. It deliberately does NOT depend on `@opengsd/daemon` (the
  v1.5 Phase-24 doc assumed a thin wrapper; the shipped package re-implements
  the runtime standalone). `scripts/validate-gsd-cloud-tarball.mjs` enforces
  this contract, so a future dependency addition fails the tarball gate loudly
  instead of silently shipping an unresolvable publish.

## Pre-flight checklist (before dispatching anything)

1. Everything intended for the release is merged to `main`, and `ci.yml` is
   green on that exact SHA — the publish workflow builds both packages
   (`build:core` → `build:daemon` + `build:gsd-cloud`) but does not re-run their
   unit suites; `ci.yml`'s `test:cloud-packages` step is the unit-test gate.
2. Local sanity (optional but recommended after touching either package):
   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @opengsd/gsd-cloud run build
   pnpm --filter @opengsd/gsd-cloud run test
   pnpm --filter @opengsd/gsd-cloud run validate:tarball   # npm pack gate
   ```
   The tarball gate must print `OK — N gates passed; tarball is publishable.`
3. `pnpm run verify:version-sync` passes (all package.json versions equal root).

## Publish day

1. **Prerelease smoke (recommended):**
   ```bash
   gh workflow run npm-publish.yml -f channel=dev
   ```
   Wait for the `prerelease-publish` + `prerelease-verify` jobs to go green.
   Note: `dev`/`next` channels publish only the root `@opengsd/gsd-pi` tarball
   (which bundles `packages/*/dist`); workspace packages publish on `latest`.
2. **Production:**
   ```bash
   gh workflow run npm-publish.yml -f channel=latest
   ```
   The `prod-release` job then runs, in order: changelog + version bump commit →
   build → native engine packages → **workspace packages in dependency order**
   (`scripts/publish-workspace-packages.sh`, auto-discovered from each package's
   `publishConfig` — daemon and gsd-cloud need no workflow edits) → root
   `@opengsd/gsd-pi` → `verify-npm-release.mjs` (hard gate: every required
   package visible on npm at the release version) → push commit + tag → GitHub
   Release.
3. If the workflow fails at "Require token auth for native packages not on npm
   yet", re-run with `-f publish_auth=token` and the `NPM_TOKEN` repo secret set
   (first-publish bootstrap for the native engine packages only).

## Trusted publishing / provenance

- Auth is npm **trusted publishing** (GitHub OIDC, `id-token: write`) — there is
  no long-lived npm token in CI. npm emits **provenance statements** for each
  package published this way.
- The workflow enforces the toolchain npm requires for this: Node ≥ 22.14 and
  npm ≥ 11.5.1, on GitHub-hosted `ubuntu-latest` runners (provenance is not
  supported from self-hosted/Blacksmith runners).
- npm accepts **one** trusted-publishing workflow filename per package on
  npmjs.com; that is why `dev`, `next`, and `latest` all live in
  `npm-publish.yml`. Do not add a second publish workflow.
- `@opengsd/gsd-cloud` and `@opengsd/daemon` are already on npm (first published
  July 2026), so `channel=latest` works as-is. For a *brand-new* workspace
  package, trusted publishing must be configured on npmjs.com for that package
  name before the first publish, or the first publish must go out with
  `publish_auth=token` + `NPM_TOKEN` and trusted publishing configured after.

## Post-publish verification

Run these yourself after `prod-release` succeeds (allow a few minutes for
registry propagation):

```bash
npm view @opengsd/gsd-cloud version          # == release version
npm view @opengsd/daemon version             # == release version
npm view @opengsd/gsd-cloud dependencies     # exactly: ws, yaml (nothing else)

# npx smoke — the bin must run from a clean install:
npx -y @opengsd/gsd-cloud@<version> --help   # lists login/pair/status/connect/stop/disconnect
```

For the deeper live smoke, follow the authoritative
[cloud live E2E runbook](cloud-live-e2e-runbook.md).

## Rollback / the 72-hour rule

Publishing is irreversible in practice — plan around `npm deprecate`, not
`npm unpublish`.

- **Within 72 hours of publish:** a version *can* be unpublished
  (`npm unpublish <pkg>@<version>`), which permanently removes it. Only do this
  for a dangerously broken tarball (leaked secret, malicious/broken code), and
  never for a version other packages depend on. It cannot be re-published — the
  version number is burned.
- **Any time:** the standard recovery is
  `npm deprecate <pkg>@<version> "broken <channel> build; use <previous-good>"`
  followed by a fixed patch release. If `@latest` points at the bad version,
  re-point it: `npm dist-tag add <pkg>@<previous-good> latest`.
- Note: trusted publishing authenticates `npm publish` only — **not**
  `dist-tag` mutation or `deprecate`. Those need a local `npm login` (or
  `NPM_TOKEN`) with publish rights on the `@opengsd` org. The workflow's error
  messages call this out when a tag move is required.
- After any rollback action, re-run the post-publish verification above against
  the corrected version.
