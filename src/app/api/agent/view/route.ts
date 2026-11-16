import { execFile } from "child_process";
import { promisify } from "util";
import { localOnly } from "@/lib/server/agent/guard";
import { chatApps } from "@/lib/server/agent/loop";
import { catalog } from "@/lib/server/agent/catalog";
import { ensureHowTo } from "@/lib/server/agent/app-knowledge";
import { appctl, pickWindow, type AppWindow } from "@/lib/server/agent/windows";
import { minSize, need, tile, type Rect } from "@/lib/server/agent/view-layout";

const execAsync = promisify(execFile);

async function place(app: string, win: AppWindow, r: Rect): Promise<string> {
  const f = (n: number) => String(Math.round(n));
  const out = await appctl(["tile", app, win.id, f(r.x), f(r.y), f(r.w), f(r.h)]).catch((e) => `ERR ${String(e).slice(0, 80)}`);
  if (out.startsWith("ERR")) return out.includes("otherspace") ? "otherspace" : out;
  // A window that can't be resized (Calculator…) keeps its size: centre it in its share instead of leaving it in a corner.
  const m = out.match(/(\d+)x(\d+)/);
  if (m) {
    const aw = Number(m[1]), ah = Number(m[2]);
    if (aw < r.w - 10 || ah < r.h - 10) await appctl(["tile", app, win.id, f(r.x + Math.max(0, (r.w - aw) / 2)), f(r.y + Math.max(0, (r.h - ah) / 2)), f(aw), f(ah)]).catch(() => {});
  }
  return "ok";
}

/**
 * Side-by-side view: lay the windows of the apps the agent is using into the area beside Marigold.
 *   POST { chat, area: {x,y,w,h} } → { ok, apps: [{ app, status }] }
 * One app fills the area; several share it, each getting room in proportion to what it needs (documents and
 * editors get more, a calculator or chat window less). Only apps this chat's agent used are touched.
 */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as { chat?: string; area?: Rect; app?: string; apps?: unknown };
  const { chat, area } = b;
  // Pre-launch: start the apps right away (the click) while the window is still sliding into place, so they are ready when it is.
  if ((b as { launchOnly?: boolean }).launchOnly) {
    const have = new Map((await catalog()).apps.map((a) => [a.name.toLowerCase(), a]));
    const names = (Array.isArray(b.apps) ? b.apps : []).map((x) => have.get(String(x).toLowerCase())).filter((a): a is NonNullable<typeof a> => !!a && a.name !== "Marigold").slice(0, 4);
    void import("@/lib/server/agent/app-actions").then((m) => m.autoLearn(names.map((a) => a.name))).catch(() => {});
    await Promise.all(names.map((a) => execAsync("open", ["-g", "-a", a.name]).catch(() => {})));
    return Response.json({ ok: true });
  }
  if (!area || ![area.x, area.y, area.w, area.h].every((n) => typeof n === "number" && Number.isFinite(n)) || area.w < 200 || area.h < 200) return Response.json({ error: "bad request" }, { status: 400 });
  // The apps the user picked (checked against what is installed, so nothing else can be launched), else the ones the agent has used.
  // `app` is the name the RUNNING app goes by (windows and Accessibility find it by that); `launch` is what to open.
  let used: { app: string; launch: string }[] = [];
  if (Array.isArray(b.apps) && b.apps.length) {
    const have = new Map((await catalog()).apps.map((a) => [a.name.toLowerCase(), a]));
    const seen = new Set<string>();
    for (const x of b.apps) {
      const a = have.get(String(x).toLowerCase());
      if (a && a.name !== "Marigold" && !seen.has(a.name)) { seen.add(a.name); used.push({ app: a.proc ?? a.name, launch: a.name }); }
    }
    used = used.slice(0, 4);
  } else if (chat) used = chatApps(chat).filter((a) => a !== "Marigold Browser").slice(0, 4).map((a) => ({ app: a, launch: a }));
  if (!used.length) return Response.json({ error: "no apps yet" }, { status: 404 });
  for (const a of used) void ensureHowTo(a.launch); // each app gets its own written guide, ready for the first request

  // All apps at once: start them together, then find their windows together.
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const found = await Promise.all(used.map(async (t) => {
    let win = await pickWindow(t.app);
    if (!win) { // not open (or no window yet): open it without taking focus, and wait for a window
      await execAsync("open", ["-g", "-a", t.launch]).catch(() => {});
      for (let i = 0; i < 14 && !win; i++) {
        await pause(250);
        win = await pickWindow(t.app);
        if (i === 8 && !win) await execAsync("open", ["-a", t.launch]).catch(() => {}); // still none: a plain open asks the app to show a window
      }
    }
    return { t, win };
  }));
  const missing = found.filter((x) => !x.win).map((x) => ({ app: x.t.app, status: "nowindow" }));
  const wins = found.filter((x): x is { t: { app: string; launch: string }; win: AppWindow } => !!x.win).map((x) => ({ app: x.t.app, win: x.win }));
  if (!wins.length) return Response.json({ ok: false, apps: missing });

  // Room each one wants: its kind, its current size, and a little extra for the one in use right now.
  let items = wins.map(({ app, win }, i) => ({ app, weight: need(app) * Math.pow(Math.max(win.w * win.h, 120_000) / 700_000, 0.3) * (i === 0 ? 1.25 : 1) }));
  // Don't make windows too small to use: drop the app that needs the least until the smallest tile is decent.
  let placed = tile(items, area);
  while (items.length > 1 && placed.some((p) => p.rect.w < minSize(p.app).w || p.rect.h < minSize(p.app).h)) {
    items = [...items].sort((a, c) => c.weight - a.weight).slice(0, -1);
    placed = tile(items, area);
  }
  const results: { app: string; status: string }[] = await Promise.all(placed.map(async (p) => ({ app: p.app, status: await place(p.app, wins.find((w) => w.app === p.app)!.win, p.rect) })));
  const skipped = wins.filter((w) => !placed.some((p) => p.app === w.app)).map((w) => ({ app: w.app, status: "skipped" })); // no room for it
  const all = [...results, ...skipped, ...missing];
  return Response.json({ ok: results.some((r) => r.status === "ok"), apps: all });
}
