#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="GSDCloudMonitor"
BUNDLE_ID="net.opengsd.GSDCloudMonitor"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"

if [[ "$MODE" != "stage" ]]; then
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
fi

cd "$ROOT_DIR"
swift build --product "$APP_NAME"
BUILD_BINARY="$(swift build --show-bin-path)/$APP_NAME"

/bin/bash "$ROOT_DIR/script/stage_app_bundle.sh" "$BUILD_BINARY" "$APP_BUNDLE"

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  stage)
    ;;
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 1
    pgrep -x "$APP_NAME" >/dev/null
    ;;
  --preview|preview)
    /usr/bin/open -n "$APP_BUNDLE" --args \
      --preview-window \
      --telemetry-path "$ROOT_DIR/Fixtures/connected-telemetry.json"
    ;;
  *)
    echo "usage: $0 [run|stage|--debug|--logs|--telemetry|--verify|--preview]" >&2
    exit 2
    ;;
esac
