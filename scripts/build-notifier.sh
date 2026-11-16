#!/bin/sh
# Builds "Marigold Notifier.app" (UserNotifications helper) into build/notifier/, signed like Marigold.
set -e
cd "$(dirname "$0")/.."
OUT="build/notifier/Marigold Notifier.app"
rm -rf "$OUT"; mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O scripts/notifier/main.swift -o "$OUT/Contents/MacOS/MarigoldNotifier"
[ -f electron/assets/icon.icns ] && cp electron/assets/icon.icns "$OUT/Contents/Resources/icon.icns"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>app.marigold.notifier</string>
  <key>CFBundleName</key><string>Marigold</string>
  <key>CFBundleDisplayName</key><string>Marigold</string>
  <key>CFBundleExecutable</key><string>MarigoldNotifier</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
IDENT="${MARIGOLD_SIGN_IDENTITY:-Apple Development: <GitHub email> (<Apple Team ID>)}"
case "$IDENT" in
  "Developer ID Application"*) codesign --force --options runtime --timestamp -s "$IDENT" "$OUT" ;;
  *) codesign --force --timestamp=none -s "$IDENT" "$OUT" ;;
esac
echo "built $OUT"
