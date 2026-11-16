import { localOnly } from "@/lib/server/agent/guard";
import { clearPings, listPings, markRead, pingPrefs, savePingPrefs, ping, type PingPrefs } from "@/lib/server/agent/notifications";

/** GET ?after=<id> → new pings since that one (the Mac app polls this); no `after` → latest 100 + prefs. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const after = new URL(req.url).searchParams.get("after") ?? undefined;
  if (after !== undefined) return Response.json({ pings: listPings(after || undefined) });
  return Response.json({ pings: listPings(), prefs: pingPrefs() });
}

/** POST { action: "read", ids? } | { action: "clear" } | { action: "prefs", prefs } | { action: "test" } | { action: "check" } */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  switch (b.action) {
    case "read": await markRead(Array.isArray(b.ids) ? b.ids : "all"); break;
    case "clear": await clearPings(); break;
    case "prefs": return Response.json({ prefs: await savePingPrefs((b.prefs ?? {}) as Partial<PingPrefs>) });
    case "test": {
      // { kind?, title?, body? } lets the pacing rules be exercised; plain "test" is the Settings button.
      const kind = ["task", "messages", "email", "reminders", "monitor", "calendar", "needs_you", "briefing", "battery"].includes(b.kind) ? b.kind : "task";
      await ping({ kind, title: String(b.title ?? "Notifications are on").slice(0, 80), body: String(b.body ?? "This is what a Marigold ping looks like."), key: b.key ? String(b.key) : undefined, urgent: kind === "briefing" || kind === "calendar" });
      break;
    }
    case "check": { const { tick } = await import("@/lib/server/agent/watcher"); await tick(true); break; }
    case "briefing": {
      const slot = ["morning", "afternoon", "evening"].includes(b.slot) ? b.slot : "morning";
      const { runBriefing } = await import("@/lib/server/agent/watcher");
      await runBriefing(slot, `brief:manual:${Date.now()}`);
      break;
    }
    default: return Response.json({ error: "unknown action" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
