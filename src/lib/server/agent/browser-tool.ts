import os from "os";
import type { Locator, Page } from "playwright-core";
import type { ToolDef } from "./tools";
import { classifyBrowser, pageCache, LEGACY_BROWSER_TOOL } from "./apps";
import { browserByName } from "@/lib/browsers";
import { expandPath, sensitivePath, type Classified } from "./policy";
import { DOWNLOADS, lastDownload, page, setPage, settle, tabs, selectAccount } from "./browser";
import { accountFor, primaryAccount, withAccount } from "./accounts";
import { appBrowserAvailable, mb } from "./app-browser";
import { searchUrl } from "./web-search";
import type { ToolCtx } from "./tools";

/**
 * web_browser — full browser automation in the Marigold Browser (Chrome via the
 * DevTools Protocol). The agent works like a person, but on the page itself:
 *   open → elements (numbered) → click / type / select / press / scroll → read …
 * Safety: the same rules as before (💳 Touch ID for payments, ask before sending /
 * posting / uploading, passwords every time) plus a last-moment check that the
 * element about to be clicked is still what the agent saw.
 */

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
const num = (a: Args, k: string, d: number) => (a[k] !== undefined && a[k] !== "" && Number.isFinite(Number(a[k])) ? Number(a[k]) : d);
const clip = (t: string, n = 6000) => (t.length > n ? `${t.slice(0, n)}\n… (cut — use read with offset ${n} for more)` : t);

const ACTIONS = ["steps", "open_url", "search", "elements", "click", "type", "type_text", "keys", "select", "press", "scroll", "read", "find", "wait_for",
  "back", "forward", "reload", "list_tabs", "switch_tab", "new_tab", "close_tab", "upload", "download", "screenshot", "google_signin"] as const;

/** Pictures the agent asked for this turn; the loop hands them to the model with its next step. */
const pendingShots: string[] = [];
export const takePendingShots = () => pendingShots.splice(0, pendingShots.length);
/** Other tools (video frames…) hand pictures to the model the same way. */
export const queueVisionImages = (urls: string[]) => { pendingShots.push(...urls); if (pendingShots.length > 8) pendingShots.splice(0, pendingShots.length - 8); };

// ---------------------------------------------------------------- page scripts

/** Number every visible interactive element (data-mg="N") and describe it. */
const SNAPSHOT = `(() => {
  document.querySelectorAll('[data-mg]').forEach(e => e.removeAttribute('data-mg'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[onclick]';
  const seen = new Set();
  let els = [...document.querySelectorAll(sel)];
  // Clickable divs/spans (common in web apps) that aren't inside something already listed.
  for (const e of document.querySelectorAll('div,span,li,td,img')) {
    if (els.length > 1500) break;
    const cs = getComputedStyle(e);
    if (cs.cursor === 'pointer' && !e.closest(sel) && (e.innerText || e.getAttribute('aria-label') || e.alt)) els.push(e);
  }
  const vh = innerHeight, vw = innerWidth;
  const label = e => {
    const lab = e.labels && e.labels[0] ? e.labels[0].innerText : '';
    const btn = e.tagName === 'INPUT' && /^(submit|button|reset|image)$/i.test(e.type);
    const t = e.getAttribute('aria-label') || lab || (btn ? (e.value || e.alt || e.title || e.name) : (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? (e.placeholder || e.name || e.title) : (e.innerText || e.value || e.title || e.alt || e.placeholder || e.name))) || '';
    return t.trim().replace(/\\s+/g, ' ').slice(0, 90);
  };
  const out = [];
  for (const e of els) {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const l = label(e);
    const kind = e.isContentEditable ? 'editor' : e.tagName.toLowerCase() + (e.type ? ':' + e.type : e.getAttribute('role') ? ':' + e.getAttribute('role') : '');
    const key = kind + '|' + l + '|' + Math.round(r.top) + '|' + Math.round(r.left);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ e, kind, label: l, ac: e.autocomplete || '', vis: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      value: (e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : e.type === 'password' ? '' : (e.value || '')).slice(0, 60),
      checked: e.checked === true || e.getAttribute('aria-checked') === 'true' });
  }
  // On-screen first, then the rest; cap the list.
  out.sort((a, b) => (b.vis - a.vis));
  const list = out.slice(0, 160);
  list.forEach((o, i) => o.e.setAttribute('data-mg', String(i)));
  return { url: location.href, title: document.title, total: out.length, els: list.map(({ e, ...o }) => o) };
})()`;

/** Readable text of the page (main content first), cleaned up. */
const READ = `(() => {
  const main = document.querySelector('main,[role=main],article') || document.body;
  const t = (main.innerText || '') + (main !== document.body ? '\\n\\n— rest of page —\\n' + document.body.innerText.slice(0, 4000) : '');
  // What's typed into fields isn't page text — list it so the agent can check its work (never passwords).
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]),textarea,select')]
    .map(e => { const lab = (e.labels && e.labels[0] ? e.labels[0].innerText : '') || e.getAttribute('aria-label') || e.placeholder || e.name || '';
      const v = e.tagName === 'SELECT' ? (e.options[e.selectedIndex] || {}).text : (e.type === 'checkbox' || e.type === 'radio') ? (e.checked ? 'checked' : '') : e.value;
      return v ? '• ' + lab.trim().replace(/\\s+/g, ' ').slice(0, 60) + ' = ' + String(v).slice(0, 200) : ''; }).filter(Boolean).slice(0, 40);
  const all = t.replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim() + (fields.length ? '\\n\\n— filled-in fields —\\n' + fields.join('\\n') : '');
  return { url: location.href, title: document.title, text: all };
})()`;

// ---------------------------------------------------------------- helpers

interface Snap { url: string; title: string; total: number; els: { kind: string; label: string; ac: string; vis: boolean; value: string; checked: boolean }[] }

async function snapshot(p: Page): Promise<Snap> {
  const s = (await p.evaluate(SNAPSHOT)) as Snap;
  pageCache.url = s.url;
  pageCache.title = s.title;
  pageCache.els = s.els.map((e) => ({ kind: e.kind, label: e.label, ac: e.ac }));
  return s;
}

function formatSnap(s: Snap) {
  const lines = s.els.map((e, i) =>
    `[${i}] ${e.kind}${e.label ? ` “${e.label}”` : ""}${e.value ? ` = “${e.value}”` : ""}${e.checked ? " ✓" : ""}${/^cc-/.test(e.ac) || /card number|cvv|cvc|security code/i.test(e.label) ? " (card field)" : ""}${e.vis ? "" : " (off-screen)"}`);
  return clip(`${s.title} — ${s.url}\n${lines.join("\n") || "(nothing clickable yet — the page may still be loading; call elements again)"}${s.total > s.els.length ? `\n(+${s.total - s.els.length} more — scroll and call elements again)` : ""}`, 7000);
}

/** The element to act on: a number from the last `elements`, or a visible label. */
async function target(p: Page, a: Args, act: string): Promise<{ loc: Locator; how: string } | string> {
  const idx = num(a, "index", -1);
  if (idx >= 0) {
    const loc = p.locator(`[data-mg="${idx}"]`).first();
    if ((await loc.count()) === 0) return "FAILED: that element number is gone (the page changed). Call elements again.";
    return { loc, how: `[${idx}]` };
  }
  const t = str(a, "text");
  if (!t || act === "type") return "FAILED: give index (from elements) or text (the visible label).";
  for (const loc of [
    p.getByRole("button", { name: t, exact: false }), p.getByRole("link", { name: t, exact: false }),
    p.getByRole("tab", { name: t, exact: false }), p.getByRole("menuitem", { name: t, exact: false }),
    p.getByLabel(t, { exact: false }), p.getByText(t, { exact: false }),
  ]) {
    const first = loc.first();
    if ((await first.count().catch(() => 0)) > 0 && (await first.isVisible().catch(() => false))) return { loc: first, how: `“${t}”` };
  }
  return `FAILED: nothing on the page matches “${t}”. Call elements to see what's there.`;
}

/** Live description of an element, for the last-moment safety re-check. */
async function describe(loc: Locator): Promise<{ kind: string; label: string; ac: string }> {
  return loc.evaluate((e: Element) => {
    const el = e as HTMLInputElement;
    const lab = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    const label = (el.getAttribute("aria-label") || lab || el.innerText || el.value || el.title || el.placeholder || el.name || "").trim().replace(/\s+/g, " ").slice(0, 90);
    return { kind: (el as HTMLElement).isContentEditable ? "editor" : el.tagName.toLowerCase() + (el.type ? ":" + el.type : ""), label, ac: el.autocomplete || "" };
  });
}

const KEYS: Record<string, string> = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", up: "ArrowUp", down: "ArrowDown",
  left: "ArrowLeft", right: "ArrowRight", backspace: "Backspace", delete: "Delete", space: " ", pagedown: "PageDown", pageup: "PageUp", home: "Home", end: "End" };

async function afterAction(p: Page, what: string) {
  await settle(p, 4000);
  const ps = await tabs();
  const newest = ps[ps.length - 1];
  // A click that opened a new tab → follow it.
  if (newest && newest !== p && newest.url() !== "about:blank") { await setPage(newest); await settle(newest, 4000); p = newest; }
  return `${what}. Now on: ${await p.title().catch(() => "")} — ${p.url()}. Call elements (or read) to see the page now.`;
}

/** read / find output (shared by both browser backends). */
function readResult(r: { url: string; title: string; text: string }, a: Args, act: string): string {
  pageCache.url = r.url; pageCache.title = r.title;
  const q = str(a, "query") || (act === "find" ? str(a, "text") : "");
  if (q) {
    // Pages rarely use your exact phrase ("Warriors"/"GSW", not "Golden State Warriors"):
    // rank lines by how many of the query's words they contain.
    const lines = r.text.split("\n");
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const scored = lines.map((l, i) => {
      const ll = l.toLowerCase();
      const n = ll.includes(q.toLowerCase()) ? words.length + 1 : words.filter((w) => ll.includes(w)).length;
      return { i, n };
    }).filter((x) => x.n > 0).sort((x, y) => y.n - x.n || x.i - y.i);
    if (!scored.length) return `Nothing about “${q}” on this page (${r.title}). Try read without query, scroll, or another page.`;
    const top = scored.slice(0, 10).sort((x, y) => x.i - y.i);
    const hits = top.map(({ i }) => lines.slice(Math.max(0, i - 2), i + 5).join("\n"));
    return clip(`${r.title} — ${r.url}\n${scored.length} line(s) mention “${q}” (best first):\n\n${hits.join("\n…\n")}`);
  }
  const off = Math.max(0, num(a, "offset", 0));
  const body = r.text.slice(off, off + 6000);
  return `${r.title} — ${r.url}\n\n${body}${r.text.length > off + 6000 ? `\n… (${r.text.length - off - 6000} more characters — read with offset ${off + 6000})` : ""}`;
}

// ---------------------------------------------------------------- classification

const BATCHABLE = new Set(["type", "type_text", "keys", "select", "click", "press", "scroll", "wait_for"]);

function classify(a: Args): Classified {
  const act = str(a, "action");
  if (act === "steps") {
    const list = Array.isArray(a.steps) ? (a.steps as Args[]) : [];
    if (!list.length) return { tier: 0, blocked: "steps needs a list of actions", summary: "browser: steps" };
    if (list.length > 15) return { tier: 0, blocked: "steps holds at most 15 actions — split it in two", summary: "browser: steps" };
    const bad = list.find((s) => !BATCHABLE.has(str(s, "action")));
    if (bad) return { tier: 0, blocked: `steps can only contain ${[...BATCHABLE].join("/")} (got "${str(bad, "action")}")`, summary: "browser: steps" };
    const each = list.map((s) => classify({ ...s, account: a.account }));
    const worst = each.reduce((m, c) => (c.tier > m.tier || c.blocked ? c : m), each[0]);
    return { ...worst, summary: `Marigold Browser: ${list.length} steps — ${each.map((c) => c.summary.replace(/^Marigold Browser:\s*/, "")).join("; ").slice(0, 160)}` };
  }
  if (!ACTIONS.includes(act as (typeof ACTIONS)[number])) return { tier: 0, blocked: `unknown action "${act}" — use one of: ${ACTIONS.join(", ")}`, summary: `browser: ${act}` };
  if (act === "google_signin") {
    const h = host(pageCache.url) || "this site";
    // Links the user's Google account to a website (name + email shared): always the user's call, once per site.
    return { tier: 2, scope: `browser:google-signin:${h}`, outward: true, summary: `Sign in to ${h} with your Google account (shares your name and email; no password is typed)` };
  }
  if (act === "upload") {
    const f = str(a, "path");
    // Uploading sends a file to a website: ask (once per site).
    return { tier: 2, blocked: sensitivePath(f), scope: `browser:upload:${host(pageCache.url)}`, outward: true, summary: `Upload ${f} to ${host(pageCache.url) || "this site"}` };
  }
  // Typing with submit = pressing Enter afterwards (sending a form/search/message).
  // A SEARCH box isn't sending anything anywhere → no prompt.
  if (act === "type" && a.submit === true) {
    const el = pageCache.els[num(a, "index", -1)];
    const isSearch = /search|find|query|look ?up|filter|zip|postal|city|location|forecast|destination|where to|keyword/i.test(`${el?.label ?? ""} ${el?.kind ?? ""}`) || /:search|searchbox|combobox/.test(el?.kind ?? "");
    if (isSearch && classifyBrowser("type", a).tier < 2) return { tier: 1, summary: `Marigold Browser: search “${str(a, "text").slice(0, 50)}” on ${host(pageCache.url) || "this site"}` };
    const c = classifyBrowser("press", { ...a, key: "Enter" });
    const typed = classifyBrowser("type", a);
    return typed.tier >= c.tier ? typed : { ...c, summary: `Marigold Browser: type “${str(a, "text").slice(0, 40)}” and press Enter on ${host(pageCache.url) || "this page"}` };
  }
  // type_text = typing into whatever has focus; keys = a sequence of key presses (risky if it includes Enter).
  if (act === "type_text") return { ...classifyBrowser("type", { ...a, index: -1 }), summary: `Marigold Browser: type “${str(a, "text").slice(0, 40)}”` };
  if (act === "keys") {
    const list = (Array.isArray(a.keys) ? (a.keys as unknown[]).map(String) : str(a, "keys").split(/[\s,]+/)).filter(Boolean);
    const each = list.map((k) => classifyBrowser("press", { ...a, key: k }));
    const worst = each.reduce((m, c) => (c.tier > m.tier ? c : m), { tier: 1, summary: "keys" } as Classified);
    return { ...worst, summary: `Marigold Browser: press ${list.join(" ").slice(0, 50)}` };
  }
  const mapped = act === "download" ? "click" : act === "read" || act === "find" || act === "wait_for" || act === "list_tabs" ? "read_page" : act;
  const c = classifyBrowser(mapped, a);
  return { ...c, summary: c.summary.replace(/^[^:]+:/, "Marigold Browser:") };
}
const host = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };

// ---------------------------------------------------------------- the tool

export const browserTool: ToolDef = {
  name: "web_browser",
  description:
    "Use the web like a person, in the Marigold Browser (real Chrome with its own saved logins). Navigate: open_url, search, back, forward, reload, list_tabs, switch_tab(index), new_tab(url), close_tab. " +
    "See: elements → numbered buttons/links/fields; read → page text (use query to jump to the part you need, offset for more); find(text) → where something appears; wait_for(text). " +
    "Act: click(index or text=visible label), type(index, text, submit=true to press Enter), select(index, text), press(key), scroll(direction), download(index), upload(index, path). " +
    "FAST: type_text(text) types a WHOLE string into whatever is focused in ONE call (use it for Google Docs/Slides/any editor — never one letter at a time); keys([\"Tab\",\"Enter\",\"Meta+B\"]) presses several keys in ONE call. " +
    "Clicks, key presses and page loads already return the page's controls — act on those numbers directly instead of calling elements again. ALWAYS batch: action=steps can hold up to 15 actions (click, type, type_text, keys, select, press, scroll, wait_for) — do a whole form or sequence in one call. " +
    "Filling a form? Use action=steps to do several type/select/click actions in one call. Always call elements again after the page changes. If a site needs the user to sign in: FIRST look for a Google option (a result may say so) and use action=google_signin; only when there is none (or Google needs a password/verification) tell the user to sign in once in the Marigold Browser, then continue. " +
    "A site offers \"Sign in / Continue with Google\"? Use action=google_signin: it clicks that button and picks the user's Google account in Google's own chooser, with no password (the user is asked first, once per site). If the site has no Google option, or Google wants a password or a verification step, it stops and the user finishes that part themselves. " +
    "Set browser only if the user names Safari/Firefox/etc.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      url: { type: "string", description: "URL to open" },
      query: { type: "string", description: "search text (search), text to look for (read/find), or part of a tab title (switch_tab)" },
      index: { type: "number", description: "element number from the latest elements list, or tab number for switch_tab" },
      text: { type: "string", description: "text to type / option to select / visible label to click or wait for" },
      keys: { type: "array", items: { type: "string" }, description: "keys: press these in order in ONE call, e.g. [\"Tab\",\"Tab\",\"Enter\"] or [\"Meta+A\",\"Backspace\"]" },
      submit: { type: "boolean", description: "type: press Enter after typing" },
      key: { type: "string", description: "press: Enter, Tab, Escape, ArrowDown, …" },
      direction: { type: "string", description: "scroll: up or down" },
      offset: { type: "number", description: "read: start from this character (for long pages)" },
      current_tab: { type: "boolean", description: "work in the tab the user is looking at (when they say 'this page')" },
      path: { type: "string", description: "upload: file on the Mac" },
      browser: { type: "string", description: "only if the user names a browser other than Chrome" },
      account: { type: "string", description: "which of the user's emails to act as (default: their primary login email)" },
      steps: {
        type: "array",
        description: "action=steps: several page actions done in ONE go, in order, using numbers from the latest elements — e.g. [{action:'type',index:0,text:'Ayush'},{action:'select',index:1,text:'Large'},{action:'click',index:3}]. Stops at the first failure.",
        items: { type: "object", properties: { action: { type: "string" }, index: { type: "number" }, text: { type: "string" }, key: { type: "string" }, keys: { type: "array", items: { type: "string" } }, submit: { type: "boolean" }, direction: { type: "string" } }, required: ["action"] },
      },
    },
    required: ["action"],
  },
  taints: true,
  classify: (a) => {
    // A non-Chrome browser named → the older on-screen control for that browser.
    const named = browserByName(str(a, "browser"));
    if (named && named.kind !== "chromium") return LEGACY_BROWSER_TOOL.classify(a);
    return classify(a);
  },
  async exec(a, signal, ctx) {
    const named = browserByName(str(a, "browser"));
    if (named && named.kind !== "chromium") return LEGACY_BROWSER_TOOL.exec(a, signal, ctx);
    // Act as the right account: primary unless the user explicitly chose another (enforced in the loop).
    selectAccount((accountFor(str(a, "account")) ?? primaryAccount())?.address);
    const act = str(a, "action");
    if (act === "steps") {
      // Each step runs through the same code (incl. the last-moment safety check); stop at the first problem.
      const log: string[] = [];
      for (const [i, s] of (a.steps as Args[]).entries()) {
        const r = await browserTool.exec({ ...s, account: a.account, _batch: true }, signal, ctx);
        log.push(`${i + 1}. ${str(s, "action")}: ${r.split("\n")[0]}`);
        if (/^(FAILED|BLOCKED)/.test(r)) { log.push(`Stopped at step ${i + 1}; the rest weren't done.`); return log.join("\n"); }
      }
      const after = appBrowserAvailable() ? await appPageSummary().catch(() => "") : "";
      return `${log.join("\n")}\nAll ${log.length} steps are DONE (including any clicks above) — don't repeat them.${after ? `\n\nThe page now:\n${after}` : " Use read to check the result."}`;
    }
    // Inside the Marigold app: drive its built-in Chromium tabs (the Marigold Browser).
    if (act === "google_signin" && !appBrowserAvailable()) return "FAILED: signing in with Google works inside the Marigold app's browser only.";
    if (appBrowserAvailable()) return execInApp(a, act, ctx);
    let p = await page();

    switch (act) {
      case "open_url": case "search": case "new_tab": {
        let url = act === "search" ? searchUrl(str(a, "query") || str(a, "text")) : str(a, "url");
        if (!url) return "FAILED: give url (or query for search).";
        if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
        if (!/^https?:/i.test(url)) return "FAILED: only http(s) links can be opened.";
        // Google services open as the user's account (primary unless they named another).
        url = withAccount(url, accountFor(str(a, "account")));
        if (act === "new_tab") { p = await (await tabs())[0].context().newPage(); await setPage(p); }
        const err = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).then(() => "", (e) => String(e).split("\n")[0]);
        if (err) {
          if (/ERR_(CONNECTION|BLOCKED|NAME_NOT_RESOLVED|INTERNET)|ERR_FILTER|ERR_ACCESS/i.test(err)) return `FAILED: ${new URL(url).hostname} can't be reached from this Mac (it may be blocked by Screen Time's content filter, or offline). Use a different site.`;
          return `FAILED: couldn't load ${url} (${err.replace(/^.*?net::/, "")}).`;
        }
        await settle(p);
        pageCache.url = p.url(); pageCache.title = await p.title().catch(() => "");
        return `Opened ${pageCache.title} — ${p.url()}. Call elements to see what you can click, or read to get the text.`;
      }
      case "elements": return formatSnap(await snapshot(p));
      case "read": case "find": {
        const r = (await p.evaluate(READ)) as { url: string; title: string; text: string };
        return readResult(r, a, act);
      }
      case "wait_for": {
        const t = str(a, "text") || str(a, "query");
        const ok = await p.getByText(t, { exact: false }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
        return ok ? `“${t}” is on the page now.` : `FAILED: “${t}” didn't appear within 15 s.`;
      }
      case "click": case "type": case "select": case "download": case "upload": {
        const t = await target(p, a, act);
        if (typeof t === "string") return t;
        // Last-moment check: still the element the agent saw, and not riskier than approved.
        const live = await describe(t.loc);
        const idx = num(a, "index", -1);
        const seen = idx >= 0 ? pageCache.els[idx] : undefined;
        if (seen && seen.label && live.label && seen.label !== live.label) return `FAILED: the page changed — element ${idx} is now “${live.label}”, not “${seen.label}”. Nothing was done. Call elements again.`;
        const approved = classify(a);
        const saved = pageCache.els;
        pageCache.els = [{ kind: live.kind, label: live.label, ac: live.ac }];
        const real = classify({ ...a, index: 0 });
        pageCache.els = saved;
        if (real.tier > approved.tier) return `BLOCKED: that targets “${live.label || live.kind}”${real.tier === 3 ? " — a payment/purchase control" : ""}. Call web_browser ${act} again with text="${live.label.replace(/"/g, "")}" so Marigold can ask the user properly.`;

        if (act === "click") {
          await t.loc.click({ timeout: 10_000 }).catch(async () => t.loc.click({ timeout: 5000, force: true }));
          return afterAction(p, `Clicked ${t.how}${live.label ? ` (“${live.label}”)` : ""}`);
        }
        if (act === "download") {
          const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30_000 }), t.loc.click({ timeout: 10_000 })]);
          const dest = `${DOWNLOADS}/${dl.suggestedFilename()}`;
          await dl.saveAs(dest);
          return `Downloaded ${dl.suggestedFilename()} to ${dest.replace(os.homedir(), "~")}.`;
        }
        if (act === "upload") {
          const f = expandPath(str(a, "path"));
          await t.loc.setInputFiles(f);
          return `Attached ${f.replace(os.homedir(), "~")}.`;
        }
        if (act === "select") {
          const want = str(a, "text");
          const native = await t.loc.evaluate((e: Element) => e.tagName === "SELECT");
          if (native) {
            await t.loc.selectOption({ label: want }).catch(() => t.loc.selectOption(want));
            return `Selected “${want}”.`;
          }
          // Custom dropdown: open it, then click the option.
          await t.loc.click({ timeout: 8000 });
          const opt = p.getByRole("option", { name: want }).or(p.getByText(want, { exact: false })).first();
          await opt.click({ timeout: 8000 });
          return afterAction(p, `Selected “${want}”`);
        }
        // type
        const text = str(a, "text");
        try { await t.loc.fill(text, { timeout: 8000 }); }
        catch { await t.loc.click({ timeout: 5000 }); await p.keyboard.press("Meta+A"); await p.keyboard.type(text, { delay: 15 }); }
        if (a.submit === true) { await p.keyboard.press("Enter"); return afterAction(p, `Typed into ${t.how} and pressed Enter`); }
        return `Typed into ${t.how}${live.label ? ` (“${live.label}”)` : ""}.`;
      }
      case "type_text": { await p.keyboard.insertText(String(a.text ?? "").slice(0, 20000)); return `Typed ${String(a.text ?? "").length} characters into the focused field.`; }
      case "keys": {
        const list = (Array.isArray(a.keys) ? (a.keys as unknown[]).map(String) : str(a, "keys").split(/[\s,]+/)).filter(Boolean).slice(0, 40);
        for (const k of list) await p.keyboard.press(KEYS[k.toLowerCase()] ?? k);
        return afterAction(p, `Pressed ${list.join(" ")}`);
      }
      case "press": {
        const k = str(a, "key") || "Enter";
        await p.keyboard.press(KEYS[k.toLowerCase()] ?? k);
        return afterAction(p, `Pressed ${k}`);
      }
      case "scroll": {
        const up = /up/i.test(str(a, "direction"));
        await p.mouse.wheel(0, up ? -700 : 700);
        await new Promise((r) => setTimeout(r, 400));
        return `Scrolled ${up ? "up" : "down"}. Call elements to see what's visible now.`;
      }
      case "back": await p.goBack({ timeout: 15_000 }).catch(() => {}); return afterAction(p, "Went back");
      case "forward": await p.goForward({ timeout: 15_000 }).catch(() => {}); return afterAction(p, "Went forward");
      case "reload": await p.reload({ timeout: 30_000 }); return afterAction(p, "Reloaded");
      case "list_tabs": {
        const ps = await tabs();
        const rows = await Promise.all(ps.map(async (t, i) => `[${i}] ${await t.title().catch(() => "")} — ${t.url()}${t === p ? "  ← current" : ""}`));
        return rows.join("\n") || "No tabs.";
      }
      case "switch_tab": {
        const ps = await tabs();
        const q = str(a, "query").toLowerCase();
        const i = num(a, "index", -1);
        let hit = i >= 0 ? ps[i] : undefined;
        if (!hit && q) for (const t of ps) if ((await t.title()).toLowerCase().includes(q) || t.url().toLowerCase().includes(q)) { hit = t; break; }
        if (!hit) return "FAILED: no such tab — call list_tabs.";
        await setPage(hit);
        return `Switched to ${await hit.title()} — ${hit.url()}.`;
      }
      case "close_tab": {
        const ps = await tabs();
        if (ps.length <= 1) { await p.goto("about:blank"); return "Closed the page (kept the window open)."; }
        await p.close();
        await setPage((await tabs())[0]);
        return "Closed the tab.";
      }
    }
    void lastDownload;
    return "Unknown action.";
  },
};

// ---------------------------------------------------------------- the Marigold app's own browser

interface Live { kind: string; label: string; ac: string; x: number; y: number; hit: boolean; password: boolean; tag: string }

/** Scroll element N into view and describe it (incl. whether a click at its centre would hit it). */
const LOCATE = (i: number) => `(() => {
  const e = document.querySelector('[data-mg="${i}"]');
  if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = e.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
  const at = document.elementFromPoint(x, y);
  const lab = e.labels && e.labels[0] ? e.labels[0].innerText : '';
  const btn = e.tagName === 'INPUT' && /^(submit|button|reset|image)$/i.test(e.type);
  const label = (e.getAttribute('aria-label') || lab || (btn ? (e.value || e.alt || e.title || e.name) : (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? (e.placeholder || e.name || e.title) : (e.innerText || e.value || e.title || e.alt || e.placeholder || e.name))) || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
  return { kind: e.isContentEditable ? 'editor' : e.tagName.toLowerCase() + (e.type ? ':' + e.type : ''), label, ac: e.autocomplete || '',
    x, y, hit: !!at && (at === e || e.contains(at) || at.contains(e)), password: e.type === 'password', tag: e.tagName };
})()`;

async function appSnap(): Promise<Snap> {
  const { value } = (await mb("eval", { js: SNAPSHOT, ...curArgs })) as { value: Snap };
  pageCache.url = value.url; pageCache.title = value.title;
  pageCache.els = value.els.map((e) => ({ kind: e.kind, label: e.label, ac: e.ac }));
  return value;
}
let useCurrent = false;
let curArgs: Record<string, unknown> = {};

/** The page's visible controls (numbered, ready to act on) — saves the agent a separate "elements" turn. */
async function appPageSummary(max = 50): Promise<string> {
  const s = await appSnap();
  return formatSnap({ ...s, els: s.els.filter((e) => e.vis).slice(0, max) }); // visible ones come first, so numbers still match
}
/** Inside an action=steps batch: don't re-number the page between steps. */
let inBatch = false;

/** On a sign-in page that offers Google: say so, so the agent uses google_signin instead of giving up or wandering through menus. */
async function googleHint(): Promise<string> {
  try {
    const { value } = (await mb("eval", { js: `(() => { if (location.hostname === 'accounts.google.com') return false; const login = !!document.querySelector('input[type=password], input[type=email], input[autocomplete=username]') || /(sign|log) ?in|login|sign ?up|register|create (an )?account/i.test(document.title + ' ' + location.pathname + ' ' + (document.body.innerText || '').slice(0, 400)); return login; })()`, ...curArgs })) as { value: boolean };
    if (!value) return "";
    const g = ((await mb("eval", { js: GOOGLE_BUTTON.replace(/e\.scrollIntoView\(\{ block: 'center' \}\); /, ""), ...curArgs })) as { value: unknown }).value;
    return g ? "\nThis page offers “Sign in with Google”. Use web_browser action=google_signin (the user is asked first; no password is typed)." : "";
  } catch { return ""; }
}

async function appAfter(what: string, info?: { title?: string; url?: string }) {
  const i = info?.url ? info : ((await mb("info", curArgs)) as { title: string; url: string });
  pageCache.url = i.url ?? ""; pageCache.title = i.title ?? "";
  const head = `${what}. Now on: ${i.title} — ${i.url}.`;
  if (inBatch) return head;
  const controls = await appPageSummary().catch(() => "");
  const hint = await googleHint();
  return controls ? `${head}\nControls now (act on these numbers directly):\n${controls}${hint}` : `${head} Call elements (or read) to see the page now.${hint}`;
}

// ---------------------------------------------------------------- "Continue with Google" (no password, ever)

/** The site's own Google button: by its words, or Google's embedded button frame. Returns where to click. */
const GOOGLE_BUTTON = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 24 && r.height > 14 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const words = /(sign|log)\\s?(in|up)\\s*(in\\s*)?(with|using|via|through)\\s*google|continue\\s*(with|using)\\s*google|(connect|register|join)\\s*(with|using)\\s*google|google\\s*(sign|log)\\s?in/i;
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '') + ' ' + (e.title || '') + ' ' + [...e.querySelectorAll('img[alt],svg[aria-label]')].map((i) => i.getAttribute('alt') || i.getAttribute('aria-label')).join(' ')).replace(/\\s+/g, ' ').trim();
  const pick = (e, how) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how, label: label(e).slice(0, 60) }; };
  const frames = [...document.querySelectorAll('iframe[src*="accounts.google.com/gsi"], iframe[title*="Sign in with Google" i], iframe[src*="accounts.google.com/gsi/button"]')].filter(vis);
  const els = [...document.querySelectorAll('button, a, [role="button"], div[tabindex], span[role="button"], input[type="button"], input[type="submit"]')].filter(vis);
  const hit = els.find((e) => words.test(label(e))) || els.find((e) => /google/i.test(label(e)) && /sign|log|continue|connect/i.test(label(e)));
  if (hit) return pick(hit, 'button');
  if (frames.length) return pick(frames[0], 'frame');
  return null;
})()`;

/** What a Google page is asking for right now. */
const GOOGLE_STATE = (email: string) => `(() => {
  const email = ${JSON.stringify(email.toLowerCase())};
  const t = (document.body && document.body.innerText || '').slice(0, 1500);
  if (document.querySelector('input[type=password]')) return { kind: 'password' };
  if (/verify it.?s you|2-step|two-step|confirm your recovery|captcha|not a robot|couldn.t sign you in|unusual activity|choose how you want to sign in|try another way|this browser or app may not be secure/i.test(t)) return { kind: 'verify' };
  const tiles = [...document.querySelectorAll('[data-identifier], [data-email], li[role=link], div[role=link], div[data-authuser]')];
  const mine = tiles.find((e) => ((e.getAttribute('data-identifier') || e.getAttribute('data-email') || e.innerText || '')).toLowerCase().includes(email));
  if (mine) { mine.scrollIntoView({ block: 'center' }); const r = mine.getBoundingClientRect(); return { kind: 'pick', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
  if (tiles.length > 1) return { kind: 'nomatch' };
  if (tiles.length === 1) { tiles[0].scrollIntoView({ block: 'center' }); const r = tiles[0].getBoundingClientRect(); return { kind: 'pick', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
  const go = [...document.querySelectorAll('button, [role=button], input[type=submit]')].find((e) => /^\\s*(continue|allow|confirm|yes, continue|sign in)\\s*$/i.test((e.innerText || e.value || e.getAttribute('aria-label') || '')));
  if (go) { const r = go.getBoundingClientRect(); return { kind: 'continue', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), what: (go.innerText || '').trim() }; }
  return { kind: 'wait' };
})()`;

async function googleSignIn(a: Args, cur: Record<string, unknown>): Promise<string> {
  const email = (accountFor(str(a, "account")) ?? primaryAccount())?.address ?? "";
  if (!email) return "FAILED: no Google account is connected to Marigold yet. Connect Google in Settings first.";
  const start = (await mb("tabs")) as { tabs: { id: number; url: string }[]; agentId?: number; activeId?: number };
  const originId = cur.current === true ? start.activeId : start.agentId;
  const found = ((await mb("eval", { js: GOOGLE_BUTTON, ...cur })) as { value: { x: number; y: number; how: string; label: string } | null }).value;
  if (!found) return "This page has no “Sign in with Google” button that I can see. Try scrolling, opening the site's sign-in page, or tell the user the site needs its own sign-in (Marigold won't type a password).";
  await mb("click", { x: found.x, y: found.y, ...cur });
  const steps: string[] = [`Clicked the Google button (${found.label || found.how}).`];
  let picked = false, continued = 0;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 900));
    const st = (await mb("tabs")) as { tabs: { id: number; url: string }[]; agentId?: number; activeId?: number };
    const g = st.tabs.find((t) => { try { return new URL(t.url).hostname === "accounts.google.com"; } catch { return false; } });
    if (!g) {
      if (picked) { // Google's window is gone: the site now has the sign-in.
        if (originId && st.tabs.some((t) => t.id === originId) && cur.current !== true) await mb("switch", { id: originId }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const info = (await mb("info", cur)) as { title: string; url: string };
        pageCache.url = info.url; pageCache.title = info.title;
        return `${steps.join(" ")} Google's part is done; now on ${info.title} — ${info.url}. Check the page: if it asks for a username, birthday or to accept terms, continue with those (never a password).\n${await appPageSummary().catch(() => "")}`;
      }
      continue; // the popup/redirect hasn't appeared yet
    }
    const target = cur.current === true ? cur : { ...cur, current: false };
    if (cur.current !== true && st.agentId !== g.id) await mb("switch", { id: g.id }).catch(() => {});
    const s = ((await mb("eval", { js: GOOGLE_STATE(email), ...target })) as { value: { kind: string; x?: number; y?: number; what?: string } }).value;
    if (s.kind === "password") return `${steps.join(" ")} STOPPED: Google is asking for the password. Marigold never types passwords. Tell the user the Google window is ready in the Browser for them (then ask you to carry on).`;
    if (s.kind === "verify") return `${steps.join(" ")} STOPPED: Google wants an extra check (verification, 2-step or a robot test). That's for the user to do. Tell them the Google window is waiting in the Browser.`;
    if (s.kind === "nomatch") return `${steps.join(" ")} STOPPED: Google lists several accounts and none is the one connected to Marigold. Ask the user which to use, and tell them to pick it in the Browser.`;
    if (s.kind === "pick" && !picked) { await mb("click", { x: s.x, y: s.y, ...target }); picked = true; steps.push("Chose the user's Google account."); continue; }
    if (s.kind === "continue" && continued < 3) { await mb("click", { x: s.x, y: s.y, ...target }); continued++; steps.push(`Clicked “${s.what}” on Google's own page.`); continue; }
  }
  return `${steps.join(" ")} It didn't finish within about 20 seconds. Look at the page (screenshot) to see where it stopped; if Google is waiting on something, the user does that part.`;
}

async function execInApp(a: Args, act: string, ctx?: ToolCtx): Promise<string> {
  useCurrent = a.current_tab === true || ctx?.browserCurrent === true;
  inBatch = a._batch === true;
  // Which profile: the tab the user is in, or the email the task names (default: the current profile).
  const named = str(a, "account") ? accountFor(str(a, "account"))?.address : undefined;
  const cur = { current: useCurrent, ...(named ? { account: named } : {}) };
  curArgs = cur;
  switch (act) {
    case "open_url": case "search": case "new_tab": {
      let url = act === "search" ? searchUrl(str(a, "query") || str(a, "text")) : str(a, "url");
      if (!url) return "FAILED: give url (or query for search).";
      if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
      if (!/^https?:/i.test(url)) return "FAILED: only http(s) links can be opened.";
      url = withAccount(url, accountFor(str(a, "account")));
      const r = (await mb("open", { url, newTab: act === "new_tab", ...cur })) as { title: string; url: string; error?: string };
      if (r.error && /ERR_(NAME_NOT_RESOLVED|INTERNET|CONNECTION|BLOCKED|ACCESS)/.test(r.error)) return `FAILED: ${new URL(url).hostname} can't be reached (offline, or blocked by a content filter).`;
      pageCache.url = r.url; pageCache.title = r.title;
      const controls = inBatch ? "" : await appPageSummary().catch(() => "");
      const hint = inBatch ? "" : await googleHint();
      return controls ? `Opened ${r.title} — ${r.url}.\nControls now (act on these numbers directly):\n${controls}${hint}` : `Opened ${r.title} — ${r.url}. Call elements to see what you can click, or read to get the text.${hint}`;
    }
    case "elements": return formatSnap(await appSnap());
    case "google_signin": return googleSignIn(a, cur);
    case "screenshot": {
      const r = (await mb("shot", { maxWidth: 1400, ...cur })) as { jpg?: string };
      if (!r.jpg) return "FAILED: couldn't take a picture of this tab (it may be empty). Use read instead.";
      pendingShots.push(`data:image/jpeg;base64,${r.jpg}`);
      if (pendingShots.length > 8) pendingShots.shift();
      return "Screenshot taken: the picture comes with your next step. Look at it for layout, charts, images or anything the text doesn't say, then carry on with the task (click, scroll, open the next page).";
    }
    case "read": case "find": {
      const { value } = (await mb("eval", { js: READ, ...cur })) as { value: { url: string; title: string; text: string } };
      return readResult(value, a, act);
    }
    case "wait_for": {
      const t = (str(a, "text") || str(a, "query")).toLowerCase();
      for (let i = 0; i < 30; i++) {
        const { value } = (await mb("eval", { js: "document.body.innerText", ...cur })) as { value: string };
        if (String(value).toLowerCase().includes(t)) return `“${t}” is on the page now.`;
        await new Promise((r) => setTimeout(r, 500));
      }
      return `FAILED: “${t}” didn't appear within 15 s.`;
    }
    case "click": case "type": case "select": case "download": case "upload": {
      let idx = num(a, "index", -1);
      if (idx < 0) {
        const want = str(a, "text").toLowerCase();
        if (!want || act === "type") return "FAILED: give index (from elements) or text (the visible label).";
        const snap = await appSnap();
        idx = snap.els.findIndex((e) => e.label.toLowerCase() === want);
        if (idx < 0) idx = snap.els.findIndex((e) => e.vis && e.label.toLowerCase().includes(want));
        if (idx < 0) idx = snap.els.findIndex((e) => e.label.toLowerCase().includes(want));
        if (idx < 0) return `FAILED: nothing on the page matches “${str(a, "text")}”. Call elements to see what's there.`;
        a = { ...a, index: idx };
      }
      const { value: live } = (await mb("eval", { js: LOCATE(idx), ...cur })) as { value: Live | null };
      if (!live) return "FAILED: that element number is gone (the page changed). Call elements again.";
      // Last-moment check: still the element the agent saw, and not riskier than approved.
      const seen = pageCache.els[idx];
      if (seen && seen.label && live.label && seen.label !== live.label) return `FAILED: the page changed — element ${idx} is now “${live.label}”, not “${seen.label}”. Nothing was done. Call elements again.`;
      const approved = classify(a);
      const saved = pageCache.els;
      pageCache.els = [{ kind: live.kind, label: live.label, ac: live.ac }];
      const real = classify({ ...a, index: 0 });
      pageCache.els = saved;
      if (real.tier > approved.tier) return `BLOCKED: that targets “${live.label || live.kind}”${real.tier === 3 ? " — a payment/purchase control" : ""}. Call web_browser ${act} again with text="${live.label.replace(/"/g, "")}" so Marigold can ask the user properly.`;

      const clickIt = async () => {
        if (live.hit) return mb("click", { x: live.x, y: live.y, ...cur }) as Promise<{ title: string; url: string }>;
        // Covered by something (sticky header, overlay): click it directly.
        await mb("eval", { js: `document.querySelector('[data-mg="${idx}"]')?.click()`, ...cur });
        await new Promise((r) => setTimeout(r, 600));
        return mb("info", cur) as Promise<{ title: string; url: string }>;
      };
      if (act === "click") return appAfter(`Clicked [${idx}]${live.label ? ` (“${live.label}”)` : ""}`, await clickIt());
      if (act === "download") {
        const before = ((await mb("last_download")) as { file: string }).file;
        await clickIt();
        for (let i = 0; i < 60; i++) {
          const f = ((await mb("last_download")) as { file: string }).file;
          if (f && f !== before) return `Downloaded ${f.replace(os.homedir(), "~")}.`;
          await new Promise((r) => setTimeout(r, 500));
        }
        return "FAILED: no download finished within 30 s.";
      }
      if (act === "upload") {
        const f = expandPath(str(a, "path"));
        const r = (await mb("upload", { index: idx, path: f, ...cur })) as { ok?: boolean; error?: string };
        return r.ok ? `Attached ${f.replace(os.homedir(), "~")}.` : `FAILED: ${r.error}`;
      }
      if (act === "select") {
        const want = str(a, "text");
        if (live.tag === "SELECT") {
          const { value } = (await mb("eval", { js: `(() => { const s = document.querySelector('[data-mg="${idx}"]'); const w = ${JSON.stringify(want.toLowerCase())};
            const o = [...s.options].find(o => o.text.trim().toLowerCase() === w) || [...s.options].find(o => o.text.toLowerCase().includes(w) || o.value.toLowerCase() === w);
            if (!o) return [...s.options].map(o => o.text.trim()).slice(0, 30);
            s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`, ...cur })) as { value: true | string[] };
          return value === true ? `Selected “${want}”.` : `FAILED: no option “${want}”. Options: ${(value as string[]).join(", ")}`;
        }
        await clickIt();
        await new Promise((r) => setTimeout(r, 500));
        const snap = await appSnap();
        const o = snap.els.findIndex((e) => e.label.toLowerCase() === want.toLowerCase() && /option|li|menuitem|div|span|button/.test(e.kind))
          ?? -1;
        const j = o >= 0 ? o : snap.els.findIndex((e) => e.label.toLowerCase().includes(want.toLowerCase()));
        if (j < 0) return `FAILED: opened the list but “${want}” isn't in it. Call elements to see the options.`;
        const { value: opt } = (await mb("eval", { js: LOCATE(j), ...cur })) as { value: Live | null };
        if (!opt) return "FAILED: the list closed — call elements and try again.";
        return appAfter(`Selected “${want}”`, (await mb("click", { x: opt.x, y: opt.y, ...cur })) as { title: string; url: string });
      }
      // type — never into a password field (the user types passwords themselves).
      if (live.password) return "BLOCKED: that's a password field — Marigold never types passwords. Tell the user the sign-in page is ready for them (Browser tab).";
      const text = str(a, "text");
      await mb("eval", { js: `(() => { const e = document.querySelector('[data-mg="${idx}"]'); e.focus();
        if (e.isContentEditable) { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        else if (e.select) e.select(); })()`, ...cur });
      await mb("insert", { text, ...cur });
      if (a.submit === true) return appAfter(`Typed into [${idx}] and pressed Enter`, (await mb("key", { key: "Enter", ...cur })) as { title: string; url: string });
      return `Typed into [${idx}]${live.label ? ` (“${live.label}”)` : ""}.`;
    }
    case "type_text": {
      const text = String(a.text ?? "").slice(0, 20000);
      if (!text) return "FAILED: give text.";
      // Never into a password field (the user types those themselves).
      const { value: pw } = (await mb("eval", { js: `(() => { const e = document.activeElement; if (!e) return false; const l = ((e.getAttribute && (e.getAttribute('aria-label') || e.name || e.id)) || ''); return e.type === 'password' || /pass(word|code)/i.test(l); })()`, ...cur })) as { value: boolean };
      if (pw) return "BLOCKED: the focused field is a password field — Marigold never types passwords. Tell the user the page is ready for them.";
      await mb("insert", { text, ...cur });
      return `Typed ${text.length} characters into the focused field.`;
    }
    case "keys": {
      const list = (Array.isArray(a.keys) ? (a.keys as unknown[]).map(String) : str(a, "keys").split(/[\s,]+/)).filter(Boolean).slice(0, 40);
      if (!list.length) return "FAILED: give keys, e.g. [\"Tab\", \"Enter\"].";
      let last: { title: string; url: string } | undefined;
      for (const k of list) {
        const parts = k.split("+");
        const key = parts.pop()!;
        const mods = parts.map((m) => m.toLowerCase().replace("command", "meta").replace("cmd", "meta").replace("ctrl", "control").replace("option", "alt"));
        last = (await mb("key", { key, modifiers: mods, ...cur })) as { title: string; url: string };
      }
      return appAfter(`Pressed ${list.join(" ")}`, last);
    }
    case "press": {
      const k = str(a, "key") || "Enter";
      // A word given as a "key" (the model sometimes spells text out) → type it in one go.
      if (k.length > 1 && !k.includes("+") && !/^(enter|return|tab|esc(ape)?|space|backspace|delete|home|end|page(up|down)|arrow(up|down|left|right)|up|down|left|right|f\d{1,2})$/i.test(k)) {
        await mb("insert", { text: k, ...cur });
        return `Typed “${k}” into the focused field.`;
      }
      const parts = k.split("+");
      const key = parts.pop()!;
      const mods = parts.map((m) => m.toLowerCase().replace("command", "meta").replace("cmd", "meta").replace("ctrl", "control").replace("option", "alt"));
      return appAfter(`Pressed ${k}`, (await mb("key", { key, modifiers: mods, ...cur })) as { title: string; url: string });
    }
    case "scroll": {
      const up = /up/i.test(str(a, "direction"));
      await mb("wheel", { dy: up ? -700 : 700, ...cur });
      return `Scrolled ${up ? "up" : "down"}. Call elements to see what's visible now.`;
    }
    case "back": case "forward": case "reload":
      return appAfter(act === "back" ? "Went back" : act === "forward" ? "Went forward" : "Reloaded", (await mb("nav", { what: act, ...cur })) as { title: string; url: string });
    case "list_tabs": {
      const s = (await mb("tabs")) as { tabs: { id: number; title: string; url: string; agent: boolean }[]; activeId: number };
      return s.tabs.map((t, i) => `[${i}] ${t.title} — ${t.url}${t.agent ? "  ← agent's tab" : ""}${t.id === s.activeId ? "  (user is viewing)" : ""}`).join("\n") || "No tabs.";
    }
    case "switch_tab": {
      const s = (await mb("tabs")) as { tabs: { id: number; title: string; url: string }[] };
      const q = str(a, "query").toLowerCase();
      const i = num(a, "index", -1);
      const hit = i >= 0 ? s.tabs[i] : s.tabs.find((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
      if (!hit) return "FAILED: no such tab — call list_tabs.";
      await mb("switch", { id: hit.id });
      return `Switched to ${hit.title} — ${hit.url}.`;
    }
    case "close_tab": await mb("close", cur); return "Closed the tab.";
  }
  return "Unknown action.";
}
