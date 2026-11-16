import { appBrowserAvailable } from "./app-browser";
import { execFile, spawn } from "child_process";
import { readFileSync, promises as fsp } from "fs";
import { promisify } from "util";
import os from "os";
import path from "path";
import { looksFinancial, sensitivePath, expandPath, MARIGOLD_DIR, type Classified } from "./policy";
import { browserByName, type BrowserInfo } from "@/lib/browsers";
import { mainBrowserSync } from "./prefs";
import { waitForUser } from "./windows";
import { helperBin } from "./helpers";

// ============================================================== in-page browser control
// Runs small DOM scripts in the active tab via AppleScript (Safari "do JavaScript",
// Chromium "execute javascript"). The last `elements` list is cached so a click
// by number can be safety-classified by its real label BEFORE it happens.

interface PageEl { kind: string; label: string; ac: string }
/** Title of the page the agent is working on (the View shows that browser window, not the user's). */
export const agentPageTitle = () => pageCache.title ?? "";
export const pageCache = ((globalThis as { __marigoldPage?: { url: string; els: PageEl[]; title?: string } }).__marigoldPage ??= { url: "", els: [] });

const MONEY_UI = /apple\s?pay|google\s?pay|pay\s?pal|checkout|check out|place (your )?order|pay now|\bpay\b|buy now|\bbuy\b|purchase|subscribe|upgrade plan|confirm (order|payment|purchase)|donate|add (a )?card|billing|complete order|book now|reserve/i;
const OUTWARD_UI = /\b(send|post|submit|publish|reply|tweet|share|comment|delete|remove|sign up|register|confirm|accept|invite|unsubscribe|log ?out|sign ?out|transfer|save changes)\b/i;

/** 0.4 → 40 (some models send a fraction for "40 percent"); 40 stays 40. */
const pct = (v: number) => (v > 0 && v <= 1 ? Math.round(v * 100) : v);

export function classifyBrowser(act: string, a: Args): Classified {
  const b = !str(a, "browser") && appBrowserAvailable() ? "Marigold Browser" : pickBrowser(str(a, "browser")).label;
  const idx = num(a, "index", -1);
  const el = idx >= 0 ? pageCache.els[idx] : undefined;
  // Judge by BOTH the cached label and any text the model gave — the riskier one wins.
  const label = [el?.label, str(a, "text")].filter(Boolean).join(" · ");
  let host = "";
  try { host = new URL(str(a, "url") || pageCache.url).hostname; } catch { /* none */ }
  const what = str(a, "url") || str(a, "query") || label;
  const summary = `${b}: ${act.replace("_", " ")}${what ? ` “${what.slice(0, 60)}”` : ""}${host && ["click", "type", "select", "press"].includes(act) ? ` on ${host}` : ""}`;

  // Money: any pay/buy/checkout control, card fields, or a checkout page → Touch ID every time.
  const cardField = /^cc-/.test(el?.ac ?? "") || /card number|cvv|cvc|expir|security code/i.test(label);
  const moneyPage = /checkout|payment|billing|\/pay\b|cart/i.test(pageCache.url) && ["click", "press"].includes(act);
  // Shop names alone ("Search Amazon" box, amazon.com) aren't spending; buy buttons and checkout are.
  const whatForMoney = what.replace(/\b(amazon|app ?store|ebay|walmart|target|etsy|bestbuy|best buy)\b/gi, "");
  if (looksFinancial(whatForMoney) || (["click", "press", "type"].includes(act) && (MONEY_UI.test(label) || cardField || moneyPage)))
    return { tier: 3, scope: "finance:browser", outward: true, summary: `💳 ${summary}` };
  if (act === "type" && el?.kind.includes("password")) return { tier: 2, scope: "browser:password", noRemember: true, outward: true, summary: `${b}: type a password on ${host || "this page"}` };
  if ((act === "click" || act === "press") && (OUTWARD_UI.test(label) || (act === "press" && /enter/i.test(str(a, "key")))))
    return { tier: 2, scope: `browser:submit:${host || "site"}`, outward: true, summary };
  return { tier: ["list_tabs", "read_page", "elements", "scroll"].includes(act) ? 0 : 1, summary };
}

// The page is driven through macOS Accessibility (scripts/axweb.swift), the same way a
// screen reader works — so no browser setting ("Allow JavaScript from Apple Events")
// is needed, and it works in Chrome, Safari, Arc, Edge, Brave, Firefox, Opera…
async function axweb(args: string[]): Promise<string> {
  const { stdout } = await execAsync(await helperBin("axweb"), args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** Same, pinned to the tab the agent last looked at (by its address) — never "whatever is in front". */
const axPage = (cmd: string, b: BrowserInfo, ...rest: string[]) =>
  axweb([cmd, b.app, ...rest, ...(pageCache.url ? ["--url", pageCache.url] : [])]);

interface AxList { error?: string; title: string; url: string; els: (PageEl & { vis: boolean })[] }
const BLANK_PAGE = /^(favorites:|about:|chrome:\/\/newtab|edge:\/\/newtab|arc:|topsites:)/i;

/** Address of the page in the agent's own window (so we never read the user's window instead). */
async function agentURL(b: BrowserInfo): Promise<string> {
  const id = agentWindows[b.app];
  if (!id || b.kind === "basic") return "";
  const prop = b.kind === "safari" ? "URL of current tab of w" : "URL of active tab of w";
  return osa(`tell application "${as(b.app)}"
  try
    set w to (first window whose id is ${id})
    return ${prop}
  end try
  return ""
end tell`).catch(() => "");
}

async function axList(b: BrowserInfo): Promise<AxList> {
  const pin = await agentURL(b);
  const j = JSON.parse(await axweb(["list", b.app, ...(pin ? ["--url", pin] : [])])) as AxList;
  if (j.error) throw new Error(`AXFAIL ${j.error}`);
  pageCache.url = j.url;
  pageCache.els = j.els;
  pageCache.title = j.title;
  return j;
}

/** Element number to act on: the given index, or (for click) the element whose label matches `text`. */
async function targetIndex(b: BrowserInfo, act: string, a: Args): Promise<number> {
  const i = num(a, "index", -1);
  if (i >= 0 || act !== "click") return i;
  const want = str(a, "text").toLowerCase();
  if (!want) return -1;
  const { els } = await axList(b);
  const exact = els.findIndex((e) => e.label.toLowerCase() === want);
  return exact >= 0 ? exact : els.findIndex((e) => e.label.toLowerCase().includes(want));
}

/** Type text into the focused field: keystrokes for short plain text, a paste (clipboard restored) otherwise. */
async function typeText(b: BrowserInfo, text: string, replace: boolean): Promise<boolean> {
  const app = as(b.app);
  // Keystrokes go to whatever window is in front: re-confirm it's OUR page right before typing.
  if ((await axPage("frontcheck", b)) !== "ok") return false;
  const plain = /^[\x20-\x7E]*$/.test(text) && text.length <= 300;
  const selectAll = replace ? 'keystroke "a" using command down\n  delay 0.1\n  ' : "";
  if (plain) {
    await osa(`tell application "System Events" to tell process "${app}"
  ${selectAll}keystroke "${as(text)}"
end tell`);
    return true;
  }
  const saved = await execAsync("pbpaste", [], { encoding: "utf8" }).then((r) => r.stdout).catch(() => "");
  await new Promise<void>((res, rej) => { const c = execFile("pbcopy", (err) => (err ? rej(err) : res())); c.stdin?.end(text); });
  await osa(`tell application "System Events" to tell process "${app}"
  ${selectAll}keystroke "v" using command down
end tell`);
  await new Promise((r) => setTimeout(r, 400));
  if (saved) await new Promise<void>((res) => { const c = execFile("pbcopy", () => res()); c.stdin?.end(saved); });
  return true;
}

const NOT_FRONT = "FAILED: couldn't bring the page's window to the front, so nothing was typed or pressed (keys would have gone to a different window). Ask the user to leave the browser window alone for a moment, or call elements again.";

async function pageAction(b: BrowserInfo, act: string, a: Args): Promise<string> {
  const app = as(b.app);
  // The user opened this browser from the View to use it themselves → don't touch it until they leave.
  if (act !== "elements") await waitForUser(b.app);
  try {
    let idx = -1;
    if (["click", "type", "select"].includes(act)) {
      idx = await targetIndex(b, act, a);
      if (idx < 0 && act !== "type") return `FAILED: no element matching “${str(a, "text")}” — call elements to see what's on the page.`;
      // Last-moment safety re-check: read the REAL element (label, kind, page URL) and refuse
      // if it's riskier than what was approved (e.g. a stale index that's now "Buy with Apple Pay").
      if (idx >= 0) {
        const cachedLabel = pageCache.els[idx]?.label;
        const raw = await axPage("info", b, String(idx));
        if (raw === "NOELEM") return "FAILED: that element isn't on the page anymore — call elements again.";
        const info = JSON.parse(raw) as { kind: string; label: string; url: string; value?: string; error?: string };
        if (info.error) throw new Error(`AXFAIL ${info.error}`);
        // The element at this number must still be the one the agent saw.
        if (cachedLabel !== undefined && num(a, "index", -1) >= 0 && cachedLabel !== info.label) {
          return `FAILED: the page changed — element ${idx} is now “${info.label}”, not “${cachedLabel}”. Nothing was done. Call elements again.`;
        }
        const approved = classifyBrowser(act, a);
        const saved = { url: pageCache.url, els: pageCache.els };
        pageCache.url = info.url || pageCache.url;
        pageCache.els = [{ kind: info.kind, label: info.label, ac: "" }];
        const real = classifyBrowser(act, { ...a, index: 0, text: act === "click" ? str(a, "text") : "" });
        pageCache.url = saved.url; pageCache.els = saved.els;
        if (real.tier > approved.tier) {
          return `BLOCKED: that ${act} targets “${info.label || info.kind}”${real.tier === 3 ? " — a payment/purchase control" : ""}, which needs ${real.tier === 3 ? "Touch ID" : "the user's OK"}. Call web_browser ${act} again with text="${info.label.replace(/"/g, "")}" so Marigold can ask properly.`;
        }
      }
    }
    switch (act) {
      case "elements": {
        const j = await axList(b);
        const lines = j.els.map((e, i) =>
          `[${i}] ${e.kind}${e.label ? ` “${e.label}”` : ""}${/card number|cvv|cvc|security code/i.test(e.label) ? " (card field)" : ""}${e.vis ? "" : " (scroll to see)"}`);
        return clip(`${j.title} — ${j.url}\n${lines.join("\n") || "(no interactive elements yet — the page may still be loading; try again)"}`);
      }
      case "click": {
        const r = await axPage("press", b, String(idx));
        if (r === "NOELEM") return "FAILED: that element isn't on the page anymore — call elements again.";
        if (r === "NOFRONT") return NOT_FRONT;
        await new Promise((res) => setTimeout(res, 1200));
        return `Clicked “${r.replace(/^ok ?/, "") || `element ${idx}`}”. The page may have changed — call elements again before the next click.`;
      }
      case "type": {
        if (idx < 0) return "FAILED: say which field to type into (index from elements).";
        // 1st choice: fill it in the background (no window raise — works while the user is in other tabs/apps).
        const bg = await axweb(["setvalue", b.app, String(idx), str(a, "text"), ...(pageCache.url ? ["--url", pageCache.url] : [])]);
        if (bg === "NOELEM") return "FAILED: that field isn't on the page anymore — call elements again.";
        if (bg === "ok") return `Typed into field ${idx} (“${pageCache.els[idx]?.label ?? ""}”).`;
        // Rich editors (e.g. Gmail's message body) need real keystrokes → bring the page forward.
        const f = await axPage("focus", b, String(idx));
        if (f === "NOELEM") return "FAILED: that field isn't on the page anymore — call elements again.";
        if (f === "NOFRONT") return NOT_FRONT;
        if (f === "NOFOCUS") return "FAILED: couldn't put the cursor in that field (it may be read-only or covered). Try clicking it first, then type.";
        if (!(await typeText(b, str(a, "text"), true))) return NOT_FRONT;
        return `Typed into field ${idx} (“${pageCache.els[idx]?.label ?? ""}”).`;
      }
      case "select": {
        // Native dropdown: focus it and type the option's name (how a keyboard user picks one), then verify.
        const f = await axPage("focus", b, String(idx));
        if (f === "NOELEM") return "FAILED: that dropdown isn't on the page anymore — call elements again.";
        if (f === "NOFRONT") return NOT_FRONT;
        if (!(await typeText(b, str(a, "text"), false))) return NOT_FRONT;
        await new Promise((res) => setTimeout(res, 300));
        const read = async () => {
          const r = JSON.parse(await axPage("info", b, String(idx))) as { value?: string; label?: string };
          return (r.value || r.label || "").trim();
        };
        let now = await read();
        if (!now.toLowerCase().includes(str(a, "text").toLowerCase())) {
          // Some browsers ignore type-to-select on a closed dropdown: open it, type, press Return.
          if ((await axPage("press", b, String(idx))) === "NOFRONT") return NOT_FRONT;
          await new Promise((res) => setTimeout(res, 400));
          await osa(`tell application "System Events" to tell process "${app}"
  keystroke "${as(str(a, "text"))}"
  delay 0.2
  key code 36
end tell`);
          await new Promise((res) => setTimeout(res, 300));
          now = await read();
        }
        return now.toLowerCase().includes(str(a, "text").toLowerCase())
          ? `Selected “${now}”.`
          : `FAILED: the dropdown shows “${now || "?"}”, not “${str(a, "text")}”. Check the option names with elements.`;
      }
      case "scroll": {
        const up = /up/i.test(str(a, "direction"));
        if ((await axPage("scroll", b, up ? "up" : "down")) === "NOFRONT") return NOT_FRONT;
        return `Scrolled ${up ? "up" : "down"}. Call elements to see what's visible now.`;
      }
      case "press": {
        if ((await axPage("frontcheck", b)) !== "ok") return NOT_FRONT;
        await osa(`tell application "System Events" to tell process "${app}" to ${keyStroke(str(a, "key"))}`);
        await new Promise((res) => setTimeout(res, 1000));
        return `Pressed ${str(a, "key") || "Enter"}.`;
      }
    }
  } catch (err) {
    const m = String(err);
    if (/AXFAIL/.test(m)) return `FAILED: ${m.replace(/^.*AXFAIL\s*/, "")}`;
    if (/not allowed assistive|assistive access|-1719|-25211/i.test(m)) {
      return "FAILED: macOS Accessibility permission is needed to work inside web pages. Tell the user: System Settings → Privacy & Security → Accessibility → turn on Terminal (the app running Marigold), one time.";
    }
    throw err;
  }
  return "Unknown action.";
}

// The agent browses in ITS OWN window (same profile/logins as the user's), opened on the
// current screen: it never takes over the user's tabs (e.g. a movie they're watching), and
// Chrome only accepts accessibility clicks in windows it's actually drawing.
const agentWindows = ((globalThis as { __marigoldAgentWin?: Record<string, number> }).__marigoldAgentWin ??= {});

/** Load `url` in the agent's window (creating it if needed). Returns true if an existing one was reused. */
async function openInAgentWindow(b: BrowserInfo, url: string): Promise<boolean> {
  const app = as(b.app);
  await waitForUser(b.app);
  const id = agentWindows[b.app];
  const find = id ? `try
    set w to (first window whose id is ${id})
  end try` : "";
  const script = b.kind === "safari"
    ? `tell application "${app}"
  set w to missing value
  set reused to true
  ${find}
  if w is missing value then
    make new document with properties {URL:"${as(url)}"}
    set w to front window
    set reused to false
  else
    try
      set URL of current tab of w to "${as(url)}"
    on error
      make new document with properties {URL:"${as(url)}"}
      set w to front window
      set reused to false
    end try
  end if
  set index of w to 1
  activate
  return (id of w as text) & "," & reused
end tell`
    : `tell application "${app}"
  set w to missing value
  set reused to true
  ${find}
  if w is missing value then
    set w to make new window
    set reused to false
  end if
  try
    set URL of active tab of w to "${as(url)}"
  on error
    set w to make new window
    set reused to false
    set URL of active tab of w to "${as(url)}"
  end try
  set index of w to 1
  activate
  return (id of w as text) & "," & reused
end tell`;
  const [wid, reused] = (await osa(script)).split(",");
  agentWindows[b.app] = Number(wid);
  pageCache.url = url; // until `elements` reads the real (possibly redirected) address
  // Wait (≤6s) until the window has left its blank start page for the real one.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await agentURL(b);
    if (now && !BLANK_PAGE.test(now)) { pageCache.url = now; break; }
  }
  return reused?.trim() === "true";
}

/** Plain text of the current page via Accessibility (works when the browser blocks scripting). */
async function axPageText(b: BrowserInfo): Promise<string> {
  try {
    const j = JSON.parse(await axweb(["text", b.app])) as { title?: string; url?: string; text?: string; error?: string };
    if (j.error || !j.text?.trim()) return "";
    return `${j.title}\n${j.url}\n\n${j.text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()}`;
  } catch { return ""; }
}

function keyStroke(key: string): string {
  const codes: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, up: 126, down: 125, left: 123, right: 124, backspace: 51, delete: 51, space: 49 };
  const c = codes[key.toLowerCase().trim() || "enter"];
  return c !== undefined ? `key code ${c}` : `keystroke "${as(key)}"`;
}

const ACTION_SYNONYMS: Record<string, string[]> = {
  forecast: ["current", "now", "today", "weather", "get", "conditions"],
  headlines: ["top", "latest", "news", "get", "search"],
  quote: ["price", "get", "lookup", "current"],
  list: ["show", "get", "all", "view"],
  play: ["resume", "start"],
  open_url: ["open", "navigate", "goto", "go", "visit"],
  read_page: ["read", "get_text", "text", "content"],
};
function nearestAction(raw: string, actions: string[]): string | undefined {
  const w = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (actions.includes(w)) return w;
  const byName = actions.filter((v) => v.split("_").includes(w) || w.split("_").includes(v) || v === w.replace(/s$/, ""));
  if (byName.length === 1) return byName[0];
  const bySyn = actions.filter((v) => ACTION_SYNONYMS[v]?.includes(w));
  return bySyn.length === 1 ? bySyn[0] : undefined;
}

const DEFAULT_ACTION: Record<string, (a: Args) => string | undefined> = {
  web_browser: (a) => (str(a, "url") ? "open_url" : str(a, "query") ? "search" : "list_tabs"),
  weather: () => "forecast",
  news: () => "headlines",
  stocks: (a) => (str(a, "symbol") ? "quote" : undefined),
};

/** The browser named in the request, else the user's main browser. */
const pickBrowser = (name: string) => browserByName(name) ?? mainBrowserSync();
import type { ToolDef } from "./tools";

/**
 * Tools for the Mac's built-in apps. Each app gets ONE tool with an `action`
 * (keeps the tool list — and the model's prompt — small). Apps with an
 * AppleScript dictionary are driven directly; the rest use URL schemes, live
 * web data, or Marigold-native features (timers/alarms).
 */

const execAsync = promisify(execFile);
type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
const num = (a: Args, k: string, d: number) => (Number.isFinite(Number(a[k])) && a[k] !== "" && a[k] != null ? Number(a[k]) : d);
const as = (t: string) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const clip = (t: string, n = 8000) => (t.length > n ? t.slice(0, n) + "\n…[truncated]" : t);
const s = (description: string) => ({ type: "string", description });

async function osa(script: string, timeout = 60_000): Promise<string> {
  const app = script.match(/application "([^"]+)"/)?.[1];
  // Photos can be very slow on big iCloud libraries — give its events up to 10 minutes.
  if (app === "Photos") {
    script = `with timeout of 600 seconds\n${script}\nend timeout`.replace(/\non minOf[\s\S]*?end minOf/, "") +
      (script.includes("on minOf") ? "\non minOf(a, b)\n  if a < b then return a\n  return b\nend minOf" : "");
    timeout = Math.max(timeout, 610_000);
  }
  try {
    const { stdout } = await execAsync("osascript", ["-e", script], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    if (app === "Photos" && /\((-1712|-609)\)/.test(String(err))) {
      throw new Error("FAILED: Photos isn't responding (it's busy — often syncing iCloud Photos or low on disk space). Tell the user to open Photos once, let it finish loading, then retry.");
    }
    if (app && String(err).includes("(-600)")) {
      await execAsync("open", ["-g", "-a", app]);
      await new Promise((r) => setTimeout(r, 2500));
      const { stdout } = await execAsync("osascript", ["-e", script], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    }
    throw err;
  }
}
const open = (target: string, args: string[] = []) => execAsync("open", [...args, target]);
const notify = (title: string, msg: string) =>
  execAsync("osascript", ["-e", `display notification "${as(msg)}" with title "${as(title)}" sound name "Glass"`]).catch(() => {});

/** AppleScript date literal from an ISO-ish string, built field-by-field (locale-proof). */
const emailsIn = (t: string) => [...new Set(t.match(/[^\s,;<>"]+@[^\s,;<>"]+\.[a-z]{2,}/gi) ?? [])];

function asDate(varName: string, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${iso}" — use ISO format like 2026-11-06T15:00`);
  return `set ${varName} to current date
set day of ${varName} to 1
set year of ${varName} to ${d.getFullYear()}
set month of ${varName} to ${d.getMonth() + 1}
set day of ${varName} to ${d.getDate()}
set hours of ${varName} to ${d.getHours()}
set minutes of ${varName} to ${d.getMinutes()}
set seconds of ${varName} to 0`;
}

const tool = (
  name: string,
  description: string,
  actions: string[],
  props: Record<string, unknown>,
  classify: (action: string, a: Args) => Classified,
  exec: (action: string, a: Args, signal: AbortSignal) => Promise<string>,
  taints = false,
): ToolDef => ({
  name,
  description,
  parameters: {
    type: "object",
    properties: { action: { type: "string", enum: actions }, ...props },
    required: ["action"],
  },
  classify: (a) => {
    // Model sometimes forgets `action`: infer the obvious one instead of failing.
    if (!str(a, "action")) {
      const guess = DEFAULT_ACTION[name]?.(a);
      if (guess) a.action = guess;
    }
    // Near-miss action names ("timer" → set_timer, "current" → forecast): map when exactly
    // one valid action fits. The mapped action is then classified normally, so safety holds.
    if (name === "system" && /bright|dim/i.test(str(a, "action")) && !actions.includes(str(a, "action"))) {
      const v = str(a, "action").toLowerCase();
      a.action = /dim|down|lower|decrease/.test(v) ? "brightness_down" : /up|raise|increase|brighter/.test(v) ? "brightness_up"
        : a.level !== undefined || a.value !== undefined || a.percent !== undefined ? "set_brightness" : "get_brightness";
    }
    if (name === "system" && a.level === undefined && (a.value !== undefined || a.percent !== undefined)) a.level = a.value ?? a.percent;
    if (str(a, "action") && !actions.includes(str(a, "action"))) {
      const fixed = nearestAction(str(a, "action"), actions);
      if (fixed) a.action = fixed;
    }
    const act = str(a, "action");
    if (!actions.includes(act)) return { tier: 0, blocked: `unknown action "${act}" — use one of: ${actions.join(", ")}`, summary: `${name}: ${act}` };
    return classify(act, a);
  },
  taints,
  exec: (a, signal) => exec(str(a, "action"), a, signal),
});

// ============================================================== timers & alarms
// macOS Clock has no scripting, so Marigold keeps its own timers/alarms.
// They're saved to ~/.marigold/alarms.json and re-armed when the server starts,
// so a restart no longer loses them. Ringing = sound + notification + an alert
// window that stays up until dismissed.

interface Alarm { id: string; label: string; at: number }
const ALARM_FILE = path.join(MARIGOLD_DIR, "alarms.json");
const g = globalThis as unknown as { __marigoldAlarmState?: { list: Map<string, Alarm>; ticker?: NodeJS.Timeout } };
type AlarmState = { list: Map<string, Alarm>; ticker?: NodeJS.Timeout };
const alarmState: AlarmState = (g.__marigoldAlarmState ??= { list: new Map() });
const alarms = alarmState.list;

function saveAlarms() {
  void fsp.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 })
    .then(() => fsp.writeFile(ALARM_FILE, JSON.stringify([...alarms.values()], null, 2), { mode: 0o600 }))
    .catch(() => {});
}

function ring(label: string) {
  void notify("⏰ Marigold", label);
  for (let i = 0; i < 5; i++) setTimeout(() => execAsync("afplay", ["/System/Library/Sounds/Glass.aiff"]).catch(() => {}), i * 1500);
  const esc = label.replace(/["\\]/g, "");
  execFile("osascript", ["-e", `display alert "⏰ ${esc}" message "Marigold alarm · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}" giving up after 600`], () => {});
}

function tickAlarms() {
  const now = Date.now();
  let changed = false;
  for (const a of [...alarms.values()]) {
    if (a.at > now) continue;
    alarms.delete(a.id);
    changed = true;
    // Missed by > 2h (Mac was off/asleep): tell, don't blast a sound.
    if (now - a.at > 2 * 3600_000) void notify("Missed Marigold alarm", `${a.label} (${new Date(a.at).toLocaleString()})`);
    else ring(a.label);
  }
  if (changed) saveAlarms();
}

if (!alarmState.ticker) {
  try {
    for (const a of JSON.parse(readFileSync(ALARM_FILE, "utf8")) as Alarm[]) alarms.set(a.id, a);
  } catch { /* none yet */ }
  alarmState.ticker = setInterval(tickAlarms, 5_000);
}

function addAlarm(label: string, at: number, prefix: string) {
  const id = `${prefix}${Date.now().toString(36)}`;
  alarms.set(id, { id, label, at });
  saveAlarms();
  return id;
}

/** Photos hangs on a "library not found" dialog when its library is missing. */
async function photosLibraryProblem(): Promise<string | undefined> {
  const { stdout } = await execAsync("mdfind", ["-onlyin", os.homedir(), 'kMDItemFSName == "*.photoslibrary"']).catch(() => ({ stdout: "" }));
  const libs = stdout.split("\n").filter((l) => l.trim() && !/Syndication\.photoslibrary/.test(l));
  if (libs.length) return undefined;
  return "FAILED: Your Photos library is missing — there's no library in ~/Pictures, so Photos is stuck on a “library not found” screen. Fix: open Photos → Open Other… → pick your library (or Create New and turn on iCloud Photos in Photos → Settings → iCloud to re-download). Then ask again.";
}

// ============================================================== tools

const ALL_APP_TOOLS: ToolDef[] = [
  // ------------------------------------------------------------ Music
  tool(
    "music",
    "Control the Music app: play/pause/skip, play a song/artist/album/playlist from the library, now playing, volume, shuffle, list playlists, search the library, or open an Apple Music catalog search.",
    ["play", "pause", "next", "previous", "now_playing", "play_search", "play_playlist", "list_playlists", "add_to_playlist", "remove_from_playlist", "search_library", "set_volume", "shuffle", "catalog_search"],
    {
      query: s("song (\"song by artist\" works; \"current\" = what's playing), artist, album or playlist name"),
      playlist: s("playlist name for add_to_playlist / remove_from_playlist"),
      volume: { type: "number", description: "0–100" },
      on: { type: "boolean", description: "shuffle on/off" },
    },
    (act, a) => ({ tier: act.startsWith("search") || act === "now_playing" || act === "list_playlists" ? 0 : 1, summary: `Music: ${act.replace("_", " ")}${str(a, "query") ? ` “${str(a, "query")}”` : ""}` }),
    async (act, a) => {
      const q = as(str(a, "query"));
      switch (act) {
        case "play": await osa('tell application "Music" to play'); return "Playing.";
        case "pause": await osa('tell application "Music" to pause'); return "Paused.";
        case "next": await osa('tell application "Music" to next track'); return "Skipped.";
        case "previous": await osa('tell application "Music" to previous track'); return "Went back.";
        case "now_playing":
          return osa(`tell application "Music"
  if player state is stopped then return "Nothing is playing."
  set t to current track
  return (name of t) & " — " & (artist of t) & " (" & (album of t) & "), " & (player state as text)
end tell`);
        case "play_search":
          return osa(`tell application "Music"
  set r to (search playlist "Library" for "${q}")
  if (count of r) is 0 then return "NOTFOUND"
  play item 1 of r
  return "Playing " & (name of item 1 of r) & " — " & (artist of item 1 of r)
end tell`).then((r) => (r === "NOTFOUND" ? `“${str(a, "query")}” isn't in the library. Use action catalog_search to find it on Apple Music.` : r));
        case "play_playlist":
          return osa(`tell application "Music"
  set ps to (every playlist whose name contains "${q}")
  if (count of ps) is 0 then return "No playlist named ${q}."
  play item 1 of ps
  return "Playing playlist " & (name of item 1 of ps)
end tell`);
        case "list_playlists": return clip(await osa('tell application "Music" to get name of every user playlist'));
        case "add_to_playlist": case "remove_from_playlist": {
          // query = song (optionally "song by artist"), playlist = playlist name ("current" = what's playing).
          const pl = as(str(a, "playlist"));
          if (!pl) return "FAILED: say which playlist.";
          const [song, artist] = str(a, "query").split(/\s+by\s+/i).map((x) => as(x.trim()));
          const pick = str(a, "query").toLowerCase() === "current" || !song
            ? "set t to current track"
            : `set hits to (search library playlist 1 for "${song}")
  if (count of hits) is 0 then return "NOTFOUND"
  set t to item 1 of hits
  ${artist ? `repeat with h in hits
    if (artist of h) contains "${artist}" then
      set t to h
      exit repeat
    end if
  end repeat` : ""}`;
          const r = await osa(`tell application "Music"
  ${pick}
  ${act === "add_to_playlist"
    ? `if not (exists user playlist "${pl}") then make new user playlist with properties {name:"${pl}"}
  duplicate t to user playlist "${pl}"`
    : `delete (every track of user playlist "${pl}" whose persistent ID is (persistent ID of t))`}
  return (name of t) & " — " & (artist of t)
end tell`, 60_000);
          if (r === "NOTFOUND") return `FAILED: “${str(a, "query")}” isn't in your Music library, so it can't be added to a playlist yet. (Add it to your library in the Music app first — e.g. app_ui on Music: search it, then “Add to Library”.)`;
          return act === "add_to_playlist" ? `Added ${r} to the playlist “${str(a, "playlist")}”.` : `Removed ${r} from “${str(a, "playlist")}”.`;
        }
        case "search_library":
          return clip(await osa(`tell application "Music"
  set out to ""
  repeat with t in (search playlist "Library" for "${q}")
    set out to out & (name of t) & " — " & (artist of t) & linefeed
  end repeat
  return out
end tell`)) || "No matches in the library.";
        case "set_volume": await osa(`tell application "Music" to set sound volume to ${Math.max(0, Math.min(100, num(a, "volume", 50)))}`); return "Volume set.";
        case "shuffle": await osa(`tell application "Music" to set shuffle enabled to ${a.on === false ? "false" : "true"}`); return `Shuffle ${a.on === false ? "off" : "on"}.`;
        case "catalog_search": await open(`music://music.apple.com/search?term=${encodeURIComponent(str(a, "query"))}`); return `Opened Apple Music search for “${str(a, "query")}”. Use ui_tree on "Music" to pick a result and press play.`;
      }
      return "Unknown action.";
    },
  ),

  // ------------------------------------------------------------ Notes
  tool(
    "notes",
    "Apple Notes: create a note, search notes, read a note, append to a note, list folders/recent notes, delete a note (goes to Recently Deleted).",
    ["create", "search", "read", "append", "list", "list_folders", "delete"],
    { title: s("note title"), body: s("note text (plain; newlines OK)"), query: s("search text"), folder: s("folder name (optional)") },
    (act, a) => ({ tier: act === "search" || act === "read" || act.startsWith("list") ? 0 : 1, summary: `Notes: ${act} ${str(a, "title") || str(a, "query")}`.trim() }),
    async (act, a) => {
      const html = (t: string) => as(t).replace(/\n/g, "<br>");
      const t = as(str(a, "title") || (act === "read" || act === "append" || act === "delete" ? str(a, "query") : ""));
      const find = `set ns to (every note whose name is "${t}")
  if (count of ns) is 0 then set ns to (every note whose name contains "${t}")
  if (count of ns) is 0 then return "NOTFOUND"
  set n to item 1 of ns`;
      const nf = (r: string) => (r === "NOTFOUND" ? `FAILED: no note titled “${str(a, "title")}”. Try action search.` : r);
      switch (act) {
        case "create": {
          const folder = str(a, "folder");
          return osa(`tell application "Notes"
  ${folder ? `if not (exists folder "${as(folder)}") then make new folder with properties {name:"${as(folder)}"}
  set f to folder "${as(folder)}"` : "set f to default account's folder 1"}
  make new note at f with properties {name:"${t}", body:"<h1>${html(str(a, "title"))}</h1>${html(str(a, "body"))}"}
  return "ok"
end tell`).then(() => `Created note “${str(a, "title")}”.`);
        }
        case "search":
          return clip(await osa(`tell application "Notes"
  set out to ""
  repeat with n in (every note whose name contains "${as(str(a, "query"))}" or plaintext contains "${as(str(a, "query"))}")
    set out to out & (name of n) & "  (" & (modification date of n as text) & ")" & linefeed
  end repeat
  return out
end tell`)) || "No matching notes.";
        case "read": return nf(clip(await osa(`tell application "Notes"
  ${find}
  return (name of n) & linefeed & (plaintext of n)
end tell`)));
        case "append": return nf(await osa(`tell application "Notes"
  ${find}
  set body of n to (body of n) & "<br>${html(str(a, "body"))}"
  return "Appended to " & (name of n)
end tell`));
        case "list":
          return clip(await osa(`tell application "Notes"
  set out to ""
  set ns to notes
  repeat with i from 1 to (count of ns)
    if i > 30 then exit repeat
    set n to item i of ns
    set out to out & (name of n) & linefeed
  end repeat
  return out
end tell`));
        case "list_folders": return osa('tell application "Notes" to get name of every folder');
        case "delete": return nf(await osa(`tell application "Notes"
  ${find}
  set nm to name of n
  delete n
  return "Moved “" & nm & "” to Recently Deleted."
end tell`));
      }
      return "Unknown action.";
    },
    true,
  ),

  // ------------------------------------------------------------ Reminders
  tool(
    "reminders",
    "Apple Reminders: add a reminder (optional due date/list), list incomplete reminders, complete a reminder, list lists.",
    ["add", "list", "complete", "list_lists"],
    { title: s("reminder text"), due: s("optional due date/time, ISO e.g. 2026-11-06T09:00"), list: s("list name (optional)"), notes: s("optional notes") },
    (act, a) => ({ tier: act === "list" || act === "list_lists" ? 0 : 1, summary: `Reminders: ${act} ${str(a, "title")}`.trim() }),
    async (act, a) => {
      const list = str(a, "list");
      const target = list ? `list "${as(list)}"` : "default list";
      switch (act) {
        case "add": {
          const due = str(a, "due");
          return osa(`tell application "Reminders"
  ${list ? `if not (exists list "${as(list)}") then make new list with properties {name:"${as(list)}"}` : ""}
  ${due ? asDate("d", due) : ""}
  make new reminder at ${target} with properties {name:"${as(str(a, "title"))}"${str(a, "notes") ? `, body:"${as(str(a, "notes"))}"` : ""}${due ? ", due date:d" : ""}}
  return "ok"
end tell`).then(() => `Added reminder “${str(a, "title")}”${due ? ` due ${new Date(due).toLocaleString()}` : ""}.`);
        }
        case "list": {
          const raw = await osa(`tell application "Reminders"
  set out to ""
  repeat with r in (reminders of ${target} whose completed is false)
    set out to out & "- " & (name of r)
    try
      set out to out & " (due " & (due date of r as text) & ")"
    end try
    set out to out & linefeed
  end repeat
  return out
end tell`);
          if (!raw.trim()) return "No open reminders.";
          // Say which are overdue / due today, so the answer doesn't have to work out dates.
          const today = new Date().toDateString();
          const marked = raw.split("\n").map((line) => {
            const m = line.match(/\(due (?:[A-Za-z]+, )?(.+?) at (.+?)\)/);
            if (!m) return line;
            const d = new Date(`${m[1]} ${m[2].replace(/\u202f/g, " ")}`);
            if (isNaN(+d)) return line;
            return d.getTime() < Date.now() && d.toDateString() !== today ? `${line} — OVERDUE` : d.toDateString() === today ? `${line} — DUE TODAY` : line;
          });
          const over = marked.filter((l) => l.endsWith("OVERDUE")).length, due = marked.filter((l) => l.endsWith("DUE TODAY")).length;
          return clip(`${marked.join("\n")}\nSummary: ${due} due today, ${over} overdue${over ? " — mention the overdue ones too" : ""}.`);
        }
        case "complete":
          return osa(`tell application "Reminders"
  set rs to (every reminder whose name contains "${as(str(a, "title"))}" and completed is false)
  if (count of rs) is 0 then return "FAILED: no open reminder matching that."
  set completed of item 1 of rs to true
  return "Completed " & (name of item 1 of rs)
end tell`);
        case "list_lists": return osa('tell application "Reminders" to get name of every list');
      }
      return "Unknown action.";
    },
    true,
  ),

  // ------------------------------------------------------------ Calendar
  tool(
    "calendar",
    "Apple Calendar: list events in a date range, create an event (optionally with notes, a meeting link and invitees' emails), delete an event, list calendars. For a meeting with a person, call person_info first to get their email and usual link.",
    ["list_events", "create_event", "delete_event", "list_calendars"],
    {
      title: s("event title"),
      start: s("ISO start, e.g. 2026-11-06T15:00"),
      end: s("ISO end (default start + 1h)"),
      calendar: s("calendar name (optional)"),
      location: s("optional location"),
      notes: s("optional description / agenda"),
      url: s("optional meeting link (Zoom, Meet…)"),
      invitees: s("optional comma-separated emails to invite (sends them an invitation)"),
      days: { type: "number", description: "list_events: how many days from start (default 7)" },
    },
    (act, a) => {
      if (act === "delete_event") return { tier: 2, scope: "calendar:delete", summary: `Delete calendar event “${str(a, "title")}”` };
      const inv = emailsIn(str(a, "invitees"));
      if (act === "create_event" && inv.length) {
        // Inviting people sends them email — outward, so ask (once, rememberable).
        return { tier: 2, scope: "calendar:invite", outward: true, summary: `Calendar: create “${str(a, "title")}” and invite ${inv.join(", ")}` };
      }
      return { tier: act === "create_event" ? 1 : 0, summary: `Calendar: ${act.replace("_", " ")} ${str(a, "title")}`.trim() };
    },
    async (act, a) => {
      const cal = str(a, "calendar");
      switch (act) {
        case "list_calendars": return osa('tell application "Calendar" to get name of every calendar');
        case "list_events": {
          // Models sometimes pass odd dates ("today", "2026-11-07 now") — fall back to the start of today.
          const raw = str(a, "start");
          const from = raw && !Number.isNaN(new Date(raw).getTime()) ? raw : new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
          const to = new Date(new Date(from).getTime() + num(a, "days", 7) * 86_400_000).toISOString();
          return clip(await osa(`tell application "Calendar"
  ${asDate("d1", from)}
  ${asDate("d2", to)}
  set out to ""
  repeat with c in ${cal ? `{calendar "${as(cal)}"}` : "calendars"}
    repeat with e in (every event of c whose start date ≥ d1 and start date ≤ d2)
      set out to out & (start date of e as text) & " — " & (summary of e) & " [" & (name of c) & "]" & linefeed
    end repeat
  end repeat
  return out
end tell`, 120_000)) || "No events in that range.";
        }
        case "create_event": {
          const start = str(a, "start");
          const end = str(a, "end") || new Date(new Date(start).getTime() + 3_600_000).toISOString();
          return osa(`tell application "Calendar"
  ${asDate("d1", start)}
  ${asDate("d2", end)}
  tell ${cal ? `calendar "${as(cal)}"` : "calendar 1"}
    set ev to make new event with properties {summary:"${as(str(a, "title"))}", start date:d1, end date:d2${str(a, "location") ? `, location:"${as(str(a, "location"))}"` : ""}${str(a, "notes") ? `, description:"${as(str(a, "notes"))}"` : ""}${str(a, "url") ? `, url:"${as(str(a, "url"))}"` : ""}}
    ${emailsIn(str(a, "invitees")).map((e) => `tell ev to make new attendee at end of attendees with properties {email:"${as(e)}"}`).join("\n    ")}
  end tell
  return "ok"
end tell`).then(() => {
            const inv = emailsIn(str(a, "invitees"));
            return `Created “${str(a, "title")}” on ${new Date(start).toLocaleString()}${str(a, "location") ? ` at ${str(a, "location")}` : ""}${str(a, "url") ? ` (link: ${str(a, "url")})` : ""}${inv.length ? `, inviting ${inv.join(", ")}` : ""}.`;
          });
        }
        case "delete_event":
          return osa(`tell application "Calendar"
  repeat with c in calendars
    set es to (every event of c whose summary is "${as(str(a, "title"))}")
    if (count of es) > 0 then
      delete item 1 of es
      return "Deleted."
    end if
  end repeat
  return "FAILED: no event with that exact title."
end tell`, 120_000);
      }
      return "Unknown action.";
    },
    true,
  ),

  // ------------------------------------------------------------ Photos
  tool(
    "photos",
    "Apple Photos: search photos (by text like 'beach', 'dog', a place or person), list albums, count photos, export matching photos to a folder, create an album, add search results to an album.",
    ["search", "list_albums", "count", "export", "create_album", "add_to_album"],
    { query: s("search text"), album: s("album name"), folder: s("export destination folder (default ~/Desktop/Marigold Export)"), limit: { type: "number", description: "max photos (default 20)" } },
    (act, a) => {
      if (act === "export") return { tier: 1, blocked: sensitivePath(str(a, "folder") || "~/Desktop"), summary: `Export “${str(a, "query")}” photos` };
      return { tier: act === "create_album" || act === "add_to_album" ? 1 : 0, summary: `Photos: ${act.replace("_", " ")} ${str(a, "query") || str(a, "album")}`.trim() };
    },
    async (act, a) => {
      const problem = await photosLibraryProblem();
      if (problem) return problem;
      const q = as(str(a, "query"));
      const lim = Math.min(200, num(a, "limit", 20));
      switch (act) {
        case "search":
          return clip(await osa(`tell application "Photos"
  set r to (search for "${q}")
  set out to "Found " & (count of r) & " photos." & linefeed
  repeat with i from 1 to (count of r)
    if i > ${lim} then exit repeat
    set p to item i of r
    set out to out & (filename of p) & " — " & (date of p as text) & linefeed
  end repeat
  return out
end tell`, 120_000));
        case "list_albums": return clip(await osa('tell application "Photos" to get name of every album'));
        case "count": {
          await execAsync("open", ["-g", "-a", "Photos"]);
          const n = await osa('tell application "Photos" to return (count of media items) as text', 300_000);
          return `${n} photos and videos in your library.`;
        }
        case "export": {
          const dest = expandPath(str(a, "folder") || path.join(os.homedir(), "Desktop", "Marigold Export"));
          await execAsync("mkdir", ["-p", dest]);
          return osa(`tell application "Photos"
  set r to (search for "${q}")
  if (count of r) is 0 then return "No photos matched."
  set sel to items 1 thru (minimum of {${lim}, count of r}) of r
  export sel to POSIX file "${as(dest)}"
  return "Exported " & (count of sel) & " photos to ${as(dest)}"
end tell`.replace("minimum of {", "(my minOf(").replace(`, count of r})`, `, count of r))`) + `
on minOf(a, b)
  if a < b then return a
  return b
end minOf`, 600_000);
        }
        case "create_album":
          return osa(`tell application "Photos" to make new album named "${as(str(a, "album"))}"`).then(() => `Created album “${str(a, "album")}”.`);
        case "add_to_album":
          return osa(`tell application "Photos"
  set r to (search for "${q}")
  if (count of r) is 0 then return "No photos matched."
  if not (exists album "${as(str(a, "album"))}") then make new album named "${as(str(a, "album"))}"
  add r to album "${as(str(a, "album"))}"
  return "Added " & (count of r) & " photos to ${as(str(a, "album"))}"
end tell`, 300_000);
      }
      return "Unknown action.";
    },
    true,
  ),

  // ------------------------------------------------------------ TV
  tool(
    "tv",
    "Apple TV app: play/pause, now playing, search the TV library, or open a search in the TV app.",
    ["play", "pause", "now_playing", "search_library", "open_search"],
    { query: s("show or movie name") },
    (act, a) => ({ tier: act === "now_playing" || act === "search_library" ? 0 : 1, summary: `TV: ${act.replace("_", " ")} ${str(a, "query")}`.trim() }),
    async (act, a) => {
      switch (act) {
        case "play": await osa('tell application "TV" to play'); return "Playing.";
        case "pause": await osa('tell application "TV" to pause'); return "Paused.";
        case "now_playing": return osa('tell application "TV"\nif player state is stopped then return "Nothing playing."\nreturn name of current track\nend tell');
        case "search_library":
          return (await osa(`tell application "TV"
  set out to ""
  repeat with t in (search playlist 1 for "${as(str(a, "query"))}")
    set out to out & (name of t) & linefeed
  end repeat
  return out
end tell`)) || "Not in your library. Use open_search.";
        case "open_search": await open(`videos://search?term=${encodeURIComponent(str(a, "query"))}`).catch(() => open("-a TV")); return `Opened TV search for “${str(a, "query")}”.`;
      }
      return "Unknown action.";
    },
  ),

  // ------------------------------------------------------------ Stocks
  tool(
    "stocks",
    "Live stock/ETF/crypto/index quotes and recent price history (e.g. AAPL, TSLA, ^GSPC, BTC-USD), or open the Stocks app on a symbol. Read-only — never trades.",
    ["quote", "history", "open_app"],
    { symbols: s("comma-separated tickers"), range: s("history range: 5d, 1mo, 6mo, 1y, 5y (default 1mo)") },
    (act, a) => ({ tier: 0, summary: `Stocks: ${act} ${str(a, "symbols")}` }),
    async (act, a, signal) => {
      const syms = str(a, "symbols").split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase());
      if (act === "open_app") { await open(`stocks://?symbol=${encodeURIComponent(syms[0] ?? "")}`); return "Opened Stocks."; }
      const range = act === "history" ? str(a, "range") || "1mo" : "5d";
      const out: string[] = [];
      for (const sym of syms.slice(0, 10)) {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${act === "history" ? "1d" : "1d"}`, { signal, headers: { "User-Agent": "Mozilla/5.0" } });
        const j = await r.json().catch(() => null);
        const res = j?.chart?.result?.[0];
        if (!res) { out.push(`${sym}: not found`); continue; }
        const m = res.meta;
        const chg = m.regularMarketPrice - m.chartPreviousClose;
        out.push(`${sym} (${m.longName ?? m.shortName ?? ""}): ${m.regularMarketPrice} ${m.currency} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}, ${((chg / m.chartPreviousClose) * 100).toFixed(2)}% vs prev close) · day ${m.regularMarketDayLow}–${m.regularMarketDayHigh} · 52w ${m.fiftyTwoWeekLow}–${m.fiftyTwoWeekHigh}`);
        if (act === "history") {
          const closes: number[] = res.indicators?.quote?.[0]?.close ?? [];
          const ts: number[] = res.timestamp ?? [];
          const pts = ts.map((t, i) => `${new Date(t * 1000).toISOString().slice(0, 10)} ${closes[i]?.toFixed(2)}`).filter((x) => !x.endsWith("undefined"));
          const step = Math.max(1, Math.ceil(pts.length / 25));
          out.push("  closes: " + pts.filter((_, i) => i % step === 0 || i === pts.length - 1).join(", "));
        }
      }
      return clip(out.join("\n"));
    },
    true,
  ),

  // ------------------------------------------------------------ News
  tool(
    "news",
    "Latest news headlines (top stories or a topic) with sources and links, or open the Apple News app.",
    ["headlines", "open_app"],
    { topic: s("optional topic, e.g. 'AI', 'Warriors', 'markets'"), limit: { type: "number", description: "default 10" } },
    (act, a) => ({ tier: 0, summary: `News: ${str(a, "topic") || "top stories"}` }),
    async (act, a, signal) => {
      if (act === "open_app") { await execAsync("open", ["-g", "-a", "News"]); return "Opened Apple News."; }
      const t = str(a, "topic");
      const url = t
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=en-US&gl=US&ceid=US:en`
        : "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
      const xml = await (await fetch(url, { signal })).text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, num(a, "limit", 10)).map((m) => {
        const tag = (k: string) => (m[1].match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`))?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        return `- ${tag("title")} (${new Date(tag("pubDate")).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})\n  ${tag("link")}`;
      });
      return clip(items.join("\n") || "No headlines found.");
    },
    true,
  ),

  // ------------------------------------------------------------ Weather
  tool(
    "weather",
    "Current weather and forecast for a place (or the user's current area if empty), or open the Weather app.",
    ["forecast", "open_app"],
    { place: s("city or place (optional)") },
    (act, a) => ({ tier: 0, summary: `Weather ${str(a, "place")}`.trim() }),
    async (act, a, signal) => {
      if (act === "open_app") { await execAsync("open", ["-g", "-a", "Weather"]); return "Opened Weather."; }
      const r = await fetch(`https://wttr.in/${encodeURIComponent(str(a, "place"))}?format=j1`, { signal, headers: { "User-Agent": "curl/8" } });
      const j = await r.json();
      const c = j.current_condition?.[0];
      const area = j.nearest_area?.[0]?.areaName?.[0]?.value ?? str(a, "place");
      const days = (j.weather ?? []).map((d: { date: string; maxtempF: string; mintempF: string; hourly: { weatherDesc: { value: string }[]; chanceofrain: string }[] }) =>
        `${d.date}: ${d.mintempF}–${d.maxtempF}°F, ${d.hourly?.[4]?.weatherDesc?.[0]?.value ?? ""}, rain ${Math.max(...d.hourly.map((h) => Number(h.chanceofrain)))}%`);
      return `${area} now: ${c.temp_F}°F (feels ${c.FeelsLikeF}°F), ${c.weatherDesc?.[0]?.value}, humidity ${c.humidity}%, wind ${c.windspeedMiles} mph\n${days.join("\n")}`;
    },
    true,
  ),

  // ------------------------------------------------------------ Maps
  tool(
    "maps",
    "Apple Maps: search for a place, or get directions (driving/walking/transit) — opens Maps.",
    ["search", "directions"],
    { query: s("place to search, or destination"), from: s("start (optional; default current location)"), mode: { type: "string", enum: ["driving", "walking", "transit"] } },
    (act, a) => ({ tier: 0, summary: `Maps: ${act} ${str(a, "query")}` }),
    async (act, a) => {
      if (act === "search") { await open(`maps://?q=${encodeURIComponent(str(a, "query"))}`); return `Showing “${str(a, "query")}” in Maps.`; }
      const flag = { driving: "d", walking: "w", transit: "r" }[str(a, "mode") as "driving"] ?? "d";
      await open(`maps://?daddr=${encodeURIComponent(str(a, "query"))}${str(a, "from") ? `&saddr=${encodeURIComponent(str(a, "from"))}` : ""}&dirflg=${flag}`);
      return `Opened ${str(a, "mode") || "driving"} directions to ${str(a, "query")} in Maps.`;
    },
  ),

  // ------------------------------------------------------------ App Store
  tool(
    "app_store",
    "App Store: search for apps, open an app's page, or install a FREE app (paid apps are never bought automatically).",
    ["search", "install_free"],
    { query: s("app name") },
    (act, a) => (act === "install_free"
      ? { tier: 2, scope: "app_store:install", summary: `Install the free app “${str(a, "query")}”` }
      : { tier: 0, summary: `Search the App Store for “${str(a, "query")}”` }),
    async (act, a) => {
      await open(`macappstore://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search?q=${encodeURIComponent(str(a, "query"))}`);
      if (act === "search") return `Opened App Store results for “${str(a, "query")}”. Use ui_tree on "App Store" to read them.`;
      // Click the first result's "Get" button — and refuse anything that shows a price.
      await new Promise((r) => setTimeout(r, 4000));
      const r = await osa(`tell application "System Events" to tell process "App Store"
  set btns to every button of (entire contents of window 1) whose description is not missing value
  repeat with b in btns
    set d to description of b
    if d starts with "Get" or d starts with "GET" or d is "Install" then
      click b
      return "clicked:" & d
    end if
    if d contains "$" or d contains "Buy" then return "paid:" & d
  end repeat
  return "none"
end tell`).catch((e) => `error:${e}`);
      if (r.startsWith("paid")) return `FAILED: that app costs money (${r.slice(5)}). Marigold never buys apps — the user must purchase it themselves.`;
      if (r.startsWith("clicked")) return `Started installing “${str(a, "query")}”. macOS may ask for your Apple Account password or Touch ID once.`;
      return `Opened the App Store page; couldn't find the Get button automatically. Use ui_tree on "App Store" to find it.`;
    },
  ),

  // ------------------------------------------------------------ Video Studio: real editing with ffmpeg + Whisper
  tool(
    "video_edit",
    "Edit video and audio files on this Mac (ffmpeg + Whisper). Workflow for a real edit: probe the file, frames (look at pictures from it), transcribe (words with timestamps), propose an edit to the user in plain words with times and WAIT for their changes, render a quick preview (preview=true), then the full version. Actions: probe, frames, transcribe, silence (dry run first, apply=true to cut), cut (keep=[{start,end}] or remove=[{start,end}]), trim, concat (files=[…]), speed (factor), reframe (aspect 9:16, 1:1, 4:5, 16:9), captions (burned in from the transcript), normalize (loudness), extract_audio, export (preset youtube/web/small). Every edit is a NEW file next to the original; nothing is overwritten. Times are seconds or m:ss.",
    ["probe", "frames", "transcribe", "silence", "cut", "trim", "concat", "speed", "reframe", "captions", "normalize", "extract_audio", "export"],
    {
      file: s("full path of the video/audio file"), files: { type: "array", items: { type: "string" }, description: "for concat: the files in order" }, out: s("optional output path (never overwrites)"),
      start: s("trim start, e.g. 0:30"), end: s("trim end, e.g. 2:15"), times: s("frames at these times, e.g. 5,30,1:20"), count: { type: "number", description: "frames: how many evenly spaced (default 6, max 8)" },
      keep: { type: "array", items: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } }, description: "cut: the parts to keep, in order" },
      remove: { type: "array", items: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } }, description: "cut: the parts to remove" },
      preview: { type: "boolean", description: "render a small, fast preview instead of the full version" }, apply: { type: "boolean", description: "silence: actually write the file (default is a dry run)" },
      min_seconds: { type: "number", description: "silence: shortest silence to cut (default 0.7)" }, noise_db: { type: "number", description: "silence: quiet level in dB (default -35)" },
      factor: { type: "number", description: "speed: 2 = twice as fast (0.25 to 4)" }, aspect: s("reframe: 9:16, 1:1, 4:5 or 16:9"), burn_in: { type: "boolean", description: "captions: burn into the video (default) or only write the .srt" },
      preset: s("export: youtube, web or small"), format: s("extract_audio: m4a or mp3"),
    },
    (act, a) => ({ tier: act === "probe" || act === "frames" || act === "transcribe" || (act === "silence" && a.apply !== true) ? 0 : 1, summary: `Video: ${act.replace("_", " ")} ${str(a, "file").split("/").pop() ?? ""}`.trim() }),
    async (act, a) => {
      const { videoEdit } = await import("./video-edit");
      const { sensitivePath } = await import("./policy");
      const { transcribeSegments } = await import("./voice");
      const { queueVisionImages } = await import("./browser-tool");
      return videoEdit({ ...(a as object), action: act } as Parameters<typeof videoEdit>[0], { sensitive: sensitivePath, transcribe: transcribeSegments, queueImages: queueVisionImages });
    },
  ),

  // ------------------------------------------------------------ Connected websites (personal tokens in Settings → Connections)
  tool(
    "github",
    "GitHub: search issues and pull requests (public ones work without signing in), read an issue or PR with its comments, list the user's repos or a repo's open PRs, create an issue, comment. Use this instead of the GitHub website.",
    ["whoami", "my_repos", "search_issues", "get_issue", "get_pr", "list_prs", "create_issue", "comment"],
    { repo: s("owner/name"), query: s("GitHub search, e.g. 'repo:owner/name is:open label:bug'"), number: { type: "number", description: "issue or PR number" }, title: s("issue title"), body: s("issue or comment text") },
    (act, a) => ({ tier: act === "create_issue" || act === "comment" ? 2 : 0, ...(act === "create_issue" || act === "comment" ? { scope: "send:github", outward: true } : {}), summary: `GitHub: ${act.replace("_", " ")} ${str(a, "repo")}`.trim() }),
    async (act, a) => { try { return await (await import("./connections")).github(act, { repo: str(a, "repo"), query: str(a, "query"), number: num(a, "number", 0), title: str(a, "title"), body: str(a, "body") }); } catch (e) { return `FAILED: ${(e as Error).message}`; } },
  ),
  tool(
    "notion",
    "Notion: search pages the user shared with Marigold, read a page's text, read a database's rows, create a page under a page, add text to a page. Use this instead of the Notion website.",
    ["search", "get_page", "query_database", "create_page", "append"],
    { query: s("search words"), page_id: s("a page id or its link"), parent_id: s("the page to create the new page under"), database_id: s("a database id or link"), title: s("new page title"), text: s("page text (blank line between paragraphs)") },
    (act, a) => ({ tier: act === "create_page" || act === "append" ? 2 : 0, ...(act === "create_page" || act === "append" ? { scope: "write:notion" } : {}), summary: `Notion: ${act.replace("_", " ")} ${str(a, "title") || str(a, "query")}`.trim() }),
    async (act, a) => { try { return await (await import("./connections")).notion(act, { query: str(a, "query"), page_id: str(a, "page_id"), parent_id: str(a, "parent_id"), database_id: str(a, "database_id"), title: str(a, "title"), text: str(a, "text") }); } catch (e) { return `FAILED: ${(e as Error).message}`; } },
  ),
  tool(
    "linear",
    "Linear: the user's open issues, search issues by title, create an issue in a team.",
    ["my_issues", "search_issues", "create_issue"],
    { query: s("title words"), team: s("team key or name"), title: s("issue title"), description: s("issue description") },
    (act, a) => ({ tier: act === "create_issue" ? 2 : 0, ...(act === "create_issue" ? { scope: "write:linear", outward: true } : {}), summary: `Linear: ${act.replace("_", " ")} ${str(a, "title") || str(a, "query")}`.trim() }),
    async (act, a) => { try { return await (await import("./connections")).linear(act, { query: str(a, "query"), team: str(a, "team"), title: str(a, "title"), description: str(a, "description") }); } catch (e) { return `FAILED: ${(e as Error).message}`; } },
  ),
  tool(
    "todoist",
    "Todoist: list tasks (optionally a filter like 'today' or 'overdue'), add a task with a due date in plain words, mark a task done.",
    ["list_tasks", "add_task", "complete_task"],
    { query: s("Todoist filter, e.g. today, overdue, p1"), title: s("task text"), due: s("due date in plain words, e.g. tomorrow 5pm"), task_id: s("task id from list_tasks") },
    (act, a) => ({ tier: act === "list_tasks" ? 0 : 1, summary: `Todoist: ${act.replace("_", " ")} ${str(a, "title")}`.trim() }),
    async (act, a) => { try { return await (await import("./connections")).todoist(act, { query: str(a, "query"), title: str(a, "title"), due: str(a, "due"), task_id: str(a, "task_id") }); } catch (e) { return `FAILED: ${(e as Error).message}`; } },
  ),

  // ------------------------------------------------------------ Video links: transcript + details (the link the user shared)
  tool(
    "video",
    "Read a video link the user shared (YouTube and others): title, channel, description, chapters and the full transcript with timestamps taken from the video's own captions. You cannot see the pictures or hear the audio, only the transcript, so never claim to have seen visual details.",
    ["watch"],
    { url: s("the video link, starting with https://") },
    (_act, a) => ({ tier: 0, summary: `Read video: ${str(a, "url").slice(0, 80)}` }),
    async (_act, a) => (await import("./video")).readVideo(str(a, "url")),
  ),

  // ------------------------------------------------------------ Sports: live scores and today's games (ESPN scoreboards)
  tool(
    "sports",
    "Live scores, finished results and today's schedule for pro and college leagues (NBA, NFL, MLB, NHL, WNBA, MLS, Premier League, Champions League, NCAA football/basketball). Use this for ANY score, who-is-playing or game-time question instead of browsing.",
    ["scores", "team"],
    {
      league: s("nba, nfl, mlb, nhl, wnba, mls, epl, ucl, ncaaf or ncaam. Leave empty for the big four (NBA, NFL, MLB, NHL)"),
      team: s("a team name or nickname to find its game, e.g. Warriors, Lakers, 49ers"),
    },
    (act, a) => ({ tier: 0, summary: `Sports: ${act === "team" ? str(a, "team") : str(a, "league") || "scores"}`.trim() }),
    async (_act, a) => {
      const pulse = await import("./pulse");
      const wanted = str(a, "league").toLowerCase().trim();
      const leagues = wanted && pulse.LEAGUES[wanted] ? [wanted] : ["nba", "nfl", "mlb", "nhl"];
      const games = (await Promise.all(leagues.map((l) => pulse.cachedLeague(l).catch(() => [])))).flat();
      const team = str(a, "team").toLowerCase().trim();
      const hit = team ? games.filter((g) => [g.home.name, g.away.name, g.home.abbr, g.away.abbr].some((n) => n.toLowerCase().includes(team))) : games;
      if (!hit.length) return team ? `No game found for "${str(a, "team")}" on today's scoreboards (it may not play today, or the league is out of season).` : "No games on today's scoreboards for that league (it may be out of season).";
      const when = (g: (typeof hit)[number]) => new Date(g.at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
      const line = (g: (typeof hit)[number]) => `${g.league}: ${g.away.name} ${g.state === "pre" ? "at" : g.away.score + " –"} ${g.home.name}${g.state === "pre" ? "" : " " + g.home.score} · ${g.state === "in" ? "LIVE, " : g.state === "post" ? "" : "starts "}${g.state === "pre" ? when(g) + " (" + g.detail + ")" : g.detail}`;
      const order = { in: 0, pre: 1, post: 2 } as const;
      return hit.sort((x, y) => order[x.state] - order[y.state]).slice(0, 20).map(line).join("\n");
    },
  ),

  // ------------------------------------------------------------ Clock: timers, alarms, world clock
  tool(
    "clock",
    "Timers, alarms and world clock. Marigold rings with a notification + sound. Also: list/cancel timers, current time in any city/timezone, open the Clock app.",
    ["set_timer", "set_alarm", "list", "cancel", "world_time", "open_app"],
    {
      minutes: { type: "number", description: "timer length in minutes (decimals OK)" },
      at: s("alarm time, ISO e.g. 2026-11-06T07:30"),
      label: s("what it's for"),
      timezone: s("IANA timezone for world_time, e.g. Asia/Kolkata, Europe/London"),
    },
    (act, a) => ({ tier: act === "list" || act === "world_time" ? 0 : 1, summary: `Clock: ${act.replace("_", " ")} ${str(a, "label") || str(a, "timezone")}`.trim() }),
    async (act, a) => {
      switch (act) {
        case "set_timer": {
          const ms = num(a, "minutes", 0) * 60_000;
          if (ms <= 0) return "FAILED: give minutes > 0.";
          const label = str(a, "label") || `${num(a, "minutes", 0)}-minute timer`;
          addAlarm(`Timer done: ${label}`, Date.now() + ms, "t");
          return `Timer set: ${label} (rings at ${new Date(Date.now() + ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}).`;
        }
        case "set_alarm": {
          const at = new Date(str(a, "at")).getTime();
          if (!Number.isFinite(at) || at <= Date.now()) return "FAILED: alarm time must be in the future (ISO format).";
          const label = str(a, "label") || "Alarm";
          addAlarm(label, at, "a");
          return `Alarm set for ${new Date(at).toLocaleString()} — ${label}. It rings with sound + an alert window while Marigold is running (saved, survives restarts).`;
        }
        case "list":
          return [...alarms.values()].map((x) => `${x.id}: ${x.label} at ${new Date(x.at).toLocaleTimeString()}`).join("\n") || "No timers or alarms.";
        case "cancel": {
          const hit = [...alarms.values()].find((x) => x.id === str(a, "label") || x.label.toLowerCase().includes(str(a, "label").toLowerCase()));
          if (!hit) return "FAILED: no matching timer/alarm.";
          alarms.delete(hit.id);
          saveAlarms();
          return `Cancelled ${hit.label}.`;
        }
        case "world_time": {
          const tz = str(a, "timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
          try {
            return `${tz}: ${new Date().toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`;
          } catch { return `FAILED: unknown timezone ${tz}.`; }
        }
        case "open_app": await execAsync("open", ["-g", "-a", "Clock"]); return "Opened Clock.";
      }
      return "Unknown action.";
    },
  ),

  // ------------------------------------------------------------ Safari
  tool(
    "web_browser",
    "Control the user's web browser (their main browser unless they name one). Navigate: open_url, search, list_tabs, switch_tab, new_tab, close_tab, back, reload, read_page. Act on a page like a person: `elements` lists the page's buttons/links/fields with numbers → then click(index), type(index, text), select(index, text), press(key e.g. Enter/Tab/Escape), scroll(direction up/down). Always call elements again after the page changes. Works in every browser.",
    ["open_url", "search", "list_tabs", "read_page", "switch_tab", "new_tab", "close_tab", "back", "reload", "elements", "click", "type", "select", "press", "scroll"],
    {
      url: s("URL to open"),
      query: s("search text (search) or part of a tab title (switch_tab)"),
      index: { type: "number", description: "element number from the last `elements` result (click/type/select)" },
      text: s("text to type, option to select, or — for click — the visible label of the button/link if you don't have an index"),
      key: s("key for press: Enter, Tab, Escape, Up, Down, Backspace"),
      direction: s("scroll: up or down"),
      browser: s("only if the user names a browser, e.g. Chrome; otherwise leave empty"),
    },
    (act, a) => classifyBrowser(act, a),
    async (act, a) => {
      const b = pickBrowser(str(a, "browser"));
      if (["elements", "click", "type", "select", "press", "scroll"].includes(act)) return pageAction(b, act, a);
      const app = as(b.app);
      let url = str(a, "url");
      if (act === "search") url = (await import("./web-search")).searchUrl(str(a, "query"));
      if (url && !/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
      if (url && !/^https?:/i.test(url)) return "FAILED: only http(s) links can be opened in the browser.";

      if (act === "open_url" || act === "search") {
        if (b.kind === "basic") {
          await execAsync("open", ["-a", b.app, url]);
          return `Opened ${url} in ${b.label}.`;
        }
        const reused = await openInAgentWindow(b, url);
        return `Opened ${url} in ${b.label} (${reused ? "Marigold's browser window" : "a new Marigold browser window — your own windows and tabs are left alone"}).`;
      }

      if (b.kind === "basic") {
        // No AppleScript tab access (Firefox, Opera…) — work through keyboard shortcuts + window titles.
        const keys: Record<string, string> = { new_tab: 'keystroke "t" using command down', close_tab: 'keystroke "w" using command down', back: 'keystroke "[" using command down', reload: 'keystroke "r" using command down' };
        if (keys[act]) {
          await osa(`tell application "${app}" to activate
delay 0.3
tell application "System Events" to tell process "${app}" to ${keys[act]}`);
          return `Done (${act.replace("_", " ")}) in ${b.label}.`;
        }
        const titles = await osa(`tell application "System Events" to tell process "${app}" to get name of every window`).catch(() => "");
        if (act === "list_tabs") return titles ? `${b.label} windows (it only shows the active tab of each): ${titles}` : `${b.label} has no open windows.`;
        if (act === "switch_tab") return `FAILED: ${b.label} doesn't let apps switch tabs. Try Safari or Chrome, or ask the user to switch.`;
        if (act === "read_page") {
          const text = await axPageText(b);
          return text ? clip(text) : `FAILED: couldn't read the page in ${b.label}. Front window: ${titles || "none"}.`;
        }
      }

      const safari = b.kind === "safari";
      // Tab commands act on the AGENT's window when it has one — never on the user's front window.
      const wid = agentWindows[b.app];
      const winRef = wid ? `(first window whose id is ${wid})` : "front window";
      const cur = safari ? `current tab of ${winRef}` : `active tab of ${winRef}`;
      const titleProp = safari ? "name" : "title";
      switch (act) {
        case "list_tabs":
          return await osa(`tell application "${app}"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (${titleProp} of t) & (ASCII character 9) & (URL of t) & linefeed
    end repeat
  end repeat
  return out
end tell`).then((out) => {
            const tabs = out.split("\n").filter(Boolean).map((l) => {
              const [t, u] = l.split("\t");
              let host = u ?? "";
              try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
              return `${t.slice(0, 70)} (${host})`;
            });
            if (!tabs.length) return "No open tabs.";
            return `${tabs.length} tabs open${tabs.length > 30 ? " (showing 30)" : ""}:\n${tabs.slice(0, 30).join("\n")}\nWhen replying, summarize — don't list every tab unless asked.`;
          });
        case "read_page": {
          // Wait (up to ~8s) for a page that's still loading, so we don't read a blank tab.
          let head = "";
          for (let i = 0; i < 8; i++) {
            head = await osa(`tell application "${app}" to return (${titleProp} of ${cur}) & linefeed & (URL of ${cur})`);
            const [t, u] = head.split("\n");
            const loading = safari
              ? (await osa(`tell application "${app}" to do JavaScript "document.readyState" in ${cur}`).catch(() => "complete")) !== "complete"
              : (await osa(`tell application "${app}" to return loading of ${cur}`).catch(() => "false")) === "true";
            if (!loading && t?.trim() && t.trim() !== u?.trim()) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          const pageUrl = head.match(/https?:\/\/\S+/)?.[0] ?? "";
          // Live page (what's on screen right now, logged in) via Accessibility, pinned to this tab.
          if (pageUrl) {
            const live = await axweb(["text", b.app, "--url", pageUrl]).then((r) => JSON.parse(r) as { text?: string; title?: string; error?: string }).catch(() => null);
            if (live?.text?.trim()) return clip(`${live.title}\n${pageUrl}\n\n${live.text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()}`);
          }
          if (safari) {
            const text = await osa(`tell application "${app}" to return text of ${cur}`).catch(() => "");
            if (text.trim()) return clip(`${head}\n\n${text}`);
          } else {
            const text = await osa(`tell application "${app}" to execute ${cur} javascript "document.body.innerText"`).catch(() => "");
            if (text.trim() && text !== "missing value") return clip(`${head}\n\n${text}`);
          }
          // Browser blocks page scripts → read it through Accessibility (keeps the user's login, e.g. Gmail).
          const axText = await axPageText(b);
          if (axText.trim()) return clip(axText);
          // Last resort: fetch the same URL ourselves (no login state).
          if (/^https?:/.test(pageUrl)) {
            const res = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0 Marigold" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
            const html = res ? await res.text() : "";
            const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
            if (text) return clip(`${head}\n\n${text}`);
          }
          return `${head}\n\n(Couldn't read the page text.)`;
        }
        case "switch_tab": {
          const q = as(str(a, "query").toLowerCase());
          const r = await osa(`tell application "${app}"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if (${titleProp} of t) contains "${q}" or (URL of t) contains "${q}" then
        ${safari ? "set current tab of w to t" : "set active tab index of w to i"}
        set index of w to 1
        activate
        return ${titleProp} of t
      end if
    end repeat
  end repeat
  return ""
end tell`);
          return r ? `Switched to “${r}”.` : `FAILED: no tab matching “${str(a, "query")}”.`;
        }
        case "new_tab":
          if (safari) await osa(`tell application "${app}" to tell ${winRef} to set current tab to (make new tab)`);
          else await osa(`tell application "${app}" to tell ${winRef} to make new tab`);
          return `Opened a new tab in ${b.label}.`;
        case "close_tab": await osa(`tell application "${app}" to close ${cur}`); return "Closed the tab.";
        case "back":
          if (safari) await osa(`tell application "${app}" to do JavaScript "history.back()" in ${cur}`);
          else await osa(`tell application "${app}" to go back ${cur}`);
          return "Went back.";
        case "reload":
          if (safari) await osa(`tell application "${app}" to set URL of ${cur} to (URL of ${cur})`);
          else await osa(`tell application "${app}" to reload ${cur}`);
          return "Reloaded.";
      }
      return "Unknown action.";
    },
    true,
  ),

  // ------------------------------------------------------------ System controls
  tool(
    "system",
    "Mac system controls: volume/mute, screen brightness (set 0–100, up, down), dark mode, Wi-Fi on/off + current network, battery status, disk space, screenshot / screen recording, lock screen, clipboard read/write, list / quit / hide running apps, speak text aloud, open a System Settings pane, empty Trash, sleep/restart/shut down.",
    ["set_volume", "get_volume", "mute", "unmute", "set_brightness", "brightness_up", "brightness_down", "get_brightness", "dark_mode", "light_mode", "wifi_on", "wifi_off", "wifi_info", "battery", "disk_space", "screenshot", "screen_record", "lock", "clipboard_get", "clipboard_set", "running_apps", "quit_app", "hide_app", "say", "open_settings", "empty_trash", "sleep", "restart", "shutdown"],
    { level: { type: "number", description: "volume or brightness 0–100" }, app: { type: "string", description: "app name (quit_app, hide_app)" }, text: { type: "string", description: "text for clipboard_set or say" }, pane: { type: "string", description: "System Settings pane for open_settings: wifi, bluetooth, network, sound, displays, battery, notifications, privacy, keyboard, trackpad, general, focus, wallpaper, users, login-items" }, seconds: { type: "number", description: "screen_record length in seconds (default 10, max 120)" } },
    (act, a) => {
      if (act === "quit_app") return { tier: 2, scope: `system:quit:${str(a, "app").toLowerCase()}`, summary: `Quit ${str(a, "app") || "an app"}` };
      if (act === "clipboard_get") return { tier: 2, scope: "system:clipboard_read", summary: "Read what's on the clipboard" };
      if (act === "screen_record") return { tier: 2, scope: "system:screen_record", summary: `Record the screen for ${Math.min(120, num(a, "seconds", 10))}s` };
      if (["sleep", "restart", "shutdown"].includes(act)) return { tier: 2, scope: "system:power", noRemember: act !== "sleep", summary: `${act[0].toUpperCase()}${act.slice(1)} the Mac` };
      if (act === "empty_trash") return { tier: 2, scope: "system:empty_trash", noRemember: true, summary: "Empty the Trash (permanent)" };
      return { tier: ["battery", "get_brightness", "get_volume", "wifi_info", "disk_space", "running_apps"].includes(act) ? 0 : 1, summary: `System: ${act.replace(/_/g, " ")}${a.level !== undefined ? ` ${a.level}` : ""}` };
    },
    async (act, a) => {
      switch (act) {
        case "set_brightness": case "brightness_up": case "brightness_down": case "get_brightness": {
          const bin = await helperBin("brightness");
          const arg = act === "set_brightness" ? ["set", String(Math.max(0, Math.min(100, pct(num(a, "level", 50)))))] : act === "get_brightness" ? ["get"] : [act === "brightness_up" ? "up" : "down"];
          const { stdout } = await execAsync(bin, arg, { timeout: 5000 });
          const r = stdout.trim();
          if (r.startsWith("ERR")) return `FAILED: ${r.slice(4)}`;
          return act === "get_brightness" ? `Screen brightness is ${r}%.` : `Screen brightness is now ${r}%.`;
        }
        case "set_volume": await osa(`set volume output volume ${Math.max(0, Math.min(100, pct(num(a, "level", 50))))}`); return "Volume set.";
        case "mute": await osa("set volume with output muted"); return "Muted.";
        case "unmute": await osa("set volume without output muted"); return "Unmuted.";
        case "dark_mode": await osa('tell application "System Events" to tell appearance preferences to set dark mode to true'); return "Dark mode on.";
        case "light_mode": await osa('tell application "System Events" to tell appearance preferences to set dark mode to false'); return "Light mode on.";
        case "wifi_on": case "wifi_off": {
          const { stdout } = await execAsync("networksetup", ["-listallhardwareports"], { encoding: "utf8" });
          const dev = stdout.match(/Hardware Port: Wi-Fi\nDevice: (\w+)/)?.[1] ?? "en0";
          await execAsync("networksetup", ["-setairportpower", dev, act === "wifi_on" ? "on" : "off"]);
          return `Wi-Fi ${act === "wifi_on" ? "on" : "off"}.`;
        }
        case "battery": return (await execAsync("pmset", ["-g", "batt"], { encoding: "utf8" })).stdout.trim();
        case "screenshot": {
          const f = path.join(os.homedir(), "Desktop", `Screenshot ${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
          await execAsync("screencapture", ["-x", f]);
          return `Saved screenshot to ${f}`;
        }
        case "get_volume": { const v = await osa("output volume of (get volume settings)"); const m = await osa("output muted of (get volume settings)"); return `Volume is ${v}%${m === "true" ? " (muted)" : ""}.`; }
        case "wifi_info": {
          const { stdout: hp } = await execAsync("networksetup", ["-listallhardwareports"], { encoding: "utf8" });
          const dev = hp.match(/Hardware Port: Wi-Fi\nDevice: (\w+)/)?.[1] ?? "en0";
          const { stdout } = await execAsync("networksetup", ["-getairportnetwork", dev], { encoding: "utf8" }).catch(() => ({ stdout: "" }));
          const { stdout: ip } = await execAsync("ipconfig", ["getifaddr", dev], { encoding: "utf8" }).catch(() => ({ stdout: "" }));
          return `${stdout.trim() || "Wi-Fi status unavailable (macOS hides the network name without Location access)."}${ip.trim() ? ` · local IP ${ip.trim()}` : ""}`;
        }
        case "disk_space": return (await execAsync("df", ["-h", "/System/Volumes/Data"], { encoding: "utf8" })).stdout.trim();
        case "screen_record": {
          const secs = Math.max(1, Math.min(120, Math.round(num(a, "seconds", 10))));
          const f = path.join(os.homedir(), "Desktop", `Screen Recording ${new Date().toISOString().replace(/[:.]/g, "-")}.mov`);
          await execAsync("screencapture", ["-x", "-v", "-V", String(secs), f], { timeout: (secs + 15) * 1000 });
          return `Saved a ${secs}-second screen recording to ${f}`;
        }
        case "clipboard_get": { const { stdout } = await execAsync("pbpaste", [], { encoding: "utf8" }); return stdout ? clip(stdout, 4000) : "The clipboard is empty (or holds something that isn't text)."; }
        case "clipboard_set": {
          const t = str(a, "text");
          if (!t) return "FAILED: give the text to copy.";
          await new Promise<void>((res, rej) => { const p = spawn("pbcopy"); p.on("error", rej); p.on("close", () => res()); p.stdin.end(t); });
          return "Copied to the clipboard.";
        }
        case "running_apps": return (await osa('tell application "System Events" to get name of (processes where background only is false)')).split(", ").sort().join(", ");
        case "quit_app": case "hide_app": {
          const n = str(a, "app");
          if (!n) return "FAILED: which app?";
          if (/^(finder|marigold|system events)$/i.test(n)) return `FAILED: ${n} can't be ${act === "quit_app" ? "quit" : "hidden"} from here.`;
          if (act === "quit_app") { await osa(`tell application "${as(n)}" to quit`); return `Asked ${n} to quit (it may ask to save first).`; }
          await osa(`tell application "System Events" to set visible of process "${as(n)}" to false`); return `Hid ${n}.`;
        }
        case "say": { const t = str(a, "text"); if (!t) return "FAILED: what should I say?"; await execAsync("say", [t.slice(0, 600)], { timeout: 60_000 }); return "Spoke it aloud."; }
        case "open_settings": {
          const P: Record<string, string> = { wifi: "com.apple.wifi-settings-extension", bluetooth: "com.apple.BluetoothSettings", network: "com.apple.Network-Settings.extension", sound: "com.apple.Sound-Settings.extension", displays: "com.apple.Displays-Settings.extension", battery: "com.apple.Battery-Settings.extension", notifications: "com.apple.Notifications-Settings.extension", privacy: "com.apple.settings.PrivacySecurity.extension", keyboard: "com.apple.Keyboard-Settings.extension", trackpad: "com.apple.Trackpad-Settings.extension", general: "com.apple.systempreferences.GeneralSettings", focus: "com.apple.Focus-Settings.extension", wallpaper: "com.apple.Wallpaper-Settings.extension", users: "com.apple.Users-Groups-Settings.extension", "login-items": "com.apple.LoginItems-Settings.extension" };
          const key = str(a, "pane").toLowerCase().replace(/\s+/g, "-");
          const id = P[key] ?? P[Object.keys(P).find((k) => key.includes(k)) ?? ""];
          await execAsync("open", id ? [`x-apple.systempreferences:${id}`] : ["-a", "System Settings"]);
          return id ? `Opened System Settings → ${key}.` : "Opened System Settings.";
        }
        case "lock": await execAsync("pmset", ["displaysleepnow"]); return "Locked the screen.";
        case "empty_trash": await osa('tell application "Finder" to empty trash'); return "Emptied the Trash.";
        case "sleep": await osa('tell application "System Events" to sleep'); return "Going to sleep.";
        case "restart": await osa('tell application "System Events" to restart'); return "Restarting.";
        case "shutdown": await osa('tell application "System Events" to shut down'); return "Shutting down.";
      }
      return "Unknown action.";
    },
  ),
];

/** The older on-screen (Accessibility) browser control — still used when the user names Safari/Firefox/etc. */
export const LEGACY_BROWSER_TOOL = ALL_APP_TOOLS.find((t) => t.name === "web_browser")!;
/** App tools exposed to the model (web_browser comes from browser-tool.ts instead). */
export const APP_TOOLS = ALL_APP_TOOLS.filter((t) => t.name !== "web_browser");
