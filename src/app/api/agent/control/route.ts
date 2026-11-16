import { localOnly } from "@/lib/server/agent/guard";
import { activeApps, chatApps } from "@/lib/server/agent/loop";
import { audit } from "@/lib/server/agent/policy";
import { appctl, isViewApp, pickWindow, userEntered } from "@/lib/server/agent/windows";
import { isAgentBrowser, viewInput } from "@/lib/server/agent/browser";

/**
 * The USER operating an app through the View's live picture (not the agent — so no
 * approval prompts; it's the same as them clicking the app themselves).
 *
 * POST { chat, app, windowId?, action, nx, ny, dy, text, key, aspect }
 *   click/scroll (nx, ny = 0..1 position in the picture) · type · key · fit (aspect) · enter
 *
 * Limited to apps this chat's agent has been working in, and to localhost.
 */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  const app = String(b.app ?? "");
  const allowed = [...(typeof b.chat === "string" ? chatApps(b.chat) : []), ...activeApps()];
  if (!allowed.some((x) => x.toLowerCase() === app.toLowerCase()) && !isViewApp(app)) return Response.json({ error: "not an app in this View" }, { status: 404 });

  // Marigold Browser tile → input goes to the page itself (no desktop/occlusion limits).
  if (String(b.windowId ?? "") === "cdp" && isAgentBrowser(app)) {
    const r = await viewInput({ action: String(b.action), nx: Number(b.nx), ny: Number(b.ny), dy: Number(b.dy), text: String(b.text ?? "").slice(0, 2000), key: String(b.key ?? ""), aspect: Number(b.aspect) }).catch((e) => `ERR ${String(e).slice(0, 100)}`);
    return Response.json({ ok: r.startsWith("ok"), result: r });
  }
  const wid = String(b.windowId ?? "") || (await pickWindow(app))?.id;
  const num = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v)));
  let r = "";
  switch (b.action) {
    case "click":
      if (!wid) return Response.json({ error: "no window" }, { status: 404 });
      r = await appctl(["click", app, wid, String(num(b.nx, 0, 1)), String(num(b.ny, 0, 1))]);
      break;
    case "scroll":
      if (!wid) return Response.json({ error: "no window" }, { status: 404 });
      r = await appctl(["scroll", app, wid, String(num(b.nx, 0, 1)), String(num(b.ny, 0, 1)), String(Math.round(num(b.dy, -2000, 2000)))]);
      break;
    case "type":
      r = await appctl(["type", app, String(b.text ?? "").slice(0, 2000)]);
      break;
    case "key":
      r = await appctl(["key", app, String(b.key ?? "")]);
      break;
    case "fit":
      if (!wid) return Response.json({ error: "no window" }, { status: 404 });
      r = await appctl(["fit", app, wid, String(num(b.aspect, 0.3, 5))]);
      break;
    case "enter":
      if (!wid) return Response.json({ error: "no window" }, { status: 404 });
      userEntered(app); // the agent won't grab this window or type into it until the user leaves it
      r = await appctl(["enter", app, wid]);
      await audit({ event: "user_entered_app", app });
      break;
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
  return Response.json({ ok: r.startsWith("ok"), result: r });
}
