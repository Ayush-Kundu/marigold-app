#!/bin/sh
# publish-update.sh — writes release/latest.json, the file Marigold's updater reads.
#
#   sh scripts/publish-update.sh https://example.com/downloads/Marigold-0.2.0-arm64.dmg "What's new in this version"
#
# Then upload BOTH files to any static host (GitHub Releases, S3, Cloudflare R2, your own site):
#   release/Marigold-<version>-arm64.dmg   and   release/latest.json
# and give each Marigold copy the address of latest.json, either by putting it in
#   ~/.marigold/update-feed.txt        (one line, per Mac)
# or by shipping it inside the app as Resources/update-feed.txt (add it to build-secrets/ and extraResources).
set -e
cd "$(dirname "$0")/.."
URL="$1"; NOTES="${2:-}"
[ -n "$URL" ] || { echo "usage: sh scripts/publish-update.sh <public url of the DMG> [notes]"; exit 1; }
VERSION=$(node -p "require('./package.json').version")
DMG="release/Marigold-$VERSION-arm64.dmg"
[ -f "$DMG" ] || { echo "$DMG not found. Run: sh scripts/release.sh"; exit 1; }
SUM=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
node -e 'const [v,u,s,n]=process.argv.slice(1);require("fs").writeFileSync("release/latest.json",JSON.stringify({version:v,url:u,sha256:s,notes:n},null,2)+"\n")' "$VERSION" "$URL" "$SUM" "$NOTES"
echo "Wrote release/latest.json (version $VERSION, sha256 $SUM)"
echo "Upload $DMG and release/latest.json, then point Marigold at latest.json's address."
