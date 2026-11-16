import { execFile } from "child_process";
import { promisify } from "util";
import type { ToolDef } from "./tools";
import { appctl, canRecordScreen, NO_SCREEN_PERMISSION, stayPut, windowsOf, type AppWindow } from "./windows";
import { minSize, need, tile, type Rect } from "./view-layout";

const exec = promisify(execFile);
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The part of the main screen windows may use (below the menu bar, clear of the Dock), in top-left coordinates. */
async function usableArea(): Promise<Rect> {
  const js = `ObjC.import('AppKit'); const sc = $.NSScreen.screens.objectAtIndex(0); const f = sc.frame, v = sc.visibleFrame;
    JSON.stringify({ x: v.origin.x, y: f.size.height - (v.origin.y + v.size.height), w: v.size.width, h: v.size.height })`;
  try {
    const r = JSON.parse((await exec("osascript", ["-l", "JavaScript", "-e", js], { timeout: 6000 })).stdout.trim()) as Rect;
    if (r.w > 400 && r.h > 300) return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  } catch { /* fall back below */ }
  return { x: 0, y: 30, w: 1440, h: 800 };
}

/** Apps with a window on screen right now (not background helpers). */
async function runningApps(): Promise<string[]> {
  try {
    const out = (await exec("osascript", ["-e", 'tell application "System Events" to get name of every process whose background only is false'], { timeout: 6000 })).stdout.trim();
    return out.split(",").map((x) => x.trim()).filter(Boolean);
  } catch { return []; }
}

/** One real window per app: titled, big enough to use, the largest of the app's windows. */
async function candidates(only?: string[]): Promise<AppWindow[]> {
  const names = only?.length ? only : (await runningApps()).filter((n) => n !== "Marigold" && n !== "Finder");
  if (!names.length) return [];
  const all = await windowsOf(names).catch(() => []);
  const best = new Map<string, AppWindow>();
  for (const w of all) {
    if (!w.name.trim() || w.w < 200 || w.h < 150) continue;
    const cur = best.get(w.app);
    if (!cur || w.w * w.h > cur.w * cur.h) best.set(w.app, w);
  }
  // keep the order windows are stacked in (front-most first)
  return all.filter((w) => best.get(w.app)?.id === w.id);
}

async function place(w: AppWindow, r: Rect): Promise<boolean> {
  const f = (n: number) => String(Math.round(n));
  const out = await appctl(["tile", w.app, w.id, f(r.x), f(r.y), f(r.w), f(r.h)]).catch(() => "ERR");
  return !out.startsWith("ERR");
}

export const desktopTool: ToolDef = {
  name: "desktop",
  description:
    "Tidy and arrange the windows on the user's desktop. action=windows lists what is open. action=tidy arranges the open apps' windows neatly in the free screen area (more room for editors and documents, less for small apps; Marigold's own window and Finder are left alone); pass apps=[names] to arrange only those, and mode: 'grid' (default, sized by need), 'columns' (side by side), 'focus' (the first app large on the left, the rest stacked on the right). Windows on other desktops (Spaces) can't be moved: say so. Moving windows changes nothing in the apps; there is no undo, so say what you arranged.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["windows", "tidy"] }, apps: { type: "array", items: { type: "string" } }, mode: { type: "string", enum: ["grid", "columns", "focus"] } }, required: ["action"] },
  classify: (a) => (s(a.action) === "tidy" ? { tier: 1, summary: `Arrange ${Array.isArray(a.apps) && a.apps.length ? (a.apps as string[]).join(", ") : "the open windows"} neatly` } : { tier: 0, summary: "See the open windows" }),
  taints: true, // window titles come from outside
  async exec(a) {
    if (!(await canRecordScreen())) return `FAILED: ${NO_SCREEN_PERMISSION}`;
    const only = Array.isArray(a.apps) ? (a.apps as unknown[]).map(String).filter(Boolean).slice(0, 8) : undefined;
    const list = await candidates(only);
    if (s(a.action) === "windows") return list.length ? list.map((w) => `${w.app}: “${w.name.slice(0, 60)}” (${w.w}×${w.h})`).join("\n") : "No app windows are open on this desktop.";
    if (s(a.action) !== "tidy") return "FAILED: action must be windows or tidy.";
    if (!list.length) return "Nothing to arrange: no app windows are open on this desktop.";
    const area = await usableArea();
    const mode = s(a.mode) === "columns" || s(a.mode) === "focus" ? s(a.mode) : "grid";
    const first = list.slice(0, 6);
    return stayPut(async () => {
      let items = first.map((w, i) => ({ app: w.app, weight: mode === "columns" ? 1 : mode === "focus" ? (i === 0 ? 3 : 1) : need(w.app) * (i === 0 ? 1.15 : 1) }));
      let placed = tile(items, area);
      // Don't make windows too small to use: drop the one that needs the least until the smallest is decent.
      while (items.length > 1 && placed.some((p) => p.rect.w < minSize(p.app).w || p.rect.h < minSize(p.app).h)) {
        items = [...items].sort((x, y) => y.weight - x.weight).slice(0, -1);
        placed = tile(items, area);
      }
      const moved: string[] = [], other: string[] = [];
      await Promise.all(placed.map(async (p) => { (await place(first.find((w) => w.app === p.app)!, p.rect)) ? moved.push(p.app) : other.push(p.app); }));
      const left = list.filter((w) => !placed.some((p) => p.app === w.app)).map((w) => w.app);
      return [
        moved.length ? `Arranged ${moved.join(", ")} neatly (${mode === "columns" ? "side by side" : mode === "focus" ? "one large, the rest stacked" : "sized by need"}).` : "Couldn't move any window.",
        other.length ? `Couldn't move ${other.join(", ")} (it may be on another desktop, full screen, or not resizable).` : "",
        left.length ? `Left as they are: ${left.join(", ")} (no room, or more than six windows).` : "",
      ].filter(Boolean).join(" ");
    });
  },
};
