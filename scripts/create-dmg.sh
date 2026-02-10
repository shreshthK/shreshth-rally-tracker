#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/Rally Notifier.app"
OUT_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Missing app bundle: $APP_PATH"
  echo "Run: npm run tauri:build:app"
  exit 1
fi

VERSION="$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));process.stdout.write(p.version);")"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) OUT_ARCH="aarch64" ;;
  x86_64) OUT_ARCH="x64" ;;
  *) OUT_ARCH="$ARCH" ;;
esac

mkdir -p "$OUT_DIR"

TMP_DIR="$(mktemp -d /tmp/rally-notifier-dmg.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cp -R "$APP_PATH" "$TMP_DIR/"
ln -s /Applications "$TMP_DIR/Applications"

OUT_FILE="$OUT_DIR/Rally Notifier_${VERSION}_${OUT_ARCH}.dmg"
echo "Creating DMG: $OUT_FILE"
hdiutil create -volname "Rally Notifier" -srcfolder "$TMP_DIR" -ov -format UDZO "$OUT_FILE"
echo "DMG ready: $OUT_FILE"
