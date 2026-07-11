#!/usr/bin/env bash
set -euo pipefail

APP_NAME="GSDCloudMonitor"
DISPLAY_NAME="GSD Cloud Monitor"
BUNDLE_ID="net.opengsd.GSDCloudMonitor"
MIN_SYSTEM_VERSION="14.0"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_BINARY="$1"
APP_BUNDLE="$2"
VERSION="${3:-0.0.0}"
BUILD_NUMBER="${4:-1}"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"

if [[ "$(basename "$APP_BUNDLE")" != "$APP_NAME.app" ]]; then
  echo "stage_app_bundle: destination must be named $APP_NAME.app" >&2
  exit 2
fi
APP_PARENT_INPUT="$(dirname "$APP_BUNDLE")"
case "$APP_PARENT_INPUT" in
  "$ROOT_DIR/dist"|"$ROOT_DIR/.build"/*) ;;
  *)
    echo "stage_app_bundle: destination must be inside $ROOT_DIR/dist or $ROOT_DIR/.build" >&2
    exit 2
    ;;
esac
EXISTING_PARENT="$APP_PARENT_INPUT"
while [[ ! -d "$EXISTING_PARENT" ]]; do
  NEXT_PARENT="$(dirname "$EXISTING_PARENT")"
  if [[ "$NEXT_PARENT" == "$EXISTING_PARENT" ]]; then
    echo "stage_app_bundle: could not resolve destination parent" >&2
    exit 2
  fi
  EXISTING_PARENT="$NEXT_PARENT"
done
EXISTING_PARENT="$(cd "$EXISTING_PARENT" && pwd -P)"
case "$EXISTING_PARENT" in
  "$ROOT_DIR"|"$ROOT_DIR/dist"|"$ROOT_DIR/.build"|"$ROOT_DIR/.build"/*) ;;
  *)
    echo "stage_app_bundle: destination must be inside $ROOT_DIR/dist or $ROOT_DIR/.build" >&2
    exit 2
    ;;
esac
mkdir -p "$APP_PARENT_INPUT"
APP_PARENT="$(cd "$APP_PARENT_INPUT" && pwd -P)"
case "$APP_PARENT" in
  "$ROOT_DIR/dist"|"$ROOT_DIR/.build"/*) ;;
  *)
    echo "stage_app_bundle: destination must be inside $ROOT_DIR/dist or $ROOT_DIR/.build" >&2
    exit 2
    ;;
esac

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$SOURCE_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$DISPLAY_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$DISPLAY_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

if [[ -f "$ROOT_DIR/Resources/GSDCloudMonitor.icns" ]]; then
  cp "$ROOT_DIR/Resources/GSDCloudMonitor.icns" "$APP_RESOURCES/GSDCloudMonitor.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string GSDCloudMonitor" "$INFO_PLIST"
fi
