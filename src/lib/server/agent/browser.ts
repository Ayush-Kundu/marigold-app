import os from "os";
import path from "path";
import { existsSync, promises as fs } from "fs";
import type { BrowserContext, Page } from "playwright-core";
import { MARIGOLD_DIR } from "./policy";

/**
 * The Marigold Browser: real Google Chrome driven through the DevTools protocol
 * (Playwright), with ONE PROFILE PER EMAIL ACCOUNT of the user.
 *
 *  • The user signs in once per account (Settings → Email accounts → Sign in, email
 *    pre-filled); the profile keeps that login, so browser tasks act as that account and
 *    "Sign in with Google" on other sites is one click.
 *  • Primary account unless the user explicitly names another.
 *  • Private pipe (no network port); doesn't disguise that it's automated.
 *  • Works on the page itself — clicks, typing, reading — even when covered or on another
 *    desktop, and never moves the user's mouse or keyboard.
 */

export const DOWNLOADS = path.join(os.homedir(), "Downloads");
const PROFILES = path.join(MARIGOLD_DIR, "browser-profiles");
const LEGACY_PROFILE = path.join(MARIGOLD_DIR, "browser-profile");
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
];

interface Session { ctx?: BrowserContext; starting?: Promise<BrowserContext>; page?: Page }
interface State { sessions: Map<string, Session>; current: string; lastDownload?: string }
const g = globalThis as unknown as { __marigoldBrowser2?: State };
const st: State = (g.__marigoldBrowser2 ??= { sessions: new Map(), current: "" });

const keyFor = (email?: string) => (email ?? "").trim().toLowerCase() || "default";

/** Which account the next browser actions use (primary unless the user named another). */
export function selectAccount(email?: string) { st.current = keyFor(email); }
export const currentAccount = () => st.current;

export const browserRunning = () => [...st.sessions.values()].some((s) => s.ctx);

export async function context(email?: string): Promise<BrowserContext> {
  const key = email ? keyFor(email) : st.current || "default";
  const s = st.sessions.get(key) ?? {};
  st.sessions.set(key, s);
  if (s.ctx) return s.ctx;
  if (s.starting) return s.starting;
  s.starting = (async () => {
    const { chromium } = await import("playwright-core");
    const exe = CHROME_PATHS.find((p) => existsSync(p));
    if (!exe) throw new Error("Google Chrome isn't installed (needed for the Marigold Browser).");
    const dir = key === "default" ? LEGACY_PROFILE : path.join(PROFILES, key);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const ctx = await chromium.launchPersistentContext(dir, {
      executablePath: exe,
      headless: false,
      viewport: null,
      acceptDownloads: true,
      downloadsPath: DOWNLOADS,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--window-size=1280,860", "--no-first-run", "--no-default-browser-check", "--disable-features=CalculateNativeWinOcclusion"],
    });
    ctx.on("close", () => { s.ctx = undefined; s.page = undefined; });
    ctx.on("page", (p) => { s.page = p; watchDownloads(p); });
    ctx.pages().forEach(watchDownloads);
    s.ctx = ctx;
    return ctx;
  })().finally(() => { s.starting = undefined; });
  return s.starting;
}

function watchDownloads(p: Page) {
  p.on("download", async (d) => {
    const dest = path.join(DOWNLOADS, d.suggestedFilename());
    await d.saveAs(dest).catch(() => {});
    st.lastDownload = dest;
  });
}
export const lastDownload = () => st.lastDownload;

const session = () => st.sessions.get(st.current || "default");

/** The tab the agent is working in, for the current account (opens one if needed). */
export async function page(): Promise<Page> {
  const ctx = await context();
  const s = session()!;
  if (s.page && !s.page.isClosed()) return s.page;
  s.page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
  return s.page;
}

export async function setPage(p: Page) {
  const s = session();
  if (s) s.page = p;
  await p.bringToFront().catch(() => {});
}

export async function tabs(): Promise<Page[]> {
  return (await context()).pages().filter((p) => !p.isClosed());
}

export async function agentTitle(): Promise<string> {
  const p = session()?.page;
  if (!p || p.isClosed()) return "";
  return p.title().catch(() => "");
}

/** Wait for the page to settle after an action (network quiet or 6s, whichever first). */
export async function settle(p: Page, ms = 6000) {
  await Promise.race([
    p.waitForLoadState("domcontentloaded").then(() => p.waitForLoadState("networkidle", { timeout: ms }).catch(() => {})),
    new Promise((r) => setTimeout(r, ms)),
  ]).catch(() => {});
}

// ---------------------------------------------------------------- View tab (live picture + user control)

const BROWSER_APPS = new Set(["google chrome", "chromium", "microsoft edge", "brave browser"]);
export const isAgentBrowser = (app: string) => !!session()?.ctx && BROWSER_APPS.has(app.toLowerCase());

export async function viewShot(): Promise<{ jpg: Buffer; width: number } | null> {
  if (!session()?.ctx) return null;
  const p = await page();
  const jpg = await p.screenshot({ type: "jpeg", quality: 62, scale: "css", timeout: 5000, animations: "allow", caret: "initial" }).catch(() => null);
  if (!jpg) return null;
  const width = await p.evaluate(() => innerWidth).catch(() => 0);
  return { jpg, width };
}

export async function viewInput(b: { action: string; nx?: number; ny?: number; dy?: number; text?: string; key?: string; aspect?: number }): Promise<string> {
  const p = await page();
  const [vw, vh] = await p.evaluate(() => [innerWidth, innerHeight]);
  const x = (b.nx ?? 0.5) * vw, y = (b.ny ?? 0.5) * vh;
  const KEY: Record<string, string> = { enter: "Enter", tab: "Tab", escape: "Escape", backspace: "Backspace", delete: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
  switch (b.action) {
    case "click": await p.mouse.click(x, y); return "ok";
    case "scroll": await p.mouse.move(x, y); await p.mouse.wheel(0, -(b.dy ?? -120)); return "ok";
    case "type": await p.keyboard.type(b.text ?? ""); return "ok";
    case "key": await p.keyboard.press(KEY[b.key ?? ""] ?? b.key ?? "Enter"); return "ok";
    case "fit": {
      const cdp = await p.context().newCDPSession(p);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      const area = Math.max(vw * vh, 1100 * 720);
      const w = Math.round(Math.sqrt(area * (b.aspect ?? 1.6))), h = Math.round(w / (b.aspect ?? 1.6)) + 88;
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: Math.min(w, 2400), height: Math.min(h, 1500), windowState: "normal" } });
      await cdp.detach().catch(() => {});
      return "ok";
    }
  }
  return "ERR unknown action";
}
