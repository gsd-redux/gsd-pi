#!/usr/bin/env bash
# Local parity with CI PR merge gates (ci.yml blocking jobs when heavy-code-changed).
# See docs/dev/test-confidence-stack.md for the full tier map.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "── verify:merge (CI PR blocking parity) ──"

echo "── native addon from source (test-fault-injection) ──"
if ! command -v rustc >/dev/null 2>&1; then
  echo "verify:merge needs Rust to build the local native engine (pnpm run build:native:test)."
  echo "CI does this before unit tests so ProjectionRootIdentityLock matches this commit."
  echo "Install rustup, then re-run. See CONTRIBUTING.md (Native engine version lockstep)."
  exit 1
fi
pnpm run build:native:test

echo "── build:core ──"
pnpm run build:core

echo "── web host (required by validate-pack) ──"
pnpm install --frozen-lockfile
pnpm run build:web-host

echo "── typecheck:extensions ──"
pnpm run typecheck:extensions

echo "── validate-pack ──"
pnpm run validate-pack

echo "── verify:workspace-coverage ──"
pnpm run verify:workspace-coverage

echo "── verify:extension-coverage ──"
pnpm run verify:extension-coverage

echo "── test:unit ──"
pnpm run test:compile
mkdir -p dist-test/native/addon
cp native/addon/*.node dist-test/native/addon/
export GSD_NATIVE_PREFER_LOCAL=1
pnpm run test:unit:compiled

echo "── test:packages ──"
pnpm run test:packages

echo "── test:pi-ai (vitest) ──"
pnpm --filter @gsd/pi-ai test

echo "── test:integration ──"
pnpm run test:integration

echo "── test:e2e ──"
chmod +x dist/loader.js
export GSD_SMOKE_BINARY="${ROOT}/dist/loader.js"
pnpm run test:e2e

echo "verify:merge: all checks passed ✓"
