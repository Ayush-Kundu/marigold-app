import { execFile } from "child_process";
import { existsSync, promises as fs, statSync } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

/**
 * What's on THIS Mac — so the agent knows which apps and command-line tools exist,
 * can map vague requests to the right app ("check my grades" → marks, an Education app),
 * and recognises app names (and nicknames) in a prompt.
 * Rebuilt when /Applications changes (checked every 2 min).
 */

const exec = promisify(execFile);
const DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "/System/Cryptexes/App/System/Applications", path.join(os.homedir(), "Applications")];

/** `proc` = the name the running app goes by ("Code" for Visual Studio Code, "iTerm2" for iTerm): windows and Accessibility find it by that. */
export interface AppInfo { name: string; kind: string; ios: boolean; path?: string; bundle?: string; proc?: string }

const CATEGORY: Record<string, string> = {
  business: "Business", "developer-tools": "Developer tools", education: "Education", entertainment: "Entertainment", finance: "Finance",
  games: "Games", "graphics-design": "Graphics & design", "healthcare-fitness": "Health & fitness", lifestyle: "Lifestyle", "medical": "Medical",
  music: "Music & audio", news: "News", photography: "Photo", productivity: "Productivity", reference: "Reference", "social-networking": "Social & messaging",
  sports: "Sports", travel: "Travel", utilities: "Utilities", video: "Video", weather: "Weather",
};
// Apple's own apps (no category in their Info.plist).
const APPLE: Record<string, string> = {
  Messages: "Social & messaging", FaceTime: "Social & messaging", Mail: "Productivity", Calendar: "Productivity", Notes: "Productivity", Reminders: "Productivity",
  Contacts: "Productivity", Freeform: "Productivity", Pages: "Productivity", Numbers: "Productivity", Keynote: "Productivity", Music: "Music & audio",
  Podcasts: "Music & audio", TV: "Video", Photos: "Photo", "Photo Booth": "Photo", Preview: "Utilities", Maps: "Travel", Weather: "Weather", Stocks: "Finance",
  News: "News", Books: "Reference", Clock: "Utilities", Calculator: "Utilities", "App Store": "Utilities", Safari: "Web browser", "System Settings": "Utilities",
  Finder: "Utilities", Terminal: "Developer tools", Xcode: "Developer tools", "Activity Monitor": "Utilities", "Voice Memos": "Music & audio", Home: "Utilities",
  Shortcuts: "Productivity", "Image Playground": "Graphics & design", GarageBand: "Music & audio", iMovie: "Video", Journal: "Lifestyle",
};
const GUESS: [RegExp, string][] = [
  [/chrome|firefox|edge|brave|opera|arc|vivaldi|comet/i, "Web browser"], [/code|cursor|xcode|terminal|iterm|python|github|docker|postman/i, "Developer tools"],
  [/zoom|teams|slack|discord|whatsapp|telegram|signal/i, "Social & messaging"], [/spotify|music|audio/i, "Music & audio"], [/steam|game|ea /i, "Games"],
  [/chatgpt|claude|gemini|perplexity/i, "AI assistant"], [/trade|bank|wallet|coin/i, "Finance"],
];

async function plist(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse((await exec("plutil", ["-convert", "json", "-o", "-", file], { timeout: 3000 })).stdout); } catch { return {}; }
}

async function describe(appPath: string, fallbackName: string): Promise<AppInfo> {
  const wrapper = path.join(appPath, "Wrapper");
  const ios = existsSync(wrapper);
  let name = fallbackName, kind = "", bundle = "", proc = "";
  if (ios) {
    // iPhone/iPad app on the Mac: genre lives in the App Store metadata.
    const meta = await plist(path.join(wrapper, "iTunesMetadata.plist"));
    kind = String(meta.genre ?? "");
    name = String(meta.itemName ?? fallbackName);
  } else {
    const info = await plist(path.join(appPath, "Contents", "Info.plist"));
    bundle = String(info.CFBundleIdentifier ?? "");
    proc = String(info.CFBundleDisplayName ?? info.CFBundleName ?? "");
    const cat = String(info.LSApplicationCategoryType ?? "").replace("public.app-category.", "");
    kind = CATEGORY[cat] ?? "";
  }
  if (!kind) kind = APPLE[fallbackName] ?? GUESS.find(([re]) => re.test(fallbackName))?.[1] ?? "Other";
  return { name: fallbackName, kind: ios ? `${kind} (iPhone/iPad app)` : kind, ios, path: appPath, bundle: bundle || undefined, proc: proc || undefined };
}

const g = globalThis as unknown as { __marigoldCatalog?: { at: number; stamp: string; apps: AppInfo[]; cli: string[] } };

function stamp(): string {
  return DIRS.map((d) => { try { return statSync(d).mtimeMs; } catch { return 0; } }).join(":");
}

const CLIS = ["git", "gh", "node", "npm", "npx", "pnpm", "yarn", "bun", "python3", "pip3", "brew", "ffmpeg", "yt-dlp", "ollama", "swift", "docker", "jq", "curl", "wget",
  "rg", "fd", "tree", "convert", "magick", "pandoc", "sqlite3", "code", "cursor", "java", "go", "cargo", "rustc", "ruby", "php", "make", "tmux", "htop", "brightness", "blueutil", "mas"];

export async function catalog(): Promise<{ apps: AppInfo[]; cli: string[] }> {
  const st = stamp();
  const c = g.__marigoldCatalog;
  if (c && c.stamp === st && Date.now() - c.at < 2 * 60_000) return c;
  const seen = new Map<string, string>();
  // Apps live directly in these folders AND inside vendor folders (Adobe, Microsoft, Setapp, games…): look two levels deep.
  const walk = async (dir: string, depth: number) => {
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (f.startsWith(".")) continue;
      const full = path.join(dir, f);
      if (f.endsWith(".app")) { if (!seen.has(f.slice(0, -4))) seen.set(f.slice(0, -4), full); }
      else if (depth > 0 && !/\.(framework|bundle|plugin|pkg|dmg|xpc)$/.test(f)) { const st = await fs.stat(full).catch(() => null); if (st?.isDirectory()) await walk(full, depth - 1); }
    }
  };
  for (const d of DIRS) await walk(d, d.startsWith("/System") ? 0 : 2);
  if (!seen.has("Finder") && existsSync("/System/Library/CoreServices/Finder.app")) seen.set("Finder", "/System/Library/CoreServices/Finder.app");
  const apps = (await Promise.all([...seen].map(([n, p]) => describe(p, n)))).sort((a, b) => a.name.localeCompare(b.name));
  const { stdout } = await exec("/bin/zsh", ["-lc", `for c in ${CLIS.join(" ")}; do command -v $c >/dev/null 2>&1 && echo $c; done`], { timeout: 8000 }).catch(() => ({ stdout: "" }));
  const cli = stdout.split("\n").filter(Boolean);
  g.__marigoldCatalog = { at: Date.now(), stamp: st, apps, cli };
  return g.__marigoldCatalog;
}

/** Compact block for the agent: every app grouped by kind + the command-line tools that exist. */
export async function catalogBlock(): Promise<string> {
  const { apps, cli } = await catalog();
  const by = new Map<string, string[]>();
  for (const a of apps) {
    if (/^(Utilities|Other)$/.test(a.kind) && /helper|uninstall|updater|installer|migration|bluetooth|boot camp|colorsync|directory|audio midi|disk utility|keychain|screenshot|system information|voiceover|grapher|console|print center|automator|script editor|font book|digital color|image capture|ticket viewer|feedback/i.test(a.name)) continue;
    const k = a.kind;
    by.set(k, [...(by.get(k) ?? []), a.name]);
  }
  const groups = [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n");
  return `APPS INSTALLED ON THIS MAC (by kind — use these exact names with app_ui / open_app):
${groups}
COMMAND-LINE TOOLS AVAILABLE: ${cli.join(", ") || "standard macOS only"}
- Vague request ("check my grades", "edit a photo", "take notes", "video call") → pick the installed app whose kind fits; prefer one the user has mentioned before. If two fit equally, pick the more likely and say which you used.
- Only suggest/run command-line tools from the list above (others aren't installed).`;
}

// ---------------------------------------------------------------- spotting app names in a prompt

const NICKNAMES: Record<string, string> = {
  "vs code": "Visual Studio Code", vscode: "Visual Studio Code", "vs-code": "Visual Studio Code", chrome: "Google Chrome", zoom: "zoom.us",
  settings: "System Settings", "system preferences": "System Settings", itunes: "Music", "apple music": "Music", imessage: "Messages", texts: "Messages",
  "word": "Microsoft Word", excel: "Microsoft Excel", powerpoint: "Microsoft PowerPoint", ppt: "Keynote", "app store": "App Store", "activity monitor": "Activity Monitor",
};

/** Installed apps named (or nicknamed) in the user's message. */
export async function appsMentioned(text: string): Promise<AppInfo[]> {
  const { apps } = await catalog();
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9.\s-]/g, " ")} `;
  const hits = new Map<string, AppInfo>();
  for (const a of apps) {
    const n = a.name.toLowerCase();
    if (n.length < 3 && n !== "tv") continue;
    if (new RegExp(`\\s${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`).test(t)) hits.set(a.name, a);
  }
  for (const [nick, real] of Object.entries(NICKNAMES)) {
    const a = apps.find((x) => x.name === real);
    if (a && t.includes(` ${nick} `)) hits.set(a.name, a);
  }
  // Common words that are also app names shouldn't trigger on their own.
  for (const w of ["Notes", "Clock", "Maps", "News", "Home", "Books", "Photos", "Music", "Mail", "Calendar", "Messages", "Contacts", "Weather", "Stocks", "Preview", "Shortcuts", "Journal", "Finder"]) {
    if (hits.has(w) && !new RegExp(`\\b(${w}|${w.replace(/s$/, "")}) app\\b|\\b(open|in|on|use|launch|my)\\s+${w}\\b`, "i").test(text)) hits.delete(w);
  }
  return [...hits.values()];
}


// ---------------------------------------------------------------- finding ONE app by whatever the user (or the model) called it

const norm = (t: string) => t.toLowerCase().replace(/\.app$/, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Resolve a name, nickname, bundle id or path to an installed app. Works for any Mac: exact name → nickname →
 * bundle id → prefix → whole-word match → "message names the app" → Spotlight.
 */
export async function resolveApp(query: string): Promise<{ app: AppInfo } | null> {
  const { apps } = await catalog();
  const raw = query.trim();
  if (!raw) return null;
  if (raw.endsWith(".app") && raw.includes("/")) {
    const hit = apps.find((a) => a.path === raw);
    return hit ? { app: hit } : existsSync(raw) ? { app: await describe(raw, path.basename(raw, ".app")) } : null;
  }
  const q = norm(raw);
  const byName = (f: (n: string) => boolean) => apps.filter((a) => f(norm(a.name)));
  let hit = apps.find((a) => norm(a.name) === q);
  if (hit) return { app: hit };
  const nick = Object.entries(NICKNAMES).find(([k]) => norm(k) === q)?.[1];
  if (nick) { hit = apps.find((a) => a.name === nick); if (hit) return { app: hit }; }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw)) { hit = apps.find((a) => a.bundle?.toLowerCase() === raw.toLowerCase()); if (hit) return { app: hit }; }
  // Starts with the query ("Photo" → Photos), else contains it as whole words ("Word" → Microsoft Word): the shortest name wins.
  for (const f of [(n: string) => n.startsWith(q), (n: string) => (" " + n + " ").includes(" " + q + " ")]) {
    const list = byName(f).sort((x, y) => x.name.length - y.name.length);
    if (list.length) return { app: list[0] };
  }
  // The query contains an app's whole name ("open the zoom app" / "Adobe Photoshop 2025 beta").
  const named = byName((n) => n.length >= 4 && (" " + q + " ").includes(" " + n + " ")).sort((x, y) => y.name.length - x.name.length);
  if (named.length) return { app: named[0] };
  // A typo or near-miss ("systm settings", "spotfy"): closest name within a couple of edits.
  const lev = (a: string, b: string) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  if (q.length >= 4) {
    const near = apps.map((a) => ({ a, d: lev(q, norm(a.name)) })).filter((x) => x.d <= Math.max(1, Math.floor(q.length / 5))).sort((x, y) => x.d - y.d);
    if (near.length) return { app: near[0].a };
  }
  // Spotlight knows apps in places we don't scan.
  try {
    const { stdout } = await exec("mdfind", [`kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "*${raw.replace(/["*\\]/g, "")}*"cd`], { timeout: 5000 });
    const p = stdout.split("\n").find((l) => l.endsWith(".app") && !l.includes(".app/") && !/^\/(System\/Library|Library)\//.test(l));
    if (p && (" " + norm(path.basename(p, ".app")) + " ").includes(" " + q + " ")) return { app: await describe(p, path.basename(p, ".app")) };
  } catch { /* no Spotlight */ }
  return null;
}
