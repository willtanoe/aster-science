#!/bin/bash
# Build the "Aster Science.app" Dock launcher.
#
# The bundle is a thin wrapper: its executable runs aster-science.sh serve in
# the foreground, so the Dock icon lives exactly as long as the daemon does.
# Ad-hoc signed; no Gatekeeper assessment because the bundle is built locally.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="Aster Science.app"
VERSION="$(bin/claude-science --version 2>/dev/null | awk '{print $2}' || true)"
VERSION="${VERSION:-0.0.0}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat >"$APP/Contents/MacOS/AsterScience" <<'LAUNCH'
#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
exec ./aster-science.sh serve "$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/AsterScience"

if [ -f assets/aster.icns ]; then
  cp assets/aster.icns "$APP/Contents/Resources/Aster.icns"
fi

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Aster Science</string>
	<key>CFBundleDisplayName</key><string>Aster Science</string>
	<key>CFBundleIdentifier</key><string>com.willtanoe.aster-science</string>
	<key>CFBundleExecutable</key><string>AsterScience</string>
	<key>CFBundleIconFile</key><string>Aster</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${VERSION}</string>
	<key>CFBundleVersion</key><string>${VERSION}</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSMicrophoneUsageDescription</key><string>Aster Science uses the microphone for voice dictation.</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1
echo "[app] wrote $APP (${VERSION})"
