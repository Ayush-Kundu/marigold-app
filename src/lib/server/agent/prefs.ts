import { execFile } from "child_process";
import { existsSync, readFileSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { BROWSERS, browserById, type BrowserInfo } from "@/lib/browsers";
import { MARIGOLD_DIR } from "./policy";

const execAsync = promisify(execFile);
const FILE = path.join(MARIGOLD_DIR, "prefs.json");

export interface Prefs {
  browser?: string;
  /** The user's email accounts (primary = their Marigold login). See accounts.ts. */
  emails?: { address: string; primary: boolean; provider: "google" | "microsoft" | "microsoft-work" | "yahoo" | "icloud" | "other" }[];
}

let cache: Prefs | null = null;
export function prefs(): Prefs {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = {}; }
  return cache!;
}

export async function setPrefs(p: Prefs) {
  cache = { ...prefs(), ...p };
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export function installedBrowsers(): BrowserInfo[] {
  return BROWSERS.filter((b) =>
    [path.join("/Applications", `${b.app}.app`), path.join(os.homedir(), "Applications", `${b.app}.app`), `/System/Volumes/Preboot/Cryptexes/App/System/Applications/${b.app}.app`]
      .some((p) => existsSync(p)));
}

const BUNDLE: Record<string, string> = {
  "com.apple.safari": "safari", "com.google.chrome": "chrome", "company.thebrowser.browser": "arc",
  "com.microsoft.edgemac": "edge", "com.brave.browser": "brave", "org.mozilla.firefox": "firefox",
  "com.operasoftware.opera": "opera", "com.operasoftware.operagx": "opera-gx", "com.vivaldi.vivaldi": "vivaldi",
  "org.chromium.chromium": "chromium", "com.kagi.kagimacos": "orion", "com.duckduckgo.macos.browser": "duckduckgo",
  "app.zen-browser.zen": "zen", "org.torproject.torbrowser": "tor",
};

/** The Mac's default web browser (from Launch Services). */
export async function systemDefaultBrowser(): Promise<BrowserInfo | undefined> {
  try {
    const { stdout } = await execAsync("defaults", ["read", path.join(os.homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure"), "LSHandlers"]);
    const m = stdout.match(/LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https;/) ?? stdout.match(/LSHandlerURLScheme = https;[^}]*LSHandlerRoleAll = "([^"]+)"/);
    return browserById(BUNDLE[m?.[1]?.toLowerCase() ?? ""]);
  } catch { return undefined; }
}

/** The browser the agent should use: the user's pick, else the Mac default, else Safari. */
export async function mainBrowser(): Promise<BrowserInfo> {
  return browserById(prefs().browser) ?? (await systemDefaultBrowser()) ?? BROWSERS[0];
}
// Mac default, looked up once in the background so the sync version can use it too.
let sysDefault: BrowserInfo | undefined;
void systemDefaultBrowser().then((b) => { sysDefault = b; });
export const mainBrowserSync = (): BrowserInfo => browserById(prefs().browser) ?? sysDefault ?? BROWSERS[0];
