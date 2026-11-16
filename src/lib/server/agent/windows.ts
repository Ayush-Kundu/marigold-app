import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";
import { agentPageTitle } from "./apps";
import { helperBin, type HelperName } from "./helpers";

const execAsync = promisify(execFile);

const helper = (name: HelperName) => helperBin(name);

/** Apps the user opened in the Apps tab: the stream and the controls accept these as well as the apps the agent is using. */
const vg = globalThis as unknown as { __marigoldViewApps?: Set<string> };
const viewApps: Set<string> = (vg.__marigoldViewApps ??= new Set());
export const addViewApp = (app: string) => { viewApps.add(app.toLowerCase()); };
export const isViewApp = (app: string) => viewApps.has(app.toLowerCase());

export interface AppWindow { id: string; app: string; name: string; w: number; h: number }

/** On-screen (and other-Space) windows of these apps, front-most first. */
export async function windowsOf(apps: string[]): Promise<AppWindow[]> {
  const { stdout } = await execAsync(await helper("windows"), apps, { timeout: 5000 });
  return stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [id, app, w, h, name = ""] = l.split("\t");
    return { id, app, name, w: Number(w), h: Number(h) };
  });
}

/** The window the View shows for this app — for a browser, the one with the AGENT's page. */
export async function pickWindow(app: string): Promise<AppWindow | undefined> {
  const all = await windowsOf([app]).catch(() => []);
  const title = agentPageTitle();
  const byTitle = title ? all.find((w) => w.name.startsWith(title)) : undefined;
  if (byTitle) return byTitle;
  // Real document windows have a title; untitled ones are often hidden helper panels
  // (e.g. Calendar's 500×500 one). Prefer titled, then the biggest.
  return [...all].sort((a, b) => Number(!!b.name) - Number(!!a.name) || b.w * b.h - a.w * a.h)[0];
}

export async function appctl(args: string[]): Promise<string> {
  const { stdout } = await execAsync(await helper("appctl"), args, { timeout: 15_000 });
  return stdout.trim();
}

// ---------------------------------------------------------------- "user is in the app"
// When the user opens an app from the View ("Open app"), the agent must not grab that
// window or type into it until they leave it.
const g = globalThis as unknown as { __marigoldUserIn?: Map<string, number> };
const userIn: Map<string, number> = (g.__marigoldUserIn ??= new Map());

export function userEntered(app: string) { userIn.set(app.toLowerCase(), Date.now()); }

/** Wait (≤10 min) while the user is using `app` directly; returns once they've switched away. */
export async function waitForUser(app: string, signal?: AbortSignal): Promise<boolean> {
  const key = app.toLowerCase();
  if (!userIn.has(key)) return false;
  let waited = false;
  for (let i = 0; i < 1200 && !signal?.aborted; i++) {
    const front = await appctl(["front", app]).catch(() => "no");
    if (front !== "yes" && Date.now() - (userIn.get(key) ?? 0) > 3000) break; // they left it
    waited = true;
    await new Promise((r) => setTimeout(r, 500));
  }
  userIn.delete(key);
  return waited;
}

// ---------------------------------------------------------------- screen-recording permission

let permCache: { at: number; ok: boolean } | null = null;
/**
 * May Marigold capture windows? Checked WITHOUT triggering macOS's permission popup
 * (calling screencapture without permission pops the dialog every single time).
 */
export async function canRecordScreen(): Promise<boolean> {
  if (permCache && Date.now() - permCache.at < 15_000) return permCache.ok;
  const ok = (await execAsync(await helper("scperm"), [], { timeout: 3000 }).then((r) => r.stdout.trim() === "yes", () => false));
  permCache = { at: Date.now(), ok };
  return ok;
}
export const NO_SCREEN_PERMISSION = "Marigold needs Screen Recording permission to show apps here: System Settings → Privacy & Security → Screen Recording → turn on Marigold, then quit and reopen Marigold.";

// ---------------------------------------------------------------- keep the user where they are

/** Bundle id of the app the user is looking at right now. */
export async function frontBundle(): Promise<string> {
  try {
    const asn = (await execAsync("lsappinfo", ["front"], { timeout: 1500 })).stdout.trim();
    const out = (await execAsync("lsappinfo", ["info", "-only", "bundleid", asn], { timeout: 1500 })).stdout;
    return out.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? "";
  } catch { return ""; }
}

/**
 * Run an agent action without dragging the user along: if the action brought another app to the
 * front (menus and on-screen clicks need that for a moment), put the user's app back right after.
 * Skipped when the user deliberately went into that app ("Open app" in the View).
 */
export async function stayPut<T>(fn: () => Promise<T>): Promise<T> {
  const before = await frontBundle();
  try { return await fn(); } finally {
    if (before) {
      const after = await frontBundle();
      const userChose = [...userIn.entries()].some(([, at]) => Date.now() - at < 600_000);
      if (after && after !== before && !userChose) {
        // LaunchServices (no Apple Events permission needed). Some apps finish coming forward a
        // moment after the action returns, so check once more.
        await execAsync("open", ["-b", before], { timeout: 3000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
        if ((await frontBundle()) !== before) await execAsync("open", ["-b", before], { timeout: 3000 }).catch(() => {});
      }
    }
  }
}
