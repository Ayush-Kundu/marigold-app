// Marigold — the Mac app.
//
// One process owns everything:
//   • the Marigold engine (the Next server with the agent) — started here, or reused if one
//     is already running on :3000 (e.g. `npm run dev` during development);
//   • the main window;
//   • a menu-bar icon (like Siri / Control Center) with a quick panel — ask anything, see what
//     the agent is doing, approve requests — also on a global shortcut (⌥⇧Space);
//   • start at login, and native Touch ID for money approvals.
//
// Because the engine is a child of Marigold.app, macOS permissions (Full Disk Access,
// Accessibility, Screen Recording, Automation…) are granted to Marigold itself — once.

// V8's just-in-time compiler crashes inside this Electron build on current macOS (all three crashes today were in
// JIT-memory registration on the main thread). Marigold's own main-process code (IPC, history, downloads, the ad
// blocker's matching) doesn't need the JIT, so run it in the interpreter: no optimizing tiers, interpreted regexps.
// (Web pages run in their own processes and keep the JIT.)
try {
  require("v8").setFlagsFromString("--no-opt");
  require("v8").setFlagsFromString("--no-maglev");
  require("v8").setFlagsFromString("--no-sparkplug");
  require("v8").setFlagsFromString("--regexp-interpret-all");
  require("v8").setFlagsFromString("--no-regexp-tier-up");
  require("v8").setFlagsFromString("--no-concurrent-recompilation");
} catch { /* an older runtime without these flags */ }

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, systemPreferences, shell, screen, nativeTheme, dialog, desktopCapturer, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const mbrowser = require("./browser.cjs");
const updater = require("./updater.cjs");

const PORT = 3000; // the address Supabase sign-in links return to
const ORIGIN = `http://localhost:${PORT}`;
const SECRET = crypto.randomBytes(24).toString("hex"); // only this process and the engine it starts know it
const HOTKEY = "Alt+Shift+Space";
const MARIGOLD_DIR = path.join(os.homedir(), ".marigold");
const APP_PREFS = path.join(MARIGOLD_DIR, "app.json");
const LOG = path.join(MARIGOLD_DIR, "app-server.log");

let server = null;          // the engine we started (null if we reused one)
let ownsServer = false;
let mainWin = null;
let quickWin = null;
let tray = null;
let quitting = false;
let shownAt = 0;

if (!app.requestSingleInstanceLock()) app.quit();
// marigold:// links (from notifications): marigold://chat/<id>, marigold://open?url=…, marigold://pings
app.setAsDefaultProtocolClient("marigold");
const pendingLinks = [];
function handleLink(link) {
  try {
    const u = new URL(link);
    if (!mainWin && !app.isReady()) { pendingLinks.push(link); return; }
    if (u.host === "ask") { const q = (u.searchParams.get("q") ?? "").slice(0, 400); if (q) { showMain(); mainWin?.webContents.send("ask-tab", q, u.searchParams.get("deep") === "1"); } return; }
    if (u.host === "deepdive") { const q = (u.searchParams.get("q") ?? "").slice(0, 300); if (q) { showMain(); mainWin?.webContents.send("deep-dive", q); } return; }
    if (u.host === "tab") { const t = u.pathname.slice(1); if (["chats", "browser", "projects"].includes(t)) mainWin?.webContents.send("open-tab", t); return; }
    if (u.host === "mute") { muteKind(u.searchParams.get("kind") ?? "", u.searchParams.get("mins") ?? "60"); return; }
    if (u.host === "chat") showMain(decodeURIComponent(u.pathname.slice(1)));
    else if (u.host === "open" && /^https?:/.test(u.searchParams.get("url") ?? "")) { showMain(); mbrowser.openUrl(u.searchParams.get("url")); mainWin?.webContents.send("open-tab", "browser"); }
    else { showMain(); mainWin?.webContents.send("open-pings"); }
  } catch {}
}
app.on("open-url", (e, link) => { e.preventDefault(); handleLink(link); });
// Media keeps playing in background/covered tabs and windows (like a normal browser), and the
// agent's off-screen tab isn't paused while it works.
app.commandLine.appendSwitch("disable-background-media-suspend");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Smoothness (the things Chrome turns on by default that Electron leaves to chance): GPU raster + zero-copy
// tiles, smooth scrolling, and a bigger on-disk cache so repeat visits are instant.
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-smooth-scrolling");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("disk-cache-size", String(512 * 1024 * 1024));
app.on("second-instance", () => showMain());

// ------------------------------------------------------------------ prefs

function readPrefs() { try { return JSON.parse(fs.readFileSync(APP_PREFS, "utf8")); } catch { return {}; } }
function writePrefs(p) {
  fs.mkdirSync(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(APP_PREFS, JSON.stringify({ ...readPrefs(), ...p }, null, 2), { mode: 0o600 });
}

// ------------------------------------------------------------------ engine

async function status() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/app/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function startEngine() {
  const existing = await status();
  if (existing?.marigold) { ownsServer = false; return; } // reuse (dev server)

  const busy = await new Promise((res) => {
    const sock = net.connect(PORT, "127.0.0.1");
    const done = (v) => { try { sock.destroy(); } catch {} res(v); };
    sock.once("connect", () => done(true)); sock.once("error", () => done(false)); setTimeout(() => done(false), 800);
  });
  if (busy) throw new Error(`Another program on this Mac is already using port ${PORT}, and Marigold needs it. Quit that program (a local development server, for example), then press Try again.`);

  const root = app.getAppPath();
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  fs.mkdirSync(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  const log = fs.openSync(LOG, "a");
  server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      MARIGOLD_APP_SECRET: SECRET,
      MARIGOLD_ORIGIN: ORIGIN,
      MARIGOLD_RESOURCES: app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "build-secrets"),
      // Apps opened from Finder get a bare PATH; the agent's tools need the usual places.
      PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":"),
    },
    stdio: ["ignore", log, log],
  });
  ownsServer = true;
  server.on("exit", (code) => {
    server = null;
    if (!quitting) console.error(`[marigold] engine exited (${code}) — see ${LOG}`);
  });
  for (let i = 0; i < 120; i++) {
    if ((await status())?.marigold) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Marigold's engine didn't start. The details are in the log below.`);
}

/** What the window shows when the engine can't start, instead of a black screen. */
let engineProblem = "";
function engineProblemPage(msg) {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  let tail = ""; try { tail = fs.readFileSync(LOG, "utf8").split("\n").filter((l) => /error|exit|EADDR|listen|started|failed|unavailable|permission|widevine|engine|ready/i.test(l) && !/lookup|notify|prompt size|cloud/i.test(l)).slice(-12).join("\n"); } catch {}
  return "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Marigold</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0c0e;color:#f4f4f5;font:14px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:620px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{color:#a1a1aa;margin:0 0 16px}pre{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:12px;max-height:200px;overflow:auto;font-size:11.5px;color:#a1a1aa;white-space:pre-wrap}
button{background:#e8a317;color:#000;border:0;border-radius:9px;padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;margin-right:8px}button.s{background:#27272a;color:#f4f4f5}</style>
<main><div style="font-size:34px">🌼</div><h1>Marigold couldn't start</h1><p>${esc(msg)}</p>
<button onclick="window.marigoldApp&&window.marigoldApp.retryEngine()">Try again</button><button class="s" onclick="window.marigoldApp&&window.marigoldApp.showLog()">Show the log</button>
<p style="margin-top:18px">If it keeps happening, send whoever gave you Marigold a screenshot of this window.</p><pre>${esc(tail || "(no log yet)")}</pre></main>`);
}

// ------------------------------------------------------------------ windows

/** The main window, created hidden if needed (the Marigold Browser's tabs live in it). */
function ensureMain() {
  if (!mainWin || mainWin.isDestroyed()) {
    mainWin = new BrowserWindow({
      show: false,
      width: 1280, height: 860, minWidth: 880, minHeight: 600,
      title: "Marigold",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0c0e" : "#ffffff",
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false }, // keeps listening/speaking alive while the window is hidden
    });
    mainWin.loadURL(engineProblem ? engineProblemPage(engineProblem) : ORIGIN);
    mainWin.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3 && url.startsWith(ORIGIN)) { engineProblem = engineProblem || `The window couldn't load Marigold's engine (${desc}).`; mainWin.loadURL(engineProblemPage(engineProblem)); }
    });
    // The app window is never zoomed (a stray ⌘+ once left it at 110%, which threw the browser's page out of line).
    mainWin.webContents.on("did-finish-load", () => { try { mainWin.webContents.setZoomFactor(1); } catch {} });
    mainWin.webContents.on("before-input-event", (e, input) => { if (input.type === "keyDown" && input.meta && !input.alt && ["=", "+", "-", "0"].includes(input.key)) e.preventDefault(); });
    guardNavigation(mainWin);
    mainWin.on("close", (e) => {
      if (quitting) return;
      e.preventDefault(); // closing the window keeps Marigold running in the menu bar
      mainWin.hide();
      if (process.platform === "darwin") app.dock.hide();
    });
    mbrowser.reattach();
  }
  return mainWin;
}

/**
 * More Marigold windows (⌘N): extra chat windows beside the main one. The Marigold Browser and the listening/speaking helpers stay
 * with the main window (a second window gets "?aux=1" and hides those), so nothing is spoken twice or fights over the page.
 */
const extraWins = new Set();
function newWindow() {
  if (!mainWin || mainWin.isDestroyed()) { showMain(); return; }
  const b = mainWin.isVisible() ? mainWin.getBounds() : { x: 120, y: 120, width: 1100, height: 780 };
  const w = new BrowserWindow({
    x: b.x + 36, y: b.y + 36, width: Math.max(900, b.width - 80), height: Math.max(640, b.height - 60), minWidth: 640, minHeight: 520,
    title: "Marigold",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0c0e" : "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  extraWins.add(w);
  w.on("closed", () => extraWins.delete(w));
  w.loadURL(`${ORIGIN}/?aux=1`);
  w.webContents.on("did-finish-load", () => { try { w.webContents.setZoomFactor(1); } catch {} });
  guardNavigation(w);
  if (process.platform === "darwin") app.dock.show();
}

function showMain(chatId) {
  ensureMain();
  if (process.platform === "darwin") app.dock.show();
  mainWin.show();
  mainWin.focus();
  if (chatId) mainWin.webContents.send("open-chat", chatId);
}

function quickBounds(fromTray) {
  const w = 420, h = 560;
  if (fromTray && tray) {
    const b = tray.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    return { x: Math.round(Math.min(Math.max(b.x + b.width / 2 - w / 2, d.x + 8), d.x + d.width - w - 8)), y: Math.round(b.y + b.height + 6), width: w, height: h };
  }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return { x: Math.round(d.x + d.width / 2 - w / 2), y: Math.round(d.y + d.height * 0.16), width: w, height: h };
}

function toggleQuick(fromTray) {
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) { quickWin.hide(); return; }
  if (!quickWin || quickWin.isDestroyed()) {
    quickWin = new BrowserWindow({
      ...quickBounds(fromTray),
      show: false, frame: false, resizable: false, movable: true, skipTaskbar: true, alwaysOnTop: true,
      fullscreenable: false, minimizable: false, maximizable: false,
      vibrancy: "popover", visualEffectState: "active", roundedCorners: true, transparent: true,
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    quickWin.loadURL(`${ORIGIN}/quick`);
    guardNavigation(quickWin);
    // Hide when the user clicks elsewhere — but not in the first moments after opening, when
    // macOS may briefly hand focus back to the previous app (that closed it instantly).
    quickWin.on("blur", () => {
      if (Date.now() - shownAt < 600 || quickWin.webContents.isDevToolsOpened()) return;
      quickWin.hide();
    });
  } else {
    quickWin.setBounds(quickBounds(fromTray));
  }
  quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // works over full-screen apps too
  shownAt = Date.now();
  app.focus({ steal: true });
  quickWin.show();
  quickWin.focus();
  quickWin.webContents.send("quick-shown");
}

/** Marigold's own pages stay in the app; any other link opens in the user's browser. */
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGIN)) shell.openExternal(url);
    return { action: url.startsWith(ORIGIN) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); shell.openExternal(url); }
  });
}

// ------------------------------------------------------------------ menu bar

let convPhase = "off";
/** Start or end the voice conversation (it lives in the main window, which may stay hidden). */
function toggleConversation() {
  ensureMain();
  const send = () => mainWin?.webContents.send("converse-toggle");
  if (mainWin.webContents.isLoading()) mainWin.webContents.once("did-finish-load", () => setTimeout(send, 1500)); else send();
}
ipcMain.on("conv-state", (_e, p) => {
  convPhase = String(p || "off");
  if (tray && convPhase !== "off") tray.setTitle(` ${({ starting: "Starting…", waiting: "Say Hey Marigold", listening: "Listening", hearing: "Hearing you", transcribing: "Got it", thinking: "Thinking", speaking: "Speaking" })[convPhase] ?? "Talking"}`);
  else if (tray) void refreshTray();
});

function trayMenu() {
  const prefs = readPrefs();
  return Menu.buildFromTemplate([
    { label: convPhase === "off" ? "Listen for “Hey Marigold”" : convPhase === "waiting" ? "Stop listening" : "End conversation", accelerator: "Alt+Shift+V", click: () => toggleConversation() },
    { label: "Ask Marigold…", accelerator: HOTKEY, click: () => toggleQuick(false) },
    { label: "Open Marigold", click: () => showMain() },
    { type: "separator" },
    { label: "Permissions…", click: () => showPermissions() },
    { label: nonUrgentPaused() ? "Resume all notifications" : "Pause non-urgent notifications (1 hour)", click: () => { quietUntil = nonUrgentPaused() ? 0 : Date.now() + 3600_000; } },
    { label: "Stop all tasks", click: () => fetch(`${ORIGIN}/api/agent/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {}) },
    { type: "separator" },
    { label: "Start at login", type: "checkbox", checked: prefs.openAtLogin !== false, click: (item) => setLogin(item.checked) },
    { label: "Quit Marigold", accelerator: "Cmd+Q", click: () => { quitting = true; app.quit(); } },
  ]);
}

// What macOS actually grants THIS build (System Settings can show a stale switch from an older build).
function permissionStatus() {
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
  };
}
/** Everything the setup screen shows (microphone is reported as-is, never asked for here). */
function setupPermissions() {
  const mic = (() => { try { return systemPreferences.getMediaAccessStatus("microphone"); } catch { return "unknown"; } })();
  const camera = (() => { try { return systemPreferences.getMediaAccessStatus("camera"); } catch { return "unknown"; } })();
  return { ...permissionStatus(), microphone: mic, camera };
}
const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};
async function showPermissions() {
  const p = permissionStatus();
  const line = (ok, name) => `${ok ? "✅" : "❌"}  ${name}`;
  const missing = Object.entries(p).filter(([, ok]) => !ok).map(([k]) => k);
  const { response } = await dialog.showMessageBox({
    type: missing.length ? "warning" : "info",
    message: missing.length ? "Marigold is missing permissions" : "Marigold has the permissions it needs",
    detail: `${line(p.accessibility, "Accessibility — see and control apps")}\n${line(p.screen, "Screen Recording — read app screens and the View")}` +
      (missing.length ? "\n\nIf the switch already looks ON, it belongs to an older copy of Marigold: select Marigold in the list, click “−” to remove it, then “+” and pick /Applications/Marigold.app (or turn it off and on). Then quit and reopen Marigold." : ""),
    buttons: missing.length ? ["Open Settings", "Later"] : ["OK"],
  });
  if (missing.length && response === 0) {
    if (missing.includes("accessibility")) systemPreferences.isTrustedAccessibilityClient(true); // adds Marigold to the list + macOS prompt
    // Asking for a screen picture once makes macOS add Marigold to Screen Recording and prompt.
    if (missing.includes("screen")) await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    await shell.openExternal(PANES[missing[0]]);
  }
}
ipcMain.handle("permissions", () => setupPermissions());
// One-click "Allow": triggers the macOS prompt where there is one, and opens the right Settings pane where there isn't.
ipcMain.handle("request-permission", async (_e, kind) => {
  if (kind === "accessibility") { systemPreferences.isTrustedAccessibilityClient(true); await shell.openExternal(PANES.accessibility); }
  else if (kind === "screen") { await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {}); await shell.openExternal(PANES.screen); }
  else if (kind === "microphone") { const ok = await systemPreferences.askForMediaAccess("microphone").catch(() => false); if (!ok) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"); }
  else if (kind === "camera") { const ok = await systemPreferences.askForMediaAccess("camera").catch(() => false); if (!ok) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"); }
  else if (kind === "fulldisk") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
  else if (kind === "notifications") await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
  return setupPermissions();
});
ipcMain.handle("show-permissions", () => showPermissions());
// Are macOS notifications allowed for Marigold? (asks the helper; "missing" if it isn't bundled)
ipcMain.handle("notify-status", () => new Promise((resolve) => {
  if (!fs.existsSync(NOTIFIER)) return resolve("missing");
  const out = spawn(NOTIFIER, ["--status"]);
  let s = "";
  out.stdout.on("data", (d) => { s += d; });
  out.on("exit", () => resolve(s.trim() || "unknown"));
}));
// Microphone (dictation): ask macOS once, then report granted / denied.
ipcMain.handle("mic-access", async () => {
  try {
    const st = systemPreferences.getMediaAccessStatus("microphone");
    if (st === "not-determined") return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
    return st;
  } catch { return "unknown"; }
});
ipcMain.handle("mic-settings", () => shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"));
ipcMain.handle("notify-settings", () => shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension"));

function setLogin(on) {
  writePrefs({ openAtLogin: on });
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

/** Menu-bar badge: ● when the agent is working, the number of approvals waiting for you. */
async function refreshTray() {
  if (!tray) return;
  try {
    const r = await fetch(`${ORIGIN}/api/agent/tasks`, { signal: AbortSignal.timeout(2000) });
    const { tasks = [], monitors = [] } = await r.json();
    const waiting = [...tasks, ...monitors].reduce((n, t) => n + (t.pending?.length ?? 0), 0);
    const working = tasks.some((t) => t.status === "running" && t.mode === "action");
    if (convPhase !== "off") return; // the conversation status owns the title while it is on
    tray.setTitle(waiting ? ` ${waiting}` : unreadImportant ? ` ${unreadImportant}` : working ? " ●" : "", { fontType: "monospacedDigit" });
    tray.setToolTip(waiting ? `Marigold — ${waiting} waiting for you` : unreadImportant ? `Marigold — ${unreadImportant} important update${unreadImportant > 1 ? "s" : ""}` : working ? "Marigold — working" : "Marigold");
  } catch { /* engine restarting */ }
}

// ------------------------------------------------------------------ native bridges

// Touch ID for money approvals: the macOS prompt, then the engine is told (with the secret
// only this process knows) that THIS approval was verified.
ipcMain.handle("touch-id", async (_e, { stepId, reason, test }) => {
  if (!systemPreferences.canPromptTouchID()) return { ok: false, error: "Touch ID isn't available on this Mac." };
  try {
    await systemPreferences.promptTouchID(String(reason || "approve this payment").slice(0, 120));
  } catch {
    return { ok: false, error: "Touch ID was cancelled." };
  }
  if (test) return { ok: true };
  if (!ownsServer) return { ok: false, error: "Restart Marigold (the engine was started outside the app)." };
  const r = await fetch(`${ORIGIN}/api/agent/approve-native`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-marigold-secret": SECRET },
    body: JSON.stringify({ id: stepId }),
  }).then((x) => x.json()).catch(() => ({ ok: false }));
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Couldn't approve." };
});
// Side-by-side view: this window becomes a narrow chat strip (1/4 the width of the app) on the left of the screen
// and hands back the area on the right for the app the agent is using. (Chats live in this one window, so it stays
// the same window — macOS doesn't let an app create a new desktop.)
let viewSaved = null;
/** Glide the window to new bounds (eased, ~60 fps) instead of jumping. */
function glideTo(win, to, ms = 340) {
  return new Promise((resolve) => {
    const from = win.getBounds(), t0 = Date.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = () => {
      if (win.isDestroyed()) return resolve();
      const k = Math.min(1, (Date.now() - t0) / ms), e = ease(k);
      win.setBounds({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e), width: Math.round(from.width + (to.width - from.width) * e), height: Math.round(from.height + (to.height - from.height) * e) });
      if (k < 1) setTimeout(step, 16); else resolve();
    };
    step();
  });
}
ipcMain.handle("view-enter", async () => {
  ensureMain();
  if (mainWin.isFullScreen()) { mainWin.setFullScreen(false); await new Promise((r) => setTimeout(r, 900)); }
  if (!viewSaved) viewSaved = { bounds: mainWin.getBounds(), min: mainWin.getMinimumSize(), maximized: mainWin.isMaximized() };
  if (mainWin.isMaximized()) mainWin.unmaximize();
  const wa = screen.getDisplayMatching(mainWin.getBounds()).workArea;
  const strip = Math.round(wa.width / 5); // app = 4 parts, Marigold = 1
  mainWin.setMinimumSize(280, 420);
  mainWin.show();
  await glideTo(mainWin, { x: wa.x + wa.width - strip, y: wa.y, width: strip, height: wa.height }); // Marigold on the right
  return { x: wa.x, y: wa.y, w: wa.width - strip, h: wa.height }; // the app takes the left
});
ipcMain.handle("view-exit", async () => {
  if (!viewSaved || !mainWin || mainWin.isDestroyed()) { viewSaved = null; return; }
  const saved = viewSaved;
  viewSaved = null;
  mainWin.setMinimumSize(...saved.min);
  await glideTo(mainWin, saved.bounds);
  if (saved.maximized) mainWin.maximize();
});
ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(mainWin && !mainWin.isDestroyed() ? mainWin : undefined, { title: "Choose a project folder", properties: ["openDirectory", "createDirectory"], defaultPath: path.join(os.homedir(), "Developer") });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle("open-main", (_e, chatId) => { quickWin?.hide(); showMain(chatId); });
ipcMain.handle("hide-quick", () => quickWin?.hide());
ipcMain.handle("engine-retry", async () => {
  try { await startEngine(); engineProblem = ""; if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(ORIGIN); return { ok: true }; }
  catch (err) { engineProblem = String(err.message); if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(engineProblemPage(engineProblem)); return { ok: false }; }
});
ipcMain.handle("show-log", () => { shell.showItemInFolder(LOG); });
ipcMain.handle("app-info", () => ({ version: app.getVersion(), ownsServer, hotkey: "⌥⇧Space" }));

// Sign-in links open in the user's browser; that page hands the session to the engine, and
// we pass it to the app's windows (only we hold the secret to collect it).
async function pollHandoff() {
  if (!ownsServer) return;
  try {
    const r = await fetch(`${ORIGIN}/api/app/handoff`, { headers: { "x-marigold-secret": SECRET } });
    if (r.status === 200) {
      const tokens = await r.json();
      for (const w of [mainWin, quickWin]) if (w && !w.isDestroyed()) w.webContents.send("auth-handoff", tokens);
      showMain();
    }
  } catch { /* fine */ }
}

// ------------------------------------------------------------------ pings → native notifications
//
// Rules (so Marigold never bombards you):
//  • You're IN Marigold (main window or menu-bar panel focused) → no macOS notification at all;
//    it lands in the bell (and the page marks it read if you're already looking at that chat).
//  • You're elsewhere → a macOS notification — but:
//      – 3+ arriving together → ONE summary notification;
//      – each kind at most once a minute (time-sensitive ones — a meeting starting, an approval
//        waiting — always go through); the rest stay in the bell;
//      – a newer ping about the same chat replaces the older notification.

const pingsSince = Date.now();
const pingsSeen = new Set();
const lastByKind = new Map();
const shownByChat = new Map();
const keepNotes = new Set(); // hold references so click handlers survive GC
const URGENT = new Set(["calendar", "needs_you", "battery", "briefing"]);
const logN = (m) => { try { fs.appendFileSync(LOG, `[marigold] notify: ${m}\n`); } catch {} };

function userInMarigold() {
  const f = (w) => w && !w.isDestroyed() && w.isVisible() && w.isFocused();
  return f(mainWin) || f(quickWin);
}

function openFromPing(p) {
  if (p.url && /^https?:/.test(p.url)) { showMain(); mbrowser.openUrl(p.url); mainWin?.webContents.send("open-tab", "browser"); }
  else showMain(p.chatId);
  if (!p.chatId && !p.url) mainWin?.webContents.send("open-pings");
}

// Electron 36 only speaks the old NSUserNotification API, which current macOS drops silently —
// so notifications go through a tiny bundled helper that uses Apple's UserNotifications.
// Clicking one opens a marigold:// link, handled below (open-url).
const NOTIFIER = app.isPackaged
  ? path.join(process.resourcesPath, "Marigold Notifier.app", "Contents", "MacOS", "MarigoldNotifier")
  : path.join(__dirname, "..", "build", "notifier", "Marigold Notifier.app", "Contents", "MacOS", "MarigoldNotifier");

function showNative(title, body, onClick, chatId, link, opts = {}) {
  if (fs.existsSync(NOTIFIER)) {
    const open = link ?? (chatId ? `marigold://chat/${encodeURIComponent(chatId)}` : "marigold://pings");
    // Briefings carry several bullets: give them room. Everything else stays short.
    const args = ["--title", String(title).slice(0, 120), "--body", String(body).slice(0, opts.long ? 420 : 300), "--open", open, "--group", chatId ? `chat-${chatId}` : "marigold", "--sound", opts.sound ?? "default"];
    if (opts.kind) args.push("--kind", opts.kind);
    if (chatId) args.push("--id", `chat-${chatId}`); // a newer ping about the same chat replaces the old banner
    const child = spawn(NOTIFIER, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => logN(code === 0 ? `shown “${title}”` : code === 2 ? "not allowed — turn on notifications for Marigold in System Settings → Notifications" : `failed (${code}) ${err.trim()}`));
    return;
  }
  if (!Notification.isSupported()) { logN("not supported"); return; }
  if (chatId && shownByChat.has(chatId)) { try { shownByChat.get(chatId).close(); } catch {} }
  const n = new Notification({ title, body, silent: false });
  keepNotes.add(n);
  if (chatId) shownByChat.set(chatId, n);
  n.on("click", () => { keepNotes.delete(n); onClick(); });
  n.on("close", () => { keepNotes.delete(n); if (chatId && shownByChat.get(chatId) === n) shownByChat.delete(chatId); });
  n.on("show", () => logN(`shown “${title}”`));
  n.on("failed", (_e, err) => logN(`failed “${title}”: ${err}`));
  n.show();
}

// ---- How notifications are paced -------------------------------------------------------------
// critical (needs you / meeting soon / briefing / battery): always a banner with its own sound, and an on-screen
//   card inside Marigold. normal / low: bell only while you're in Marigold; when you're away at most 3 quiet
//   banners per 30 minutes, then one "N more waiting" summary. Per-kind snooze comes from the banner's button;
//   "Pause non-urgent" is in the menu-bar menu.
const SOUND = { briefing: "Glass", calendar: "Ping", needs_you: "Hero", battery: "Basso", normal: "Tink", low: "none" };
const BUDGET = { windowMs: 30 * 60_000, max: 3 };
const bannerTimes = [];            // when recent non-critical banners were shown
let heldCount = 0, lastSummaryAt = 0, lastBannerAt = 0;
const mutedKinds = new Map();      // kind → until (from the banner's "Quiet these for 1 hour")
let quietUntil = 0;                // global "pause non-urgent"
let unreadImportant = 0;           // for the menu-bar count
const priorityOf = (p) => p.priority ?? (URGENT.has(p.kind) ? "critical" : "normal");

function muteKind(kind, mins) {
  mutedKinds.set(String(kind), Date.now() + Math.max(1, Math.min(24 * 60, Number(mins) || 60)) * 60_000);
  logN(`quiet: ${kind} for ${mins} min`);
}
const isMuted = (kind) => (mutedKinds.get(kind) ?? 0) > Date.now();
const nonUrgentPaused = () => quietUntil > Date.now();

/** Pings held back by the pacing rules become ONE gentle summary after a quiet spell (never a stream of banners). */
function flushHeld() {
  const now = Date.now();
  if (heldCount > 0 && !userInMarigold() && !nonUrgentPaused() && now - lastBannerAt > 4 * 60_000 && now - lastSummaryAt > 10 * 60_000) {
    lastSummaryAt = now;
    showNative(`${heldCount} more update${heldCount > 1 ? "s" : ""} from Marigold`, "They're waiting in the bell.", () => { showMain(); mainWin?.webContents.send("open-pings"); }, undefined, undefined, { sound: "none", kind: "summary" });
    heldCount = 0;
  }
  if (userInMarigold()) heldCount = 0; // you're looking at the bell now
}

async function pollPings() {
  let all;
  try { all = (await (await fetch(`${ORIGIN}/api/agent/pings`)).json()).pings ?? []; } catch { return; }
  // Menu-bar / dock cue: how many important things are still unread.
  unreadImportant = all.filter((p) => !p.read && priorityOf(p) === "critical" && Date.parse(p.at) >= pingsSince - 86_400_000).length;
  try { app.dock?.setBadge(unreadImportant ? String(unreadImportant) : ""); } catch {}
  const fresh = [];
  for (const p of [...all].reverse()) {
    if (pingsSeen.has(p.id)) continue;
    pingsSeen.add(p.id);
    if (Date.parse(p.at) < pingsSince - 5000 || p.read) continue; // older than this launch, or already seen in the app
    fresh.push(p);
  }
  if (pingsSeen.size > 3000) pingsSeen.clear();
  if (!fresh.length) return;
  for (const w of [mainWin, quickWin]) if (w && !w.isDestroyed()) for (const p of fresh) w.webContents.send("ping", p);
  const inApp = userInMarigold();
  const now = Date.now();

  // ---- critical: always speaks
  const critical = fresh.filter((p) => priorityOf(p) === "critical");
  if (critical.length) {
    // While you're inside Marigold a needs-you card is already in front of you: the on-screen card + menu-bar count are enough.
    const banners = critical.filter((p) => !(inApp && p.kind === "needs_you"));
    if (!inApp) try { app.dock?.bounce(critical.some((p) => p.kind === "needs_you") ? "critical" : "informational"); } catch {}
    if (banners.length > 3) showNative(`${banners.length} important updates`, banners.map((p) => p.title).slice(0, 4).join(" · "), () => { showMain(); mainWin?.webContents.send("open-pings"); }, undefined, undefined, { sound: SOUND.needs_you, kind: "briefing" });
    else for (const p of banners) showNative(p.title, p.body, () => openFromPing(p), p.chatId, p.url && /^https?:/.test(p.url) ? `marigold://open?url=${encodeURIComponent(p.url)}` : undefined, { sound: SOUND[p.kind] ?? SOUND.needs_you, kind: p.kind, long: p.kind === "briefing" });
  }

  // ---- everything else: quiet, capped
  const rest = fresh.filter((p) => priorityOf(p) !== "critical" && !isMuted(p.kind));
  if (!rest.length || inApp || nonUrgentPaused()) return; // in the app the bell has it
  while (bannerTimes.length && now - bannerTimes[0] > BUDGET.windowMs) bannerTimes.shift();
  // One banner per kind per minute, newest wins.
  const perKind = rest.filter((p) => now - (lastByKind.get(p.kind) ?? 0) > 60_000);
  const room = Math.max(0, BUDGET.max - bannerTimes.length);
  const show = perKind.slice(0, room);
  heldCount += rest.length - show.length;
  for (const p of show) {
    lastByKind.set(p.kind, now); bannerTimes.push(now); lastBannerAt = now;
    showNative(p.title, p.body, () => openFromPing(p), p.chatId, p.url && /^https?:/.test(p.url) ? `marigold://open?url=${encodeURIComponent(p.url)}` : undefined, { sound: SOUND[priorityOf(p)], kind: p.kind });
  }
  // The overflow becomes ONE gentle summary (at most every 30 min), never a stream of banners.
  if (heldCount > 0 && bannerTimes.length >= BUDGET.max && now - lastSummaryAt > BUDGET.windowMs) {
    lastSummaryAt = now;
    showNative(`${heldCount} more update${heldCount > 1 ? "s" : ""} from Marigold`, "They're waiting in the bell.", () => { showMain(); mainWin?.webContents.send("open-pings"); }, undefined, undefined, { sound: "none", kind: "summary" });
    heldCount = 0;
  }
}

// ------------------------------------------------------------------ lifecycle

app.whenReady().then(async () => {
  app.setName("Marigold");
  // Widevine (Netflix, Disney+, Spotify…): only in the castlabs Electron build; the module is
  // downloaded by Chromium's component updater on first launch. Stock Electron skips this.
  const { components } = require("electron");
  if (components?.whenReady) {
    try { await components.whenReady(); fs.appendFileSync(LOG, `[marigold] widevine: ${JSON.stringify(components.status())}\n`); }
    catch (e) { try { fs.appendFileSync(LOG, `[marigold] widevine unavailable: ${e}\n`); } catch {} }
  }
  const perms = permissionStatus();
  try { fs.appendFileSync(LOG, `[marigold] permissions: accessibility=${perms.accessibility} screen=${perms.screen} mic=${systemPreferences.getMediaAccessStatus("microphone")} camera=${systemPreferences.getMediaAccessStatus("camera")}\n`); } catch {}
  if (!perms.accessibility || !perms.screen) setTimeout(() => showPermissions(), 4000);
  if (process.platform === "darwin") app.dock.setIcon(path.join(__dirname, "assets", "icon.iconset", "icon_512x512.png"));

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png")));
  tray.setToolTip("Marigold — starting…");
  tray.on("click", () => toggleQuick(true));
  tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));

  const prefs = readPrefs();
  // On by default (toggle in the menu). Only the installed app registers itself — never a dev run.
  if (app.isPackaged) setLogin(prefs.openAtLogin !== false);
  globalShortcut.register(HOTKEY, () => toggleQuick(false));
  globalShortcut.register("Alt+Shift+V", () => toggleConversation());
  // Meeting notes: the main window may ask for the sound this Mac is playing (the other people on a call). Only our own page, only audio is used.
  try {
    require("electron").session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (!String(request.frame?.url ?? "").startsWith(ORIGIN)) return callback({});
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
        callback(sources[0] ? { video: sources[0], audio: "loopback" } : {});
      } catch { callback({}); }
    }, { useSystemPicker: false });
  } catch (e) { try { fs.appendFileSync(LOG, `[marigold] system audio handler unavailable: ${e}\n`); } catch {} }
  const upd = updater.start({ app, dialog, shell, getWindow: () => mainWin });
  // The app's own menu bar: the default menus plus a Talk menu (the shortcut label is shown; the page handles the key itself).
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Marigold", submenu: [{ role: "about" }, { label: "Check for Updates…", click: () => void upd.check() }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "Talk", submenu: [{ label: "Listen for “Hey Marigold”", accelerator: "CmdOrCtrl+Shift+V", registerAccelerator: false, click: () => toggleConversation() }, { label: "Dictate into the message box", accelerator: "CmdOrCtrl+Shift+D", registerAccelerator: false, click: () => mainWin?.webContents.send("dictate-toggle") }] },
    { label: "File", submenu: [{ label: "New Marigold Window", accelerator: "CmdOrCtrl+N", click: () => newWindow() }, { type: "separator" }, { role: "close" }] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Marigold on the web", click: () => shell.openExternal("https://github.com") }].slice(0, 0) },
  ]));

  // The Marigold Browser's private control channel — its port goes to the engine we start.
  const browserPort = await mbrowser.init({ win: () => (mainWin && !mainWin.isDestroyed() ? mainWin : null), ensure: ensureMain, secret: SECRET, onLink: (l) => handleLink(l) });
  process.env.MARIGOLD_BROWSER_PORT = String(browserPort);

  try {
    await startEngine();
    engineProblem = "";
  } catch (err) {
    engineProblem = String(err.message);
    tray.setToolTip(engineProblem);
    if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(engineProblemPage(engineProblem));
  }
  tray.setToolTip("Marigold");
  const launchedAtLogin = app.getLoginItemSettings().wasOpenedAsHidden;
  if (!launchedAtLogin) showMain();
  setInterval(refreshTray, 3000);
  for (const l of pendingLinks.splice(0)) handleLink(l); // a notification clicked while Marigold was starting
  setInterval(pollHandoff, 2000);
  setInterval(pollPings, 3000);
  setInterval(flushHeld, 60_000);
  // Watchdog: if the engine is gone (crashed, or a reused one exited), start our own again.
  let restarting = false;
  setInterval(async () => {
    if (restarting || quitting || server) return;
    if ((await status())?.marigold) return;
    restarting = true;
    try { await startEngine(); } catch (e) { try { fs.appendFileSync(LOG, `[marigold] engine restart failed: ${e}\n`); } catch {} }
    restarting = false;
  }, 5000);
});

app.on("activate", () => showMain());
app.on("before-quit", () => { quitting = true; mbrowser.markCleanExit(); });
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (server) server.kill("SIGTERM");
});
app.on("window-all-closed", (e) => e.preventDefault()); // live in the menu bar
