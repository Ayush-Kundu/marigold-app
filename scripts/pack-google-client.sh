#!/bin/sh
# Put Marigold's Google OAuth client inside the app so users never do the Google Cloud setup.
# Download the "Desktop app" client JSON from Google Cloud once and save it as
# build-secrets/google-client.json (kept out of git). Runs before codesign in app:pack.
APP="$1"
# The web-search key rides along too, so testers never see a key prompt (build-secrets/brave-key.txt: just the key).
if [ -f build-secrets/brave-key.txt ]; then
  cp build-secrets/brave-key.txt "$APP/Contents/Resources/brave-key.txt" && echo "Search key bundled"
else
  echo "No build-secrets/brave-key.txt — search shows a connect prompt until a key is added in Settings"
fi
if [ -f build-secrets/google-client.json ]; then
  cp build-secrets/google-client.json "$APP/Contents/Resources/google-client.json" && echo "Google client bundled"
else
  echo "No build-secrets/google-client.json — users will see the one-time Google setup in Settings"
fi
# Google Programmable Search (key + engine ID) powers Marigold's own results page: build-secrets/google-search.json = {"key":"…","cx":"…"}.
if [ -f build-secrets/google-search.json ]; then
  cp build-secrets/google-search.json "$APP/Contents/Resources/google-search.json" && echo "Google search key bundled"
fi
# The invite for testers: an encrypted file (AI key + settings). They type the invite code once and the AI is connected.
if [ "$MARIGOLD_CHANNEL" = "store" ]; then
  echo "Store build: no invite, no keys bundled"
elif [ -f build-secrets/invite.dat ]; then
  cp build-secrets/invite.dat "$APP/Contents/Resources/invite.dat" && echo "Invite bundled"
else
  echo "No build-secrets/invite.dat — Setup will ask for an API key instead"
fi
