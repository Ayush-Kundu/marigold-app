import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR, type Classified } from "./policy";
import { helperBin } from "./helpers";
import type { ToolDef } from "./tools";

/**
 * Marigold learns what EVERY app on THIS Mac can do, whatever apps the user has (nothing here is a fixed list).
 *   • from the app itself, without launching it: its AppleScript dictionary (sdef), App Intents (the actions Shortcuts and
 *     Siri use), URL schemes and the file types it opens;
 *   • from the running app: its whole menu bar (every command it has);
 *   • from experience: scripts and UI steps that worked for the user's earlier requests ("recipes").
 * It is stored per app in ~/.marigold/app-profiles and read back by the `app_capabilities` tool, so the agent starts
 * from what the app can really do instead of guessing.
 */

const exec = promisify(execFile);
const DIR = path.join(MARIGOLD_DIR, "app-profiles");
type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");

interface Recipe { request: string; tool: string; how: string; at: number; uses: number }
export interface Profile {
  name: string; bundle?: string; path?: string; version?: string; learnedAt: number;
  scripting: string | null;            // compact AppleScript dictionary
  scriptable: boolean;
  intents: { title: string; about: string; params: string[] }[];
  urlSchemes: string[]; docTypes: string[];
  menus?: { at: number; text: string };
  recipes: Recipe[];
  /** A short working guide for THIS app, written by the AI from the app's own description of itself (once, when the app first matters). */
  howTo?: string;
}

const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const cache = new Map<string, Profile>();
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export async function loadProfile(name: string): Promise<Profile | null> {
  const k = slug(name);
  if (cache.has(k)) return cache.get(k)!;
  try { const p = JSON.parse(await fs.readFile(path.join(DIR, `${k}.json`), "utf8")) as Profile; cache.set(k, p); return p; } catch { return null; }
}
async function saveProfile(p: Profile) {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(DIR, `${slug(p.name)}.json`), JSON.stringify(p), { mode: 0o600 });
  cache.set(slug(p.name), p);
}

// ---------------------------------------------------------------- reading the app's own description of itself

async function plist(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse((await exec("plutil", ["-convert", "json", "-o", "-", file], { timeout: 4000 })).stdout); } catch { return {}; }
}

/** The AppleScript dictionary, boiled down to what a script author needs: commands with their parameters, and classes with their properties. */
function summarizeSdef(xml: string): { text: string; commands: number } | null {
  const tag = /<(\/?)([\w-]+)([^>]*?)(\/?)>/g;
  const attr = (s: string, k: string) => { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? decode(m[1]) : ""; };
  const suites: { name: string; commands: string[]; classes: string[] }[] = [];
  let suite: (typeof suites)[number] | null = null, cmd: { name: string; desc: string; params: string[] } | null = null, cls: { name: string; props: string[]; elems: string[] } | null = null;
  let n = 0, standard = false;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    const [, close, name, attrs, self] = m;
    if (close) {
      if (name === "suite") { if (suite && (suite.commands.length || suite.classes.length)) suites.push(suite); suite = null; }
      else if (name === "command" && cmd && suite) { suite.commands.push(`${cmd.name}${cmd.params.length ? ` (${cmd.params.slice(0, 7).join(", ")})` : ""}${cmd.desc ? ` — ${cmd.desc.slice(0, 70)}` : ""}`); n++; cmd = null; }
      else if ((name === "class" || name === "class-extension") && cls && suite) { suite.classes.push(`${cls.name}${cls.props.length ? ` {${cls.props.slice(0, 10).join(", ")}}` : ""}${cls.elems.length ? ` contains ${cls.elems.slice(0, 6).join(", ")}` : ""}`); cls = null; }
      continue;
    }
    if (name === "suite") {
      const sn = attr(attrs, "name");
      if (/^(Standard Suite|Text Suite|Type Names Suite)$/i.test(sn)) { standard = true; suite = { name: sn, commands: [], classes: [] }; continue; }
      suite = { name: sn, commands: [], classes: [] };
    } else if (!suite) continue;
    else if (/^(Standard Suite|Text Suite|Type Names Suite)$/i.test(suite.name)) continue;
    else if (name === "command" || name === "event") { cmd = { name: attr(attrs, "name"), desc: attr(attrs, "description"), params: [] }; if (self) { suite.commands.push(cmd.name); n++; cmd = null; } }
    else if (name === "parameter" && cmd) cmd.params.push(`${attr(attrs, "name")}${attr(attrs, "optional") === "yes" ? "?" : ""}`);
    else if (name === "direct-parameter" && cmd) cmd.params.unshift("<direct>");
    else if (name === "class" || name === "class-extension") { cls = { name: attr(attrs, "name") || attr(attrs, "extends"), props: [], elems: [] }; if (self) { suite.classes.push(cls.name); cls = null; } }
    else if (name === "property" && cls) cls.props.push(attr(attrs, "name"));
    else if (name === "element" && cls) cls.elems.push(attr(attrs, "type"));
  }
  if (!suites.length && !standard) return null;
  const lines = suites.map((s) => `${s.name}:\n  commands: ${s.commands.slice(0, 40).join("; ") || "none"}\n  classes: ${s.classes.slice(0, 30).join("; ") || "none"}`);
  const text = `${standard ? "Standard commands: open, close, save, print, quit, make new, delete, duplicate, move, exists, count, get/set properties.\n" : ""}${lines.join("\n")}`;
  return { text: text.slice(0, 5200), commands: n };
}

/** The actions the app offers to Shortcuts and Siri (App Intents). */
async function readIntents(appPath: string): Promise<Profile["intents"]> {
  const f = path.join(appPath, "Contents", "Resources", "Metadata.appintents", "extract.actionsdata");
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(await fs.readFile(f, "utf8")) as { actions?: Record<string, { title?: { key?: string }; descriptionMetadata?: { descriptionText?: { key?: string } }; parameters?: { title?: { key?: string }; isOptional?: boolean }[]; visibilityMetadata?: { isDiscoverable?: boolean; assistantOnly?: boolean } }> };
    return Object.values(j.actions ?? {}).filter((a) => a.title?.key && a.visibilityMetadata?.isDiscoverable !== false).slice(0, 40).map((a) => ({
      title: a.title!.key!, about: (a.descriptionMetadata?.descriptionText?.key ?? "").slice(0, 100),
      params: (a.parameters ?? []).map((p) => `${p.title?.key ?? "?"}${p.isOptional ? "?" : ""}`).slice(0, 6),
    }));
  } catch { return []; }
}

/** Learn what an app can do from the app itself (it is not launched). */
export async function learnStatic(name: string, appPath: string, bundle?: string): Promise<Profile> {
  const info = await plist(path.join(appPath, "Contents", "Info.plist"));
  const urlSchemes = [...new Set(((info.CFBundleURLTypes as { CFBundleURLSchemes?: string[] }[] | undefined) ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []))].slice(0, 8);
  const docTypes = [...new Set(((info.CFBundleDocumentTypes as { CFBundleTypeExtensions?: string[] }[] | undefined) ?? []).flatMap((t) => t.CFBundleTypeExtensions ?? []))].slice(0, 24);
  let scripting: string | null = null, scriptable = false;
  if (info.NSAppleScriptEnabled === true || info.OSAScriptingDefinition) {
    const r = await exec("sdef", [appPath], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).catch(() => null);
    const s = r ? summarizeSdef(r.stdout) : null;
    if (s) { scripting = s.text; scriptable = true; }
  }
  const old = await loadProfile(name);
  const p: Profile = { name, bundle: bundle || (info.CFBundleIdentifier as string | undefined), path: appPath, version: info.CFBundleShortVersionString as string | undefined, learnedAt: Date.now(), scripting, scriptable, intents: await readIntents(appPath), urlSchemes, docTypes, menus: old?.menus, recipes: old?.recipes ?? [] };
  await saveProfile(p);
  return p;
}

/** Learn the whole menu bar of a RUNNING app (every command it has, with its place in the menus). */
export async function learnMenus(name: string): Promise<string | null> {
  try {
    const { stdout } = await exec(await helperBin("axapp"), ["menus", name], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(stdout) as { menus?: { menu: string; items: string[] }[]; error?: string };
    if (!j.menus?.length) return null;
    const text = j.menus.map((m) => `${m.menu}: ${m.items.filter(Boolean).slice(0, 40).join(" | ")}`).join("\n").slice(0, 6000);
    const p = await loadProfile(name);
    if (p) { p.menus = { at: Date.now(), text }; await saveProfile(p); }
    return text;
  } catch { return null; }
}

async function isRunning(p: Profile): Promise<boolean> {
  if (!p.path) return false;
  return exec("pgrep", ["-f", `${p.path}/Contents/MacOS`]).then(() => true, () => false);
}

// ---------------------------------------------------------------- experience

/** What worked: a script or UI sequence that succeeded for a request, kept per app so next time starts from it. */
export async function recordRecipe(app: string, request: string, tool: string, how: string) {
  if (!app || !request.trim() || how.length < 8) return;
  const p = await loadProfile(app); if (!p) return;
  const req = request.replace(/\s+/g, " ").trim().slice(0, 140), h = how.slice(0, 700);
  const hit = p.recipes.find((r) => r.how === h || (r.request === req && r.tool === tool));
  if (hit) { hit.uses++; hit.at = Date.now(); hit.how = h; } else p.recipes.push({ request: req, tool, how: h, at: Date.now(), uses: 1 });
  p.recipes = p.recipes.sort((a, b) => b.uses - a.uses || b.at - a.at).slice(0, 24);
  await saveProfile(p);
}
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);

// ---------------------------------------------------------------- learning every app

const g = globalThis as unknown as { __marigoldLearn?: { running: boolean; done: number; total: number; at: number } };
const learnState = (g.__marigoldLearn ??= { running: false, done: 0, total: 0, at: 0 });
export const learningStatus = () => ({ ...learnState });

/** Learn every installed app in the background (static knowledge only: nothing is launched). Safe to call often. */
export function learnAllApps(force = false) {
  if (learnState.running) return;
  if (!force && Date.now() - learnState.at < 6 * 3600_000 && learnState.done > 0) return;
  learnState.running = true; learnState.done = 0;
  void (async () => {
    try {
      const { catalog } = await import("./catalog");
      const apps = (await catalog()).apps.filter((a) => a.path && !a.ios);
      learnState.total = apps.length;
      const queue = [...apps];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          const old = await loadProfile(a.name);
          if (force || !old || Date.now() - old.learnedAt > 14 * 86400_000) await learnStatic(a.name, a.path!, a.bundle).catch(() => {});
          learnState.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } finally { learnState.running = false; learnState.at = Date.now(); }
  })();
}

/** One line for the agent's request: what is known about an app the user named. */
const howToBusy = new Set<string>();
/** Write this app's own toolset guide (how to drive it, its common jobs, what goes wrong), once, in the background. */
export async function ensureHowTo(name: string): Promise<void> {
  const k = slug(name);
  if (howToBusy.has(k)) return;
  const p = await loadProfile(name);
  if (!p || p.howTo) return;
  howToBusy.add(k);
  try {
    const { cloudText, hasCloudKey, stepModel } = await import("./cloud");
    if (!(await hasCloudKey())) return;
    const desc = [
      `App: ${p.name}${p.version ? ` ${p.version}` : ""}`,
      p.scriptable ? `AppleScript dictionary (excerpt):\n${(p.scripting ?? "").slice(0, 1800)}` : "Not scriptable (no AppleScript dictionary).",
      p.menus ? `Menu bar (excerpt):\n${p.menus.text.slice(0, 1200)}` : "",
      p.intents.length ? `Shortcuts actions: ${p.intents.slice(0, 12).map((i) => i.title).join(", ")}` : "",
      p.urlSchemes.length ? `URL schemes: ${p.urlSchemes.join(", ")}` : "",
      p.docTypes.length ? `Opens files: ${p.docTypes.slice(0, 12).join(", ")}` : "",
    ].filter(Boolean).join("\n");
    const out = await cloudText(
      "You write a short working guide for an AI assistant that operates ONE Mac app for the user. From the app's own description below write 4 to 6 short lines: (1) the best way to drive it (AppleScript when scriptable and for which things; menus and keyboard shortcuts through app_ui when not; its URL schemes); (2) the three most common jobs people do in it and exactly how to do each; (3) what to check before and after (save, export, undo); (4) one thing that commonly goes wrong. Be concrete. Use only what the description shows. Never invent menu names. No marketing.",
      desc, AbortSignal.timeout(45_000), { model: stepModel(), maxTokens: 450 });
    if (out.trim()) { p.howTo = out.trim().slice(0, 1000); await saveProfile(p); }
  } catch { /* next time */ } finally { howToBusy.delete(k); }
}

export async function profileHint(name: string): Promise<string> {
  const p = await loadProfile(name);
  if (!p) return "";
  const bits = [p.scriptable ? "scriptable (AppleScript)" : "not scriptable: use its menus / UI", p.intents.length ? `${p.intents.length} Shortcuts actions` : "", p.urlSchemes.length ? `opens ${p.urlSchemes.slice(0, 3).map((s) => `${s}://`).join(" ")} links` : "", p.recipes.length ? `${p.recipes.length} learned recipes` : ""].filter(Boolean);
  return `${p.name}: ${bits.join(", ")}${p.howTo ? `. How to work in it: ${p.howTo.replace(/\s*\n+\s*/g, " ")}` : ""}`;
}

// ---------------------------------------------------------------- the tool

export const appCapabilitiesTool: ToolDef = {
  name: "app_capabilities",
  description: "What can this app do, and how should I drive it? For ANY app installed on the Mac: its AppleScript dictionary (commands, classes, properties), its Shortcuts/Siri actions (App Intents), URL schemes it handles, file types it opens, its whole menu bar, and scripts or UI steps that worked for the user before (recipes). Call this FIRST for any app you have no dedicated tool for, with query = what you want to do (it filters to the relevant parts). Then choose the best route: applescript (if scriptable), open a URL scheme, app_ui menu/shortcut, or app_ui clicks. Works for every app on this Mac, including ones added later.",
  parameters: { type: "object", properties: { app: { type: "string", description: "app name as installed, e.g. Slack, Notion, Pages" }, query: { type: "string", description: "what you want to do (e.g. 'export as PDF', 'create a note')" }, relearn: { type: "boolean", description: "refresh what is known about the app" } }, required: ["app"] },
  classify: (a: Args): Classified => ({ tier: 0, summary: `What can ${str(a, "app")} do?` }),
  async exec(a) {
    const asked = str(a, "app"); if (!asked) return "FAILED: give app.";
    const { installedApps } = await import("./app-ui");
    const apps = await installedApps();
    const key = [...apps.keys()].find((k) => k.toLowerCase() === asked.toLowerCase().replace(/\.app$/, "")) ?? [...apps.keys()].find((k) => k.toLowerCase().includes(asked.toLowerCase()));
    if (!key) return `FAILED: no app called “${asked}” is installed. Installed apps include: ${[...apps.keys()].slice(0, 25).join(", ")}…`;
    let p = await loadProfile(key);
    if (!p || a.relearn === true) p = await learnStatic(key, apps.get(key)!);
    if ((!p.menus || Date.now() - p.menus.at > 7 * 86400_000 || a.relearn === true) && (await isRunning(p))) { await learnMenus(key); p = (await loadProfile(key)) ?? p; }
    const q = str(a, "query").toLowerCase(), qw = words(q);
    const out: string[] = [`${p.name}${p.version ? ` ${p.version}` : ""}`];
    out.push(p.scriptable ? "SCRIPTING: yes. Drive it with the applescript tool using these terms:" : "SCRIPTING: this app has no AppleScript dictionary. Use its menus and shortcuts (app_ui), URL schemes, or its Shortcuts actions.");
    if (p.scripting) {
      // Filter the dictionary to the lines that matter for the request when it is long.
      const lines = p.scripting.split("\n");
      const keep = q && lines.join("\n").length > 2500 ? lines.filter((l) => /^[A-Z]/.test(l) || [...qw].some((w) => l.toLowerCase().includes(w))) : lines;
      out.push(keep.join("\n").slice(0, 4200));
    }
    if (p.intents.length) {
      const list = q ? [...p.intents].sort((x, y) => Number([...qw].some((w) => `${y.title} ${y.about}`.toLowerCase().includes(w))) - Number([...qw].some((w) => `${x.title} ${x.about}`.toLowerCase().includes(w)))) : p.intents;
      out.push(`SHORTCUTS ACTIONS (what ${p.name} offers Siri/Shortcuts; run through a shortcut the user has, or do the same by menu/script): ${list.slice(0, 14).map((i) => `${i.title}${i.params.length ? ` (${i.params.join(", ")})` : ""}`).join("; ")}`);
    }
    if (p.urlSchemes.length) out.push(`URL SCHEMES: ${p.urlSchemes.map((s) => `${s}://`).join(", ")} (open them with the files tool's open or open_app to jump straight to a place in the app)`);
    if (p.docTypes.length) out.push(`OPENS FILES: ${p.docTypes.join(", ")}`);
    if (p.menus) {
      const lines = p.menus.text.split("\n");
      const keep = q ? lines.map((l) => { const [m, ...rest] = l.split(": "); const items = rest.join(": ").split(" | "); const hit = items.filter((i) => [...qw].some((w) => i.toLowerCase().includes(w))); return hit.length ? `${m} > ${hit.join(" | ")}` : ""; }).filter(Boolean) : [];
      out.push(`MENUS (${lines.map((l) => l.split(":")[0]).join(", ")}). ${keep.length ? `Matching “${q}”: ${keep.join("; ")}. ` : ""}Use app_ui menu with a path like “File > Export…”, or app_ui find_command.`);
    } else out.push("MENUS: not read yet (the app isn't running). app_ui open(app), then app_ui menus(app) lists every command.");
    if (p.recipes.length) {
      const rank = p.recipes.map((r) => ({ r, s: [...words(r.request)].filter((w) => qw.has(w)).length })).sort((x, y) => y.s - x.s || y.r.uses - x.r.uses).slice(0, 3);
      out.push(`WORKED BEFORE: ${rank.map(({ r }) => `“${r.request}” via ${r.tool} (used ${r.uses}×): ${r.how}`).join("\n  ")}`);
    }
    out.push("APPROACH: scripting dictionary → applescript; else a URL scheme; else menu path or shortcut via app_ui; else app_ui elements/click; last resort screen_text/click_text.");
    return out.join("\n");
  },
};
