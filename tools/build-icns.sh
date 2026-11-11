#!/bin/bash
# Build assets/aster.icns from assets/source/aster.png for the Dock launcher.
#
# The iconset needs the exact names iconutil expects; each slot is rasterized
# from the 2048 px source so the 1024 px retina slot stays sharp.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/source/aster.png"
OUT="assets/aster.icns"

if [ ! -f "$SRC" ]; then
  echo "[icns] missing $SRC" >&2
  exit 1
fi
if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  echo "[icns] $OUT is up to date"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/Aster.iconset"
mkdir -p "$ICONSET"

emit() { # size filename
  sips -z "$1" "$1" "$SRC" --out "$ICONSET/$2" >/dev/null
}

emit 16   icon_16x16.png
emit 32   icon_16x16@2x.png
emit 32   icon_32x32.png
emit 64   icon_32x32@2x.png
emit 128  icon_128x128.png
emit 256  icon_128x128@2x.png
emit 256  icon_256x256.png
emit 512  icon_256x256@2x.png
emit 512  icon_512x512.png
emit 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT"
echo "[icns] wrote $OUT"
