#!/usr/bin/env bash
# Local parity with CI PR merge gates (ci.yml blocking jobs when heavy-code-changed).
# See docs/dev/test-confidence-stack.md for the full tier map.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "── verify:merge (CI PR blocking parity) ──"

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
pnpm run test:unit

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
