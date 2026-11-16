import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { ToolDef } from "./tools";
import { looksFinancial, type Classified } from "./policy";
import { helperBin } from "./helpers";

/**
 * app_ui — operate ANY app installed on the Mac (Slack, Spotify, Word, Excel, Discord,
 * Zoom, Figma, Xcode, Notion…) the way a person does: see its buttons/fields/lists,
 * click, type, and use its menus. Built on macOS Accessibility (scripts/axapp.swift).
 * Menus work even when the app's window is on another desktop.
 */

const exec = promisify(execFile);
type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
const num = (a: Args, k: string, d: number) => (a[k] !== undefined && a[k] !== "" && Number.isFinite(Number(a[k])) ? Number(a[k]) : d);
const as = (t: string) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

async function ax(args: string[]): Promise<string> {
  const { stdout } = await exec(await helperBin("axapp"), args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** Every installed app (name → path), including apps inside vendor folders. */
export async function installedApps(): Promise<Map<string, string>> {
  const { catalog } = await import("./catalog");
  return new Map((await catalog()).apps.filter((a) => a.path).map((a) => [a.name, a.path as string]));
}

/** Bundle id per app name — lets keystrokes target the right process even when its name differs from the app's file name. */
const bundleOf = new Map<string, string>();

/** Is the app running, and does it have a window yet? (by bundle id when known, else by name) */
async function appState(app: string): Promise<{ running: boolean; windows: number }> {
  const id = bundleOf.get(app);
  const who = id ? `first process whose bundle identifier is "${as(id)}"` : `process "${as(app)}"`;
  const r = await exec("osascript", ["-e", `tell application "System Events" to if exists (${who}) then return "yes " & (count of windows of (${who}))`, "-e", 'return "no 0"'], { timeout: 8000 }).then((x) => x.stdout.trim(), () => "no 0");
  const [yes, n] = r.split(" ");
  return { running: yes === "yes", windows: Number(n) || 0 };
}

/** Launch in the background (by path: unambiguous) and wait until it's running with a window (apps like Photoshop take a while). */
async function launch(app: string, appPath: string | undefined, windowsToo: boolean) {
  await exec("open", appPath ? ["-g", appPath] : ["-g", "-a", app]).catch(() => exec("open", ["-g", "-a", app]));
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 600));
    const st = await appState(app);
    if (st.running && (!windowsToo || st.windows > 0)) { await new Promise((r) => setTimeout(r, 400)); return; }
  }
}

// Last element list per app — lets a click by number be safety-checked by its real label first.
const cache = ((globalThis as { __marigoldAppUi?: Map<string, { kind: string; label: string }[]> }).__marigoldAppUi ??= new Map());

const MONEY = /\b(buy|purchase|pay|checkout|subscribe|upgrade|place order|send money|transfer|donate|apple pay|confirm (payment|purchase))\b/i;
const OUTWARD = /\b(send|post|submit|share|publish|reply|invite|call|join|start meeting|upload|delete|remove|erase|empty trash|sign out|log out|unsubscribe|accept|decline)\b/i;

/** Actions that can run inside a batch (the ones whose result the model doesn't need before the next one). */
const BATCH_OK = new Set(["open", "menu", "click", "click_text", "type", "press", "shortcut"]);

function classify(a: Args): Classified {
  const act = str(a, "action"), app = str(a, "app");
  if (act === "steps") {
    const list = Array.isArray(a.steps) ? (a.steps as Args[]) : [];
    if (!list.length) return { tier: 0, blocked: "steps needs a list of actions", summary: `${app}: steps` };
    if (list.length > 15) return { tier: 0, blocked: "steps holds at most 15 actions — split it in two", summary: `${app}: steps` };
    const bad = list.find((x) => !BATCH_OK.has(str(x, "action")));
    if (bad) return { tier: 0, blocked: `steps can only contain ${[...BATCH_OK].join("/")} (got "${str(bad, "action")}") — call elements/screen_text on their own`, summary: `${app}: steps` };
    const each = list.map((x) => classify({ ...x, app: str(x, "app") || app }));
    const worst = each.reduce((m, c) => (c.tier > m.tier || c.blocked ? c : m), each[0]);
    return { ...worst, summary: `${app}: ${list.length} steps — ${each.map((c) => c.summary.replace(`${app}: `, "")).join("; ").slice(0, 150)}` };
  }
  const idx = num(a, "index", -1);
  const label = [cache.get(app.toLowerCase())?.[idx]?.label, str(a, "text"), str(a, "path")].filter(Boolean).join(" · ");
  const sum = `${app}: ${act}${label ? ` “${label.slice(0, 60)}”` : ""}`;
  if (["list_apps", "elements", "read", "menus", "screen_text", "find_command"].includes(act)) return { tier: 0, summary: sum };
  if (looksFinancial(app) || (["click", "menu", "press", "type", "click_text"].includes(act) && MONEY.test(label))) return { tier: 3, scope: `finance:${app}`, outward: true, summary: `💳 ${sum}` };
  if (["click", "menu", "click_text"].includes(act) && OUTWARD.test(label)) return { tier: 2, scope: `ui:${app}:act`, outward: true, summary: sum };
  // Enter in a SEARCH box sends nothing anywhere → no prompt.
  if (act === "type" && a.submit === true && /search|find|filter|look ?up/i.test(label)) return { tier: 1, summary: `${sum} + Enter` };
  if (act === "type" && (a.submit === true)) return { tier: 2, scope: `ui:${app}:act`, outward: true, summary: `${sum} + Enter` };
  if (act === "press" && /enter|return/i.test(str(a, "key"))) return { tier: 2, scope: `ui:${app}:act`, outward: true, summary: sum };
  return { tier: 1, summary: sum };
}

async function keystroke(app: string, what: string) {
  const id = bundleOf.get(app);
  const who = id ? `(first process whose bundle identifier is "${as(id)}")` : `process "${as(app)}"`;
  await exec("osascript", ["-e", id ? `tell application id "${as(id)}" to activate` : `tell application "${as(app)}" to activate`, "-e", "delay 0.3", "-e", `tell application "System Events" to tell ${who} to ${what}`], { timeout: 15_000 });
}
const KEYCODE: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, space: 49, backspace: 51, delete: 117, up: 126, down: 125, left: 123, right: 124 };

/** "cmd+shift+n" → System Events keystroke. */
function chord(s: string): string {
  const parts = s.toLowerCase().split("+").map((x) => x.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => ({ cmd: "command down", command: "command down", shift: "shift down", opt: "option down", option: "option down", alt: "option down", ctrl: "control down", control: "control down" } as Record<string, string>)[m]).filter(Boolean);
  const using = mods.length ? ` using {${mods.join(", ")}}` : "";
  return KEYCODE[key] !== undefined ? `key code ${KEYCODE[key]}${using}` : `keystroke "${as(key)}"${using}`;
}

const lastElements = new Map<string, string>();
const clickedSince = new Set<string>();

export const appUiTool: ToolDef = {
  name: "app_ui",
  description:
    "Operate ANY app on the Mac that has no dedicated tool (Slack, Spotify, Discord, Word, Excel, PowerPoint, Pages, Zoom, Teams, Figma, Notion, Xcode, VS Code, System Settings…). " +
    "list_apps → what's installed; open(app); find_command(app, text) → menu paths matching what you want to do (e.g. text 'rectangle' → 'Insert > Shape > Rectangle'); menus(app) → everything the app can do from its menu bar; menu(app, path 'File > Export…'); " +
    "elements(app) → numbered buttons/fields/lists in its window; read(app) → the window's text; click(app, index or text); type(app, index, text, submit); press(app, key) e.g. enter/escape/down; shortcut(app, keys) e.g. cmd+n. " +
    "If elements finds nothing useful (games, canvas/graphics apps), screen_text(app) reads the window's visible text with positions and click_text(app, text) clicks that text (briefly brings the app forward). " +
    "FAST: action=steps runs up to 15 of menu/click/click_text/type/press/shortcut/open in ONE call — batch a whole sequence instead of one action per call. " +
    "Prefer menus and shortcuts for commands. Call elements again after the window changes. iPhone/iPad apps installed on the Mac work too.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["steps", "list_apps", "open", "find_command", "menus", "menu", "elements", "read", "click", "type", "press", "shortcut", "screen_text", "click_text"] },
      steps: {
        type: "array",
        description: "action=steps: several actions in ONE call, in order (menu / click by text / click_text / type / press / shortcut / open) — e.g. [{action:'menu',path:'Insert > Shape > Rectangle'},{action:'shortcut',keys:'cmd+s'}]. Stops at the first failure. Use text labels (not element numbers) inside a batch.",
        items: { type: "object", properties: { action: { type: "string" }, app: { type: "string" }, path: { type: "string" }, text: { type: "string" }, key: { type: "string" }, keys: { type: "string" }, submit: { type: "boolean" } }, required: ["action"] },
      },
      app: { type: "string", description: "app name as installed, e.g. Slack" },
      path: { type: "string", description: "menu: e.g. File > Export…" },
      query: { type: "string", description: "find_command: what you want to do, e.g. rectangle, export pdf, new board" },
      index: { type: "number", description: "element number from the latest elements" },
      text: { type: "string", description: "text to type, or the visible label to click" },
      submit: { type: "boolean", description: "type: press Enter afterwards" },
      key: { type: "string", description: "press: enter, tab, escape, up, down…" },
      keys: { type: "string", description: "shortcut: e.g. cmd+n, cmd+shift+4" },
    },
    required: ["action"],
  },
  taints: true,
  classify,
  async exec(a, signal, ctx) {
    const act = str(a, "action");
    if (act === "list_apps") return `Installed apps:\n${[...(await installedApps()).keys()].sort().join(", ")}`;
    if (act === "steps") {
      // Each step runs through the same code (incl. its own safety re-check); stop at the first problem.
      const log: string[] = [];
      for (const [i, st] of (a.steps as Args[]).entries()) {
        const r = await appUiTool.exec({ ...st, app: str(st, "app") || str(a, "app") }, signal, ctx);
        log.push(`${i + 1}. ${str(st, "action")}: ${r.split("\n")[0]}`);
        if (/^(FAILED|BLOCKED)/.test(r)) { log.push(`Stopped at step ${i + 1}; the rest weren't done.`); return log.join("\n"); }
      }
      return `${log.join("\n")}\nAll ${log.length} steps are DONE — don't repeat them. Call elements/screen_text to check the result.`;
    }
    const asked = str(a, "app");
    if (!asked) return "FAILED: say which app.";
    const { resolveApp } = await import("./catalog");
    const hit = (await resolveApp(asked))?.app;
    if (!hit) return `FAILED: “${asked}” isn't installed on this Mac (call list_apps to see the exact names). If it's really not installed, tell the user.`;
    const app = hit.name;
    if (hit.bundle) bundleOf.set(app, hit.bundle);
    const key = app.toLowerCase();

    // Websites go through web_browser (the Marigold Browser) — never drive the user's own browsers.
    if (/^(safari|google chrome|chrome|firefox|arc|microsoft edge|brave browser|opera|vivaldi|orion)$/i.test(app)) {
      return `FAILED: Marigold doesn't operate ${app} (the user's own browser). For websites use web_browser — it works in the Marigold Browser.`;
    }
    const st = await appState(app);
    if (act === "open" || !st.running || (st.windows === 0 && !["menus", "menu", "find_command"].includes(act))) {
      await launch(app, hit.path, act !== "open" || st.running === false);
      if (act === "open") return `Opened ${app}${hit.name.toLowerCase() !== asked.toLowerCase().replace(/\.app$/, "") ? ` (matched “${asked}”)` : ""}. Call menus or elements to see what you can do.`;
    }

    const parse = (raw: string) => JSON.parse(raw) as { error?: string; window?: string; els?: { kind: string; label: string; value: string; vis: boolean }[]; text?: string; menus?: { menu: string; items: string[] }[] };
    switch (act) {
      case "menus": {
        const j = parse(await ax(["menus", app]));
        if (j.error) return `FAILED: ${j.error}`;
        return (j.menus ?? []).map((m) => `${m.menu}: ${m.items.join(" · ")}`).join("\n").slice(0, 6000);
      }
      case "find_command": {
        // Search every menu (and submenu) for the words the agent is looking for.
        const j = parse(await ax(["menus", app]));
        if (j.error) return `FAILED: ${j.error}`;
        const words = (str(a, "query") || str(a, "text")).toLowerCase().split(/\s+/).filter(Boolean);
        const paths: string[] = [];
        for (const m of j.menus ?? []) for (const it of m.items) {
          const sub = it.match(/^(.*?) > \[(.*)\]$/);
          if (sub) for (const leaf of sub[2].split(", ")) paths.push(`${m.menu} > ${sub[1]} > ${leaf}`);
          else paths.push(`${m.menu} > ${it}`);
        }
        const hits = paths.map((p) => ({ p, n: words.filter((w) => p.toLowerCase().includes(w)).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 12);
        if (!hits.length) return `No menu command in ${app} matches “${words.join(" ")}”. Try other words, menus to see everything, or elements for toolbar buttons.`;
        return `${app} commands matching “${words.join(" ")}”:\n${hits.map((h) => `• ${h.p}`).join("\n")}\nRun one with menu(path). "(disabled)" ones need something first (e.g. open/create a document, select an object).`;
      }
      case "menu": {
        // Menus reflect the window in FRONT (e.g. Freeform's Insert items only enable on a board) —
        // so bring the app forward first, and retry once if the item is still disabled.
        // Try in the background first (most menu commands work without stealing focus); only if
        // the item is disabled, bring the app forward briefly (the loop puts the user back after).
        let r = await ax(["menu", app, str(a, "path")]);
        if (/disabled/.test(r)) {
          await exec("osascript", ["-e", `tell application "${as(app)}" to activate`]).catch(() => {});
          await new Promise((res) => setTimeout(res, 700));
          r = await ax(["menu", app, str(a, "path")]);
          if (/disabled/.test(r)) { await new Promise((res) => setTimeout(res, 1200)); r = await ax(["menu", app, str(a, "path")]); }
        }
        if (/disabled/.test(r)) return `FAILED: “${str(a, "path")}” is disabled — it needs something first (open/create a document or board, or select an object). Do that, then try again.`;
        return r.startsWith("ok") ? `Clicked ${app} › ${str(a, "path")}. Call elements to see the result.` : `FAILED: ${r.replace(/^ERR\s*/, "")}`;
      }
      case "elements": {
        let j = parse(await ax(["elements", app]));
        if (j.error) return `FAILED: ${j.error}`;
        const looksEmpty = (x: typeof j) => (x.els ?? []).filter((e) => e.label && !/zoom the window|close|minimi[sz]e|full ?screen/i.test(e.label)).length === 0;
        // Electron / Chromium apps (ChatGPT, Spotify, Discord, Slack, VS Code…) only build their accessibility tree after the
        // first request — ask again a moment later before concluding the app can't be read.
        if (looksEmpty(j)) { await new Promise((r) => setTimeout(r, 1500)); const again = parse(await ax(["elements", app])); if (!again.error) j = again; }
        cache.set(key, (j.els ?? []).map((e) => ({ kind: e.kind, label: e.label })));
        // iPhone/iPad apps (and some others) don't describe their buttons — only the window's own controls show up.
        const useful = (j.els ?? []).filter((e) => e.label && !/zoom the window|close|minimi[sz]e|full ?screen/i.test(e.label));
        if (useful.length === 0) {
          return `${app} doesn't describe its buttons to macOS (common for iPhone/iPad apps). Use screen_text to read what's on screen, then click_text with the button's words (e.g. click_text "Sign in").`;
        }
        const lines = (j.els ?? []).map((e, i) => `[${i}] ${e.kind}${e.label ? ` “${e.label}”` : ""}${e.value ? ` = “${e.value}”` : ""}${e.vis ? "" : " (scroll)"}`);
        const out = `${app} — ${j.window || "window"}\n${lines.join("\n") || "(no controls found — try menus, or read)"}`.slice(0, 7000);
        // Clicked something but the button list didn't change? The app drew its own UI (a pop-up list,
        // iPhone-app sheet) that macOS can't see — show what's actually on screen right away.
        const prev = lastElements.get(app);
        lastElements.set(app, out);
        if (prev === out && clickedSince.has(app)) {
          clickedSince.delete(app);
          const seen = await appUiTool.exec({ action: "screen_text", app }, signal, ctx);
          return `${out}\n\nThe button list didn't change after your click — the app is showing something macOS can't describe. What's on screen now (use click_text with these words):\n${seen}`.slice(0, 9000);
        }
        clickedSince.delete(app);
        return out;
      }
      case "read": {
        const j = parse(await ax(["read", app]));
        if (j.error) return `FAILED: ${j.error}`;
        return `${app} — ${j.window}\n\n${(j.text ?? "").replace(/\n{2,}/g, "\n").slice(0, 6000) || "(no text)"}`;
      }
      case "click": case "type": {
        if (act === "click") clickedSince.add(app);
        let idx = num(a, "index", -1);
        if (idx < 0 && act === "click" && str(a, "text")) {
          const j = parse(await ax(["elements", app]));
          const els = j.els ?? [];
          cache.set(key, els.map((e) => ({ kind: e.kind, label: e.label })));
          const want = str(a, "text").toLowerCase();
          idx = els.findIndex((e) => e.label.toLowerCase() === want);
          if (idx < 0) idx = els.findIndex((e) => e.label.toLowerCase().includes(want));
          if (idx < 0) {
            // Not an accessible button (iPhone/iPad apps, custom UIs): try the same words visually.
            // Same label → same safety tier as click, so this doesn't skip any approval.
            const viaText = await appUiTool.exec({ ...a, action: "click_text" }, signal, ctx);
            return viaText.startsWith("Clicked") ? `${viaText} (found by reading the screen)` : `FAILED: nothing labeled “${str(a, "text")}” in ${app}'s window — call elements (or screen_text).`;
          }
        }
        if (idx < 0 && act === "type") {
          // No index given: type into the window's text field (the only one, or the first).
          const j = parse(await ax(["elements", app]));
          const els = j.els ?? [];
          cache.set(key, els.map((e) => ({ kind: e.kind, label: e.label })));
          idx = els.findIndex((e) => /field|text ?area|search|combo/i.test(e.kind));
          if (idx < 0) return "FAILED: no text field in the window — click the box first (click_text its placeholder), or call elements.";
        }
        if (idx < 0) return "FAILED: give index (from elements).";
        // Last-moment check: same element the agent saw, and not riskier than approved.
        const infoRaw = await ax(["info", app, String(idx)]);
        if (infoRaw === "NOELEM") return "FAILED: that element is gone (the window changed) — call elements again.";
        const info = JSON.parse(infoRaw) as { kind: string; label: string };
        if (act === "type" && (info.kind === "password" || /password|passcode|\bpin\b|verification code|one-time code/i.test(info.label)))
          return "BLOCKED: that's a password/code field — Marigold never types passwords or codes. Tell the user it's ready for them to type it themselves.";
        const seen = cache.get(key)?.[idx];
        if (seen && seen.label !== info.label) return `FAILED: the window changed — element ${idx} is now “${info.label}”, not “${seen.label}”. Call elements again.`;
        const approved = classify(a).tier;
        if (classify({ ...a, index: -1, text: info.label }).tier > approved) return `BLOCKED: that's “${info.label}”, which needs the user's OK — call ${act} again with text="${info.label.replace(/"/g, "")}".`;
        if (act === "click") {
          await ax(["press", app, String(idx)]);
          await new Promise((r) => setTimeout(r, 700));
          return `Clicked “${info.label || info.kind}” in ${app}. Call elements to see what changed.`;
        }
        const text = str(a, "text");
        const set = await ax(["setvalue", app, String(idx), text]);
        if (set !== "ok") { // rich editors need real typing
          await ax(["focus", app, String(idx)]);
          await keystroke(app, `keystroke "${as(text)}"`);
        }
        if (a.submit === true) await keystroke(app, "key code 36");
        return `Typed into “${info.label || info.kind}” in ${app}${a.submit === true ? " and pressed Enter" : ""}.`;
      }
      case "screen_text": case "click_text": {
        // Visual fallback: read the window with Apple's on-device text recognition.
        const { pickWindow, appctl, canRecordScreen, NO_SCREEN_PERMISSION } = await import("./windows");
        if (!(await canRecordScreen())) return `FAILED: ${NO_SCREEN_PERMISSION}`;
        const win = await pickWindow(app);
        if (!win) return `FAILED: ${app} has no window open.`;
        const shot = path.join(os.tmpdir(), `marigold-ocr-${win.id}.png`);
        await exec("screencapture", ["-x", "-o", "-l", win.id, "-t", "png", shot], { timeout: 8000 });
        const bin = await helperBin("ocr");
        const items = JSON.parse((await exec(bin, [shot], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })).stdout || "[]") as { text: string; x: number; y: number }[];
        // The capture can be bigger than the window (an open pop-up menu hangs below it), and OCR
        // positions are fractions of the IMAGE — convert them to fractions of the window for clicking.
        const png = await fs.readFile(shot).catch(() => null);
        await fs.unlink(shot).catch(() => {});
        if (png && png.length > 24 && win.w > 0 && win.h > 0) {
          const iw = png.readUInt32BE(16), ih = png.readUInt32BE(20);
          const scale = iw / win.w; // pixels per point (2 on Retina)
          if (scale > 0) for (const t of items) { t.x = (t.x * iw) / scale / win.w; t.y = (t.y * ih) / scale / win.h; }
        }
        if (act === "screen_text") return `${app} — text on screen (${items.length}):\n${items.map((t, i) => `[${i}] “${t.text}” at ${Math.round(t.x * 100)}%,${Math.round(t.y * 100)}%`).join("\n").slice(0, 6000)}`;
        const want = str(a, "text").toLowerCase();
        const hit = items.find((t) => t.text.toLowerCase() === want) ?? items.find((t) => t.text.toLowerCase().includes(want));
        if (!hit) return `FAILED: “${str(a, "text")}” isn't visible in ${app}. Call screen_text to see what is.`;
        const r = await appctl(["realclick", app, win.id, String(hit.x), String(hit.y)]);
        return r.startsWith("ok") ? `Clicked “${hit.text}” in ${app}.` : `FAILED: ${r}`;
      }
      case "press": await keystroke(app, chord(str(a, "key") || "enter")); return `Pressed ${str(a, "key") || "enter"} in ${app}.`;
      case "shortcut": await keystroke(app, chord(str(a, "keys"))); return `Pressed ${str(a, "keys")} in ${app}.`;
    }
    return "Unknown action.";
  },
};
