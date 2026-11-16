#!/bin/sh
# Pre-compiles Marigold's native Swift helpers into build/helpers/ so shipped builds need no developer tools.
set -e
cd "$(dirname "$0")/.."
OUT=build/helpers
rm -rf "$OUT"; mkdir -p "$OUT"
IDENT="${MARIGOLD_SIGN_IDENTITY:-Apple Development: <GitHub email> (<Apple Team ID>)}"
for n in axapp axweb appctl windows scperm ocr eventkit brightness docread appicon; do
  swiftc -O "scripts/$n.swift" -o "$OUT/$n"
  # Signed here so every helper carries the same identity as the app (hardened + timestamped for Developer ID builds).
  case "$IDENT" in
    "Developer ID Application"*) codesign --force --options runtime --timestamp -s "$IDENT" "$OUT/$n" ;;
    *) codesign --force --timestamp=none -s "$IDENT" "$OUT/$n" ;;
  esac
done
echo "built $(ls "$OUT" | wc -l | tr -d ' ') helpers in $OUT"
