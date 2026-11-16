import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { localOnly } from "@/lib/server/agent/guard";
import { activeApps, activeRunCount, chatApps } from "@/lib/server/agent/loop";
import { canRecordScreen, NO_SCREEN_PERMISSION, pickWindow, windowsOf } from "@/lib/server/agent/windows";
import { isAgentBrowser, viewShot } from "@/lib/server/agent/browser";

const execAsync = promisify(execFile);
/** Apps we've already tried to show a window for (don't keep re-opening ones the user closed). */
const openedAt: Map<string, number> = ((globalThis as { __marigoldOpenedAt?: Map<string, number> }).__marigoldOpenedAt ??= new Map());
const opened = { has: (a: string) => Date.now() - (openedAt.get(a) ?? 0) < 5 * 60_000, add: (a: string) => openedAt.set(a, Date.now()) };

/**
 * View tab picture-in-picture: ONLY the windows of apps the agent is working
 * in right now — never the whole screen. Served only while a run is active,
 * only to localhost.
 *   GET            → { apps: [{ app, visible }] }
 *   GET ?app=Notes → JPEG of that app's front window
 */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const params = new URL(req.url).searchParams;
  const chat = params.get("chat");
  // With ?chat=… : the apps THAT chat's agent is using or last used (kept after it finishes).
  const apps = chat ? chatApps(chat) : activeApps();
  if (!chat && activeRunCount() === 0 && apps.length === 0) return Response.json({ apps: [] }, { status: 409 });
  const want = params.get("app");

  if (!want) {
    let wins = apps.length ? await windowsOf(apps).catch(() => []) : [];
    // Apps driven by script often have no window (Reminders, Messages…). Open one
    // in the background (no focus steal) so there's something to watch.
    const hidden = apps.filter((a) => !wins.some((w) => w.app.toLowerCase() === a.toLowerCase()) && !opened.has(a));
    if (hidden.length) {
      hidden.forEach((a) => opened.add(a));
      await Promise.all(hidden.map((a) => execAsync("open", ["-g", "-a", a]).catch(() => {})));
      await new Promise((r) => setTimeout(r, 800));
      wins = await windowsOf(apps).catch(() => wins);
    }
    return Response.json({ apps: apps.map((app) => ({ app, visible: app === "Marigold Browser" || isAgentBrowser(app) || wins.some((w) => w.app.toLowerCase() === app.toLowerCase()) })) });
  }
  if (!apps.some((a) => a.toLowerCase() === want.toLowerCase())) return new Response("not an agent app", { status: 404 });

  // The Marigold Browser: picture straight from the page (no window corners, works anywhere).
  if (isAgentBrowser(want)) {
    const shot = await viewShot();
    if (shot) return new Response(new Uint8Array(shot.jpg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Window-Id": "cdp", "X-Window-Width": "0" } });
  }

  // No permission → say so; never call screencapture (that pops macOS's dialog on every try).
  if (!(await canRecordScreen())) return new Response(NO_SCREEN_PERMISSION, { status: 403 });
  // For a browser, the window with the page the AGENT is on — not e.g. a movie the user is watching.
  const win = await pickWindow(want);
  if (!win) return new Response("no window", { status: 404 });
  const file = path.join(os.tmpdir(), `marigold-win-${process.pid}-${win.id}.jpg`);
  try {
    await execAsync("screencapture", ["-x", "-o", "-l", win.id, "-t", "jpg", file], { timeout: 5000 });
    await execAsync("sips", ["-Z", "1920", "-s", "formatOptions", "60", file], { timeout: 5000 }).catch(() => {});
    // X-Window-Id lets the View send the user's clicks to exactly this window.
    return new Response(new Uint8Array(await fs.readFile(file)), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Window-Id": win.id, "X-Window-Width": String(win.w) } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/could not create image/i.test(msg)) {
      return new Response("macOS hasn't allowed screen recording yet. Open System Settings → Privacy & Security → Screen Recording, turn on Terminal, then restart Marigold from Terminal.", { status: 403 });
    }
    return new Response(`Couldn't capture ${want}: ${msg}`, { status: 500 });
  } finally {
    fs.unlink(file).catch(() => {});
  }
}
