#!/bin/sh
# Widevine VMP signing (castlabs EVS). Needed for Netflix-class streaming; must run BEFORE codesign.
# One-time setup: pip3 install --upgrade castlabs-evs && python3 -m castlabs_evs.account signup
if node -p "require('electron/package.json').version" | grep -q wvcus && python3 -c "import castlabs_evs" 2>/dev/null; then
  python3 -m castlabs_evs.vmp sign-pkg dist/mac-arm64 || echo "VMP signing failed (is your castlabs account set up?) — continuing unsigned"
else
  echo "VMP signing skipped (castlabs Electron or castlabs-evs not installed)"
fi
