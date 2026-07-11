#!/usr/bin/env bash
set -euo pipefail

APP_NAME="GSDCloudMonitor"
DISPLAY_NAME="GSD Cloud Monitor"
MIN_SYSTEM_VERSION="14.0"
DRY_RUN=false
VERSION=""
OUTPUT_DIR=""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: $0 [--dry-run] --version <version> [--output <directory>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "package_release: --version is required" >&2
  exit 2
fi
/bin/bash "$ROOT_DIR/script/validate_release_version.sh" "$VERSION"

OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/dist/release}"
WORK_DIR="$ROOT_DIR/.build/release-package"
ARM_BUILD="$ROOT_DIR/.build/release-arm64"
INTEL_BUILD="$ROOT_DIR/.build/release-x86_64"
APP_BUNDLE="$WORK_DIR/$APP_NAME.app"
UNIVERSAL_BINARY="$WORK_DIR/$APP_NAME"
ZIP_PATH="$OUTPUT_DIR/$APP_NAME-$VERSION-macos.zip"
DMG_PATH="$OUTPUT_DIR/$APP_NAME-$VERSION-macos.dmg"
BUILD_NUMBER="${BUILD_NUMBER:-1}"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"
rm -f "$ZIP_PATH" "$DMG_PATH" "$OUTPUT_DIR/SHA256SUMS"

cd "$ROOT_DIR"
swift build \
  --configuration release \
  --product "$APP_NAME" \
  --triple "arm64-apple-macosx$MIN_SYSTEM_VERSION" \
  --scratch-path "$ARM_BUILD"
swift build \
  --configuration release \
  --product "$APP_NAME" \
  --triple "x86_64-apple-macosx$MIN_SYSTEM_VERSION" \
  --scratch-path "$INTEL_BUILD"

ARM_BINARY="$(swift build --configuration release --triple "arm64-apple-macosx$MIN_SYSTEM_VERSION" --scratch-path "$ARM_BUILD" --show-bin-path)/$APP_NAME"
INTEL_BINARY="$(swift build --configuration release --triple "x86_64-apple-macosx$MIN_SYSTEM_VERSION" --scratch-path "$INTEL_BUILD" --show-bin-path)/$APP_NAME"
/usr/bin/lipo -create "$ARM_BINARY" "$INTEL_BINARY" -output "$UNIVERSAL_BINARY"
/bin/bash "$ROOT_DIR/script/stage_app_bundle.sh" \
  "$UNIVERSAL_BINARY" "$APP_BUNDLE" "$VERSION" "$BUILD_NUMBER"

if [[ "$DRY_RUN" == true ]]; then
  /usr/bin/codesign --force --deep --options runtime --sign - "$APP_BUNDLE"
else
  if [[ -z "${DEVELOPER_ID_APPLICATION:-}" ]]; then
    echo "package_release: DEVELOPER_ID_APPLICATION is required" >&2
    exit 2
  fi
  /usr/bin/codesign \
    --force \
    --deep \
    --options runtime \
    --timestamp \
    --sign "$DEVELOPER_ID_APPLICATION" \
    "$APP_BUNDLE"

  SUBMISSION_ZIP="$WORK_DIR/notarization.zip"
  /usr/bin/ditto -c -k --keepParent "$APP_BUNDLE" "$SUBMISSION_ZIP"
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    xcrun notarytool submit "$SUBMISSION_ZIP" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
  elif [[ -n "${ASC_KEY_PATH:-}" && -n "${ASC_KEY_ID:-}" ]]; then
    NOTARY_ARGS=(--key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID")
    if [[ -n "${ASC_ISSUER_ID:-}" ]]; then
      NOTARY_ARGS+=(--issuer "$ASC_ISSUER_ID")
    fi
    xcrun notarytool submit "$SUBMISSION_ZIP" "${NOTARY_ARGS[@]}" --wait
  else
    echo "package_release: NOTARYTOOL_PROFILE or ASC_KEY_PATH/ASC_KEY_ID is required" >&2
    exit 2
  fi
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler validate "$APP_BUNDLE"
fi

/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
/usr/bin/ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"

DMG_STAGE="$WORK_DIR/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP_BUNDLE" "$DMG_STAGE/$APP_NAME.app"
ln -s /Applications "$DMG_STAGE/Applications"
/usr/bin/hdiutil create \
  -volname "$DISPLAY_NAME" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

if [[ "$DRY_RUN" == false ]]; then
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
  else
    xcrun notarytool submit "$DMG_PATH" "${NOTARY_ARGS[@]}" --wait
  fi
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

(
  cd "$OUTPUT_DIR"
  /usr/bin/shasum -a 256 "$(basename "$ZIP_PATH")" "$(basename "$DMG_PATH")" >SHA256SUMS
)

echo "package_release: created $ZIP_PATH"
echo "package_release: created $DMG_PATH"
