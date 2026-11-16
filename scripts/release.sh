#!/bin/sh
# release.sh — builds Marigold and packages it for testers: release/Marigold-<version>-arm64.dmg (+ a README for them).
#
#   sh scripts/release.sh                       → test build (development certificate; testers clear the quarantine flag once)
#   MARIGOLD_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   MARIGOLD_NOTARY_PROFILE="marigold-notary" sh scripts/release.sh
#                                               → signed + notarized + stapled: opens with a normal double-click on any Mac.
#
# One-time notarization setup (needs the Apple Developer Program, $99/yr):
#   xcrun notarytool store-credentials marigold-notary --apple-id YOU@EMAIL --team-id TEAMID --password <app-specific password>
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT="release"; STAGE="$OUT/stage"; APP="dist/mac-arm64/Marigold.app"; DMG="$OUT/Marigold-$VERSION-arm64.dmg"
rm -rf "$STAGE" dist; mkdir -p "$STAGE" "$OUT"

export NEXT_PUBLIC_MARIGOLD_CHANNEL="${MARIGOLD_CHANNEL:-tester}"   # MARIGOLD_CHANNEL=store → the public build (see src/lib/channel.ts)
export MARIGOLD_CHANNEL="${MARIGOLD_CHANNEL:-tester}"
node scripts/gen-licenses.mjs
npm run app:pack            # builds helpers + notifier, packs, VMP-signs, signs (identity from MARIGOLD_SIGN_IDENTITY)

if [ -n "$MARIGOLD_NOTARY_PROFILE" ]; then
  echo "Notarizing (takes a few minutes)…"
  ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
  xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$MARIGOLD_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$OUT/notarize.zip"
fi

cp -R "$APP" "$STAGE/Marigold.app"
ln -s /Applications "$STAGE/Applications"
if [ -z "$MARIGOLD_NOTARY_PROFILE" ]; then cp scripts/tester/READ-ME-FIRST.txt "$STAGE/READ ME FIRST.txt"; fi
rm -f "$DMG"
hdiutil create -volname "Marigold" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE" dist
echo; echo "Built $DMG ($(du -h "$DMG" | cut -f1))"
[ -n "$MARIGOLD_NOTARY_PROFILE" ] && spctl -a -t exec -vv "/Volumes/Marigold/Marigold.app" 2>/dev/null || true
