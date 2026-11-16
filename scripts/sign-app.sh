#!/bin/sh
# sign-app.sh <Marigold.app>
# Signs the app (and the helpers + notifier inside it). With MARIGOLD_SIGN_IDENTITY="Developer ID Application: …"
# it signs for distribution (hardened runtime + timestamp, ready for notarization); otherwise with the
# development certificate (fine for your own Mac and for testers who clear the quarantine flag).
set -e
APP="$1"; [ -d "$APP" ] || { echo "usage: sign-app.sh <Marigold.app>"; exit 2; }
cd "$(dirname "$0")/.."
IDENT="${MARIGOLD_SIGN_IDENTITY:-Apple Development: <GitHub email> (<Apple Team ID>)}"
case "$IDENT" in
  "Developer ID Application"*)
    ENT="build/entitlements.mac.plist"
    for f in "$APP"/Contents/Resources/helpers/*; do [ -f "$f" ] && codesign --force --options runtime --timestamp -s "$IDENT" "$f"; done
    [ -d "$APP/Contents/Resources/Marigold Notifier.app" ] && codesign --force --options runtime --timestamp -s "$IDENT" "$APP/Contents/Resources/Marigold Notifier.app"
    codesign --force --deep --options runtime --timestamp --entitlements "$ENT" -s "$IDENT" "$APP"
    echo "signed for distribution: $IDENT" ;;
  *)
    codesign --force --deep --timestamp=none -s "$IDENT" "$APP"
    echo "signed with development certificate (not notarizable)" ;;
esac
codesign --verify --deep --strict "$APP" && echo "signature ok"
