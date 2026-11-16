// Chrome-extension compatibility shim for the Marigold Browser.
//
// Electron implements only PART of Chrome's extension API. An extension's background worker
// that touches a missing piece (chrome.windows.onFocusChanged, chrome.tabs.onRemoved,
// chrome.commands.onCommand, chrome.storage.managed, chrome.tabs.create …) throws on its first
// line and never starts — so it silently does nothing.
//
// This file runs inside every extension's background service worker BEFORE the extension's own
// code (Session.registerPreloadScript, type "service-worker"). It wraps `chrome` so that:
//   • anything Electron lacks becomes a safe stand-in: events that never fire, calls that resolve
//     with nothing, so the extension starts and its working parts (content scripts, popups,
//     storage, messaging, cookies, web requests) keep working;
//   • the few things that matter get a real implementation: tabs.create / windows.create open a
//     tab in the Marigold Browser, alarms run on timers, chrome.storage.managed is empty,
//     idle is "active", commands list is empty.
// Nothing here weakens security — it only stops missing APIs from crashing the extension.

function installShim() {

  const listeners = new Map();
  const eventStub = (key) => {
    if (!listeners.has(key)) {
      const set = new Set();
      listeners.set(key, {
        addListener: (f) => { if (typeof f === "function") set.add(f); },
        removeListener: (f) => { set.delete(f); },
        hasListener: (f) => set.has(f),
        hasListeners: () => set.size > 0,
        addRules() {}, removeRules() {}, getRules(_a, cb) { cb?.([]); },
        _fire: (...a) => set.forEach((f) => { try { f(...a); } catch { /* the extension's own error */ } }),
      });
    }
    return listeners.get(key);
  };
  // A call we don't have: calls back / resolves with `value` (undefined unless we know better).
  const answer = (value) => (...args) => {
    const cb = args.length && typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
    if (cb) { try { cb(value); } catch { /* ignore */ } return undefined; }
    return Promise.resolve(value);
  };

  const FALLBACK_WINDOW = { id: 1, focused: true, type: "normal", state: "normal", incognito: false, alwaysOnTop: false, left: 0, top: 0, width: 1280, height: 860, tabs: [] };
  const openTab = (opts) => { const url = opts && (opts.url || (Array.isArray(opts.url) ? opts.url[0] : "")); if (url && globalThis.__mgExt) globalThis.__mgExt.open(String(url)); return { id: -1, windowId: 1, index: 0, url: String(url || ""), active: true, pinned: false, highlighted: true, incognito: false, status: "loading" }; };

  // Things with a real (if small) implementation, by "namespace.member".
  const IMPL = {
    "tabs.create": (...a) => { const t = openTab(a[0]); const cb = typeof a.at(-1) === "function" ? a.at(-1) : null; if (cb) { cb(t); return undefined; } return Promise.resolve(t); },
    "windows.create": (...a) => { const t = openTab(a[0]); const w = { ...FALLBACK_WINDOW, tabs: [t] }; const cb = typeof a.at(-1) === "function" ? a.at(-1) : null; if (cb) { cb(w); return undefined; } return Promise.resolve(w); },
    "windows.getAll": answer([FALLBACK_WINDOW]),
    "windows.getCurrent": answer(FALLBACK_WINDOW),
    "windows.getLastFocused": answer(FALLBACK_WINDOW),
    "windows.get": answer(FALLBACK_WINDOW),
    "windows.update": answer(FALLBACK_WINDOW),
    "commands.getAll": answer([]),
    "idle.queryState": answer("active"),
    "permissions.contains": answer(true),
    "permissions.request": answer(true),
    "permissions.getAll": answer({ permissions: [], origins: [] }),
    "management.getSelf": answer({ id: "", enabled: true, installType: "normal" }),
    "identity.launchWebAuthFlow": () => Promise.reject(new Error("Signing in through this extension isn't available in the Marigold Browser.")),
    "identity.getAuthToken": () => Promise.reject(new Error("Signing in through this extension isn't available in the Marigold Browser.")),
    "identity.getRedirectURL": () => "https://marigold.invalid/",
    "offscreen.hasDocument": answer(false),
    "sidePanel.setPanelBehavior": answer(undefined),
  };

  // chrome.alarms on plain timers (the worker may be stopped by Chromium; alarms re-arm on restart like Chrome's).
  const timers = new Map();
  const alarmEvent = eventStub("alarms.onAlarm");
  const arm = (name, info) => {
    clearTimeout(timers.get(name)?.t); clearInterval(timers.get(name)?.i);
    const first = Math.max(1000, (info.delayInMinutes ?? info.periodInMinutes ?? 1) * 60_000);
    const rec = { info, scheduledTime: Date.now() + first };
    rec.t = setTimeout(() => {
      alarmEvent._fire({ name, scheduledTime: rec.scheduledTime, periodInMinutes: info.periodInMinutes });
      if (info.periodInMinutes) rec.i = setInterval(() => alarmEvent._fire({ name, scheduledTime: Date.now(), periodInMinutes: info.periodInMinutes }), Math.max(1000, info.periodInMinutes * 60_000));
      else timers.delete(name);
    }, first);
    timers.set(name, rec);
  };
  IMPL["alarms.create"] = (...a) => { const [n, i] = typeof a[0] === "string" ? [a[0], a[1] || {}] : ["", a[0] || {}]; arm(n, i); const cb = a.at(-1); if (typeof cb === "function") cb(); return Promise.resolve(); };
  IMPL["alarms.get"] = (...a) => { const r = timers.get(typeof a[0] === "string" ? a[0] : ""); const v = r ? { name: a[0], scheduledTime: r.scheduledTime, periodInMinutes: r.info.periodInMinutes } : undefined; return answer(v)(...a.slice(1)); };
  IMPL["alarms.getAll"] = answer([...timers].map(([name, r]) => ({ name, scheduledTime: r.scheduledTime, periodInMinutes: r.info.periodInMinutes })));
  IMPL["alarms.clear"] = (...a) => { const n = typeof a[0] === "string" ? a[0] : ""; const had = timers.has(n); clearTimeout(timers.get(n)?.t); clearInterval(timers.get(n)?.i); timers.delete(n); return answer(had)(...a.slice(typeof a[0] === "string" ? 1 : 0)); };
  IMPL["alarms.clearAll"] = answer(true);
  IMPL["alarms.onAlarm"] = null; // handled as an event below

  const wrap = (obj, path) => new Proxy(obj, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      const full = path ? `${path}.${key}` : String(key);
      let v;
      try { v = target[key]; } catch { v = undefined; } // e.g. chrome.storage.managed throws "not available"
      // Our own implementation wins where Electron's is missing or known-poor.
      if (full === "alarms.onAlarm") return alarmEvent;
      if (Object.prototype.hasOwnProperty.call(IMPL, full) && IMPL[full]) return v === undefined || ["tabs.create", "windows.create"].includes(full) ? IMPL[full] : (typeof v === "function" ? v.bind(target) : v);
      if (v !== undefined && v !== null) {
        if (typeof v === "function") return v.bind(target);
        if (typeof v === "object" && path.split(".").length < 2) return wrap(v, full); // namespaces and their members
        return v;
      }
      // Missing: an event that never fires, or a call that resolves with nothing.
      if (/^on[A-Z]/.test(String(key))) return eventStub(full);
      if (full === "storage.managed") return { get: answer({}), getBytesInUse: answer(0), onChanged: eventStub("storage.managed.onChanged") };
      return answer(undefined);
    },
    has(target, key) { return true; },
  });

  // A whole namespace Electron doesn't have (chrome.windows, chrome.commands …) → an empty wrapped one.
  const wrapRoot = (real) => new Proxy(real, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      let v;
      try { v = target[key]; } catch { v = undefined; }
      const name = String(key);
      if (typeof v === "function") return v.bind(target);
      if (v !== undefined && v !== null && typeof v !== "object") return v;
      return wrap(v && typeof v === "object" ? v : {}, name);
    },
    has() { return true; },
  });

  const install = (real) => { try { return wrapRoot(real); } catch { return real; } };
  try {
    if (globalThis.chrome) {
      Object.defineProperty(globalThis, "chrome", { value: install(globalThis.chrome), configurable: true, writable: true });
    } else {
      // `chrome` shows up later → wrap it the moment it's assigned.
      let held;
      Object.defineProperty(globalThis, "chrome", { configurable: true, get: () => held, set: (x) => { held = x && typeof x === "object" ? install(x) : x; } });
    }
  } catch { /* leave chrome as Electron provides it */ }
}

// The preload runs in an ISOLATED context: it can talk to the app (ipc) but can't reach the
// worker's own `chrome`. So: expose a tiny "open this tab" bridge, then run the shim in the main world.
try {
  const { contextBridge, ipcRenderer } = require("electron");
  try { contextBridge.exposeInMainWorld("__mgExt", { open: (u) => ipcRenderer.send("mg-ext-open", String(u)) }); } catch (e) { console.error("[mg-shim] bridge failed", String(e)); }
  contextBridge.executeInMainWorld({ func: installShim });
} catch (e) {
  console.error("[mg-shim] couldn't install into the worker:", String(e));
}
