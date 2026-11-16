import { appBrowserAvailable, mb } from "./app-browser";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { APP_TOOLS } from "./apps";
import { personInfoTool } from "./context";
import { browserTool } from "./browser-tool";
import { appUiTool } from "./app-ui";
import { memoryTool } from "./memory";
import { CODE_TOOLS, CODE_TOOL_NAMES } from "./code-tools";
import { appCapabilitiesTool } from "./app-knowledge";
import { appActionsTool } from "./app-actions";
import { financeTool } from "./finance-tool";
import { paymentTool } from "./payment-tool";
import { desktopTool } from "./desktop-tool";
import { gcalTool, gdriveTool, gmailTool , gdocsTool, gsheetsTool, gslidesTool, gtasksTool, gcontactsTool } from "./google-tools";
import {
  MARIGOLD_DIR,
  expandPath,
  looksFinancial,
  sensitivePath,
  type Classified,
  NETWORK_OUT,
} from "./policy";

const execAsync = promisify(execFile);
/** execFile wrapper: osascript calls that hit "Application isn't running (-600)" launch the app and retry once. */
async function run(cmd: string, args: string[], opts: Parameters<typeof execAsync>[2] = {}) {
  try {
    return await execAsync(cmd, args, { encoding: "utf8", ...opts }) as { stdout: string; stderr: string };
  } catch (err) {
    const app = cmd === "osascript" ? String(err).includes("(-600)") && args.join(" ").match(/application "([^"]+)"/)?.[1] : null;
    if (!app) throw err;
    await execAsync("open", ["-g", "-a", app]);
    await new Promise((r) => setTimeout(r, 2500));
    return await execAsync(cmd, args, { encoding: "utf8", ...opts }) as { stdout: string; stderr: string };
  }
}
type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Classify a concrete call → risk tier, scope, human summary. */
  classify: (args: Args) => Classified;
  /** Output of this tool is untrusted (may contain prompt injection). */
  taints?: boolean;
  exec: (args: Args, signal: AbortSignal, ctx: ToolCtx) => Promise<string>;
}

/** Per-run context handed to tools by the loop. */
export interface ToolCtx {
  /** Schedule a task for a specific time (only in interactive runs). Returns the first run time (ISO). */
  scheduleTask?: (goal: string, atISO: string, repeat: "none" | "daily" | "weekdays" | "weekly" | "monthly") => Promise<string>;
  /** This run IS a scheduled task the user approved when they scheduled it: its ordinary approvals are pre-granted (money never is). */
  scheduledApproved?: boolean;
  /** Create a recurring background watcher (only in interactive runs). */
  startMonitor?: (goal: string, everyMinutes: number, maxDays: number, repeat?: boolean) => string;
  /** Corrections the user typed in the View sidebar while this run works. */
  steerQueue?: string[];
  /** Holds while the user has paused this run (returns at once otherwise). */
  waitIfPaused?: (signal: AbortSignal) => Promise<void>;
  /** Chat this run belongs to (the View tab follows it). */
  chatId?: string;
  /** Skip the answer-vs-action router (always use the agent). */
  forceAgent?: boolean;
  /** "Auto" model choice: simple actions may use the fast model. */
  auto?: boolean;
  /** Background checks: use the small fast model whenever it's available. */
  preferFast?: boolean;
  /** Sent from the Browser tab's assistant: web_browser works in the tab the user is looking at. */
  browserCurrent?: boolean;
  /** Browser-agent mode without taking over the user's tab (works in the agent's own tab). */
  browserMode?: boolean;
  /** Coding mode: the project folder the user chose (the coding tools only work inside it). */
  coding?: { root: string };
  /** What the user is looking at in the Browser tab (title, URL, page text) — model context only. */
  pageContext?: string;
  /** The user's current message (so tools can honour things like "in my 251552 account"). */
  userText?: string;
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: props,
  required,
});
const s = (description: string) => ({ type: "string", description });

/** Make sure an app is running and responsive before scripting it. */
async function ensureApp(app: string) {
  try {
    const { stdout } = await execAsync("osascript", ["-e", `application "${app}" is running`], { encoding: "utf8" });
    if (stdout.trim() === "true") return;
  } catch { /* fall through */ }
  await execAsync("open", ["-g", "-a", app]);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await execAsync("osascript", ["-e", `tell application "${app}" to count windows`], { encoding: "utf8", timeout: 5000 });
      return;
    } catch { /* still starting */ }
  }
}

export interface KnownHandle { handle: string; name?: string; nick?: string; /** Contacts person id — two people can share a name */ pid?: string }
let knownCache: { at: number; handles: KnownHandle[] } | null = null;
/** Every phone/email in Contacts (with the owner's name) plus every 1:1 Messages handle. Cached 60s. */
// People the user gave a number/email for in chat ("Kala is 510 695 0139"),
// remembered so next time "text Kala" just works. Local file, never synced.
const PEOPLE_FILE = path.join(MARIGOLD_DIR, "people.json");
async function rememberedPeople(): Promise<KnownHandle[]> {
  try { return JSON.parse(await fs.readFile(PEOPLE_FILE, "utf8")); } catch { return []; }
}
export async function rememberPerson(name: string, handle: string) {
  name = name.trim();
  if (!name || name === "self-typed" || !handle.trim()) return;
  const list = (await rememberedPeople()).filter((p) => !(p.name?.toLowerCase() === name.toLowerCase() && sameHandle(p.handle, handle)));
  list.push({ name, handle: handle.trim() });
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(PEOPLE_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

export async function knownHandles(): Promise<KnownHandle[]> {
  return [...(await contactHandles()), ...(await rememberedPeople())];
}

async function contactHandles(): Promise<KnownHandle[]> {
  // Contacts rarely change mid-session and reading them takes ~10–20s, so keep them 10 min.
  if (knownCache && Date.now() - knownCache.at < 10 * 60_000) return knownCache.handles;
  const out: KnownHandle[] = [];
  try {
    await ensureApp("Contacts");
    const { stdout } = await run("osascript", ["-e", `tell application "Contacts"
  set out to ""
  repeat with p in people
    set n to name of p
    set pid to id of p
    set nn to ""
    try
      set nn to nickname of p
      if nn is missing value then set nn to ""
    end try
    repeat with ph in phones of p
      set out to out & n & tab & nn & tab & (value of ph) & tab & pid & linefeed
    end repeat
    repeat with e in emails of p
      set out to out & n & tab & nn & tab & (value of e) & tab & pid & linefeed
    end repeat
  end repeat
  return out
end tell`], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      const [name, nick, handle, pid] = line.split("\t");
      if (handle?.trim()) out.push({ name: name.trim(), nick: nick?.trim() || undefined, handle: handle.trim(), pid: pid?.trim() || undefined });
    }
  } catch (err) {
    console.warn("[marigold] contacts lookup failed:", String(err).slice(0, 300));
  }
  try {
    const { stdout } = await run("osascript", ["-e", `tell application "Messages"
  set out to ""
  repeat with c in chats
    try
      if (count of participants of c) is 1 then set out to out & (handle of item 1 of participants of c) & linefeed
    end try
  end repeat
  return out
end tell`], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    for (const h of stdout.split("\n")) if (h.trim()) out.push({ handle: h.trim() });
  } catch { /* Messages unavailable */ }
  // Only cache a good read — never "remember" an empty Contacts list from a slow launch.
  if (out.some((k) => k.name)) knownCache = { at: Date.now(), handles: out };
  return out;
}

function editDistance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * How well does what the user typed match a contact? 0 = no match, 100 = exact.
 * Handles shorthand: prefixes ("Shik" → Shikha), nicknames, typos ("Shika"),
 * first-name-only, initials ("SG" → Shikha Garg) and partial names.
 */
export function nameScore(contact: { name?: string; nick?: string }, query: string): number {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (!q || !contact.name) return 0;
  const names = [contact.name, contact.nick].filter(Boolean).map((n) => n!.toLowerCase());
  let best = 0;
  for (const n of names) {
    const toks = n.split(/\s+/).filter(Boolean);
    const qt = q.split(/\s+/).filter(Boolean);
    if (n === q) best = Math.max(best, 100);
    // Every typed word is the start of some name word: "shik", "shikha g", "a kundu"
    if (qt.every((t) => toks.some((w) => w.startsWith(t)))) best = Math.max(best, toks[0].startsWith(qt[0]) ? 90 : 80);
    // Typos: each typed word within 1–2 edits of a name word
    if (qt.every((t) => toks.some((w) => t.length >= 3 && editDistance(t, w.slice(0, Math.max(t.length, w.length))) <= (t.length >= 6 ? 2 : 1))))
      best = Math.max(best, 65);
    // Substring anywhere: "ikha"
    if (q.length >= 3 && n.includes(q)) best = Math.max(best, 60);
    // Initials: "sg" → Shikha Garg
    if (/^[a-z]{2,4}$/.test(q) && toks.length >= q.length && toks.map((w) => w[0]).join("").startsWith(q)) best = Math.max(best, 55);
  }
  return best;
}

/** Back-compat: does a contact's name (loosely) match what the agent says? */
export function nameMatches(contactName: string | undefined, wanted: string) {
  return nameScore({ name: contactName }, wanted) >= 55;
}

export type Resolved =
  | { name: string; handles: string[]; preferred: string; ambiguous?: undefined }
  | { ambiguous: string[]; candidates: { name: string; handles: string[] }[] };

/** Rank everyone in Contacts against a (possibly shorthand) name. */
export async function rankContacts(query: string) {
  const book = await knownHandles();
  const people = new Map<string, { name: string; nick?: string; handles: string[]; score: number }>();
  for (const k of book) {
    if (!k.name) continue;
    const score = nameScore(k, query);
    if (score < 55) continue;
    const key = k.pid ?? `name:${k.name}`;
    const p = people.get(key) ?? { name: k.name, nick: k.nick, handles: [], score };
    if (!p.handles.some((h) => sameHandle(h, k.handle))) p.handles.push(k.handle);
    people.set(key, p);
  }
  return { ranked: [...people.values()].sort((a, b) => b.score - a.score || a.name.length - b.name.length), book };
}

/**
 * Resolve a person's (possibly shorthand) name straight from Contacts — so the
 * model never copies or mixes up numbers. If two people match equally well,
 * returns `ambiguous` so Marigold asks "which one?" instead of guessing.
 */
export async function resolveContact(name: string): Promise<Resolved | null> {
  const { ranked, book } = await rankContacts(name);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  const ties = ranked.filter((p) => p.score === top.score);
  // Several equally good matches — including two contacts with the very same name.
  if (ties.length > 1) {
    const c = ties.slice(0, 6);
    const same = new Set(c.map((p) => p.name.toLowerCase())).size < c.length;
    return {
      ambiguous: c.map((p) => (same ? `${p.name} (${p.handles[0]})` : p.name)),
      candidates: c.map((p) => ({ name: p.name, handles: p.handles })),
    };
  }
  const threads = book.filter((k) => !k.name).map((k) => k.handle);
  const preferred =
    top.handles.find((h) => threads.some((t) => sameHandle(h, t))) ??
    top.handles.find((h) => !h.includes("@")) ??
    top.handles[0];
  return { name: top.name, handles: top.handles, preferred };
}

/** Same person? Compares emails case-insensitively and phones by their last 10 digits. */
export function sameHandle(a: string, b: string) {
  if (a.includes("@") || b.includes("@")) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const da = a.replace(/\D/g, "").slice(-10);
  const db = b.replace(/\D/g, "").slice(-10);
  return da.length >= 7 && da === db;
}

/** Pull the plain text out of a Messages `attributedBody` blob (newer macOS stores text there). */
export function decodeAttributed(hex: string): string {
  if (!hex) return "";
  const b = Buffer.from(hex, "hex");
  const i = b.indexOf("NSString");
  if (i < 0) return "";
  let p = i + 8 + 5;
  let len = b[p];
  if (len === 0x81) { len = b.readUInt16LE(p + 1); p += 3; }
  else if (len === 0x82) { len = b.readUInt32LE(p + 1); p += 5; }
  else p += 1;
  return b.subarray(p, p + len).toString("utf8");
}

/** After sending, peek at chat.db for an error on that message (needs Full Disk Access; "unknown" otherwise). */
async function deliveryStatus(key: string, since: number): Promise<"ok" | "sms" | "failed" | "unknown"> {
  const db = path.join(os.homedir(), "Library/Messages/chat.db");
  const like = key.includes("@") ? key : `%${key}`;
  const sinceApple = (since / 1000 - 978307200 - 5) * 1e9;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const { stdout } = await execAsync("sqlite3", ["-readonly", "-json", db,
        `select m.error, m.service from message m join handle h on h.ROWID = m.handle_id where m.is_from_me = 1 and h.id like '${like.replace(/'/g, "")}' and m.date > ${Math.floor(sinceApple)} order by m.date desc limit 1`]);
      const row = (JSON.parse(stdout || "[]") as { error: number; service: string }[])[0];
      if (!row) continue;
      if (row.error) return "failed";
      return row.service === "SMS" ? "sms" : "ok";
    } catch { return "unknown"; }
  }
  return "unknown";
}

const FDA_HELP =
  "FAILED: macOS hasn't given Marigold access to your message history. Tell the user to open System Settings → Privacy & Security → Full Disk Access and turn on the app running Marigold (Terminal), then restart Marigold. This is a one-time step.";

/** Click a button in an app's dialog, polling until it appears. */
async function clickButton(process: string, names: string[], timeoutMs = 6000) {
  const list = names.map((n) => `"${n}"`).join(", ");
  const script = `tell application "System Events"
  if not (exists process "${process}") then return "no-process"
  tell process "${process}"
    repeat with w in windows
      repeat with b in (buttons of w)
        if name of b is in {${list}} then
          click b
          return "clicked"
        end if
      end repeat
      try
        repeat with b in (buttons of group 1 of w)
          if name of b is in {${list}} then
            click b
            return "clicked"
          end if
        end repeat
      end try
    end repeat
  end tell
end tell
return "none"`;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { stdout } = await execAsync("osascript", ["-e", script], { encoding: "utf8", timeout: 5000 });
      if (stdout.trim() === "clicked") return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const MAX_OUT = 8000;
/** Escape a string for an AppleScript string literal. */
const as = (t: string) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const emails = (t: string) => t.split(/[,;\s]+/).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
const clip = (t: string) => (t.length > MAX_OUT ? t.slice(0, MAX_OUT) + "\n…[truncated]" : t);

/** Copy a file into ~/.marigold/backups before overwriting — makes writes undoable. */
async function backup(file: string) {
  try {
    await fs.access(file);
  } catch {
    return;
  }
  const dir = path.join(MARIGOLD_DIR, "backups");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.copyFile(file, path.join(dir, `${Date.now()}_${path.basename(file)}`));
}

// ------------------------------------------------------------------ shell

// Commands that only read state run without asking.
const READONLY_CMDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "which", "whoami", "date", "echo", "find",
  "grep", "rg", "du", "df", "uname", "sw_vers", "file", "stat", "tree", "mdfind",
]);
const READONLY_GIT = /^git\s+(status|log|diff|show|branch|remote -v)\b/;
// Version / info queries that only print ("node -v", "brew list", "ollama ps", "pmset -g batt").
const READONLY_INFO = [
  /^[\w.+-]+\s+(--version|-v|-V|version|--help|-h)$/,
  /^(brew)\s+(list|ls|info|outdated|search|config|leaves|deps)\b/,
  /^(npm|pnpm|yarn)\s+(ls|list|outdated|view|info|config get|root)\b/,
  /^(pip3?|python3 -m pip)\s+(list|show|freeze)\b/,
  /^(ollama)\s+(list|ls|ps|show)\b/,
  /^(pmset\s+-g|system_profiler\s+SP\w+|uptime|hostname|ps(\s+-?\w+)?|top\s+-l\s*1\b|vm_stat|sysctl\s+-n?\s*[\w.]+$|ifconfig$|networksetup\s+-get|scutil\s+--get|defaults\s+read\s+-g\s+AppleInterfaceStyle|command\s+-v|type\s+\w+$|mas\s+list|blueutil\s+(-p|--power)$|docker\s+(ps|images)|gh\s+(pr|issue|repo)\s+(list|view|status)|git\s+--version)/,
];
const SHELL_BLOCK: [RegExp, string][] = [
  [/\bsudo\b|\bsu\s/, "no root access"],
  [/rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, "refusing to wipe a root/home directory"],
  [/\b(mkfs|diskutil\s+erase|dd\s+if=)/, "disk-destructive command"],
  [/\bsecurity\s+(find|dump|export)/, "keychain extraction is blocked"],
  [/(curl|wget)[^|]*\|\s*(ba|z)?sh/, "piping downloads into a shell is blocked"],
  [/\.marigold\b/, "the agent can't modify its own safety settings"],
  [/\b(csrutil|spctl|tccutil)\b/, "can't change macOS security settings"],
];

/** 4823449600 → "4.5 GB" — so the model never has to convert units. */
const human = (bytes: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(bytes >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

function classifyShell(cmd: string): Classified {
  for (const [re, why] of SHELL_BLOCK) {
    if (re.test(cmd)) return { tier: 2, blocked: why, summary: cmd };
  }
  // Same off-limits folders as the file tools (keys, keychains, Marigold's own settings…).
  for (const tok of cmd.match(/(~|\/)[^\s'"|;&<>]*/g) ?? []) {
    const why = sensitivePath(tok);
    if (why) return { tier: 2, blocked: why, summary: cmd };
  }
  const first = cmd.trim().split(/\s+/)[0];
  const chained = /[;&|`$><]/.test(cmd);
  // `open -a App` just opens an app (same as open_app).
  if (!chained && /^open\s+-a\s+("[^"]+"|'[^']+'|[\w .-]+)$/.test(cmd.trim())) return { tier: 1, summary: `Open ${cmd.trim().slice(8).replace(/["']/g, "")}` };
  // `find` can delete (-delete / -exec rm …) — only plain searches count as read-only.
  const findWrites = first === "find" && /\s-(delete|exec|execdir|ok|okdir|fprint)\b/.test(cmd);
  if (!chained && !findWrites && (READONLY_CMDS.has(first) || READONLY_GIT.test(cmd.trim()) || READONLY_INFO.some((re) => re.test(cmd.trim())))) {
    return { tier: 0, summary: `Run (read-only): ${cmd}` };
  }
  if (looksFinancial(cmd)) return { tier: 3, scope: "finance:shell", summary: `Run: ${cmd}` };
  // ONE permission for the whole terminal: "Allow once" asks again next time, "Always allow" never asks again (hard blocks like sudo still apply).
  return { tier: 2, scope: "terminal", outward: NETWORK_OUT.test(cmd), summary: `Run in Terminal: ${cmd}` };
}

// ------------------------------------------------------------------ apps

/** Every `tell application "X"` in an AppleScript. */
function appsIn(script: string): string[] {
  return [...script.matchAll(/application\s+(?:id\s+)?"([^"]+)"/gi)].map((m) => m[1]);
}
const SEND_WORDS = /\b(send|reply|forward|post|submit|share|call|facetime)\b/i;

/** Every `process "X"` targeted through System Events UI scripting. */
function processesIn(script: string): string[] {
  return [...script.matchAll(/process\s+"([^"]+)"/gi)].map((m) => m[1]);
}
const UI_ACTION = /\b(keystroke|key code|click|set value|perform action|select)\b/i;
const BROWSER_JS = /\b(do javascript|execute\b.*\bjavascript)\b/i;

function classifyAppleScript(script: string): Classified {
  const procs = processesIn(script);
  // A System Events script is really controlling the process it names.
  const apps = [...procs, ...appsIn(script).filter((a) => a !== "System Events" || procs.length === 0)];
  if (/do shell script/i.test(script)) {
    const c = classifyShell(script.match(/do shell script\s+"([^"]*)"/i)?.[1] ?? script);
    if (c.blocked) return c;
  }
  if (/\bkeychain\b|password/i.test(script) && !/1password/i.test(script)) {
    return { tier: 2, blocked: "reading passwords via scripting is blocked — use the vault", summary: script };
  }
  if (looksFinancial(script, apps.join(" "))) {
    return { tier: 3, scope: `finance:${apps[0] ?? "script"}`, summary: script };
  }
  const label = apps.length ? apps.join(", ") : "System Events";
  const usesSystemEvents = /application\s+"System Events"/i.test(script);
  if (usesSystemEvents && procs.length === 0 && UI_ACTION.test(script)) {
    return { tier: 2, scope: "ui:frontmost", noRemember: true, outward: true, summary: "Type/click in the frontmost app" };
  }
  if (BROWSER_JS.test(script)) {
    return { tier: 2, scope: `browser-js:${apps[0] ?? "browser"}`, outward: true, summary: `Run JavaScript in ${label}` };
  }
  return {
    tier: 2,
    scope: `app:${apps[0] ?? "System Events"}`,
    outward: SEND_WORDS.test(script),
    summary: `Control ${label}`,
  };
}

// ------------------------------------------------------------------ web

function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&quot;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------------ registry

export const TOOLS: ToolDef[] = [
  {
    name: "web_search",
    description: "Search the web. Returns titles, URLs and snippets (and news). Never use google.com or another search engine's page for this.",
    parameters: obj({ query: s("search query") }, ["query"]),
    classify: (a) => ({ tier: 0, summary: `Search the web for “${str(a, "query")}”` }),
    taints: true,
    async exec(a) {
      // Marigold's own licensed search (Brave with the user's key, else Wikipedia): never a search engine's page.
      const { searchText } = await import("./web-search");
      return searchText(str(a, "query"));
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page and return its readable text.",
    parameters: obj({ url: s("http(s) URL") }, ["url"]),
    classify: (a) => {
      const url = str(a, "url");
      if (!/^https?:\/\//i.test(url)) return { tier: 0, blocked: "only http(s) URLs", summary: url };
      return { tier: 0, summary: `Read ${url}` };
    },
    taints: true,
    async exec(a, signal) {
      const res = await fetch(str(a, "url"), { signal, headers: { "User-Agent": "Mozilla/5.0 Marigold" } });
      return clip(htmlToText(await res.text()));
    },
  },
  {
    name: "list_dir",
    description: "List files in a folder on the user's Mac. Use ~ for home.",
    parameters: obj({ path: s("folder path, e.g. ~/Downloads") }, ["path"]),
    classify: (a) => ({ tier: 0, blocked: sensitivePath(str(a, "path")), summary: `Look in ${str(a, "path")}` }),
    async exec(a) {
      const entries = await fs.readdir(expandPath(str(a, "path")), { withFileTypes: true });
      return clip(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)");
    },
  },
  {
    name: "read_file",
    description: "Read a text file on the user's Mac.",
    parameters: obj({ path: s("file path") }, ["path"]),
    classify: (a) => ({ tier: 0, blocked: sensitivePath(str(a, "path")), summary: `Read ${str(a, "path")}` }),
    taints: true,
    exec: async (a) => clip(await fs.readFile(expandPath(str(a, "path")), "utf8")),
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file. Existing files are backed up first.",
    parameters: obj({ path: s("file path"), content: s("full file contents") }, ["path", "content"]),
    classify: (a) => ({ tier: 1, blocked: sensitivePath(str(a, "path")), summary: `Write ${str(a, "path")}` }),
    async exec(a) {
      const p = expandPath(str(a, "path"));
      await backup(p);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, str(a, "content"));
      return `Wrote ${p} (${str(a, "content").length} chars). Previous version backed up.`;
    },
  },
  {
    name: "move_path",
    description: "Move or rename a file or folder.",
    parameters: obj({ from: s("source path"), to: s("destination path") }, ["from", "to"]),
    classify: (a) => ({
      tier: 1,
      blocked: sensitivePath(str(a, "from")) ?? sensitivePath(str(a, "to")),
      summary: `Move ${str(a, "from")} → ${str(a, "to")}`,
    }),
    async exec(a) {
      const to = expandPath(str(a, "to"));
      try {
        await fs.access(to);
        return `Refused: ${to} already exists (won't overwrite on a move).`;
      } catch { /* free */ }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(expandPath(str(a, "from")), to);
      return `Moved to ${to}`;
    },
  },
  {
    name: "trash_path",
    description: "Delete a file or folder by moving it to the macOS Trash (recoverable).",
    parameters: obj({ path: s("path to delete") }, ["path"]),
    classify: (a) => ({ tier: 1, blocked: sensitivePath(str(a, "path")), summary: `Move ${str(a, "path")} to Trash` }),
    async exec(a) {
      const p = expandPath(str(a, "path"));
      const dest = path.join(os.homedir(), ".Trash", `${path.basename(p)} ${Date.now()}`);
      await fs.rename(p, dest);
      return `Moved to Trash (recoverable).`;
    },
  },
  {
    name: "open_app",
    description: "Open a macOS app, file, or URL (like double-clicking it).",
    parameters: obj({ target: s("app name (e.g. Notes), file path, or URL") }, ["target"]),
    classify: (a) => {
      const t = str(a, "target") || str(a, "app") || str(a, "name") || str(a, "path") || str(a, "url"); // same aliases as exec, so the money check can't be skipped
      if (looksFinancial(t)) return { tier: 3, scope: `finance:${t}`, summary: `Open ${t}` };
      return { tier: 1, summary: `Open ${t}` };
    },
    async exec(a) {
      const t = (str(a, "target") || str(a, "app") || str(a, "name") || str(a, "path") || str(a, "url")).trim();
      if (!t) return "FAILED: say which app, file or URL to open (target).";
      // A web link → the Marigold Browser (a new tab the user can see in the Browser tab).
      if (/^https?:/i.test(t) && appBrowserAvailable()) {
        const r = (await mb("open", { url: t, newTab: true })) as { title?: string; url?: string };
        return `Opened ${r.title || t} in the Marigold Browser. Use web_browser to work on the page.`;
      }
      // "Clock", "Clock.app", "App Store" → launch by app name; anything else is a path or URL.
      const isApp = !t.includes("/") && !t.includes(":") && (/\.app$/i.test(t) || !t.includes(".") || /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(t));
      if (isApp) {
        // Find it however it was named (nickname, bundle id, partial name, apps in vendor folders), then open by path.
        const { resolveApp } = await import("./catalog");
        const hit = (await resolveApp(t))?.app;
        if (!hit?.path) return `FAILED: “${t}” isn't installed on this Mac. Call app_ui list_apps for the exact names; if it really isn't installed, tell the user.`;
        await run("open", ["-g", hit.path]);
        return `Opened ${hit.name}`;
      }
      await run("open", [t.startsWith("~") ? expandPath(t) : t]);
      return `Opened ${t}`;
    },
  },
  {
    name: "find_contact",
    description:
      "Look up a person in the user's Contacts by name. Returns their email addresses and phone numbers. ALWAYS call this before emailing or texting someone by name.",
    parameters: obj({ name: s("full or partial name, e.g. Shikha") }, ["name"]),
    classify: (a) => ({ tier: 0, summary: `Look up “${str(a, "name")}” in Contacts` }),
    async exec(a) {
      const { ranked, book } = await rankContacts(str(a, "name"));
      if (ranked.length === 0) return `No contact matching "${str(a, "name")}" (tried nicknames, prefixes and typos). Ask the user who they mean.`;
      const threads = book.filter((k) => !k.name).map((k) => k.handle);
      return ranked.slice(0, 5).map((p) =>
        `NAME: ${p.name}${p.nick ? ` (nickname ${p.nick})` : ""}\n` +
        p.handles.map((h) => `  ${h.includes("@") ? "email" : "phone"}: ${h}${threads.some((t) => sameHandle(h, t)) ? "   ← existing Messages conversation" : ""}`).join("\n"),
      ).join("\n") + (ranked.length > 1 ? "\n(Several matches — if it's unclear which one the user means, ask.)" : "");
    },
  },
  {
    name: "send_email",
    description:
      "Send an email from the user's Mail app. `to` must be real email address(es) — use find_contact first if you only have a name.",
    parameters: obj(
      {
        contact_name: s("the person's name as the user said it, e.g. Shikha (or \"self-typed\" if the user gave the address directly)"),
        to: s("comma-separated email addresses"),
        subject: s("subject line"),
        body: s("plain-text body"),
        cc: s("optional comma-separated cc addresses"),
      },
      ["contact_name", "to", "subject", "body"],
    ),
    classify: (a) => {
      const to = emails(str(a, "to"));
      const who = str(a, "contact_name") && str(a, "contact_name") !== "self-typed" ? `${str(a, "contact_name")} ` : "";
      const summary = `Email ${who}<${to.join(", ") || "no recipient"}> — “${str(a, "subject")}”`;
      if (to.length === 0) return { tier: 2, blocked: "no valid email address — call find_contact or ask the user", summary };
      if (looksFinancial(str(a, "subject"), str(a, "body"))) return { tier: 3, scope: "finance:email", outward: true, summary };
      return { tier: 2, scope: "send:email", outward: true, summary };
    },
    async exec(a, signal) {
      const to = emails(str(a, "to"));
      const cc = emails(str(a, "cc"));
      const rcpt = (kind: string, list: string[]) =>
        list.map((e) => `make new ${kind} recipient at end of ${kind} recipients with properties {address:"${as(e)}"}`).join("\n    ");
      const script = `tell application "Mail"
  if (count of (every account whose enabled is true)) is 0 then error "NO_MAIL_ACCOUNT"
  set m to make new outgoing message with properties {subject:"${as(str(a, "subject"))}", content:"${as(str(a, "body"))}", visible:false}
  tell m
    ${rcpt("to", to)}
    ${rcpt("cc", cc)}
  end tell
  if (count of to recipients of m) is 0 then error "no recipients were added"
  set ok to send m
  if ok is false then error "Mail refused to send (check that an account is set up in Mail)"
  return "sent"
end tell`;
      try {
        await run("osascript", ["-e", script], { signal, timeout: 60_000 });
      } catch (err) {
        if (String(err).includes("NO_MAIL_ACCOUNT")) {
          return "FAILED: the Mail app has no email account set up, so nothing was sent. Tell the user to add their email account in System Settings → Internet Accounts (turn on Mail), then try again.";
        }
        throw err;
      }
      return `Sent via Mail to ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}. It's in the Sent mailbox.`;
    },
  },
  {
    name: "send_imessage",
    description:
      "Send a text (iMessage or SMS) from Messages to ONE person or one existing group. Pass the person's name in contact_name — their number is looked up automatically. For several people separately, call it once per person.",
    parameters: obj(
      {
        contact_name: s("the person's name as the user said it, e.g. Arya (or \"self-typed\" if the user gave the number directly)"),
        to: s("their phone number (e.g. +15551234567) or email, taken from THIS person's find_contact result. Leave empty when sending to a group."),
        group: s("exact name of an existing group chat (from list_conversations) — use instead of `to` for groups"),
        text: s("message text"),
      },
      ["contact_name", "text"],
    ),
    classify: (a) => {
      const group = str(a, "group").trim();
      if (group) {
        const summary = `Message group “${group}” — “${str(a, "text").slice(0, 60)}”`;
        if (looksFinancial(str(a, "text"))) return { tier: 3, scope: "finance:message", outward: true, summary };
        return { tier: 2, scope: "send:message", outward: true, summary };
      }
      const to = str(a, "to").trim();
      const valid = /^\+?[\d\s().-]{7,}$/.test(to) || emails(to).length === 1;
      const who = str(a, "contact_name") && str(a, "contact_name") !== "self-typed" ? `${str(a, "contact_name")} ` : "";
      const summary = `Text ${who}(${to}) — “${str(a, "text").slice(0, 60)}”`;
      if (!valid) return { tier: 2, blocked: "need a phone number or email — call find_contact first", summary };
      if (looksFinancial(str(a, "text"))) return { tier: 3, scope: "finance:message", outward: true, summary };
      return { tier: 2, scope: "send:message", outward: true, summary };
    },
    async exec(a, signal) {
      const group = str(a, "group").trim();
      if (group) {
        const { stdout } = await run("osascript", ["-e", `tell application "Messages"
  repeat with c in chats
    try
      if (name of c as text) is "${as(group)}" then
        send "${as(str(a, "text"))}" to c
        return "sent"
      end if
    end try
  end repeat
  return "missing"
end tell`], { signal, timeout: 60_000 });
        return stdout.trim() === "sent"
          ? `Message sent to the group “${group}”.`
          : `FAILED: no group chat named “${group}”. Call list_conversations to see the exact names.`;
      }
      const raw = str(a, "to").trim();
      // Normalize phones to E.164 so we hit the same thread Messages already has.
      let handle = raw;
      if (!raw.includes("@")) {
        const d = raw.replace(/\D/g, "");
        handle = raw.startsWith("+") ? `+${d}` : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : `+${d}`;
      }
      const key = handle.includes("@") ? handle.toLowerCase() : handle.replace(/\D/g, "").slice(-10);
      const text = as(str(a, "text"));
      const script = `tell application "Messages"
  set target to missing value
  repeat with c in chats
    try
      if (count of participants of c) is 1 then
        set h to handle of item 1 of participants of c
        if h contains "${as(key)}" then
          set target to c
          exit repeat
        end if
      end if
    end try
  end repeat
  if target is not missing value then
    send "${text}" to target
    return "existing"
  end if
  return "none"
end tell`;
      const started = Date.now();
      const { stdout } = await run("osascript", ["-e", script], { signal, timeout: 60_000 });
      const existing = stdout.trim() === "existing";
      if (!existing) {
        // New conversation: use Messages' own compose window so IT decides
        // iMessage (blue) vs SMS (green). Forcing iMessage silently fails for
        // numbers without iMessage ("Not Delivered").
        await run("open", [`sms:/open?addresses=${encodeURIComponent(handle)}&body=${encodeURIComponent(str(a, "text"))}`]);
        await new Promise((r) => setTimeout(r, 2500));
        try {
          await run("osascript", ["-e", `tell application "Messages" to activate
delay 0.5
tell application "System Events" to tell process "Messages" to key code 36`]);
        } catch (err) {
          if (/not allowed|assistive|1002|-25211/i.test(String(err))) {
            return "FAILED: the message is typed into Messages but not sent — macOS needs Accessibility permission to press Send. Tell the user: System Settings → Privacy & Security → Accessibility → turn on Terminal (one time), or press Return in Messages now.";
          }
          throw err;
        }
      }
      const where = existing ? `in your existing conversation with ${raw}` : `to ${handle} (new conversation)`;
      const status = await deliveryStatus(key, started);
      if (status === "failed") return `FAILED: Messages couldn't deliver it ${where} (shows “Not Delivered”). The number may be wrong, or it can't get iMessage and this Mac can't send SMS — tell the user to turn on iPhone → Settings → Apps → Messages → Text Message Forwarding → this Mac.`;
      return `Message sent ${where}: “${str(a, "text")}”${status === "unknown" ? "" : status === "sms" ? " (as a green SMS)" : ""}.`;
    },
  },
  {
    name: "call_contact",
    description:
      "Start a phone call (through the user's iPhone) or a FaceTime call. `to` must come from THIS person's find_contact result.",
    parameters: obj(
      {
        contact_name: s("the person's name as the user said it, e.g. Nani"),
        to: s("their phone number or FaceTime email"),
        type: { type: "string", enum: ["phone", "facetime_audio", "facetime_video"], description: "default phone" },
      },
      ["contact_name"],
    ),
    classify: (a) => {
      const to = str(a, "to").trim();
      const valid = /^\+?[\d\s().-]{7,}$/.test(to) || emails(to).length === 1;
      const kind = str(a, "type") || "phone";
      const label = kind === "phone" ? "Call" : kind === "facetime_video" ? "FaceTime video" : "FaceTime audio";
      const summary = `${label} ${str(a, "contact_name")} (${to})`;
      if (!valid) return { tier: 2, blocked: "need a phone number or email — call find_contact first", summary };
      return { tier: 2, scope: "send:call", outward: true, summary };
    },
    async exec(a) {
      const raw = str(a, "to").trim();
      const handle = raw.includes("@") ? raw : "+" + raw.replace(/\D/g, "").replace(/^(\d{10})$/, "1$1");
      const kind = str(a, "type") || "facetime_audio";
      // Every call goes through the FaceTime app (that's what Messages' call button does too).
      // "phone" = cellular via iPhone; others = FaceTime.
      const scheme = kind === "phone" ? "tel" : kind === "facetime_video" ? "facetime" : "facetime-audio";
      await run("open", [`${scheme}://${encodeURIComponent(handle)}`]);
      // macOS asks "Call?" — press it for the user (they already approved in Marigold).
      const clicked =
        (await clickButton("FaceTime", ["Call", "FaceTime Audio", "Audio", "Video", "FaceTime"])) ||
        (await clickButton("NotificationCenter", ["Call"], 2000));
      return clicked
        ? `Calling ${str(a, "contact_name")} (${handle}) via ${kind === "phone" ? "iPhone (cellular)" : "FaceTime"}.`
        : `Opened the call to ${str(a, "contact_name")} (${handle}); if it didn't start, macOS is showing a "Call" button the user must click (or Accessibility permission is off).`;
    },
  },
  {
    name: "create_group_chat",
    description:
      "Start a NEW group iMessage with several people and send the first message. Look up every person with find_contact first.",
    parameters: obj(
      {
        contact_names: s("comma-separated names of everyone, e.g. Arya, Shikha"),
        to: s("optional — filled in automatically from Contacts"),
        text: s("first message"),
      },
      ["contact_names", "text"],
    ),
    classify: (a) => {
      const n = str(a, "to").split(/[,;]+/).filter((x) => x.trim()).length;
      const summary = `New group with ${str(a, "contact_names")} — “${str(a, "text").slice(0, 60)}”`;
      if (n < 2) return { tier: 2, blocked: "a group needs at least 2 people — use send_imessage for one person", summary };
      return { tier: 2, scope: "send:message", outward: true, summary };
    },
    async exec(a) {
      const handles = str(a, "to").split(/[,;]+/).map((h) => h.trim()).filter(Boolean)
        .map((h) => (h.includes("@") ? h : "+" + h.replace(/\D/g, "").replace(/^(\d{10})$/, "1$1")));
      const url = `sms:/open?addresses=${handles.map(encodeURIComponent).join(",")}&body=${encodeURIComponent(str(a, "text"))}`;
      await run("open", [url]);
      await new Promise((r) => setTimeout(r, 2500));
      // The compose window is filled in — press Return to send.
      await run("osascript", ["-e", `tell application "Messages" to activate
delay 0.5
tell application "System Events" to tell process "Messages" to key code 36`]);
      return `Created a group with ${str(a, "contact_names")} and sent the first message.`;
    },
  },
  {
    name: "list_conversations",
    description: "List Messages conversations (group chats with their names + members, and recent 1:1 chats).",
    parameters: obj({ filter: s("optional text to filter by name or number") }, []),
    classify: () => ({ tier: 0, summary: "Look at your Messages conversations" }),
    taints: true,
    async exec(a, signal) {
      const book = await knownHandles();
      const nameOf = (h: string) => book.find((k) => k.name && sameHandle(h, k.handle))?.name ?? h;
      const { stdout } = await run("osascript", ["-e", `tell application "Messages"
  set out to ""
  repeat with c in chats
    try
      set hs to ""
      repeat with p in participants of c
        set hs to hs & (handle of p) & ","
      end repeat
      set out to out & (name of c as text) & tab & hs & linefeed
    end try
  end repeat
  return out
end tell`], { signal, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      const f = str(a, "filter").toLowerCase();
      const rows = stdout.split("\n").filter(Boolean).map((line) => {
        const [name, hs] = line.split("\t");
        const people = (hs ?? "").split(",").filter(Boolean).map(nameOf);
        const group = people.length > 1;
        return `${group ? "GROUP" : "1:1"}  ${name !== "missing value" ? `“${name}” ` : ""}— ${people.join(", ")}`;
      }).filter((r) => !f || r.toLowerCase().includes(f));
      return clip(rows.slice(0, 60).join("\n") || "No matching conversations.");
    },
  },
  {
    name: "read_messages",
    description:
      "Read recent messages from a conversation (1:1 or group) to summarize, answer questions, or find info. Give a person's name, phone/email, or group name.",
    parameters: obj(
      {
        conversation: s("a person's name (e.g. Arya), a group name, or a phone/email"),
        limit: { type: "number", description: "how many recent messages (default 30, max 200)" },
      },
      ["conversation"],
    ),
    classify: (a) => ({ tier: 2, scope: "read:messages", summary: `Read your messages with ${str(a, "conversation")}` }),
    taints: true,
    async exec(a, signal) {
      const db = path.join(os.homedir(), "Library/Messages/chat.db");
      const conv = str(a, "conversation").trim();
      const limit = Math.min(200, Math.max(1, Number(a.limit) || 30));
      const keys = conv.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
        const d = c.replace(/\D/g, "").slice(-10);
        return (c.includes("@") ? c.toLowerCase() : d.length >= 7 ? d : c).replace(/'/g, "''");
      });
      const sql = `SELECT m.date, m.is_from_me, m.text, hex(m.attributedBody) AS ab,
          COALESCE(h.id, '') AS sender, COALESCE(c.display_name, '') AS chat
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE ${keys.map((k) => `c.display_name = '${k}' OR (c.chat_identifier LIKE '%${k}%' AND c.style = 45)`).join(" OR ")}
        ORDER BY m.date DESC LIMIT ${limit};`;
      let out: string;
      try {
        ({ stdout: out } = await run("sqlite3", ["-readonly", "-json", db, sql], { signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
      } catch (err) {
        if (/authorization denied|unable to open/i.test(String(err))) return FDA_HELP;
        throw err;
      }
      const rows = (out.trim() ? JSON.parse(out) : []) as { date: number; is_from_me: number; text: string | null; ab: string; sender: string; chat: string }[];
      if (rows.length === 0) return `No messages found for “${conv}”. Try list_conversations for exact names.`;
      const book = await knownHandles();
      const nameOf = (h: string) => book.find((k) => k.name && sameHandle(h, k.handle))?.name ?? h;
      const lines = rows.reverse().map((r) => {
        const when = new Date((r.date / 1e9 + 978307200) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const body = (r.text ?? decodeAttributed(r.ab)).replace(/\uFFFC/g, "[attachment]").trim() || "[attachment]";
        return `[${when}] ${r.is_from_me ? "Me" : nameOf(r.sender)}: ${body}`;
      });
      return clip(lines.join("\n"));
    },
  },
  {
    name: "schedule_task",
    description:
      "Do something AT A SPECIFIC TIME (and optionally repeat it): 'text Mom at 2 pm to pick me up', 'tomorrow at 8 am email my teacher…', 'every weekday at 7 am give me the weather'. Marigold sleeps until that time and then runs the task itself, once, with no polling. " +
      "The user approves it now; it runs unattended later. Put EVERYTHING needed in `goal` (who, exact message wording, which app) because nothing can be asked at run time. Compute `at` from the [Now: …] line (local time, ISO like 2026-11-11T14:00:00). " +
      "Use this for any time-of-day request. Do NOT use start_monitor for that: start_monitor is only for 'keep checking until something happens'.",
    parameters: obj(
      {
        goal: s("the complete, self-contained instruction to carry out at that time (recipient, exact text, app, details)"),
        at: s("when to run it, local time, ISO 8601, e.g. 2026-11-11T14:00:00"),
        repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"], description: "how often to repeat after the first run (default none)" },
      },
      ["goal", "at"],
    ),
    classify: (a) => {
      const goal = str(a, "goal");
      const at = new Date(str(a, "at"));
      if (!goal) return { tier: 0, blocked: "schedule_task needs a goal.", summary: "Schedule a task" };
      if (Number.isNaN(at.getTime())) return { tier: 0, blocked: "I couldn't read that time. Use a local ISO time like 2026-11-11T14:00:00 (see the [Now: …] line for today's date).", summary: "Schedule a task" };
      if (at.getTime() < Date.now() - 60_000) return { tier: 0, blocked: "That time has already passed. Work out the right date from the [Now: …] line and try again (ask the user if it's unclear).", summary: "Schedule a task" };
      const when = at.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const rep = ["daily", "weekdays", "weekly", "monthly"].includes(str(a, "repeat")) ? `, repeating ${str(a, "repeat")}` : "";
      // Approving this IS approving what happens later. Money still asks again when it runs.
      return { tier: looksFinancial(goal) ? 3 : 2, scope: "schedule", noRemember: true, outward: true, summary: `At ${when}${rep}: ${goal.slice(0, 220)}` };
    },
    async exec(a, _signal, ctx) {
      if (!ctx.scheduleTask) return "Scheduled tasks can't be created from inside a background task.";
      const rep = (["daily", "weekdays", "weekly", "monthly"].includes(str(a, "repeat")) ? str(a, "repeat") : "none") as "none" | "daily" | "weekdays" | "weekly" | "monthly";
      try {
        const at = await ctx.scheduleTask(str(a, "goal"), str(a, "at"), rep);
        const when = new Date(at).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" });
        return `Scheduled for ${when}${rep !== "none" ? `, then ${rep}` : ""}. Marigold will run it by itself at that time and notify the user. Tell the user in one short line what will happen and when. Do NOT do the task now.`;
      } catch (e) { return `FAILED: ${e instanceof Error ? e.message : e}`; }
    },
  },
  {
    name: "start_monitor",
    description:
      "Create a BACKGROUND TASK that keeps RE-CHECKING something until a condition happens and pings the user (never for 'at 2 pm do X': that is schedule_task) (e.g. 'tell me when flights to Tokyo drop under $600', 'ping me when the Warriors game starts', 'let me know whenever Sinisia emails me' → repeat=true). ONLY for things that must be watched over time. Never for one-off requests — do those directly.",
    parameters: obj(
      {
        goal: s("what to check and the exact condition that means done"),
        every_minutes: { type: "number", description: "how often to check (min 5)" },
        max_days: { type: "number", description: "give up after this many days (default 7)" },
        repeat: { type: "boolean", description: "keep watching and ping EVERY time it happens (\"whenever…\", \"every time…\"); false = stop after the first hit" },
      },
      ["goal", "every_minutes"],
    ),
    classify: (a) => ({ tier: 1, summary: `Start background task: ${str(a, "goal")}` }),
    async exec(a, _signal, ctx) {
      if (!ctx.startMonitor) return "Background tasks can't be created from inside another background task.";
      const every = Math.max(5, Number(a.every_minutes) || 60);
      const days = Math.min(30, Math.max(1, Number(a.max_days) || 7));
      ctx.startMonitor(str(a, "goal"), every, days, a.repeat === true);
      return `Background task created: checking every ${every} min for up to ${days} days${a.repeat === true ? ", pinging every time something new turns up" : ""}. Tell the user in one line that it's running and they'll get a notification.`;
    },
  },
  {
    name: "list_apps",
    description: "List the apps currently running on the Mac.",
    parameters: obj({}, []),
    classify: () => ({ tier: 0, summary: "See which apps are open" }),
    async exec() {
      const { stdout } = await run("osascript", ["-e", 'tell application "System Events" to get name of every process whose background only is false']);
      return stdout.trim();
    },
  },
  {
    name: "ui_tree",
    description:
      "Read the accessibility tree (windows, buttons, text fields, menus) of any running app so you can click/type in it with applescript + System Events. Works for apps that have no AppleScript support.",
    parameters: obj({ app: s("process name, e.g. Slack") }, ["app"]),
    classify: (a) => {
      const app = str(a, "app");
      if (looksFinancial(app)) return { tier: 3, scope: `finance:${app}`, summary: `Read the screen of ${app}` };
      return { tier: 0, summary: `Look at ${app}'s window` };
    },
    taints: true,
    async exec(a, signal) {
      const app = str(a, "app").replace(/"/g, "");
      const script = `tell application "System Events" to tell process "${app}"
  set out to ""
  repeat with w in windows
    set out to out & "WINDOW: " & (name of w as text) & linefeed
    try
      repeat with el in (entire contents of w)
        try
          set r to role of el
          set d to ""
          try
            set d to (description of el) as text
          end try
          set n to ""
          try
            set n to (name of el) as text
          end try
          set v to ""
          try
            set v to (value of el) as text
          end try
          if n is not "missing value" or v is not "" then set out to out & r & " | " & n & " | " & d & " | " & v & linefeed
        end try
      end repeat
    end try
  end repeat
  return out
end tell`;
      const { stdout } = await run("osascript", ["-e", script], { signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return clip(stdout.replace(/missing value/g, "").trim() || "No windows (is the app open, and does Marigold have Accessibility permission?)");
    },
  },
  {
    name: "applescript",
    description:
      "Control ANY Mac app via AppleScript (Mail, Messages, Calendar, Notes, Reminders, Finder, Safari, Music, System Events UI scripting, etc). Returns the script's result.",
    parameters: obj({ script: s("AppleScript source") }, ["script"]),
    classify: (a) => classifyAppleScript(str(a, "script")),
    taints: true,
    async exec(a, signal) {
      const { stdout, stderr } = await run("osascript", ["-e", str(a, "script")], { signal, timeout: 60_000 });
      return clip(stdout.trim() || stderr.trim() || "OK");
    },
  },
  {
    name: "run_shortcut",
    description:
      "Run an Apple Shortcut by name (Shortcuts sync to iPhone via iCloud — use for iPhone/HomeKit/Focus actions).",
    parameters: obj({ name: s("shortcut name"), input: s("optional text input") }, ["name"]),
    classify: (a) => {
      const n = str(a, "name");
      if (looksFinancial(n, str(a, "input"))) return { tier: 3, scope: `finance:shortcut:${n}`, summary: `Run Shortcut “${n}”` };
      return { tier: 2, scope: `shortcut:${n}`, summary: `Run Shortcut “${n}”` };
    },
    async exec(a, signal) {
      const args = ["run", str(a, "name")];
      const input = str(a, "input");
      if (input) {
        const f = path.join(os.tmpdir(), `marigold-sc-${Date.now()}.txt`);
        await fs.writeFile(f, input);
        args.push("-i", f);
      }
      const { stdout } = await run("shortcuts", args, { signal, timeout: 120_000 });
      return clip(stdout.trim() || "Shortcut finished.");
    },
  },
  {
    name: "files",
    description: "Manage files and folders on the Mac. Actions: search (by name, or content=true for text inside files; optional folder), info (size, dates, kind), copy (from → to), mkdir, rename (path → new name), zip (path → .zip next to it), unzip, disk_usage (biggest items in a folder), open (with its default app), reveal (show in Finder). For move/delete use move_path / trash_path.",
    parameters: obj({
      action: { type: "string", enum: ["search", "info", "copy", "mkdir", "rename", "zip", "unzip", "disk_usage", "open", "reveal"] },
      path: s("file or folder path (~ allowed)"),
      to: s("destination (copy) or new name (rename)"),
      query: s("search text"),
      folder: s("where to search (default ~)"),
      content: { type: "boolean", description: "search inside files instead of names" },
    }, ["action"]),
    classify: (a) => {
      const act = str(a, "action");
      const paths = [str(a, "path"), str(a, "to") && act === "copy" ? str(a, "to") : "", str(a, "folder")].filter(Boolean);
      const blocked = paths.map((p) => sensitivePath(p)).find(Boolean);
      const what = `${act} ${str(a, "path") || str(a, "query")}${str(a, "to") ? ` → ${str(a, "to")}` : ""}`.trim();
      return { tier: ["search", "info", "disk_usage", "reveal"].includes(act) ? 0 : 1, blocked, summary: `Files: ${what}` };
    },
    async exec(a, signal) {
      const act = str(a, "action");
      const p = str(a, "path") ? expandPath(str(a, "path")) : "";
      const exists = async (x: string) => fs.access(x).then(() => true, () => false);
      switch (act) {
        case "search": {
          const folder = expandPath(str(a, "folder") || "~");
          const q = str(a, "query");
          if (!q) return "FAILED: give query.";
          const args = a.content === true ? ["-onlyin", folder, q] : ["-onlyin", folder, "-name", q];
          const { stdout } = await run("mdfind", args, { signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
          const hits = stdout.split("\n").filter((l) => l && !sensitivePath(l)).slice(0, 50);
          return hits.length ? `${hits.length}${hits.length === 50 ? "+" : ""} found:\n${hits.map((h) => h.replace(os.homedir(), "~")).join("\n")}` : "Nothing found.";
        }
        case "info": {
          const st = await fs.stat(p);
          const { stdout: kind } = await run("mdls", ["-name", "kMDItemKind", "-raw", p]).catch(() => ({ stdout: "" }));
          let size = st.size;
          if (st.isDirectory()) size = Number((await run("du", ["-sk", p], { timeout: 30_000 })).stdout.split(/\s/)[0]) * 1024;
          return `${p.replace(os.homedir(), "~")}\nKind: ${kind || (st.isDirectory() ? "Folder" : "File")}\nSize: ${human(size)}\nModified: ${st.mtime.toLocaleString()}\nCreated: ${st.birthtime.toLocaleString()}`;
        }
        case "copy": {
          const to = expandPath(str(a, "to"));
          const dest = (await fs.stat(to).then((x) => x.isDirectory(), () => false)) ? path.join(to, path.basename(p)) : to;
          if (await exists(dest)) return `Refused: ${dest.replace(os.homedir(), "~")} already exists (won't overwrite).`;
          await fs.cp(p, dest, { recursive: true, errorOnExist: true });
          return `Copied to ${dest.replace(os.homedir(), "~")}`;
        }
        case "mkdir": await fs.mkdir(p, { recursive: true }); return `Created folder ${p.replace(os.homedir(), "~")}`;
        case "rename": {
          const name = str(a, "to");
          if (!name || name.includes("/")) return "FAILED: `to` must be just the new name (use move_path to move).";
          const dest = path.join(path.dirname(p), name);
          if (await exists(dest)) return `Refused: ${name} already exists there.`;
          await fs.rename(p, dest);
          return `Renamed to ${name}`;
        }
        case "zip": {
          const dest = `${p.replace(/\/$/, "")}.zip`;
          if (await exists(dest)) return `Refused: ${path.basename(dest)} already exists.`;
          await run("ditto", ["-c", "-k", "--keepParent", p, dest], { signal, timeout: 300_000 });
          return `Zipped to ${dest.replace(os.homedir(), "~")}`;
        }
        case "unzip": {
          const dest = p.replace(/\.zip$/i, "");
          if (await exists(dest)) return `Refused: ${path.basename(dest)} already exists.`;
          await run("ditto", ["-x", "-k", p, dest], { signal, timeout: 300_000 });
          return `Unzipped into ${dest.replace(os.homedir(), "~")}`;
        }
        case "disk_usage": {
          const folder = p || os.homedir();
          const { stdout } = await run("/bin/zsh", ["-c", `du -sk "${folder.replace(/"/g, "")}"/* 2>/dev/null | sort -rn | head -15`], { signal, timeout: 120_000 });
          return `Biggest items in ${folder.replace(os.homedir(), "~")}:\n${stdout.split("\n").filter(Boolean).map((l) => { const [k, ...n] = l.split("\t"); return `${human(Number(k) * 1024).padStart(9)}  ${n.join("").replace(os.homedir(), "~")}`; }).join("\n")}`;
        }
        case "open": await run("open", [p]); return `Opened ${path.basename(p)}`;
        case "reveal": await run("open", ["-R", p]); return `Showing ${path.basename(p)} in Finder`;
      }
      return "Unknown action.";
    },
  },
  {
    name: "run_shell",
    description: "Run a terminal (zsh) command on the Mac: dev work, scripts, git, npm/brew, system info, bulk file operations. Output is returned. Set visible=true to run it in a Terminal window the user can watch (output then stays in that window).",
    parameters: obj({
      command: s("shell command"),
      cwd: s("working directory (optional, default ~)"),
      visible: { type: "boolean", description: "run in a visible Terminal window instead of in the background" },
    }, ["command"]),
    classify: (a) => classifyShell(str(a, "command")),
    taints: true,
    async exec(a, signal) {
      const cwd = str(a, "cwd") ? expandPath(str(a, "cwd")) : os.homedir();
      if (a.visible === true) {
        const q = (t: string) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        await run("osascript", ["-e", `tell application "Terminal"
  activate
  do script "cd " & quoted form of "${q(cwd)}" & " && ${q(str(a, "command"))}"
end tell`]);
        return `Started in a Terminal window (in ${cwd}). Its output is shown there.`;
      }
      try {
        const { stdout, stderr } = await run("/bin/zsh", ["-lc", str(a, "command")], {
          cwd, signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
        });
        return clip([stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)");
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        return clip(`Exit error: ${e.stderr || e.stdout || e.message}`);
      }
    },
  },
  {
    name: "notify",
    description: "Show a macOS notification — ONLY when the user asks for one or for a reminder/alert. Never to report a result (the chat reply does that).",
    parameters: obj({ title: s("title"), message: s("body") }, ["title", "message"]),
    classify: () => ({ tier: 0, summary: "Show a notification" }),
    async exec(a) {
      const esc = (t: string) => t.replace(/["\\]/g, "\\$&");
      await run("osascript", ["-e", `display notification "${esc(str(a, "message"))}" with title "${esc(str(a, "title"))}"`]);
      return "Notified.";
    },
  },
];

/** Browser automation: on — in the Marigold Browser (built into the app; see electron/browser.cjs). */
export const BROWSER_AUTOMATION = true;
TOOLS.push(...CODE_TOOLS, appCapabilitiesTool, appActionsTool, financeTool, paymentTool, desktopTool, ...APP_TOOLS, ...(BROWSER_AUTOMATION ? [browserTool] : []), appUiTool, personInfoTool, memoryTool, gmailTool, gcalTool, gdriveTool, gdocsTool, gsheetsTool, gslidesTool, gtasksTool, gcontactsTool);

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Every tool, including the coding ones (coding mode picks its own set). */
export const allToolSchemas = () => TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** Ollama / OpenAI-style tool schema list. */
export const toolSchemas = (exclude: string[] = []) =>
  TOOLS.filter((t) => !exclude.includes(t.name) && !(CODE_TOOL_NAMES.has(t.name) && CODE_TOOLS.some((c) => c.name === t.name))).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
