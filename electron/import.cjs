// "Connect your browser": bring bookmarks, history and sign-ins (cookies) from the user's own
// Chromium-family browser into the Marigold Browser — only when the user asks, in the app.
//
//  • Sign-ins: Chromium encrypts cookies with a key in the macOS Keychain ("Chrome Safe Storage").
//    Reading it makes macOS ask the user ("Marigold wants to use … Chrome Safe Storage") — that
//    prompt IS the consent; Deny → nothing is imported.
//  • Passwords are never read or copied (Marigold never handles passwords).
//  • Files are copied to a temp folder first (the browser may have them open).

const { execFile } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");

const exec = promisify(execFile);
const AS = path.join(os.homedir(), "Library", "Application Support");

const BROWSERS = [
  { id: "chrome", label: "Google Chrome", dir: "Google/Chrome", keychain: ["Chrome Safe Storage", "Chrome"] },
  { id: "brave", label: "Brave", dir: "BraveSoftware/Brave-Browser", keychain: ["Brave Safe Storage", "Brave"] },
  { id: "edge", label: "Microsoft Edge", dir: "Microsoft Edge", keychain: ["Microsoft Edge Safe Storage", "Microsoft Edge"] },
  { id: "arc", label: "Arc", dir: "Arc/User Data", keychain: ["Arc Safe Storage", "Arc"] },
  { id: "vivaldi", label: "Vivaldi", dir: "Vivaldi", keychain: ["Vivaldi Safe Storage", "Vivaldi"] },
  { id: "opera", label: "Opera", dir: "com.operasoftware.Opera", keychain: ["Opera Safe Storage", "Opera"] },
  { id: "chromium", label: "Chromium", dir: "Chromium", keychain: ["Chromium Safe Storage", "Chromium"] },
];

/** Installed Chromium-family browsers and their profiles (name + folder). */
function sources() {
  const out = [];
  for (const b of BROWSERS) {
    const root = path.join(AS, b.dir);
    if (!fs.existsSync(root)) continue;
    let names = {};
    try { names = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8"))?.profile?.info_cache ?? {}; } catch {}
    const profiles = fs.readdirSync(root).filter((d) => (d === "Default" || /^Profile \d+$/.test(d)) && fs.existsSync(path.join(root, d, "Preferences")))
      .map((d) => ({ dir: d, name: names[d]?.name || d, email: names[d]?.user_name || "" }));
    // Opera keeps a single profile in the root folder.
    if (!profiles.length && fs.existsSync(path.join(root, "Bookmarks"))) profiles.push({ dir: ".", name: "Default", email: "" });
    if (profiles.length) out.push({ id: b.id, label: b.label, profiles });
  }
  return out;
}

async function sqlJson(dbFile, sql) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-import-"));
  try {
    const copy = path.join(tmp, "db");
    fs.copyFileSync(dbFile, copy);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, copy + ext);
    const { stdout } = await exec("/usr/bin/sqlite3", ["-json", "-readonly", copy, sql], { maxBuffer: 256 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function bookmarks(profileDir) {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(profileDir, "Bookmarks"), "utf8"));
    const walk = (n, folder) => {
      if (!n) return;
      if (n.type === "url" && /^https?:/i.test(n.url)) out.push({ title: n.name || n.url, url: n.url, folder });
      for (const c of n.children ?? []) walk(c, n.type === "folder" && n.name ? (folder ? `${folder} › ${n.name}` : n.name) : folder);
    };
    for (const r of Object.values(j.roots ?? {})) walk(r, "");
  } catch {}
  return out.slice(0, 5000);
}

async function history(profileDir) {
  const f = path.join(profileDir, "History");
  if (!fs.existsSync(f)) return [];
  const rows = await sqlJson(f, "SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0 AND url LIKE 'http%' ORDER BY visit_count DESC, last_visit_time DESC LIMIT 4000;");
  return rows.map((r) => ({ url: r.url, title: r.title || r.url, visits: r.visits | 0, last: chromeTime(r.last) }));
}

/** Chromium time (µs since 1601) → ms since 1970. */
const chromeTime = (t) => (Number(t) > 0 ? Math.round(Number(t) / 1000 - 11644473600000) : 0);

/** AES key for this browser's cookies (asks the user via the macOS Keychain prompt). */
async function cookieKey(b) {
  try {
    const { stdout } = await exec("/usr/bin/security", ["find-generic-password", "-w", "-s", b.keychain[0], "-a", b.keychain[1]], { timeout: 180_000 });
    return crypto.pbkdf2Sync(stdout.trim(), "saltysalt", 1003, 16, "sha1");
  } catch (e) {
    const why = String(e.stderr || "").trim();
    const code = e.code;
    // 128 (no message) = the macOS prompt was answered with Deny / closed; 51 = it couldn't be shown.
    if (code === 128 || /cancel/i.test(why)) throw new Error("DENIED");
    if (code === 44 || /could not be found/i.test(why)) throw new Error(`NOTFOUND`);
    if (code === 51 || /interaction is not allowed/i.test(why)) throw new Error("NOPROMPT");
    if (e.killed) throw new Error("TIMEOUT");
    throw new Error(`code ${code}${why ? `: ${why.slice(0, 120)}` : ""}`);
  }
}

/** Decrypt one Chromium cookie value (macOS "v10" format). */
function decrypt(hex, key, dbVersion) {
  const buf = Buffer.from(hex, "hex");
  if (buf.length < 4) return null;
  const tag = buf.subarray(0, 3).toString();
  if (tag !== "v10" && tag !== "v11") return null;
  const d = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  let plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  if (dbVersion >= 24) plain = plain.subarray(32); // newer Chromium prefixes SHA-256(host)
  return plain.toString("utf8");
}

// ---------------------------------------------------------------- extensions

/** Google's own built-ins that make no sense outside Chrome. */
/** Extensions known to crash Electron's browser (tested): imported into _incompatible/, never loaded. */
const INCOMPATIBLE_EXT = new Set(["kbfnbcaeplbcioakkpcpgfkobkghlhen" /* Grammarly — crashes the app when a page is visible */]);
const SKIP_EXT = new Set(["nmmhkkegccagdldgiimedpiccmgmieda" /* Web Store payments */, "ghbmnnjooekpmoecnnnilnnbdlolhkhi" /* Docs offline */, "pkedcjkdefgpdelpbcmbmeomcjbeemfm" /* Cast */, "mhjfbmdgcfjbbpaeojofohoefgiehjai" /* PDF viewer */]);

/** "__MSG_appName__" → the extension's English name. */
function extName(dir, m) {
  const raw = String(m.name ?? "");
  const key = raw.match(/^__MSG_(.+)__$/)?.[1];
  if (!key) return raw;
  for (const loc of [m.default_locale, "en", "en_US"].filter(Boolean)) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, "_locales", loc, "messages.json"), "utf8"));
      const hit = Object.entries(msgs).find(([k]) => k.toLowerCase() === key.toLowerCase());
      if (hit) return hit[1].message;
    } catch {}
  }
  return raw;
}

/** Copy the profile's extensions (latest version of each) into Marigold's extensions folder for this account. */
function extensions(profileDir, destRoot) {
  const src = path.join(profileDir, "Extensions");
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  // Extensions an organization FORCE-INSTALLED (school/work policy — often monitoring/lockdown
  // tools): held back in _held/ instead of loading, so Marigold doesn't start reporting browsing
  // to them without the user choosing that. Chrome location 7/9 = installed by policy.
  const settings = {};
  for (const f of ["Secure Preferences", "Preferences"]) {
    try { Object.assign(settings, JSON.parse(fs.readFileSync(path.join(profileDir, f), "utf8"))?.extensions?.settings ?? {}); } catch {}
  }
  const byPolicy = (id) => [7, 9].includes(Number(settings[id]?.location));
  const out = [];
  for (const id of fs.readdirSync(src)) {
    if (!/^[a-p]{32}$/.test(id) || SKIP_EXT.has(id)) continue;
    const versions = fs.readdirSync(path.join(src, id)).filter((v) => fs.existsSync(path.join(src, id, v, "manifest.json")));
    const ver = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (!ver) continue;
    const from = path.join(src, id, ver);
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(from, "manifest.json"), "utf8")); } catch { continue; }
    if (m.theme || m.app) continue; // themes and old Chrome apps don't apply
    const held = byPolicy(id);
    const bad = INCOMPATIBLE_EXT.has(id);
    const to = path.join(destRoot, bad ? "_incompatible" : held ? "_held" : "", id);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(path.join(to, "_metadata"), { recursive: true, force: true }); // Chrome's store signature (unpacked loads refuse it)
    out.push({ id, name: extName(from, m), version: m.version, held, incompatible: bad });
  }
  return out;
}

const SAMESITE = { "-1": "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" };

async function cookies(b, profileDir, ses) {
  const f = [path.join(profileDir, "Network", "Cookies"), path.join(profileDir, "Cookies")].find((p) => fs.existsSync(p));
  if (!f) return { count: 0 };
  const key = await cookieKey(b); // ← macOS asks the user here
  const meta = await sqlJson(f, "SELECT value FROM meta WHERE key = 'version';").catch(() => []);
  const ver = Number(meta[0]?.value ?? 0);
  const now = Date.now() / 1000;
  const rows = await sqlJson(f, "SELECT host_key, name, value, hex(encrypted_value) AS ev, path, expires_utc, is_secure, is_httponly, samesite FROM cookies;");
  let count = 0, skipped = 0;
  for (const r of rows) {
    try {
      const value = r.value || (r.ev ? decrypt(r.ev, key, ver) : "");
      if (value == null) { skipped++; continue; }
      let exp = chromeTime(r.expires_utc) / 1000;
      if (exp && exp < now) continue; // already expired
      // "Until the browser closes" sign-ins: keep them for 30 days so a restart doesn't sign you out.
      if (!exp) exp = now + 30 * 86400;
      const host = String(r.host_key);
      const secure = r.is_secure === 1 || String(r.name).startsWith("__Secure-") || String(r.name).startsWith("__Host-");
      await ses.cookies.set({
        url: `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${r.path || "/"}`,
        name: r.name, value,
        ...(host.startsWith(".") && !String(r.name).startsWith("__Host-") ? { domain: host } : {}),
        path: r.path || "/", secure, httpOnly: r.is_httponly === 1,
        expirationDate: exp,
        sameSite: SAMESITE[String(r.samesite)] ?? "unspecified",
      });
      count++;
    } catch { skipped++; }
  }
  await ses.cookies.flushStore();
  return { count, skipped };
}

/**
 * Import from browser `id` / profile folder. what = { bookmarks, history, cookies }.
 * Returns counts; bookmarks/history are merged into the Marigold Browser's own data file.
 */
async function runImport({ id, profile, what }, ses, store) {
  const b = BROWSERS.find((x) => x.id === id);
  if (!b) throw new Error("Unknown browser");
  const dir = path.join(AS, b.dir, profile || "Default");
  if (!fs.existsSync(dir)) throw new Error("That profile wasn't found");
  const res = { from: `${b.label}${profile && profile !== "Default" && profile !== "." ? ` (${profile})` : ""}` };
  if (what.bookmarks !== false) { const bm = bookmarks(dir); store.addBookmarks(bm); res.bookmarks = bm.length; }
  if (what.history !== false) { const h = await history(dir); store.addHistory(h); res.history = h.length; }
  if (what.extensions !== false && store.extensionsDir) {
    try {
      const ex = extensions(dir, store.extensionsDir);
      res.extensions = ex.filter((e) => !e.held && !e.incompatible).map((e) => e.name);
      res.extensionsIncompatible = ex.filter((e) => e.incompatible).map((e) => e.name);
      res.extensionsHeld = ex.filter((e) => e.held).map((e) => e.name);
      if (ex.length && store.loadExtensions) await store.loadExtensions();
    }
    catch (e) { res.extensionsError = String(e?.message ?? e).slice(0, 120); }
  }
  if (what.cookies !== false) {
    try { const c = await cookies(b, dir, ses); res.signins = c.count; if (c.count) store.markSignins(res.from); }
    catch (e) {
      const m = String(e?.message ?? e);
      res.signinsError = m === "DENIED" ? `macOS's “${b.label} Safe Storage” prompt was declined or closed, so sign-ins weren't copied. Click “Try sign-ins again” and choose Allow (or Always Allow).`
        : m === "NOPROMPT" ? "macOS couldn't show its permission prompt (is the screen locked?). Try again while you're at the Mac."
        : m === "TIMEOUT" ? "Nobody answered macOS's prompt in time. Try again and click Allow."
        : m === "NOTFOUND" ? `${b.label}'s sign-in key wasn't found in your Keychain — open ${b.label} once, then try again.`
        : `Sign-ins couldn't be copied (${m.slice(0, 140)}).`;
    }
  }
  store.markImported(res.from, { id, profile: profile || "Default" });
  return res;
}

module.exports = { sources, runImport, decrypt, chromeTime, extName, extensions };
