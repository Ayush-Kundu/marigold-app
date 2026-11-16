import { execFile } from "child_process";
import { promises as fs, readFileSync } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR, type Classified } from "./policy";
import type { ToolDef } from "./tools";

/**
 * A toolset for each app on THIS Mac, built from what the app says about itself (its AppleScript dictionary and URL schemes,
 * read by app-knowledge.ts), never from a fixed list:
 *   1. the model turns the dictionary into a few named actions with typed parameters (an AppleScript or URL template);
 *   2. every template is compiled against the app's real dictionary (osacompile, nothing runs) with sample values;
 *   3. read-only actions that need no input are actually run once, and kept only if they work;
 *   4. the survivors are saved in ~/.marigold/app-actions/<app>.json, stamped with the app's version, and offered to the agent
 *      through ONE tool (app_actions) so it never carries hundreds of tools at once.
 * Anything that changes or sends something is never run during testing, and asks permission when used.
 */

const exec = promisify(execFile);
const DIR = path.join(MARIGOLD_DIR, "app-actions");
type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export interface ActionParam { name: string; type: "text" | "number" | "boolean" | "date"; about: string; optional?: boolean }
export interface AppAction {
  name: string; about: string; kind: "applescript" | "url"; template: string; params: ActionParam[];
  /** The model's claim, checked again here: a template with a changing verb in it is never "read-only". */
  readonly: boolean; outward: boolean;
  /** compiled = the dictionary accepts it; works = it was run once and gave a result; failed = it did not and is not offered. */
  status: "works" | "compiled" | "failed"; note?: string;
}
export interface AppToolset { app: string; version?: string; builtAt: number; actions: AppAction[]; skipped?: string }

// ---------------------------------------------------------------- safety checks on generated templates

const CHANGES = /\b(delete|remove|erase|send|post|reply|forward|make new|make|set|move|duplicate|save|close|quit|empty|trash|purge|keystroke|key code|click|do shell script|run script|activate|launch|open location|archive|mark|add|insert|paste|write|append|create|import|export|print|schedule|empty)\b/i;
const NEVER = /do shell script|run script|run workflow|sudo|password|keychain|keystroke|key code|system events|administrator privileges|load script|\bsend\b.*\bmessage\b.*\bto\b.*\bbuddy\b/i;
const FINANCE = /bank|wallet|coin|trad(e|ing)|invest|broker|payment|paypal|venmo|crypto|password|1password|bitwarden|keychain|lastpass/i;
const OUTWARD = /\b(send|post|reply|forward|share|publish|invite|tweet|upload|open location|http)/i;

/** `set out to …`, `set end of out to …` and the text-delimiter setting only touch the script's own variables, not the app. */
const stripLocalSets = (t: string) => t.replace(/\bset\s+(?:end of\s+)?[a-z_]\w*\s+to\b/gi, "").replace(/\bset\s+AppleScript's\s+text item delimiters\s+to\b/gi, "");

const placeholders = (t: string) => [...new Set([...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];

/** An AppleScript string literal's worth of safe text: backslashes and quotes escaped, line breaks turned into AppleScript returns. */
function asString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, '" & return & "')}"`;
}

const DATE_HANDLER = `on mgDate(y, mo, d, h, mi)
  set dt to current date
  set day of dt to 1
  set year of dt to y
  set month of dt to mo
  set day of dt to d
  set hours of dt to h
  set minutes of dt to mi
  set seconds of dt to 0
  return dt
end mgDate
`;
/** "2026-11-12 14:30" (or just a date) → a locale-proof AppleScript date expression. */
function dateExpr(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  return m ? `my mgDate(${+m[1]}, ${+m[2]}, ${+m[3]}, ${+(m[4] ?? 0)}, ${+(m[5] ?? 0)})` : null;
}

function fill(a: AppAction, args: Args): { ok: true; text: string } | { ok: false; why: string } {
  let out = a.template;
  for (const p of a.params) {
    const raw = args[p.name];
    if (raw === undefined || raw === "" || raw === null) { if (!p.optional) return { ok: false, why: `missing ${p.name}` }; out = out.replace(new RegExp(`\\{\\{${p.name}\\}\\}`, "g"), p.type === "number" ? "0" : a.kind === "url" ? "" : '""'); continue; }
    let v: string;
    if (p.type === "number") { const n = Number(raw); if (!Number.isFinite(n)) return { ok: false, why: `${p.name} must be a number` }; v = String(n); }
    else if (p.type === "date") { const e = dateExpr(String(raw)); if (!e) return { ok: false, why: `${p.name} must look like 2026-11-12 14:30` }; v = e; }
    else if (p.type === "boolean") v = raw === true || raw === "true" ? "true" : "false";
    else { const t = String(raw).slice(0, 20_000); v = a.kind === "url" ? encodeURIComponent(t) : asString(t); }
    out = out.replace(new RegExp(`\\{\\{${p.name}\\}\\}`, "g"), () => v);
  }
  return { ok: true, text: a.kind === "applescript" && a.params.some((p) => p.type === "date") ? `${DATE_HANDLER}${out}` : out };
}

const SAMPLE = { text: "Marigold test" };
const sampleArgs = (a: AppAction): Args => Object.fromEntries(a.params.map((p) => [p.name, p.type === "text" ? SAMPLE.text : p.type === "number" ? 1 : p.type === "date" ? "2030-01-02 09:00" : true]));

async function compiles(script: string): Promise<string | null> {
  const out = path.join(os.tmpdir(), `marigold-oc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.scpt`);
  try { await exec("osacompile", ["-o", out, "-e", script], { timeout: 20_000 }); return null; }
  catch (e) { return String((e as { stderr?: string }).stderr ?? e).replace(/\s+/g, " ").slice(0, 200); }
  finally { await fs.rm(out, { force: true }).catch(() => {}); }
}

// ---------------------------------------------------------------- building

const PROMPT = `You turn one Mac app's own AppleScript description into a few safe, useful, named actions for an AI assistant.
Return ONLY JSON: {"actions":[{"name":"snake_case","about":"one sentence","kind":"applescript"|"url","template":"...","params":[{"name":"x","type":"text"|"number"|"date"|"boolean","about":"...","optional":false}],"readonly":true|false}]}
Rules:
- 4 to 10 actions covering the most common jobs: LIST/FIND/READ things first (readonly), then create / add / open / export.
- Use ONLY commands, classes and properties that appear in the description. Never invent any.
- A template is a COMPLETE AppleScript starting with: tell application "<exact app name>" … end tell, which RETURNS text (build the result with "return"; join lists with linefeeds; keep results short: first 20 items).
- Put each input as {{param}} where a quoted string/number/boolean value goes, e.g. make new note with properties {name:{{title}}, body:{{body}}}. Never put quotes around {{param}}: the value is inserted already quoted. For a date or time input use type "date" (the user gives 2026-11-12 14:30) and put {{param}} where a date value goes, e.g. make new event with properties {summary:{{title}}, start date:{{start}}, end date:{{end}}}. For kind "url" the template is a URL like things:///add?title={{title}} and values are URL-encoded for you.
- readonly=true only when the action changes nothing and sends nothing.
- Never use do shell script, keystroke, key code, System Events, passwords or anything that moves money.
- Do not include actions that need the user to pick a file or a window by clicking.`;

export async function buildToolset(app: string, force = false): Promise<AppToolset | { error: string }> {
  const { installedApps } = await import("./app-ui");
  const { loadProfile, learnStatic } = await import("./app-knowledge");
  const apps = await installedApps();
  const key = [...apps.keys()].find((k) => k.toLowerCase() === app.toLowerCase().replace(/\.app$/, "")) ?? [...apps.keys()].find((k) => k.toLowerCase().includes(app.toLowerCase()));
  if (!key) return { error: `No app called “${app}” is installed.` };
  if (/safari|chrome|firefox|brave|edge|arc|opera|vivaldi|comet|marigold/i.test(key)) return { error: `${key} is a browser: Marigold uses its own browser tool for the web, not scripts.` };
  if (FINANCE.test(key)) return { error: `${key}: Marigold doesn't build actions for money or password apps.` };
  let p = await loadProfile(key);
  if (!p || force) p = await learnStatic(key, apps.get(key)!);
  const old = await loadToolset(key);
  if (old && !force && old.version === p.version && !old.skipped) return old;

  const base: AppToolset = { app: key, version: p.version, builtAt: Date.now(), actions: [] };
  if (!p.scripting && !p.urlSchemes.length) { const t = { ...base, skipped: "This app has no AppleScript dictionary or URL scheme, so Marigold drives it through its menus instead (app_ui)." }; await saveToolset(t); return t; }
  const { cloudJson, hasCloudKey, stepModel } = await import("./cloud");
  if (!(await hasCloudKey())) return { error: "No cloud AI key is set, so Marigold can't write the actions yet." };
  const desc = `App name: ${key}\n${p.scripting ? `APPLESCRIPT DESCRIPTION:\n${p.scripting.slice(0, 9000)}` : "(no AppleScript dictionary)"}\n${p.urlSchemes.length ? `URL SCHEMES: ${p.urlSchemes.map((s) => `${s}://`).join(", ")}` : ""}`;
  const raw = await cloudJson(PROMPT, desc, AbortSignal.timeout(90_000), { model: stepModel(), maxTokens: 3500 });
  let list: Partial<AppAction>[] = [];
  try { const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as { actions?: Partial<AppAction>[] }; list = Array.isArray(j.actions) ? j.actions : []; } catch { return { error: "The AI's answer wasn't usable. Try again." }; }

  const actions: AppAction[] = [];
  for (const x of list.slice(0, 12)) {
    const name = String(x.name ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
    const template = String(x.template ?? "");
    if (!name || !template || actions.some((y) => y.name === name)) continue;
    const kind = x.kind === "url" ? "url" : "applescript";
    const declared = (Array.isArray(x.params) ? x.params : []).map((q) => ({ name: String(q.name ?? "").replace(/\W/g, ""), type: (["number", "boolean", "date"].includes(String(q.type)) ? q.type : "text") as ActionParam["type"], about: String(q.about ?? "").slice(0, 120), optional: q.optional === true })).filter((q) => q.name);
    const used = placeholders(template);
    const act: AppAction = {
      name, about: String(x.about ?? "").slice(0, 200), kind, template, params: declared.filter((q) => used.includes(q.name)),
      readonly: x.readonly === true && !CHANGES.test(stripLocalSets(template.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) && kind === "applescript", outward: OUTWARD.test(template) || kind === "url",
      status: "failed",
    };
    if (used.some((u) => !act.params.some((q) => q.name === u))) { act.note = "uses an input it doesn't declare"; actions.push(act); continue; }
    if (kind === "applescript" && NEVER.test(template)) { act.note = "uses something Marigold never scripts"; actions.push(act); continue; }
    if (kind === "applescript" && !new RegExp(`tell application "${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(template)) { act.note = "does not target this app"; actions.push(act); continue; }
    if (kind === "url") {
      const scheme = template.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      if (!scheme || !p.urlSchemes.map((s) => s.toLowerCase()).includes(scheme)) { act.note = "not a URL scheme this app declares"; actions.push(act); continue; }
      act.status = "compiled"; actions.push(act); continue;
    }
    const filled = fill(act, sampleArgs(act));
    if (!filled.ok) { act.note = filled.why; actions.push(act); continue; }
    const err = await compiles(filled.text);
    if (err) { act.note = `the app's dictionary rejects it (${err.slice(0, 100)})`; actions.push(act); continue; }
    act.status = "compiled";
    // Run it for real only when it can't change anything and needs no input.
    if (act.readonly) {
      try {
        const r = await exec("osascript", ["-e", filled.text], { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
        act.status = "works"; act.note = `test run ok (${r.stdout.trim().length} characters back)`; // (the content itself is not kept)
      } catch (e) { const m = String((e as { stderr?: string }).stderr ?? e); const needsApp = /not allowed|-1743|-600/.test(m);
        // "Can't get calendar "Marigold test"" only means the sample input names something that doesn't exist: the script itself is fine.
        const sampleMiss = act.params.length > 0 && /\(-1728\)/.test(m) && m.includes("Marigold test");
        act.status = needsApp || sampleMiss ? "compiled" : "failed";
        act.note = needsApp ? "needs permission or the app open; will be tried when used" : sampleMiss ? "compiles; the sample input matched nothing, as expected" : `test run failed: ${m.replace(/\s+/g, " ").slice(0, 100)}`; }
    }
    actions.push(act);
  }
  const set: AppToolset = { ...base, actions };
  await saveToolset(set);
  return set;
}

async function saveToolset(t: AppToolset) {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(DIR, `${slug(t.app)}.json`), JSON.stringify(t, null, 1), { mode: 0o600 });
}
export async function loadToolset(app: string): Promise<AppToolset | null> {
  try { return JSON.parse(await fs.readFile(path.join(DIR, `${slug(app)}.json`), "utf8")) as AppToolset; } catch { return null; }
}
export async function listToolsets(): Promise<AppToolset[]> {
  try { return (await Promise.all((await fs.readdir(DIR)).filter((f) => f.endsWith(".json")).map((f) => fs.readFile(path.join(DIR, f), "utf8").then((x) => JSON.parse(x) as AppToolset).catch(() => null)))).filter(Boolean) as AppToolset[]; } catch { return []; }
}
export async function forgetToolset(app: string) { await fs.rm(path.join(DIR, `${slug(app)}.json`), { force: true }); }

// ---------------------------------------------------------------- learn on its own

const learnG = globalThis as unknown as { __mgLearn?: { queue: string[]; busy: boolean; tried: Map<string, number> } };
const L = (learnG.__mgLearn ??= { queue: [] as string[], busy: false, tried: new Map<string, number>() });
/**
 * Apps the user opens or asks about get their ready-made actions without a trip to Settings: learned one at a time in the
 * background (an app that is already up to date costs nothing; one that failed isn't retried for an hour; a new app version
 * is re-learned). Never blocks the request that triggered it.
 */
export function autoLearn(names: string[]) {
  for (const n of names) {
    if (!n || /^marigold/i.test(n)) continue;
    const k = n.toLowerCase();
    if (L.queue.some((q) => q.toLowerCase() === k) || Date.now() - (L.tried.get(k) ?? 0) < 3600_000) continue;
    L.queue.push(n);
  }
  if (L.busy || !L.queue.length) return;
  L.busy = true;
  void (async () => {
    try {
      while (L.queue.length) {
        const n = L.queue.shift()!;
        const r = await buildToolset(n).catch(() => ({ error: "x" }) as { error: string });
        if ("error" in r) L.tried.set(n.toLowerCase(), Date.now());
      }
    } finally { L.busy = false; }
  })();
}

/** For the apps named in a request that already have ready actions: tell the agent to look there BEFORE writing a script. */
export async function actionsHint(names: string[]): Promise<string> {
  const all = (await listToolsets()).filter((t) => t.actions.some((a) => a.status !== "failed") && names.some((n) => n.toLowerCase() === t.app.toLowerCase()));
  if (!all.length) return "";
  const lines = all.map((t) => `${t.app}: ${offered(t).map((x) => `${x.name}(${x.params.map((p) => p.name + (p.optional ? "?" : "")).join(", ")})${x.readonly ? "" : "*"}`).join("; ").slice(0, 700)}`);
  return `READY-MADE TESTED ACTIONS (* = changes or sends something, asks first). Use them with app_actions action=run app=… name=… params={…} INSTEAD of writing AppleScript; reading ones need no approval. Write your own script only if none fits.\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------- the tool

const offered = (t: AppToolset) => t.actions.filter((a) => a.status !== "failed");

export const appActionsTool: ToolDef = {
  name: "app_actions",
  description: "Ready-made, tested actions for an app on this Mac (built from the app's own dictionary). action=apps lists which apps have them; action=list (app) shows an app's actions and their inputs; action=build (app) creates them if the app has none yet; action=run (app, name, params) runs one. Prefer this over writing AppleScript yourself when an action fits; fall back to app_capabilities / applescript / app_ui when none does.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["apps", "list", "build", "run"] }, app: { type: "string" }, name: { type: "string", description: "action name (run)" }, params: { type: "object", description: "inputs for the action (run)" } }, required: ["action"] },
  classify: (a: Args): Classified => {
    const act = str(a, "action");
    if (act !== "run") return { tier: 0, summary: act === "build" ? `Learn what ${str(a, "app")} can do` : "App actions" };
    // The real risk is known only from the saved action: read it synchronously from the cache filled when it was listed or built.
    const t = known.get(slug(str(a, "app"))) ?? readSync(str(a, "app"));
    const x = t?.actions.find((y) => y.name === str(a, "name"));
    const label = `${str(a, "app")}: ${str(a, "name").replace(/_/g, " ")}`;
    if (!x) return { tier: 2, scope: `app:${str(a, "app")}`, summary: label };
    if (x.readonly) return { tier: 0, summary: label };
    return { tier: 2, scope: `app:${t!.app}`, outward: x.outward, summary: label };
  },
  taints: true,
  async exec(a) {
    const act = str(a, "action");
    if (act === "apps") { const all = await listToolsets(); remember(all); return all.filter((t) => offered(t).length).map((t) => `${t.app} (${offered(t).length} actions)`).join("\n") || "No app has ready-made actions yet. action=build with an app name creates them."; }
    const appName = str(a, "app"); if (!appName) return "FAILED: give app.";
    if (act === "build") {
      const r = await buildToolset(appName, (a.params as Args | undefined)?.force === true);
      if ("error" in r) return `FAILED: ${r.error}`;
      remember([r]);
      return r.skipped ?? `${r.app}: ${offered(r).length} actions ready (${r.actions.filter((x) => x.status === "works").length} tested by running, ${r.actions.filter((x) => x.status === "failed").length} dropped).\n${describeSet(r)}`;
    }
    const t = (await loadToolset(appName)) ?? (await listToolsets()).find((x) => x.app.toLowerCase().includes(appName.toLowerCase())) ?? null;
    if (!t) return `FAILED: no actions built for “${appName}” yet. Call action=build first.`;
    remember([t]);
    if (act === "list") return t.skipped ?? describeSet(t);
    if (act !== "run") return "FAILED: action must be apps, list, build or run.";
    const x = offered(t).find((y) => y.name === str(a, "name"));
    if (!x) return `FAILED: ${t.app} has no action “${str(a, "name")}”. Its actions: ${offered(t).map((y) => y.name).join(", ")}`;
    const filled = fill(x, (a.params ?? {}) as Args);
    if (!filled.ok) return `FAILED: ${filled.why}. Inputs: ${x.params.map((p) => `${p.name}${p.optional ? "?" : ""}`).join(", ")}`;
    if (x.kind === "url") { await exec("open", [filled.text], { timeout: 15_000 }); return "Opened."; }
    try {
      const r = await exec("osascript", ["-e", filled.text], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      return r.stdout.trim().slice(0, 8000) || (x.readonly ? "(It ran fine and found nothing: the list is empty.)" : "Done.");
    } catch (e) {
      const m = String((e as { stderr?: string }).stderr ?? e).replace(/\s+/g, " ");
      if (/-600/.test(m)) { await exec("open", ["-g", "-a", t.app]).catch(() => {}); await new Promise((r) => setTimeout(r, 2500)); try { return (await exec("osascript", ["-e", filled.text], { timeout: 60_000 })).stdout.trim().slice(0, 8000) || (x.readonly ? "(It ran fine and found nothing: the list is empty.)" : "Done."); } catch { /* fall through */ } }
      return `FAILED: ${m.slice(0, 300)}. If this keeps happening, build again with action=build and params {force:true}.`;
    }
  },
};

const known = new Map<string, AppToolset>();
/** classify() can't wait, so on a fresh start (nothing listed yet) it reads the saved file directly. */
function readSync(app: string): AppToolset | undefined {
  try { const t = JSON.parse(readFileSync(path.join(DIR, `${slug(app)}.json`), "utf8")) as AppToolset; known.set(slug(app), t); return t; } catch { return undefined; }
}
function remember(ts: AppToolset[]) { for (const t of ts) known.set(slug(t.app), t); }
function describeSet(t: AppToolset): string {
  return offered(t).map((x) => `- ${x.name}(${x.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")}) ${x.readonly ? "[read-only]" : x.outward ? "[sends/shares: asks first]" : "[changes things: asks first]"} ${x.about}`).join("\n");
}
