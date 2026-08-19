#!/usr/bin/env bash
# Advisory decision helper for whether verify:merge is worth running locally.
# Known caveat (pre-existing in scripts/ci-classify-changes.sh, not fixed here):
# if BASE_REF/HEAD_REF don't resolve, the classifier silently falls back to
# `HEAD~1`, which can under-report a multi-commit diff. When in doubt, or on a
# shallow/unusual checkout, just run verify:merge directly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEFAULT_BASE_REF="upstream/main"
if ! git rev-parse --verify "$DEFAULT_BASE_REF" >/dev/null 2>&1; then
  DEFAULT_BASE_REF="origin/main"
fi

BASE_REF="$DEFAULT_BASE_REF"
HEAD_REF="HEAD"

while [ $# -gt 0 ]; do
  case "$1" in
    --)
      # pnpm/npm forward a literal `--` from `pnpm run ... -- --base ...`; skip it.
      shift
      ;;
    --base)
      [ $# -ge 2 ] || { echo "error: --base requires a value" >&2; exit 2; }
      BASE_REF="$2"
      shift 2
      ;;
    --head)
      [ $# -ge 2 ] || { echo "error: --head requires a value" >&2; exit 2; }
      HEAD_REF="$2"
      shift 2
      ;;
    *)
      echo "usage: bash scripts/verify-merge-needed.sh [--base <ref>] [--head <ref>]" >&2
      exit 2
      ;;
  esac
done

CLASSIFY_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/verify-merge-needed.XXXXXX")"
cleanup() {
  rm -f "$CLASSIFY_OUTPUT"
}
trap cleanup EXIT

echo "── verify:merge scope check ──"
echo "Base ref: $BASE_REF"
echo "Head ref: $HEAD_REF"

# Advisory only: classification is diff-based (committed BASE..HEAD), so it can't see
# staged/unstaged/untracked changes. Warn rather than fail closed so this stays usable
# mid-edit; commit (or stash) before trusting the recommendation for real.
if [ "$HEAD_REF" = "HEAD" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "Warning: uncommitted or untracked changes present -- this recommendation only reflects committed history ($BASE_REF..HEAD)." >&2
fi

CLASSIFY_EXIT=0
if [ "${VERIFY_MERGE_VERBOSE:-0}" = "1" ]; then
  GITHUB_OUTPUT="$CLASSIFY_OUTPUT" \
    EVENT_NAME=pull_request \
    PR_BASE_SHA="$BASE_REF" \
    HEAD_SHA="$HEAD_REF" \
    bash scripts/ci-classify-changes.sh || CLASSIFY_EXIT=$?
else
  GITHUB_OUTPUT="$CLASSIFY_OUTPUT" \
    EVENT_NAME=pull_request \
    PR_BASE_SHA="$BASE_REF" \
    HEAD_SHA="$HEAD_REF" \
    bash scripts/ci-classify-changes.sh >/dev/null 2>&1 || CLASSIFY_EXIT=$?
fi

# Fail SAFE, not closed: see the matching comment in verify-merge.sh.
if [ "$CLASSIFY_EXIT" -ne 0 ] || [ ! -s "$CLASSIFY_OUTPUT" ]; then
  echo "Warning: change classification failed (base ref '$BASE_REF' may not resolve in this checkout, e.g. a shallow clone) -- defaulting to recommending verify:merge." >&2
  HEAVY_CODE_CHANGED="true"
  PORTABILITY_CHANGED="true"
  DOCKER_CHANGED="true"
else
  HEAVY_CODE_CHANGED="$(sed -n 's/^heavy-code-changed=//p' "$CLASSIFY_OUTPUT" | tail -n 1)"
  PORTABILITY_CHANGED="$(sed -n 's/^portability-changed=//p' "$CLASSIFY_OUTPUT" | tail -n 1)"
  DOCKER_CHANGED="$(sed -n 's/^docker-changed=//p' "$CLASSIFY_OUTPUT" | tail -n 1)"
  [ -n "$HEAVY_CODE_CHANGED" ] || HEAVY_CODE_CHANGED="true"
  [ -n "$PORTABILITY_CHANGED" ] || PORTABILITY_CHANGED="true"
  [ -n "$DOCKER_CHANGED" ] || DOCKER_CHANGED="true"
fi

if [ "$HEAVY_CODE_CHANGED" = "true" ]; then
  echo "Recommendation: verify:merge is required before review for this diff."
else
  echo "Recommendation: verify:merge is not required for CI parity for this diff."
  echo "Recommended minimum: pnpm run verify:fast plus targeted checks for touched files."
fi

if [ "$PORTABILITY_CHANGED" = "true" ]; then
  echo "Additional note: portability-sensitive paths changed; expect Windows/native coverage to matter."
fi

if [ "$DOCKER_CHANGED" = "true" ]; then
  echo "Additional note: docker-sensitive paths changed; also run pnpm run test:e2e:docker before review."
fi

if [ "${VERIFY_MERGE_VERBOSE:-0}" = "1" ]; then
  echo "Verbose mode preserved the raw change classification output above."
fi
