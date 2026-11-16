# Marigold website

A single static page (`index.html`) in the same style as the app. No build step, no dependencies.

## Put it online
Any static host works for free: **Cloudflare Pages**, **Netlify**, or **GitHub Pages**. Point the host at this `site/` folder, then add your domain in the host's settings.

## The download
The DMG is ~290 MB, which is too big for some hosts (Cloudflare Pages allows 25 MB per file; GitHub Pages 100 MB). Put the DMG on **GitHub Releases** (up to 2 GB) or Cloudflare R2, then paste its address into `config.js` (`dmg`).

## Updates
`sh scripts/publish-update.sh <the DMG's public address>` writes `release/latest.json` for the in-app updater. Upload it next to the DMG and put its address in `~/.marigold/update-feed.txt` (or ship it in the app).

## Before launch
- Add a privacy policy page and link it in the footer.
- Remove the "can't verify the app" FAQ once the app is notarized.
