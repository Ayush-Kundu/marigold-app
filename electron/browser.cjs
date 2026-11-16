// Marigold Browser — real Chromium tabs inside the Marigold app (Electron's own engine).
//
//  • Tabs are WebContentsViews placed over a "host" area the page draws (the Browser tab, or a
//    tile on the View tab), so what you see is the live page — click, type, scroll as usual.
//  • Its own profile (persist:marigold-browser): the user signs in to sites once, here.
//  • The agent drives tabs through a PRIVATE control channel (127.0.0.1, random port, secret
//    known only to this process and the engine it starts) — no network debugging port, nothing
//    any other app can attach to. Real input events (sendInputEvent / insertText), and the
//    page is never told to hide that it's being automated.

const { app, WebContentsView, BrowserWindow, session, ipcMain, dialog, shell, Menu, clipboard } = require("electron");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PARTITION = "persist:marigold-browser";
/** A new tab is Marigold's own chat space (drawn by the app page) — the web view stays blank. */
const NEWTAB = "about:blank";
const HOME = NEWTAB;
const importer = require("./import.cjs");

// ---------------------------------------------------------------- search engines (the engine's own results page, like any browser)

// Searches always go to Marigold's own results page (its own pages and design; the results come from licensed search
// APIs on the engine side). No other site's pages are embedded or imported.
// The address bar searches with the engine's own page, like any browser (the user chooses in the ⋮ menu). Startpage serves Google's results
// without tracking; Marigold's own page (free open sources) stays as an option. Marigold's Brief and assistant read whatever page is showing.
const ENGINES = {
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=%s" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  marigold: { name: "Marigold", url: `${process.env.MARIGOLD_ORIGIN || "http://localhost:3000"}/search?q=%s` },
};
// Startpage first. If an engine's page won't load on this network, the next one in this order takes over (remembered for 30 minutes).
const ENGINE_ORDER = ["startpage", "duckduckgo", "marigold"];
const engineDown = new Map();
const engineUp = (k) => k === "marigold" || (engineDown.get(k) ?? 0) < Date.now();
const pickEngine = () => ENGINE_ORDER.slice(Math.max(0, ENGINE_ORDER.indexOf(store.engine()))).find(engineUp) ?? "marigold";
const engineUrl = (k, q) => {
  let u = ENGINES[k].url.replace("%s", encodeURIComponent(q));
  if (k === "duckduckgo") { try { if (require("electron").nativeTheme.shouldUseDarkColors) u += "&kae=d"; } catch { /* no theme */ } } // DuckDuckGo's own URL setting for its dark theme
  return u;
};
const searchUrlFor = (q) => engineUrl(pickEngine(), q);

// ---------------------------------------------------------------- bookmarks + history (local file)

const DATA = path.join(os.homedir(), ".marigold", "browser-data.json");
const store = (() => {
  let d = { bookmarks: [], history: [], imported: [], signins: [], last: null };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(DATA, "utf8")) }; } catch {}
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => { try { fs.mkdirSync(path.dirname(DATA), { recursive: true, mode: 0o700 }); fs.writeFileSync(DATA, JSON.stringify(d), { mode: 0o600 }); } catch {} }, 800); };
  // Bookmarks / history / "imported from" are kept PER PROFILE (the primary uses the top level,
  // so older data keeps working); a school account's history never mixes into personal suggestions.
  const bucket = (p = currentProfile) => {
    if (!p) return d;
    d.byProfile ??= {};
    return (d.byProfile[p] ??= { bookmarks: [], history: [], imported: [], signins: [], last: null });
  };
  return {
    get: () => d,
    /** The icon each site used last time, so tabs that haven't loaded yet (restored or in the background) still show theirs. */
    favicon(host) { return (d.favicons ?? {})[host] ?? ""; },
    setFavicon(host, icon) {
      if (!host || !icon || !/^https?:|^data:image\//.test(icon) || icon.length > 4000) return;
      d.favicons ??= {};
      if (d.favicons[host] === icon) return;
      d.favicons[host] = icon;
      const keys = Object.keys(d.favicons);
      if (keys.length > 600) for (const k of keys.slice(0, keys.length - 500)) delete d.favicons[k];
      save();
    },
    p: (profile) => bucket(profile),
    addBookmarks(list, profile) { const b = bucket(profile); const have = new Set(b.bookmarks.map((x) => x.url)); b.bookmarks.push(...list.filter((x) => !have.has(x.url))); save(); },
    addHistory(list, profile) {
      const b = bucket(profile);
      const by = new Map(b.history.map((h) => [h.url, h]));
      for (const h of list) { const o = by.get(h.url); if (o) { o.visits += h.visits; o.last = Math.max(o.last, h.last); } else by.set(h.url, { ...h }); }
      b.history = [...by.values()].sort((x, y) => y.visits - x.visits).slice(0, 6000); save();
    },
    visit(url, title, profile) {
      if (!/^https?:/i.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) return; // never Marigold's own pages
      const b = bucket(profile);
      const h = b.history.find((x) => x.url === url);
      if (h) { h.visits++; h.last = Date.now(); if (title) h.title = title; } else b.history.push({ url, title: title || url, visits: 1, last: Date.now() });
      save();
    },
    engine() { return ENGINES[d.engine] ? d.engine : "startpage"; },
    setEngine(id) { if (ENGINES[id]) { d.engine = id; save(); } },
    /** Newest first; optional text filter. */
    historyList(q, profile, limit = 400) {
      const t = String(q || "").toLowerCase().trim();
      return bucket(profile).history.filter((h) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(h.url)).filter((h) => !t || h.url.toLowerCase().includes(t) || (h.title || "").toLowerCase().includes(t)).sort((a, b) => b.last - a.last).slice(0, limit);
    },
    removeHistory(profile, { url, since } = {}) {
      const b = bucket(profile);
      b.history = url ? b.history.filter((h) => h.url !== url) : since ? b.history.filter((h) => h.last < since) : [];
      save();
    },
    markImported(from, last, profile) { const b = bucket(profile); b.imported = [...new Set([...(b.imported ?? []), from])]; if (last) b.last = last; save(); },
    markSignins(from, profile) { const b = bucket(profile); b.signins = [...new Set([...(b.signins ?? []), from])]; save(); },
    setAdblock(on) { d.adblock = !!on; save(); },
    setSessions(byProfile, lastProfile) { if (byProfile) d.sessions = { ...(d.sessions ?? {}), ...byProfile }; d.lastProfile = lastProfile; save(); },
  };
})();

// The address bar asks for suggestions on every keystroke. Index the history ONCE (lowercased, newest first, capped)
// and scan it with plain loops, so typing never does heavy work in the main process.
let sugIndex = null;
function suggestIndex() {
  const p = store.p();
  const key = `${currentProfile}|${p.history.length}|${p.bookmarks.length}|${p.history[p.history.length - 1]?.last ?? 0}`;
  if (sugIndex?.key === key) return sugIndex.list;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i;
  const list = [];
  for (const b of p.bookmarks) list.push({ url: b.url, title: b.title, kind: "bookmark", visits: 50, u: b.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, ""), t: (b.title || "").toLowerCase() });
  const recent = [...p.history].sort((x, y) => y.last - x.last).slice(0, 2500);
  for (const h of recent) if (!local.test(h.url)) list.push({ url: h.url, title: h.title, kind: "history", visits: h.visits ?? 1, u: h.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, ""), t: (h.title || "").toLowerCase() });
  sugIndex = { key, list };
  return list;
}
function suggest(q) {
  const t = String(q || "").toLowerCase().trim().slice(0, 80);
  if (!t) return [];
  const best = [];
  for (const x of suggestIndex()) {
    const s = (x.u.startsWith(t) ? 100 : x.u.includes(t) ? 40 : 0) + (x.t.includes(t) ? 30 : 0);
    if (s <= 0) continue;
    best.push({ x, s });
    if (best.length > 400) break; // plenty to choose from
  }
  best.sort((a, b) => b.s - a.s || b.x.visits - a.x.visits);
  const seen = new Set(), out = [];
  for (const { x } of best) { if (seen.has(x.url)) continue; seen.add(x.url); out.push({ url: x.url, title: x.title, kind: x.kind }); if (out.length >= 6) break; }
  return out;
}
function topSites() {
  const seen = new Set();
  return store.p().history.filter((h) => { const host = (() => { try { return new URL(h.url).hostname; } catch { return ""; } })(); if (!host || seen.has(host)) return false; seen.add(host); return true; })
    .slice(0, 8).map((h) => ({ url: new URL(h.url).origin, title: (h.title || "").split(/[-|–·]/)[0].trim() || new URL(h.url).hostname }));
}
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const downloads = []; // newest first: { id, name, path, url, state, received, total, at }
const downloadItems = new Map();
let dlSeq = 1;

let getWin = () => null;   // the main window (set by init)
let ensureWin = () => null;
let nextId = 1;
/** @type {Map<number, {id:number, view: Electron.WebContentsView, agent: boolean, favicon: string, opener?: number}>} */
const tabs = new Map();
let activeId = 0;          // the tab the user sees in the Browser tab
let agentId = 0;           // the tab the agent works in
let host = null;
let fullscreenId = 0;      // a tab whose video is full screen (covers the whole window)           // { which: "active" | "agent", bounds: {x,y,width,height} } — where to show a tab
let lastDownload = "";
/** Browser profiles = the user's emails ("" = the primary). Each has its own logins (partition) and tabs. */
let currentProfile = "";
let restored = false;      // saved tabs reopened (once per launch)
const activeBy = {};       // profile → its last active tab
const sessions = new Map(); // partition → session

const OFFSCREEN = { x: -30000, y: 0 };
let lastSize = { width: 1200, height: 800 };

// ---------------------------------------------------------------- extensions (per profile)

const EXT_ROOT = path.join(os.homedir(), ".marigold", "extensions");
const extDir = (profile) => path.join(EXT_ROOT, profile ? profile.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "primary");
/** profile → id → { name, version, ok, error, popup, icon } */
const extInfo = {};
/** profile → id → how many errors its background worker has logged (0 = running clean). */
const extErrors = {};

// Safety net: if Marigold closed unexpectedly last time, start this launch WITHOUT extensions
// (a broken extension can't crash it over and over) and tell the user. Next launch loads them again.
const RUNNING = path.join(os.homedir(), ".marigold", ".browser-running");
let extSafeMode = false;
function markRunning() {
  try {
    if (fs.existsSync(RUNNING)) extSafeMode = true;
    fs.mkdirSync(path.dirname(RUNNING), { recursive: true });
    fs.writeFileSync(RUNNING, String(Date.now()));
  } catch {}
}
function markCleanExit() { try { fs.rmSync(RUNNING, { force: true }); } catch {} }

/** Load every extension imported for this profile into its session (Chromium needs this each launch). */
async function loadExtensions(profile = currentProfile) {
  if (extSafeMode) return (extInfo[profile] ??= {});
  const ses = setupSession(profile);
  const api = ses.extensions ?? ses;
  const root = extDir(profile);
  const info = (extInfo[profile] ??= {});
  if (!fs.existsSync(root)) return info;
  const loaded = new Set(api.getAllExtensions().map((e) => e.id));
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { continue; }
    const action = m.action ?? m.browser_action ?? {};
    const icons = { ...(m.icons ?? {}), ...(typeof action.default_icon === "object" ? action.default_icon : {}) };
    const iconFile = typeof action.default_icon === "string" ? action.default_icon : icons[Object.keys(icons).sort((a, b) => b - a).find((k) => Number(k) <= 48) ?? Object.keys(icons)[0]];
    let icon = "";
    try { if (iconFile) icon = `data:image/png;base64,${fs.readFileSync(path.join(dir, iconFile)).toString("base64")}`; } catch {}
    const base = { name: importer.extName(dir, m), version: m.version, popup: action.default_popup || "", icon };
    if (loaded.has(id)) { info[id] = { ...base, ok: true }; continue; }
    const log = (m) => { try { fs.appendFileSync(path.join(os.homedir(), ".marigold", "app-server.log"), `[marigold] extension ${m}\n`); } catch {} };
    try {
      const ext = await api.loadExtension(dir, { allowFileAccess: false });
      info[ext.id] = { ...base, ok: true };
      log(`loaded: ${base.name} (${profile || "primary"})`);
    } catch (e) { info[id] = { ...base, ok: false, error: String(e?.message ?? e).slice(0, 160) }; log(`failed: ${base.name}: ${info[id].error}`); }
  }
  return info;
}

/** An extension's toolbar popup, in a small window under the toolbar (like Chrome's). */
let extPopup = null;
function openExtensionPopup(id) {
  const info = extInfo[currentProfile]?.[id];
  if (!info?.popup) return false;
  const win = getWin();
  try { extPopup?.close(); } catch {}
  const b = win?.getBounds() ?? { x: 200, y: 100, width: 1200 };
  extPopup = new BrowserWindow({
    width: 380, height: 560, x: Math.round(b.x + b.width - 400), y: Math.round(b.y + 96),
    parent: win ?? undefined, frame: false, resizable: true, show: false, roundedCorners: true,
    webPreferences: { session: setupSession(currentProfile), sandbox: true, contextIsolation: true },
  });
  extPopup.loadURL(`chrome-extension://${id}/${info.popup.replace(/^\//, "")}`).catch(() => {});
  extPopup.once("ready-to-show", () => extPopup?.show());
  extPopup.on("blur", () => { try { extPopup?.close(); } catch {} });
  extPopup.on("closed", () => { extPopup = null; });
  return true;
}

// ---------------------------------------------------------------- built-in ad & tracker blocking

let blockerPromise = null;
/** Ghostery's open-source blocker with the standard ad + tracker lists (cached on disk). */
function adBlocker() {
  blockerPromise ??= (async () => {
    const { ElectronBlocker } = require("@ghostery/adblocker-electron");
    return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(os.homedir(), ".marigold", "adblock-engine.bin"),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
  })().catch((e) => { blockerPromise = null; try { fs.appendFileSync(path.join(os.homedir(), ".marigold", "app-server.log"), `[marigold] ad blocker unavailable: ${e}\n`); } catch {} return null; });
  return blockerPromise;
}
const adblockOn = () => store.get().adblock !== false;
const blocked = new Set(); // sessions the blocker is currently attached to
async function applyAdblock(ses) {
  const b = await adBlocker();
  if (!b) return false;
  if (adblockOn() && !blocked.has(ses)) { b.enableBlockingInSession(ses); blocked.add(ses); }
  if (!adblockOn() && blocked.has(ses)) { b.disableBlockingInSession(ses); blocked.delete(ses); }
  return true;
}

const partitionOf = (profile) => (profile ? `persist:mb-${profile.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : PARTITION);

/** The user's emails from Marigold's prefs → profiles (the primary keeps the original browser data). */
function profiles() {
  let emails = [];
  try { emails = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".marigold", "prefs.json"), "utf8")).emails ?? []; } catch {}
  const primary = emails.find((e) => e.primary)?.address ?? emails[0]?.address ?? "";
  return [{ key: "", email: primary }, ...emails.filter((e) => e.address && e.address !== primary).map((e) => ({ key: e.address.toLowerCase(), email: e.address }))];
}
const profileKeyFor = (email) => { const e = String(email || "").toLowerCase(); return profiles().find((p) => p.email.toLowerCase() === e)?.key ?? currentProfile; };

function setupSession(profile = currentProfile) {
  const part = partitionOf(profile);
  if (sessions.has(part)) return sessions.get(part);
  const ses = session.fromPartition(part);
  sessions.set(part, ses);
  // Fill in the Chrome extension features Electron lacks, inside each extension's background
  // worker (see ext-shim.cjs), and let that worker ask us to open a tab.
  try { ses.registerPreloadScript({ type: "service-worker", filePath: path.join(__dirname, "ext-shim.cjs"), id: "mg-ext-shim" }); } catch (e) { try { fs.appendFileSync(path.join(os.homedir(), ".marigold", "app-server.log"), `[marigold] extension shim not registered: ${e}\n`); } catch {} }
  void applyAdblock(ses);
  const hooked = new Set();
  ses.serviceWorkers.on("running-status-changed", (d) => {
    if (d.runningStatus === "stopped" || hooked.has(d.versionId)) return;
    const w = ses.serviceWorkers.getWorkerFromVersionID(d.versionId);
    if (!w) return;
    hooked.add(d.versionId);
    w.ipc.on("mg-ext-open", (_e, url) => { if (/^https?:\/\//i.test(String(url))) createTab(String(url), { profile, activate: true }); });
  });
  // Errors thrown in extension background workers → shown as "Partly working" in the Extensions menu.
  ses.serviceWorkers.on("console-message", (_e, m) => {
    const id = String(m.sourceUrl || "").match(/^chrome-extension:\/\/([a-p]{32})/)?.[1];
    if (id && m.level >= 3 && !/^\[mg-shim\]/.test(m.message || "")) { const b = (extErrors[profile] ??= {}); b[id] = (b[id] ?? 0) + 1; }
  });
  // Requests that fail because this Mac blocks the site (hosts file / site blocker) — so a page
  // that just spins can say WHY (e.g. YouTube TV needs www.youtube.com, which FocusGuard blocks).
  ses.webRequest.onErrorOccurred((d) => {
    if (!/CONNECTION_REFUSED|ADDRESS_INVALID|ADDRESS_UNREACHABLE|BLOCKED/.test(d.error)) return;
    let host = "";
    try { host = new URL(d.url).hostname; } catch { return; }
    require("dns").promises.lookup(host).then((r) => {
      if (!/^(127\.|0\.0\.0\.0|::1?$)/.test(r.address)) return;
      const t = [...tabs.values()].find((x) => x.view.webContents.id === d.webContentsId);
      if (!t) return;
      t.blocked ??= new Set();
      if (!t.blocked.has(host)) { t.blocked.add(host); push(); }
    }, () => {});
  });
  setTimeout(() => void loadExtensions(profile).catch(() => {}), 0);
  // The user agent is left exactly as Chromium reports it. Nothing is hidden from sites.
  // Site permissions (camera, location, notifications…): answered at once, never by a blocking
  // pop-up (a modal that outlives the request can crash Chromium). Unknown → "not now" + a bar
  // above the page (like Chrome); Allow there is remembered for that site/account and the page reloads.
  const MEDIA_LOG = (m) => { try { fs.appendFileSync(path.join(os.homedir(), ".marigold", "app-server.log"), `[marigold] ${m}\n`); } catch { /* no log */ } };
  // Camera/microphone work on every site, not just Meet: the question is held OPEN (the page just waits, like Chrome) and
  // answered from the bar above the page, with no reload. Pages that probe first (enumerateDevices / permissions.query)
  // are told "granted" — the real gate is still the request below.
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (["media", "audio-capture", "video-capture", "fullscreen", "clipboard-sanitized-write", "pointerLock", "speaker-selection", "mediaKeySystem"].includes(permission)) return true;
    return false;
  });
  const macAccess = macAccessGlobal;
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const once = (() => { let d = false; return (v) => { if (d) return; d = true; try { done(v); } catch { /* page gone */ } }; })();
    if (permission === "media") MEDIA_LOG(`media request: ${details.requestingUrl ?? wc.getURL()} types=${(details.mediaTypes ?? []).join(",")}`);
    if (["fullscreen", "clipboard-sanitized-write", "pointerLock", "mediaKeySystem", "speaker-selection"].includes(permission)) return once(true);
    if (!["media", "geolocation", "notifications", "midi", "clipboard-read", "display-capture"].includes(permission)) return once(false);
    const top = (() => { try { return new URL(wc.getURL()).hostname; } catch { return ""; } })();
    const site = (() => { try { return new URL(details.requestingUrl || wc.getURL()).hostname; } catch { return top; } })() || top;
    const types = (details.mediaTypes ?? []).filter((x) => x === "audio" || x === "video");
    const remembered = store.p(profile).perms?.[`${site}|${permission}`] ?? store.p(profile).perms?.[`${top}|${permission}`];
    if (remembered === true) {
      if (permission === "media") macAccess(types).finally(() => once(true)); else once(true);
      return;
    }
    // A remembered "no" is final for everything except camera/mic, which is asked again (a stuck "no" must not lock a call out).
    if (remembered === false && permission !== "media") return once(false);
    // Find the tab (a pop-up or embedded view falls back to the tab in front).
    let t = [...tabs.values()].find((x) => !x.view.webContents.isDestroyed() && (x.view.webContents.id === wc.id || x.view.webContents.id === wc.hostWebContents?.id));
    if (!t) t = tabs.get(activeId);
    if (!t || t.agent || !site) return once(false);
    // Hold the question open. A newer question on the same tab merges with it (audio + video asked separately).
    const prev = t.permAsk;
    const cbs = prev && prev.site === site && prev.permission === permission ? prev.cbs : [];
    cbs.push(once);
    const media = [...new Set([...(prev && prev.site === site ? prev.media ?? [] : []), ...types])];
    t.permAsk = { site, permission, media, cbs };
    clearTimeout(t.permTimer);
    t.permTimer = setTimeout(() => { const a = t.permAsk; if (a) { a.cbs.forEach((f) => f(false)); t.permAsk = null; push(); } }, 90000);
    push();
  });
  ses.on("will-download", (_e, item) => {
    const file = uniquePath(path.join(DOWNLOADS, item.getFilename()));
    item.setSavePath(file);
    const rec = { id: dlSeq++, name: path.basename(file), path: file, url: item.getURL(), state: "progressing", received: 0, total: item.getTotalBytes(), at: Date.now() };
    downloads.unshift(rec); downloads.length = Math.min(downloads.length, 40);
    downloadItems.set(rec.id, item);
    item.on("updated", (_ev, st) => { rec.received = item.getReceivedBytes(); rec.total = item.getTotalBytes(); rec.state = st === "interrupted" ? "interrupted" : "progressing"; push(); });
    item.once("done", (_ev, st) => { rec.received = item.getReceivedBytes(); rec.state = st; downloadItems.delete(rec.id); if (st === "completed") lastDownload = file; push(true); });
    push(true);
  });
  return ses;
}

async function macAccessGlobal(types) {
    const { systemPreferences } = require("electron");
    for (const [type, kind] of [["audio", "microphone"], ["video", "camera"]]) {
      if (types.length && !types.includes(type)) continue;
      try {
        if (systemPreferences.getMediaAccessStatus(kind) === "not-determined") await systemPreferences.askForMediaAccess(kind);
        const st = systemPreferences.getMediaAccessStatus(kind);
        try { fs.appendFileSync(path.join(os.homedir(), ".marigold", "app-server.log"), `[marigold] media allow: ${kind}=${st}\n`); } catch { /* no log */ }
        if (st === "denied" || st === "restricted") shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === "camera" ? "Camera" : "Microphone"}`);
      } catch { /* not available */ }
    }
  }

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 999; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q)) return q; }
  return p;
}

// ---------------------------------------------------------------- tabs

function createTab(url = HOME, { agent = false, activate = true, opener, profile = currentProfile, lazy = false, title = "" } = {}) {
  setupSession(profile);
  const view = new WebContentsView({
    webPreferences: { partition: partitionOf(profile), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: true },
  });
  try { view.setBorderRadius(14); } catch { /* older Electron: square corners */ }
  const id = nextId++;
  // lazy = a restored tab: shown in the strip, loads only when the user opens it.
  const tab = { id, view, agent, pinned: false, favicon: "", opener, profile, newTab: normalize(url, agent) === NEWTAB, pendingUrl: lazy && normalize(url, agent) !== NEWTAB ? normalize(url, agent) : "", savedTitle: title };
  tabs.set(id, tab);
  const wc = view.webContents;
  // Links like marigold://deepdive?q=… (from Marigold's own search page) are handed to the app instead of navigating.
  wc.on("will-navigate", (e, u) => {
    if (/^marigold:/i.test(u)) { e.preventDefault(); onAppLink(u); return; }
    const to = !tab.agent ? normalize(u) : u; // an old Marigold results page opens as a real search
    if (to !== u && /^https?:/.test(to)) { e.preventDefault(); wc.loadURL(to).catch(() => {}); }
  });
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^marigold:/i.test(u)) { onAppLink(u); return { action: "deny" }; }
    if (/^https?:/i.test(u)) createTab(u, { agent: tab.agent, activate: !tab.agent, opener: id, profile: tab.profile });
    return { action: "deny" };
  });
  wc.on("page-favicon-updated", (_e, icons) => {
    tab.favicon = icons[0] ?? "";
    try { if (tab.favicon) store.setFavicon(new URL(wc.getURL()).hostname, tab.favicon); } catch { /* no url */ }
    push();
  });
  for (const ev of ["did-start-loading", "did-stop-loading", "page-title-updated", "did-navigate-in-page"]) wc.on(ev, push);
  wc.on("did-navigate", (_e, u) => { if (u === NEWTAB) tab.newTab = true; else if (u) tab.newTab = false; tab.blocked = new Set(); if (tab.permAsk) { tab.permAsk.cbs?.forEach((f) => f(false)); tab.permAsk = null; } tab.googleSignIn = (() => { try { return new URL(u).hostname === "accounts.google.com"; } catch { return false; } })(); push(); });
  // Google sign-in is spotted the moment the page starts to load (not after it has finished), so the sign-in from Chrome can happen before the user can click anything.
  wc.on("did-start-navigation", (_e, u, _inPlace, isMainFrame) => { if (!isMainFrame) return; try { if (new URL(u).hostname === "accounts.google.com" && !tab.googleSignIn) { tab.googleSignIn = true; push(); } } catch { /* odd url */ } });
  wc.on("did-stop-loading", () => {
    const u = wc.getURL();
    if (!u || u === NEWTAB) return;
    tab.newTab = false;
    store.visit(u, wc.getTitle(), tab.profile);
    // Is this page asking the user to sign in? (password box, or a sign-in page)
    wc.executeJavaScript(`!!document.querySelector('input[type=password]') || /(^|[/.])(login|signin|sign-in|sign_in|auth|accounts?)([/.?#]|$)/i.test(location.href) || /\\b(sign|log) ?in\\b/i.test(document.title)`, false)
      .then((v) => { if (tab.loginPage !== !!v) { tab.loginPage = !!v; push(); } }, () => {});
    // Google's own sign-in (it refuses embedded apps: "Couldn't sign you in / may not be secure").
    wc.executeJavaScript(`location.hostname === 'accounts.google.com' && /sign in|couldn.t sign you in|may not be secure|choose an account/i.test(document.title + ' ' + (document.body.innerText || '').slice(0, 600))`, false)
      .then((v) => { if (!!tab.googleSignIn !== !!v) { tab.googleSignIn = !!v; push(); } }, () => {});
  });
  wc.on("before-input-event", (e, input) => {
    // ⌘L / ⌘T / ⌘W / ⌘[ ⌘] inside a page → browser shortcuts.
    // ⌘⇧D (dictate) while a web page has focus: the Marigold window does the listening.
    if (input.type === "keyDown" && input.meta && input.shift && !input.alt && !input.control && input.key.toLowerCase() === "d") { e.preventDefault(); getWin()?.webContents.send("dictate-toggle"); return; }
    if (input.type === "keyDown" && input.meta && input.shift && !input.alt && !input.control && input.key.toLowerCase() === "v") { e.preventDefault(); getWin()?.webContents.send("converse-toggle"); return; }
    if (tabKey(input)) { e.preventDefault(); return; }
    if (input.type === "keyDown" && input.key === "Escape" && !input.meta && !input.control && !input.alt && wc.isLoading()) wc.stop(); // Esc stops loading, like Chrome
    if (input.type !== "keyDown" || !input.meta) return;
    const k = input.key.toLowerCase();
    if (k === "t") { e.preventDefault(); createTab(HOME, { profile: tab.profile }); }
    else if (k === "w") { e.preventDefault(); closeTab(id); }
    else if (k === "l") { e.preventDefault(); getWin()?.webContents.send("browser-focus-omnibox"); }
    else if (k === "[") { e.preventDefault(); if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
    else if (k === "]") { e.preventDefault(); if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
    else if (k === "r") { e.preventDefault(); wc.reload(); }
    else if (k === "f") { e.preventDefault(); getWin()?.webContents.send("browser-find-open"); }
    else if (k === "p") { e.preventDefault(); wc.print(); }
    else if (k === "=" || k === "+") { e.preventDefault(); wc.setZoomLevel(Math.min(5, wc.getZoomLevel() + 0.5)); }
    else if (k === "-") { e.preventDefault(); wc.setZoomLevel(Math.max(-5, wc.getZoomLevel() - 0.5)); }
    else if (k === "0") { e.preventDefault(); wc.setZoomLevel(0); }
  });
  // Speaker icon on tabs that are playing sound (click it to mute).
  wc.on("audio-state-changed", (e) => { tab.audible = !!e.audible; push(); });
  // Right-click menu, like any browser.
  wc.on("context-menu", (_e, p) => {
    const T = [];
    const open = (u) => createTab(u, { profile: tab.profile, activate: true });
    if (p.linkURL) T.push({ label: "Open link in new tab", click: () => open(p.linkURL) }, { label: "Copy link address", click: () => clipboard.writeText(p.linkURL) }, { type: "separator" });
    if (p.mediaType === "image" && p.srcURL) T.push({ label: "Open image in new tab", click: () => open(p.srcURL) }, { label: "Copy image address", click: () => clipboard.writeText(p.srcURL) }, { label: "Save image…", click: () => wc.downloadURL(p.srcURL) }, { type: "separator" });
    if (p.isEditable) T.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { role: "selectAll" }, { type: "separator" });
    else if (p.selectionText) {
      const q = p.selectionText.trim().slice(0, 80);
      const shown = q.length > 30 ? q.slice(0, 30) + "…" : q;
      const askAbout = (text) => { const w = getWin(); if (w) w.webContents.send("ask-tab", text, false); };
      T.push({ role: "copy" },
        { label: `Ask Marigold about “${shown}”`, click: () => askAbout(`Explain this from the page I'm on, in plain words, and say what matters about it: “${p.selectionText.trim().slice(0, 1200)}”`) },
        { label: `Search ${ENGINES[pickEngine()].name} for “${shown}”`, click: () => open(normalize(q)) }, { type: "separator" });
    }
    if (!p.selectionText && !p.isEditable && !p.linkURL) T.push({ label: "Ask Marigold about this page", click: () => { const w = getWin(); if (w) w.webContents.send("ask-tab", "Summarize this page for me and tell me what I should do or know.", false); } }, { type: "separator" });
    T.push(
      { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: "Reload", click: () => wc.reload() },
      { type: "separator" },
      { label: "Print…", click: () => wc.print() },
      { label: "Inspect", click: () => wc.inspectElement(p.x, p.y) },
    );
    const win = getWin();
    if (win) Menu.buildFromTemplate(T).popup({ window: win });
  });
  wc.on("found-in-page", (_e, r) => { const win = getWin(); if (win && id === activeId) win.webContents.send("browser-find-result", { active: r.activeMatchOrdinal, total: r.matches }); });
  wc.on("render-process-gone", () => push());
  // Video full screen (YouTube's button, double-click): fill the whole screen, like Chrome.
  wc.on("enter-html-full-screen", () => {
    const win = getWin();
    if (!win) return;
    fullscreenId = id;
    tab.wasWindowFull = win.isFullScreen();
    if (!tab.wasWindowFull) win.setFullScreen(true);
    layout();
    setTimeout(layout, 700); // after macOS's full-screen animation
  });
  wc.on("leave-html-full-screen", () => {
    const win = getWin();
    if (fullscreenId === id) fullscreenId = 0;
    if (win && !tab.wasWindowFull && win.isFullScreen()) win.setFullScreen(false);
    layout();
    setTimeout(layout, 700);
  });
  // A page that can't load → say why (a blank tab looks like it's still loading).
  wc.on("did-fail-load", async (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted (user navigated on) */ || !/^https?:/.test(failedUrl)) return;
    const host = (() => { try { return new URL(failedUrl).hostname; } catch { return failedUrl; } })();
    // The search engine itself won't load here (a network filter, a bad certificate…): search with the next engine instead, and keep using it.
    {
      const ENGINE_HOSTS = { startpage: /(^|\.)startpage\.com$/, duckduckgo: /(^|\.)duckduckgo\.com$/ };
      const failed = Object.keys(ENGINE_HOSTS).find((k) => ENGINE_HOSTS[k].test(host));
      const q = (() => { try { const u = new URL(failedUrl); return u.searchParams.get("q") || u.searchParams.get("query") || ""; } catch { return ""; } })();
      if (failed && q && /CERT|SSL|NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT|BLOCKED|ACCESS_DENIED/.test(desc)) {
        engineDown.set(failed, Date.now() + 30 * 60_000); // skip a blocked engine for a while
        const to = ENGINE_ORDER.slice(ENGINE_ORDER.indexOf(failed) + 1).find(engineUp) ?? "marigold"; // Startpage → DuckDuckGo → Marigold's own page
        push(true);
        wc.loadURL(engineUrl(to, q)).catch(() => {});
        return;
      }
    }
    // A site that points at this Mac itself = blocked by the hosts file or a site blocker.
    const local = /CONNECTION_REFUSED/.test(desc) && await require("dns").promises.lookup(host).then((r) => /^(127\.|::1$|0\.0\.0\.0)/.test(r.address), () => false);
    const why = local ? "It's blocked on this Mac (by a site blocker or the hosts file), so no browser can open it."
      : /NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED/.test(desc) ? "Check your internet connection, or the address."
      : /BLOCKED|FILTER|ACCESS_DENIED/.test(desc) ? "It may be blocked by Screen Time or another content filter on this Mac."
      : /CERT|SSL/.test(desc) ? "Its security certificate isn't valid, so Marigold didn't open it."
      : /TIMED_OUT|CONNECTION/.test(desc) ? "The site didn't answer. Try again in a moment." : "";
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const html = `<!doctype html><meta charset=utf-8><title>${esc(host)} didn't load</title><body style="font:15px -apple-system,system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px"><h2 style="font-weight:600;margin:0 0 8px">${esc(host)} didn't load</h2><p style="color:#999;margin:0 0 6px">${esc(why || "Something went wrong opening this page.")}</p><p style="color:#666;font-size:12px">${esc(desc)}</p><button onclick="location.href=${esc(JSON.stringify(failedUrl))}" style="margin-top:12px;padding:7px 14px;border-radius:8px;border:0;background:#e8a317;font-weight:600">Try again</button></div>`;
    wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  });
  attach(tab);
  if (!tab.pendingUrl) wc.loadURL(normalize(url, agent)).catch(() => {});
  if (agent) agentId = id;
  if (activate && profile === currentProfile) activeId = id;
  layout();
  push(true);
  // A new blank tab puts the cursor in the address bar, like Chrome.
  if (tab.newTab && activate && !agent && profile === currentProfile) setTimeout(() => getWin()?.webContents.send("browser-focus-omnibox"), 120);
  return tab;
}

let browserShown = false; // the Browser tab is on screen (even while a menu has the page stepped aside)
const wiredWins = new WeakSet();
function wireWindow(win) {
  if (wiredWins.has(win)) return;
  wiredWins.add(win);
  win.webContents.on("before-input-event", (e, input) => {
    if (!browserShown) return; // only while the Browser tab is showing
    if (tabKey(input)) { e.preventDefault(); return; }
    if (input.type === "keyDown" && input.meta && !input.alt && !input.control) {
      const k = input.key.toLowerCase();
      if (k === "=" || k === "+" || k === "-" || k === "0") {
        e.preventDefault();
        const wc = tabs.get(activeId)?.view.webContents;
        if (wc) wc.setZoomLevel(k === "0" ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + (k === "-" ? -0.5 : 0.5))));
        return;
      }
    }
    if (input.type === "keyDown" && input.meta && !input.shift && !input.alt && !input.control) {
      const k = input.key.toLowerCase();
      if (k === "t") { e.preventDefault(); createTab(HOME, { profile: currentProfile }); }
      else if (k === "w") { e.preventDefault(); closeTab(activeId); }
    }
  });
  // Two-finger swipe = back / forward, like Chrome on a trackpad.
  win.on("swipe", (_e, dir) => {
    const t = tabs.get(activeId);
    if (!t || !browserShown) return;
    const h = t.view.webContents.navigationHistory;
    if (dir === "left" && h.canGoBack()) h.goBack();
    else if (dir === "right" && h.canGoForward()) h.goForward();
  });
}

function attach(tab) {
  const win = ensureWin();
  if (!win) return;
  wireWindow(win);
  if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
}

/**
 * A site asks for an HTTP username and password (router, school or work page). The page's own
 * sign-in bar appears above it and the user types it themselves; it goes to that request only and
 * is never saved by Marigold.
 */
const authWaiting = new Map(); // tab id → { id, host, realm, proxy, callback }
app.on("login", (event, wcontents, details, authInfo, callback) => {
  const tab = [...tabs.values()].find((t) => t.view.webContents === wcontents);
  if (!tab) return; // not one of ours → default (cancel)
  event.preventDefault();
  tab.authAsk?.callback();
  tab.authAsk = { id: `${tab.id}-${Date.now()}`, host: authInfo.host, realm: authInfo.realm || "", proxy: !!authInfo.isProxy, callback };
  push();
});
function answerAuth(id, user, pass) {
  for (const t of tabs.values()) if (t.authAsk?.id === id) { const cb = t.authAsk.callback; t.authAsk = null; if (user == null) cb(); else cb(String(user), String(pass ?? "")); push(); return true; }
  return false;
}

/** Recently closed tabs (⌘⇧T brings the last one back). */
const closedStack = [];
const stripTabs = () => [...tabs.values()].filter((x) => x.profile === currentProfile);

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const list = stripTabs();
  const at = list.indexOf(t);
  const url = t.pendingUrl || t.view.webContents.getURL();
  if (!t.agent && /^https?:/.test(url)) { closedStack.push({ url, profile: t.profile }); if (closedStack.length > 15) closedStack.shift(); }
  t.authAsk?.callback(); t.authAsk = null;
  tabs.delete(id);
  try { getWin()?.contentView.removeChildView(t.view); } catch {}
  try { t.view.webContents.close(); } catch {}
  if (agentId === id) agentId = 0;
  if (activeId === id) {
    // Like Chrome: the tab you came from, else the one that slid into its place, else the one before.
    const rest = list.filter((x) => x !== t);
    const next = (t.opener && tabs.get(t.opener) && tabs.get(t.opener).profile === currentProfile ? tabs.get(t.opener) : null) ?? rest[at] ?? rest[at - 1] ?? rest.at(-1);
    activeId = next?.id ?? 0;
  }
  layout();
  push(true);
}

function reopenClosedTab() {
  const c = closedStack.pop();
  if (!c) return false;
  if (c.profile !== currentProfile) { closedStack.push(c); return false; }
  createTab(c.url, { profile: c.profile });
  return true;
}

/** Move a tab to a new position in the strip (drag to reorder). */
function moveTab(id, toIndex) {
  const list = stripTabs();
  const t = list.find((x) => x.id === id);
  if (!t) return;
  list.splice(list.indexOf(t), 1);
  const pins = list.filter((x) => x.pinned).length;
  const lo = t.pinned ? 0 : pins, hi = t.pinned ? pins : list.length; // pinned tabs stay left of the others
  list.splice(Math.max(lo, Math.min(hi, toIndex)), 0, t);
  const others = [...tabs.values()].filter((x) => x.profile !== currentProfile);
  tabs.clear();
  for (const x of [...others, ...list]) tabs.set(x.id, x);
  push(true);
}

const pinnedCount = () => stripTabs().filter((x) => x.pinned).length;
function pinTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.pinned = !t.pinned;
  moveTab(id, t.pinned ? pinnedCount() - 1 : pinnedCount()); // pinned tabs live at the left
}
function duplicateTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const u = t.pendingUrl || t.view.webContents.getURL();
  const n = createTab(u && /^https?:/.test(u) ? u : HOME, { profile: t.profile });
  moveTab(n.id, stripTabs().indexOf(t) + 1);
}
function newTabRight(id) {
  const t = tabs.get(id);
  const n = createTab(HOME, { profile: currentProfile });
  if (t) moveTab(n.id, stripTabs().indexOf(t) + 1);
}
function closeOthers(id) { for (const x of stripTabs()) if (x.id !== id && !x.pinned && !x.agent) closeTab(x.id); }
function closeRight(id) {
  const list = stripTabs(); const i = list.findIndex((x) => x.id === id);
  for (const x of list.slice(i + 1)) if (!x.pinned && !x.agent) closeTab(x.id);
}
function toggleBookmarkActive() {
  const t = tabs.get(activeId);
  if (!t || t.newTab) return;
  const url = t.view.webContents.getURL(), title = t.view.webContents.getTitle();
  const b = store.p(); const i = b.bookmarks.findIndex((x) => x.url === url);
  if (i >= 0) b.bookmarks.splice(i, 1); else b.bookmarks.push({ url, title: title || url, folder: "Bookmarks Bar" });
  store.addBookmarks([], currentProfile); // persists
  getWin()?.webContents.send("browser-bookmarks-changed");
}
function tabMenu(id) {
  const t = tabs.get(id); const win = getWin();
  if (!t || !win) return;
  const wc = t.view.webContents;
  Menu.buildFromTemplate([
    { label: "New tab to the right", click: () => newTabRight(id) },
    { type: "separator" },
    { label: "Reload", enabled: !t.newTab, click: () => wc.reload() },
    { label: "Duplicate", enabled: !t.newTab, click: () => duplicateTab(id) },
    { label: t.pinned ? "Unpin tab" : "Pin tab", click: () => pinTab(id) },
    { label: wc.isAudioMuted() ? "Unmute site" : "Mute site", enabled: !t.newTab, click: () => { t.muted = !t.muted; wc.setAudioMuted(t.muted); push(true); } },
    { type: "separator" },
    { label: "Close", click: () => closeTab(id) },
    { label: "Close other tabs", click: () => closeOthers(id) },
    { label: "Close tabs to the right", click: () => closeRight(id) },
    { type: "separator" },
    { label: "Reopen closed tab", enabled: closedStack.length > 0, accelerator: "Cmd+Shift+T", click: () => reopenClosedTab() },
  ]).popup({ window: win });
}

function stepTab(delta) {
  const list = stripTabs();
  if (list.length < 2) return;
  const i = list.findIndex((x) => x.id === activeId);
  activeId = list[(i + delta + list.length) % list.length].id;
  layout(); push(true);
}
function tabNumber(n) {
  const list = stripTabs();
  const t = n >= 9 ? list.at(-1) : list[n - 1];
  if (t) { activeId = t.id; layout(); push(true); }
}

let lastFind = "";
/** ⌘S: save the page (complete, with its files) where the user chooses. */
async function savePageAs(wc) {
  try {
    const name = (wc.getTitle() || "page").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "page";
    const r = await dialog.showSaveDialog(getWin() ?? undefined, { defaultPath: path.join(app.getPath("downloads"), `${name}.html`), filters: [{ name: "Web page", extensions: ["html"] }] });
    if (!r.canceled && r.filePath) await wc.savePage(r.filePath, "HTMLComplete");
  } catch {}
}

/** Browser keyboard shortcuts shared by the page and the app window. Returns true when handled. */
function tabKey(input) {
  if (input.type !== "keyDown") return false;
  const k = input.key;
  const lower = k.toLowerCase();
  if (input.control && !input.meta && k === "Tab") { stepTab(input.shift ? -1 : 1); return true; }
  if (!input.meta) return false;
  if (lower === "t" && input.shift) { reopenClosedTab(); return true; }
  if (lower === "a" && input.shift && !input.alt) { getWin()?.webContents.send("browser-open-panel", "tab-search"); return true; } // ⇧⌘A search open tabs
  const act = tabs.get(activeId);
  const awc = act?.view.webContents;
  // Chrome's other Mac shortcuts.
  if (lower === "r" && input.shift && !input.alt) { awc?.reloadIgnoringCache(); return true; }            // ⇧⌘R hard reload
  if (lower === "g" && !input.alt) {                                                                       // ⌘G / ⇧⌘G next / previous match
    if (awc && lastFind) { awc.findInPage(lastFind, { forward: !input.shift, findNext: true }); getWin()?.webContents.send("browser-find-open"); }
    else getWin()?.webContents.send("browser-find-open");
    return true;
  }
  if (lower === "u" && !input.shift && !input.alt) {                                                       // ⌘U view source
    const u = awc?.getURL();
    if (u && /^https?:/.test(u)) createTab(`view-source:${u}`, { profile: act.profile });
    return true;
  }
  if (input.alt && !input.shift && (input.code === "KeyJ" || input.code === "KeyC")) { if (awc) awc.isDevToolsOpened() ? awc.closeDevTools() : awc.openDevTools({ mode: "detach" }); return true; } // ⌥⌘J / ⌥⌘C
  if (input.shift && (k === "Backspace" || k === "Delete")) { getWin()?.webContents.send("browser-open-panel", "clear"); return true; } // ⇧⌘⌫ clear browsing data
  if (lower === "b" && input.shift && !input.alt) { getWin()?.webContents.send("browser-open-panel", "bookmarks-bar"); return true; }   // ⇧⌘B bookmarks bar
  if (lower === "s" && !input.shift && !input.alt) { if (awc && act && !act.newTab) void savePageAs(awc); return true; }                  // ⌘S save page
  if (k === "." && !input.shift && !input.alt) { awc?.stop(); return true; }                              // ⌘. stop loading
  if (lower === "y" && !input.shift && !input.alt) { getWin()?.webContents.send("browser-open-panel", "history"); return true; }
  if (lower === "j" && input.shift && !input.alt) { getWin()?.webContents.send("browser-open-panel", "downloads"); return true; }
  if (lower === "d" && !input.shift && !input.alt) { toggleBookmarkActive(); return true; }
  if (input.alt && (lower === "i" || k === "ˆ")) { const wc = tabs.get(activeId)?.view.webContents; if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" }); return true; }
  if (/^[1-9]$/.test(k) && !input.shift && !input.alt) { tabNumber(Number(k)); return true; }
  if (input.alt && (k === "ArrowRight" || k === "ArrowLeft")) { stepTab(k === "ArrowRight" ? 1 : -1); return true; }
  if (input.shift && (k === "}" || k === "{" || k === "]" || k === "[")) { stepTab(k === "}" || k === "]" ? 1 : -1); return true; }
  return false;
}

function normalize(input, keepMarigoldSearch = false) {
  const s = String(input || "").trim();
  if (!s || s === NEWTAB) return NEWTAB;
  if (/^view-source:https?:/i.test(s)) return s;
  if (/^(https?|about|file|chrome):/i.test(s)) {
    if (/^(file|chrome):/i.test(s)) return HOME;
    return s;
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) || /^localhost(:\d+)?(\/|$)/.test(s)) return `https://${s}`;
  // Anything else is a search on Marigold's own results page.
  return searchUrlFor(s);
}

/** Put the hosted tab over the host area; everything else off-screen (still alive, still sized). */
function layout() {
  const win = getWin();
  if (!win) return;
  const shownId = host ? (host.which === "agent" ? (agentId || activeId) : activeId) : 0;
  const full = tabs.get(fullscreenId);
  if (full) {
    const [w, h] = win.getContentSize();
    for (const t of tabs.values()) { attach(t); if (t !== full) t.view.setBounds({ ...OFFSCREEN, ...lastSize }); }
    // On top of everything else in the window.
    try { win.contentView.removeChildView(full.view); win.contentView.addChildView(full.view); } catch {}
    full.view.setBounds({ x: 0, y: 0, width: w, height: h });
    return;
  }
  for (const t of tabs.values()) {
    attach(t);
    if (t.id === shownId && host?.bounds?.width > 10) {
      if (t.pendingUrl) { const u = t.pendingUrl; t.pendingUrl = ""; t.view.webContents.loadURL(u).catch(() => {}); }
      // The page reports its area in the window's zoomed CSS pixels; native views are placed in real points.
      const z = win.webContents.getZoomFactor() || 1;
      const b = { x: Math.round(host.bounds.x * z), y: Math.round(host.bounds.y * z), width: Math.round(host.bounds.width * z), height: Math.round(host.bounds.height * z) };
      lastSize = { width: b.width, height: b.height };
      t.view.setBounds(b);
      t.view.setVisible(true);
    } else {
      t.view.setBounds({ ...OFFSCREEN, ...lastSize });
    }
  }
}

function info(t) {
  const wc = t.view.webContents;
  return {
    id: t.id, pinned: !!t.pinned, title: t.pendingUrl ? t.savedTitle || t.pendingUrl : wc.getTitle() || wc.getURL() || "New tab", url: t.pendingUrl || wc.getURL(), favicon: t.favicon || (() => { try { return store.favicon(new URL(t.pendingUrl || wc.getURL()).hostname); } catch { return ""; } })(), loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), agent: t.id === agentId,
    newTab: !!t.newTab, loginPage: !!t.loginPage, blocked: [...(t.blocked ?? [])], permAsk: t.permAsk ? { site: t.permAsk.site, permission: t.permAsk.permission, media: t.permAsk.media } : null, googleSignIn: !!t.googleSignIn, audible: !!t.audible, muted: !!t.muted, authAsk: t.authAsk ? { id: t.authAsk.id, host: t.authAsk.host, realm: t.authAsk.realm, proxy: t.authAsk.proxy } : null,
  };
}
function state() {
  const list = [...tabs.values()].filter((t) => t.profile === currentProfile);
  return { downloads: downloads.slice(0, 20), engine: pickEngine(), tabs: list.map(info), activeId, agentId: list.some((t) => t.id === agentId) ? agentId : 0, lastDownload, profile: currentProfile, profiles: profiles() };
}

// ---------------------------------------------------------------- saved tabs (per profile)

/** Remember each profile's open tabs, so they come back next time. */
let saveTimer = null;
function saveTabs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const byProfile = {};
    for (const t of tabs.values()) {
      if (t.agent) continue;
      const u = t.pendingUrl || t.view.webContents.getURL();
      if (!u || !/^https?:/.test(u)) continue;
      (byProfile[t.profile] ??= { tabs: [], active: 0 }).tabs.push({ url: u, title: t.pendingUrl ? t.savedTitle : t.view.webContents.getTitle(), pinned: !!t.pinned });
      if (t.id === (t.profile === currentProfile ? activeId : activeBy[t.profile])) byProfile[t.profile].active = byProfile[t.profile].tabs.length - 1;
    }
    store.setSessions(byProfile, currentProfile);
  }, 1500);
}

/** Open a profile's saved tabs (lazily) — or a new tab if it has none. */
function restoreProfile(profile) {
  const saved = store.get().sessions?.[profile];
  if (saved?.tabs?.length) {
    const made = saved.tabs.slice(0, 30).map((x) => { const t = createTab(x.url, { profile, activate: false, lazy: true, title: x.title }); t.pinned = !!x.pinned; return t; });
    const act = made[Math.min(saved.active ?? 0, made.length - 1)];
    if (profile === currentProfile) activeId = act.id; else activeBy[profile] = act.id;
  } else createTab(HOME, { profile });
}

/**
 * Switch email. The page you're on comes with you: it opens straight away with the new
 * account's cookies and storage (each account's data lives in its own partition, and a page
 * can't change partitions while open — so it's a tab in that account's storage, no reload needed).
 */
function switchProfile(profile, carry = false) {
  if (profile === currentProfile) return;
  const from = tabs.get(activeId);
  const carryUrl = carry && from && !from.newTab ? (from.pendingUrl || from.view.webContents.getURL()) : "";
  activeBy[currentProfile] = activeId;
  currentProfile = profile;
  const mine = [...tabs.values()].filter((t) => t.profile === profile && !t.agent);
  if (!mine.length) restoreProfile(profile);
  else activeId = activeBy[profile] && tabs.has(activeBy[profile]) ? activeBy[profile] : mine.at(-1).id;
  if (/^https?:/.test(carryUrl)) {
    const same = (u) => { try { return new URL(u).origin === new URL(carryUrl).origin; } catch { return false; } };
    const all = [...tabs.values()].filter((t) => t.profile === profile && !t.agent);
    const exact = all.find((t) => (t.pendingUrl || t.view.webContents.getURL()) === carryUrl);
    const sameSite = exact ?? all.find((t) => same(t.pendingUrl || t.view.webContents.getURL()));
    if (sameSite) {
      activeId = sameSite.id;
      // Same site but a different page → go to the page you were on (this account's version of it).
      if (!exact) { sameSite.pendingUrl = ""; sameSite.view.webContents.loadURL(carryUrl).catch(() => {}); }
    } else {
      // Replace an empty new tab if that's all there is; otherwise open a tab for it.
      const blank = all.length === 1 && all[0].newTab ? all[0] : null;
      if (blank) { blank.newTab = false; blank.view.webContents.loadURL(carryUrl).catch(() => {}); activeId = blank.id; }
      else createTab(carryUrl, { profile, activate: true });
    }
  }
  store.setSessions(null, currentProfile);
  layout();
  push();
}
let pushTimer = null;
function flush() {
  clearTimeout(pushTimer); pushTimer = null;
  const win = getWin();
  if (win && !win.isDestroyed()) win.webContents.send("browser-state", state());
}
/** Loading chatter is batched (60 ms); anything about the tabs themselves (open / close / switch) goes out at once. */
function push(now = false) {
  saveTabs();
  if (now) { flush(); return; }
  if (pushTimer) return;
  pushTimer = setTimeout(flush, 60);
}

// ---------------------------------------------------------------- renderer (the Browser tab UI)

function registerIpc() {
  ipcMain.handle("browser:state", () => {
    if (!restored) { restored = true; currentProfile = store.get().lastProfile ?? ""; if (!profiles().some((p) => p.key === currentProfile)) currentProfile = ""; restoreProfile(currentProfile); }
    return state();
  });
  ipcMain.handle("browser:profile", (_e, key, carry) => { switchProfile(String(key ?? ""), carry === true); return state(); });
  ipcMain.handle("browser:host", (_e, h) => { host = h && h.bounds ? h : null; layout(); });
  // A still picture of the user's tab (works while it's off-screen too).
  // A picture of a tab (default: the one showing), shrunk to a size a vision model reads well. Marigold's assistant sends it with questions.
  // A video call's live captions, as the page shows them (the way Gemini takes notes: no audio needed). Fixed script, nothing else runs in the page.
  const CAPTION_SCRIPT = `(() => {
    const sels = ['[role="region"][aria-label*="aption" i]', '[aria-label="Captions"]', '[data-tid="closed-caption-renderer-wrapper"]', '.live-transcription-subtitle__box', '#live-transcription-subtitle', '[class*="aption" i][class*="ontainer" i]', '[data-test*="caption" i]', '[data-testid*="caption" i]', '[class*="closed-caption" i]', '[class*="ClosedCaption" i]', '[class*="transcript" i][class*="live" i]', '[aria-live][class*="subtitle" i]'];
    for (const sel of sels) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim()) return { found: true, text: el.innerText }; }
    return { found: !!document.querySelector(sels.join(",")), text: "" };
  })()`;
  ipcMain.handle("browser:captions", async (_e, id) => {
    const t = tabs.get(id ?? activeId);
    if (!t || t.view.webContents.isDestroyed()) return null;
    try { return await t.view.webContents.executeJavaScript(CAPTION_SCRIPT, true); } catch { return null; }
  });
  // Google Meet turns captions on with the C key (when the call page has focus).
  // Turn a call's live captions on, whatever the call service: Meet has a key (C), Teams has a shortcut, Zoom and Webex have a
  // Captions button. The page script only looks for a button or menu item that says "captions" and clicks it; nothing else.
  const CAPTION_CLICK = `(() => {
    const txt = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '') + ' ' + (el.title || '')).trim();
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = () => [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], li[role], a[role="menuitem"]')].filter(vis);
    const on = all().find((el) => /(show|turn on|enable|start).{0,20}(captions?|subtitles?|closed caption)|^\s*(closed )?captions?\s*$|^\s*cc\s*$/i.test(txt(el)) && !/(hide|turn off|disable|stop)/i.test(txt(el)));
    if (on) { on.click(); return 'clicked'; }
    const more = all().find((el) => /^\s*(more|more actions|more options|\.\.\.|…)\s*$/i.test(txt(el)) || /more (actions|options)/i.test(txt(el)));
    if (more) { more.click(); return 'more'; }
    return 'none';
  })()`;
  ipcMain.handle("browser:captions-on", async (_e, id) => {
    const t = tabs.get(id ?? activeId);
    if (!t || t.view.webContents.isDestroyed()) return false;
    let host = ""; try { host = new URL(t.view.webContents.getURL()).hostname.replace(/^www\./, ""); } catch { /* no url */ }
    const wc = t.view.webContents;
    const key = (k, mods) => { wc.focus(); wc.sendInputEvent({ type: "keyDown", keyCode: k, modifiers: mods }); wc.sendInputEvent({ type: "char", keyCode: k, modifiers: mods }); wc.sendInputEvent({ type: "keyUp", keyCode: k, modifiers: mods }); };
    try {
      const already = await wc.executeJavaScript(CAPTION_SCRIPT, true);
      if (already?.found) return true;
      if (host === "meet.google.com") { key("c", []); return true; }
      if (host === "teams.microsoft.com" || host === "teams.live.com") { key("u", ["meta", "shift"]); return true; }
      if (/(^|\.)(zoom\.us|zoom\.com|webex\.com)$/.test(host)) {
        // The button may sit behind a "More" menu: look, open the menu if needed, look again.
        let r = await wc.executeJavaScript(CAPTION_CLICK, true);
        if (r === "more") { await new Promise((x) => setTimeout(x, 450)); r = await wc.executeJavaScript(CAPTION_CLICK, true); }
        return r === "clicked";
      }
      return false;
    } catch { return false; }
  });
  ipcMain.handle("browser:page-shot", async (_e, id) => {
    const t = tabs.get(id ?? activeId);
    if (!t || t.newTab || t.view.webContents.isDestroyed()) return "";
    try {
      let img = await t.view.webContents.capturePage();
      if (img.isEmpty()) return "";
      if (img.getSize().width > 1400) img = img.resize({ width: 1400, quality: "good" });
      return `data:image/jpeg;base64,${img.toJPEG(74).toString("base64")}`;
    } catch { return ""; }
  });
  ipcMain.handle("browser:snapshot", async () => {
    const t = tabs.get(activeId);
    if (!t || t.newTab) return "";
    try { const p = await t.view.webContents.capturePage(); return p.isEmpty() ? "" : `data:image/jpeg;base64,${p.toJPEG(80).toString("base64")}`; } catch { return ""; }
  });
  // A still picture of the visible tab, then hide it — the page shows this while the layout animates.
  ipcMain.handle("browser:freeze", async () => {
    const shownId = host ? (host.which === "agent" ? (agentId || activeId) : activeId) : 0;
    const t = tabs.get(shownId);
    let img = "";
    if (t && !t.newTab) { try { const p = await t.view.webContents.capturePage(); if (!p.isEmpty()) img = `data:image/jpeg;base64,${p.toJPEG(80).toString("base64")}`; } catch {} }
    host = null;
    layout();
    return img;
  });
  ipcMain.handle("browser:find", (_e, { text, forward, next }) => { const t = tabs.get(activeId); if (!t) return false; const wc = t.view.webContents; if (!text) { wc.stopFindInPage("clearSelection"); return true; } lastFind = String(text); wc.findInPage(lastFind, { forward: forward !== false, findNext: !!next }); return true; });
  ipcMain.handle("browser:find-stop", () => { tabs.get(activeId)?.view.webContents.stopFindInPage("clearSelection"); return true; });
  ipcMain.handle("browser:auth", (_e, { id, user, pass, cancel }) => answerAuth(String(id), cancel ? null : user, pass));
  ipcMain.handle("browser:mute", (_e, id) => { const t = tabs.get(id); if (!t) return false; t.muted = !t.muted; t.view.webContents.setAudioMuted(t.muted); push(); return true; });
  ipcMain.handle("browser:new", (_e, url) => { createTab(url || HOME, { profile: currentProfile }); return state(); });
  ipcMain.handle("browser:close", (_e, id) => { closeTab(id); return state(); });
  ipcMain.handle("browser:activate", (_e, id) => { if (tabs.has(id)) activeId = id; layout(); push(true); return state(); });
  ipcMain.handle("browser:move", (_e, id, to) => { moveTab(id, to); return state(); });
  ipcMain.handle("browser:reopen", () => reopenClosedTab());
  ipcMain.handle("browser:shown", (_e, v) => { browserShown = !!v; });
  ipcMain.handle("browser:tab-menu", (_e, id) => tabMenu(id));
  ipcMain.handle("browser:pin", (_e, id) => { pinTab(id); return state(); });
  ipcMain.handle("browser:engine-set", (_e, id) => { store.setEngine(String(id)); push(true); return store.engine(); });
  ipcMain.handle("browser:history-list", (_e, q) => store.historyList(q, currentProfile).map(({ url, title, last, visits }) => ({ url, title, last, visits })));
  ipcMain.handle("browser:history-delete", (_e, arg) => { store.removeHistory(currentProfile, arg && arg.url ? { url: String(arg.url) } : arg && arg.since ? { since: Number(arg.since) } : {}); return true; });
  ipcMain.handle("browser:clear-data", async (_e, { history, cookies, cache, sinceMs }) => {
    const ses = setupSession(currentProfile);
    const since = sinceMs ? Date.now() - Number(sinceMs) : 0;
    if (history) store.removeHistory(currentProfile, since ? { since } : {});
    if (cache) await ses.clearCache().catch(() => {});
    if (cookies) await ses.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"] }).catch(() => {});
    push(true);
    return true;
  });
  ipcMain.handle("browser:download", (_e, { id, action }) => {
    const rec = downloads.find((d) => d.id === id);
    if (action === "clear") { for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== "progressing") downloads.splice(i, 1); push(true); return true; }
    if (!rec) return false;
    if (action === "open") shell.openPath(rec.path);
    else if (action === "reveal") shell.showItemInFolder(rec.path);
    else if (action === "cancel") downloadItems.get(id)?.cancel();
    else if (action === "remove") { downloads.splice(downloads.indexOf(rec), 1); push(true); }
    return true;
  });
  ipcMain.handle("browser:zoom", (_e, { id, delta, reset }) => {
    const wc = tabs.get(id ?? activeId)?.view.webContents;
    if (!wc) return 100;
    wc.setZoomLevel(reset ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + (delta ?? 0))));
    return Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100);
  });
  ipcMain.handle("browser:devtools", () => { const wc = tabs.get(activeId)?.view.webContents; if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" }); });
  ipcMain.handle("browser:print", () => { tabs.get(activeId)?.view.webContents.print(); });
  // The links on the page the user is looking at (e.g. a search results page), for Marigold's Brief.
  ipcMain.handle("browser:page-links", async (_e, id) => {
    const t = tabs.get(id ?? activeId);
    if (!t || t.view.webContents.isDestroyed()) return [];
    try {
      return await t.view.webContents.executeJavaScript(`(() => {
        const here = location.hostname.replace(/^www\\./, ""), out = [], seen = new Set();
        for (const a of document.querySelectorAll("a[href]")) {
          let href = a.href, u; try { u = new URL(href); } catch { continue; }
          if (!/^https?:$/.test(u.protocol)) continue;
          if (u.pathname === "/url" && u.searchParams.get("q")) { try { href = u.searchParams.get("q"); u = new URL(href); } catch { continue; } }
          const host = u.hostname.replace(/^www\\./, "");
          if (host === here || host.endsWith("." + here.split(".").slice(-2).join(".")) || /(^|\\.)(google|bing|duckduckgo|gstatic|googleusercontent|microsoft|brave)\\.[a-z.]+$/.test(host)) continue;
          const text = (a.innerText || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
          if (text.length < 12) continue;
          const key = host + u.pathname; if (seen.has(key)) continue; seen.add(key);
          out.push({ text: text.slice(0, 160), href });
          if (out.length >= 14) break;
        }
        return out;
      })()`, false);
    } catch { return []; }
  });
  ipcMain.handle("browser:navigate", (_e, { id, input }) => {
    const t = tabs.get(id ?? activeId) ?? createTab(HOME, { profile: currentProfile });
    const url = normalize(input);
    t.pendingUrl = "";
    t.newTab = url === NEWTAB; // a page → show it right away (with the loading bar); the new-tab page → show that
    t.view.webContents.loadURL(url).catch(() => {});
    layout();
    push();
    return state();
  });
  // Start connecting while the user is still typing an address (like Chrome's preconnect).
  ipcMain.handle("browser:preconnect", (_e, input) => { const u = normalize(input); if (/^https?:/.test(u)) try { setupSession().preconnect({ url: new URL(u).origin, numSockets: 2 }); } catch {} });
  ipcMain.handle("browser:nav", (_e, { id, what }) => {
    const wc = tabs.get(id ?? activeId)?.view.webContents;
    if (!wc) return;
    if (what === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (what === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (what === "reload") wc.reload();
    if (what === "stop") wc.stop();
  });
  ipcMain.handle("browser:page-text", async (_e, id) => {
    const wc = tabs.get(id ?? activeId)?.view.webContents;
    if (!wc) return null;
    const text = await Promise.race([
      wc.executeJavaScript(`(document.querySelector('main,article,[role=main]')||document.body).innerText.slice(0, 20000)`, true).catch(() => ""),
      new Promise((r) => setTimeout(() => r(""), 3000)), // a busy/loading page never blocks the assistant
    ]);
    return { title: wc.getTitle(), url: wc.getURL(), text };
  });
  ipcMain.handle("browser:reveal-download", () => { if (lastDownload) shell.showItemInFolder(lastDownload); });
  ipcMain.handle("browser:suggest", (_e, q) => suggest(q));
  // Hand a page to the user's own browser (e.g. a Google sign-in, which Google only allows there).
  ipcMain.handle("browser:open-external", (_e, url, email) => {
    if (!/^https?:\/\//i.test(String(url))) return false;
    // With an account: open it in the Chrome profile signed in as that account (the plain default would use
    // whichever profile was last used, which is often the wrong Google account).
    try {
      const want = String(email || "").toLowerCase();
      const chrome = want && importer.sources().find((b) => b.id === "chrome");
      const prof = chrome && chrome.profiles.find((p) => p.email.toLowerCase() === want);
      if (prof && prof.dir !== ".") {
        require("child_process").execFile("/usr/bin/open", ["-na", "Google Chrome", "--args", `--profile-directory=${prof.dir}`, String(url)], (err) => { if (err) shell.openExternal(String(url)); });
        return true;
      }
    } catch {}
    shell.openExternal(String(url)); return true;
  });
  // Answer from the permission bar: remember it for that site (this account) and reload if allowed.
  ipcMain.handle("browser:perm", async (_e, { id, allow }) => {
    const t = tabs.get(id);
    if (!t?.permAsk) return;
    const ask = t.permAsk;
    clearTimeout(t.permTimer);
    t.permAsk = null;
    const b = store.p(t.profile);
    b.perms = { ...(b.perms ?? {}), [`${ask.site}|${ask.permission}`]: !!allow };
    store.addBookmarks([], t.profile); // save
    push();
    if (allow && ask.permission === "media") await macAccessGlobal(ask.media ?? []);
    ask.cbs?.forEach((f) => f(!!allow));
  });
  // Forget every site permission answer for this account (a way back from a "no" given by mistake).
  ipcMain.handle("browser:perms-reset", (_e) => {
    const b = store.p(currentProfile);
    b.perms = {};
    store.addBookmarks([], currentProfile); // save
    for (const t of tabs.values()) t.permAsk = null;
    push();
    return true;
  });
  // Extensions for the current profile (+ open a toolbar popup / remove one).
  ipcMain.handle("browser:extensions", async () => {
    const loaded = Object.entries(await loadExtensions(currentProfile)).map(([id, x]) => ({ id, ...x, errors: extErrors[currentProfile]?.[id] ?? 0 }));
    const badDir = path.join(extDir(currentProfile), "_incompatible");
    const bad = fs.existsSync(badDir) ? fs.readdirSync(badDir).map((id) => {
      try { const d = path.join(badDir, id); const m = JSON.parse(fs.readFileSync(path.join(d, "manifest.json"), "utf8")); return { id, name: importer.extName(d, m), version: m.version, ok: false, incompatible: true, popup: "", icon: "" }; } catch { return null; }
    }).filter(Boolean) : [];
    const safe = extSafeMode ? [{ id: "_safe", name: "Extensions are off this launch", version: "", ok: false, safeMode: true, popup: "", icon: "" }] : [];
    // Held back (installed by an organization): listed, off until the user turns them on.
    const heldDir = path.join(extDir(currentProfile), "_held");
    const held = fs.existsSync(heldDir) ? fs.readdirSync(heldDir).map((id) => {
      try { const d = path.join(heldDir, id); const m = JSON.parse(fs.readFileSync(path.join(d, "manifest.json"), "utf8")); return { id, name: importer.extName(d, m), version: m.version, ok: false, held: true, popup: "", icon: "" }; } catch { return null; }
    }).filter(Boolean) : [];
    return [...safe, ...loaded, ...held, ...bad];
  });
  ipcMain.handle("browser:extension-enable", async (_e, id) => {
    const from = path.join(extDir(currentProfile), "_held", String(id));
    if (!/^[a-p]{32}$/.test(String(id)) || !fs.existsSync(from)) return false;
    fs.renameSync(from, path.join(extDir(currentProfile), String(id)));
    await loadExtensions(currentProfile);
    return true;
  });
  ipcMain.handle("browser:adblock", async (_e, on) => {
    if (typeof on === "boolean") { store.setAdblock(on); await Promise.all([...sessions.values()].map(applyAdblock)); for (const t of tabs.values()) if (!t.newTab && !t.pendingUrl) t.view.webContents.reload(); }
    return { on: adblockOn(), ready: !!blocked.size || (await blockerPromise) !== null };
  });
  ipcMain.handle("browser:extension-open", (_e, id) => openExtensionPopup(String(id)));
  ipcMain.handle("browser:extension-remove", (_e, id) => {
    const ses = setupSession(currentProfile);
    try { (ses.extensions ?? ses).removeExtension(String(id)); } catch {}
    fs.rmSync(path.join(extDir(currentProfile), String(id)), { recursive: true, force: true });
    delete extInfo[currentProfile]?.[id];
    return true;
  });
  // Bookmarks (per profile): the bar, and the star in the address bar.
  ipcMain.handle("browser:bookmarks", () => store.p().bookmarks);
  ipcMain.handle("browser:bookmark-toggle", (_e, { url, title }) => {
    const b = store.p();
    const i = b.bookmarks.findIndex((x) => x.url === url);
    if (i >= 0) b.bookmarks.splice(i, 1); else b.bookmarks.unshift({ url, title: title || url, folder: "Bookmarks Bar" });
    store.addBookmarks([]); // save
    return i < 0;
  });
  ipcMain.handle("browser:home-data", () => { const b = store.p(); return { topSites: topSites(), bookmarks: b.bookmarks.slice(0, 12), imported: b.imported ?? [], signins: b.signins ?? [], last: b.last ?? null }; });
  ipcMain.handle("browser:reload-all", () => { for (const t of tabs.values()) if (!t.newTab) t.view.webContents.reload(); });
  ipcMain.handle("browser:import-sources", () => importer.sources());
  ipcMain.handle("browser:import", async (_e, opts) => {
    const profile = currentProfile; // the logins/history go into the profile you're in
    const bound = {
      addBookmarks: (l) => store.addBookmarks(l, profile), addHistory: (l) => store.addHistory(l, profile),
      markSignins: (f) => store.markSignins(f, profile), markImported: (f, last) => store.markImported(f, last, profile),
      extensionsDir: extDir(profile),
      loadExtensions: async () => { await loadExtensions(profile); for (const t of tabs.values()) if (t.profile === profile && !t.newTab && !t.pendingUrl) t.view.webContents.reload(); },
    };
    try { const r = await importer.runImport(opts, setupSession(profile), bound); push(); return { ok: true, ...r }; }
    catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
}

// ---------------------------------------------------------------- agent control channel

// Ghost tab: while the agent works on pages that are NOT the one the user is on, it uses its own background tab,
// so the user's page (and the chat beside it) never gets navigated away. Reset at the start of each run.
let ghostFocus = false;

function agentTab(useCurrent, email) {
  if (useCurrent && ghostFocus) { const g = tabs.get(agentId); if (g) return g; ghostFocus = false; }
  if (useCurrent && tabs.get(activeId)) return tabs.get(activeId);
  const profile = email ? profileKeyFor(email) : currentProfile;
  const t = tabs.get(agentId);
  if (t && t.profile === profile) return t;
  return createTab("about:blank", { agent: true, activate: false, profile });
}

function waitLoad(wc, ms = 15000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) return setTimeout(resolve, 150);
    const done = () => { clearTimeout(t); wc.off("did-stop-loading", done); setTimeout(resolve, 300); };
    const t = setTimeout(done, ms);
    wc.on("did-stop-loading", done);
  });
}

const KEYMAP = { enter: "Enter", return: "Return", tab: "Tab", escape: "Escape", esc: "Escape", up: "Up", down: "Down", left: "Left", right: "Right",
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", backspace: "Backspace", delete: "Delete", space: "Space", pagedown: "PageDown", pageup: "PageUp", home: "Home", end: "End" };

async function command(b) {
  // Commands about the browser as a whole don't need (or create) an agent tab.
  if (b.cmd === "ghost_reset") { ghostFocus = false; return { ok: true }; }
  // "Open this link" from a run working beside the user's page: do it in the ghost tab, not in the user's tab.
  if ((b.cmd === "open") && b.current === true && !ghostFocus) {
    const mine = tabs.get(activeId);
    const profile = b.account ? profileKeyFor(b.account) : (mine?.profile ?? currentProfile);
    let g = tabs.get(agentId);
    if (!g || g.profile !== profile) g = createTab("about:blank", { agent: true, activate: false, profile });
    ghostFocus = true;
    console.info("[browser] agent opens pages in its ghost tab; the user's tab stays put");
    b = { ...b, newTab: false, current: true };
  }
  const t = ["tabs", "reload_matching", "last_download"].includes(b.cmd) ? null : agentTab(b.current === true, b.account);
  const wc = t?.view.webContents;
  switch (b.cmd) {
    case "tabs": return { ...state() };
    case "info": return info(t);
    case "blocked": return { blocked: [...(t.blocked ?? [])] };
    case "open": {
      let target = t;
      if (b.newTab) target = createTab("about:blank", { agent: true, activate: false, profile: t.profile });
      await target.view.webContents.loadURL(normalize(b.url, true)).catch((e) => { target.err = String(e); });
      await waitLoad(target.view.webContents);
      return { ...info(target), error: target.err ? String(target.err).slice(0, 200) : undefined };
    }
    case "eval": return { value: await wc.executeJavaScript(String(b.js), true) };
    // Type a saved card into the checkout page's card fields (every frame: card forms usually live in the payment company's own frame).
    // Only after the user approved this exact site; the site is checked again here. The security code is never filled. Nothing is logged.
    case "fill_card": {
      const c = b.card || {};
      let top = ""; try { top = new URL(wc.getURL()).hostname.toLowerCase(); } catch { /* none */ }
      if (!/^https:/.test(wc.getURL()) || top !== String(b.host || "").toLowerCase()) return { error: "The page isn't the site you approved." };
      const code = `(() => {
        const d = ${JSON.stringify({ pan: String(c.pan || ""), mm: String(c.mm || ""), yy: String(c.yy || ""), name: String(c.name || ""), zip: String(c.zip || "") })};
        const n = { number: 0, exp: 0, name: 0, zip: 0 };
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const set = (e, v) => { const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); for (const t of ['input', 'change', 'blur']) e.dispatchEvent(new Event(t, { bubbles: true })); };
        for (const e of document.querySelectorAll('input, select')) {
          if (!vis(e) || e.type === 'password' || e.type === 'hidden' || e.disabled || e.readOnly) continue;
          const k = ((e.autocomplete || '') + ' ' + e.name + ' ' + e.id + ' ' + (e.placeholder || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
          if (/cc-csc|cvc|cvv|csc|security.?code|verification/.test(k)) continue;
          if (/cc-number|card.?number|cardnumber|ccnum|card-number/.test(k)) { if (d.pan) { set(e, d.pan); n.number++; } }
          else if (/cc-exp-month|exp.?month|expmonth/.test(k)) { if (d.mm) { set(e, d.mm); n.exp++; } }
          else if (/cc-exp-year|exp.?year|expyear/.test(k)) { if (d.yy) { set(e, e.maxLength === 4 ? '20' + d.yy : d.yy); n.exp++; } }
          else if (/cc-exp|expir|mm ?\\/ ?yy|exp.?date/.test(k)) { if (d.mm) { set(e, d.mm + ' / ' + d.yy); n.exp++; } }
          else if (/cc-name|name.?on.?card|card.?holder|cardholder|card.?name/.test(k)) { if (d.name) { set(e, d.name); n.name++; } }
          else if (/postal|zip/.test(k)) { if (d.zip) { set(e, d.zip); n.zip++; } }
        }
        return n;
      })()`;
      let filled = 0;
      for (const f of wc.mainFrame.framesInSubtree) {
        if (!/^https:/.test(f.url || "")) continue;
        try { const r = await f.executeJavaScript(code, true); filled += (r.number || 0) + (r.exp || 0) + (r.name || 0) + (r.zip || 0); } catch { /* a frame that won't run it */ }
      }
      return { filled };
    }
    case "click": {
      const x = Math.round(b.x), y = Math.round(b.y);
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 250));
      await waitLoad(wc, 8000);
      return info(t);
    }
    case "insert": wc.insertText(String(b.text ?? "")); return { ok: true };
    case "key": {
      const k = KEYMAP[String(b.key).toLowerCase()] ?? String(b.key);
      const modifiers = (b.modifiers ?? []).filter((m) => ["shift", "control", "alt", "meta", "cmd"].includes(m)).map((m) => (m === "cmd" ? "meta" : m));
      wc.sendInputEvent({ type: "keyDown", keyCode: k, modifiers });
      if (k.length === 1 || k === "Enter" || k === "Return" || k === "Space") wc.sendInputEvent({ type: "char", keyCode: k === "Space" ? " " : k === "Return" || k === "Enter" ? "\r" : k, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: k, modifiers });
      await new Promise((r) => setTimeout(r, 200));
      await waitLoad(wc, 8000);
      return info(t);
    }
    case "wheel": wc.sendInputEvent({ type: "mouseWheel", x: Math.round(b.x ?? 400), y: Math.round(b.y ?? 400), deltaX: 0, deltaY: -Math.round(b.dy ?? 600) }); await new Promise((r) => setTimeout(r, 350)); return { ok: true };
    case "nav": {
      if (b.what === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (b.what === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      if (b.what === "reload") wc.reload();
      await waitLoad(wc);
      return info(t);
    }
    case "switch": { if (!tabs.has(b.id)) return { error: "no such tab" }; agentId = b.id; layout(); push(); return info(tabs.get(b.id)); }
    case "close": { closeTab(t.id); return { ok: true }; }
    case "shot": {
      let img = await wc.capturePage();
      if (b.maxWidth && img.getSize().width > b.maxWidth) img = img.resize({ width: Math.round(b.maxWidth), quality: "good" });
      const size = img.getSize();
      return { jpg: img.isEmpty() ? "" : img.toJPEG(b.maxWidth ? 72 : 62).toString("base64"), width: size.width, height: size.height };
    }
    case "upload": {
      // Attach a file to <input type=file data-mg=N> via the in-process DevTools channel.
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      const { result } = await dbg.sendCommand("Runtime.evaluate", { expression: `document.querySelector('[data-mg="${Number(b.index)}"]')` });
      if (!result?.objectId) return { error: "that element is gone" };
      await dbg.sendCommand("DOM.setFileInputFiles", { files: [String(b.path)], objectId: result.objectId });
      dbg.detach();
      return { ok: true };
    }
    case "reload_matching": {
      // The API just changed this file → refresh any open tab showing it (any account).
      const id = String(b.contains ?? "");
      let n = 0;
      if (id.length >= 20) for (const tb of tabs.values()) { const w = tb.view.webContents; if (!w.isDestroyed() && w.getURL().includes(id)) { w.reload(); n++; } }
      return { reloaded: n };
    }
    case "last_download": return { file: lastDownload };
    case "show": { activeId = t.id; layout(); push(); return { ok: true }; }
  }
  return { error: `unknown command ${b.cmd}` };
}

function startControl(secret) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.headers["x-marigold-secret"] !== secret) { res.writeHead(403); return res.end(); }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      req.on("end", async () => {
        let out;
        try { out = await command(JSON.parse(body || "{}")); } catch (e) { out = { error: String(e?.message ?? e).slice(0, 300) }; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out ?? {}));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });
}

let onAppLink = () => {};
async function init({ win, ensure, secret, onLink }) {
  if (onLink) onAppLink = onLink;
  markRunning();
  getWin = win;
  ensureWin = ensure;
  registerIpc();
  return startControl(secret);
}

/** The main window was (re)created: put the tabs into it. */
function reattach() { for (const t of tabs.values()) attach(t); layout(); push(); }

/** Open a link in a new Marigold Browser tab (from a notification). */
function openUrl(url) { createTab(url, { activate: true }); }

module.exports = { init, reattach, openUrl, markCleanExit, safeMode: () => extSafeMode };
