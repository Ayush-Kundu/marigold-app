"use strict";
/**
 * Marigold's own updater (works without an Apple Developer ID, unlike Squirrel/electron-updater).
 *
 * A feed is one small JSON file somewhere on the web:
 *     { "version": "0.2.0", "url": "https://…/Marigold-0.2.0-arm64.dmg", "sha256": "<hex of the DMG>", "notes": "What's new" }
 * (scripts/publish-update.sh writes it.) The feed address comes from, in order: MARIGOLD_UPDATE_URL, ~/.marigold/update-feed.txt,
 * Resources/update-feed.txt inside the app. With none of those, updates are off and the menu says so.
 *
 * Flow: check at launch and every 6 hours → if the feed's version is newer, ask → download → verify the SHA-256 (required) →
 * mount the DMG → verify the app's signature → copy it next to the installed app → quit → a tiny script swaps it in and relaunches.
 * Nothing is installed without the user's click, and a download that doesn't match the feed's hash is thrown away.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { execFile, spawn } = require("child_process");

const LOG = path.join(os.homedir(), ".marigold", "app-server.log");
const log = (m) => { try { fs.appendFileSync(LOG, `[marigold] updater: ${m}\n`); } catch { /* no log */ } };
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 8 << 20 }, (e, out, err) => (e ? rej(new Error(String(err || e.message).slice(0, 300))) : res(String(out)))));

/** 1 if a > b, -1 if a < b, 0 if equal (dotted numbers; a trailing "-beta" sorts before the release). */
function compareVersions(a, b) {
  const parse = (v) => { const [core, pre] = String(v).replace(/^v/, "").split("-"); return { n: core.split(".").map((x) => parseInt(x, 10) || 0), pre: pre ?? "" }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) { const d = (x.n[i] ?? 0) - (y.n[i] ?? 0); if (d) return d > 0 ? 1 : -1; }
  if (x.pre === y.pre) return 0;
  return x.pre ? -1 : y.pre ? 1 : 0;
}

function feedUrl() {
  const fromFile = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
  const u = process.env.MARIGOLD_UPDATE_URL || fromFile(path.join(os.homedir(), ".marigold", "update-feed.txt")) || (process.resourcesPath ? fromFile(path.join(process.resourcesPath, "update-feed.txt")) : "");
  return /^https?:\/\//i.test(u) ? u : "";
}

function get(url, { json = false, toFile = "", onProgress, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "Marigold-Updater/1" }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), { json, toFile, onProgress, hops: hops + 1 })); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (toFile) {
        const hash = crypto.createHash("sha256"), out = fs.createWriteStream(toFile);
        const total = Number(res.headers["content-length"]) || 0; let got = 0;
        res.on("data", (c) => { hash.update(c); got += c.length; onProgress?.(got, total); });
        res.pipe(out);
        out.on("finish", () => resolve(hash.digest("hex")));
        out.on("error", reject);
      } else {
        let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(new Error("feed too large")); });
        res.on("end", () => { try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); } });
      }
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

/** The newest release in the feed if it is newer than `current`, else null. Throws if the feed is unreachable or malformed. */
async function checkFeed(url, current) {
  const f = await get(url, { json: true });
  if (!f || typeof f.version !== "string" || typeof f.url !== "string" || !/^https?:\/\//i.test(f.url)) throw new Error("the update feed is malformed");
  if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(f.sha256)) throw new Error("the update feed has no SHA-256, so it can't be verified");
  return compareVersions(f.version, current) > 0 ? f : null;
}

/** Download → verify → mount → verify signature → copy beside the installed app. Returns the staged app's path. */
async function stage(feed, appPath, { onProgress, skipSignature = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "marigold-update-"));
  const dmg = path.join(work, "update.dmg"), mnt = path.join(work, "mnt");
  fs.mkdirSync(mnt);
  try {
    const sum = await get(feed.url, { toFile: dmg, onProgress });
    if (sum.toLowerCase() !== feed.sha256.toLowerCase()) throw new Error("the download didn't match its checksum, so it was discarded");
    await run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noverify", "-mountpoint", mnt]);
    try {
      const src = path.join(mnt, "Marigold.app");
      if (!fs.existsSync(src)) throw new Error("the update didn't contain Marigold.app");
      if (!skipSignature) await run("codesign", ["--verify", "--deep", "--strict", src]);
      const staged = path.join(path.dirname(appPath), ".Marigold-update.app");
      await run("/bin/rm", ["-rf", staged]);
      await run("ditto", [src, staged]);
      await run("xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => {});
      return staged;
    } finally { await run("hdiutil", ["detach", mnt, "-force"]).catch(() => {}); }
  } finally { await run("/bin/rm", ["-rf", work]).catch(() => {}); }
}

/** After this process exits: swap the staged app in, then reopen it. Only ever touches the two paths it is given (both must be Marigold bundles). */
function swapAndRelaunch(appPath, staged, pid, { relaunch = true } = {}) {
  if (path.basename(appPath) !== "Marigold.app" || path.basename(staged) !== ".Marigold-update.app" || path.dirname(appPath) !== path.dirname(staged)) throw new Error("unexpected paths");
  const old = path.join(path.dirname(appPath), ".Marigold-old.app");
  const script = `
    for i in $(seq 1 60); do kill -0 ${Number(pid)} 2>/dev/null || break; sleep 0.5; done
    sleep 1
    rm -rf "$OLD"
    if mv "$APP" "$OLD"; then
      if mv "$NEW" "$APP"; then rm -rf "$OLD"; else mv "$OLD" "$APP"; fi
    fi
    ${relaunch ? 'open -n "$APP"' : ":"}
  `;
  spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: { ...process.env, APP: appPath, NEW: staged, OLD: old } }).unref();
}

/** Wire the updater into the app. `deps` are Electron's app/dialog/shell so this file stays testable. */
function start({ app, dialog, shell, getWindow }) {
  let busy = false, asked = "";
  const appPath = path.resolve(app.getPath("exe"), "..", "..", "..");
  const say = (opts) => dialog.showMessageBox(getWindow?.() ?? undefined, { type: "info", ...opts });

  async function check(manual) {
    if (busy) return;
    const url = feedUrl();
    if (!url) { if (manual) await say({ message: "Updates aren't set up for this copy of Marigold.", detail: "Whoever sent you Marigold can send a newer version, or add an update address to it." }); return; }
    busy = true;
    try {
      const feed = await checkFeed(url, app.getVersion());
      if (!feed) { if (manual) await say({ message: "Marigold is up to date.", detail: `You have version ${app.getVersion()}.` }); return; }
      if (!manual && asked === feed.version) return; // ask once per version per launch
      asked = feed.version;
      const r = await say({ message: `Marigold ${feed.version} is ready`, detail: `${feed.notes ? feed.notes + "\n\n" : ""}You have ${app.getVersion()}. Marigold will download it, check it, and restart itself. Your chats and settings stay.`, buttons: ["Update now", "Later"], defaultId: 0, cancelId: 1 });
      if (r.response !== 0) return;
      const win = getWindow?.();
      const staged = await stage(feed, appPath, { onProgress: (got, total) => { if (total) win?.setProgressBar?.(got / total); } });
      win?.setProgressBar?.(-1);
      swapAndRelaunch(appPath, staged, process.pid);
      log(`staged ${feed.version}, restarting`);
      app.quit();
    } catch (e) {
      log(`failed: ${e.message}`);
      getWindow?.()?.setProgressBar?.(-1);
      if (manual || busy) await say({ type: "error", message: "Couldn't update Marigold.", detail: String(e.message).slice(0, 300) }).catch(() => {});
    } finally { busy = false; }
  }

  setTimeout(() => void check(false), 40_000);
  setInterval(() => void check(false), 6 * 3600_000);
  return { check: () => check(true) };
}

module.exports = { start, compareVersions, checkFeed, stage, swapAndRelaunch, feedUrl };
