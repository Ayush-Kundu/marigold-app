#!/bin/sh
# The castlabs Electron package (installed from GitHub) loses the symlinks macOS frameworks need
# (Versions/Current, and top-level links to the binary/Resources/Libraries/Helpers). Without them
# the app's signature is invalid and macOS refuses to open it. Recreate them.
#   fix-framework-links.sh <path/to/App.app> [...]
for APP in "$@"; do
  for FW in "$APP"/Contents/Frameworks/*.framework; do
    [ -d "$FW/Versions/A" ] || continue
    ( cd "$FW/Versions" && [ -L Current ] || ln -sfn A Current )
    for ENTRY in "$FW"/Versions/A/*; do
      NAME=$(basename "$ENTRY")
      [ -e "$FW/$NAME" ] || ( cd "$FW" && ln -sfn "Versions/Current/$NAME" "$NAME" )
    done
  done
done
echo "framework links ok"
