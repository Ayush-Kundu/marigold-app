import type { NextRequest } from "next/server";
import { localOnly } from "@/lib/server/agent/guard";
import { getTask, pauseTask, steerTask, stopTask, subscribe } from "@/lib/server/agent/tasks";
import { acknowledgeMonitor, drainMonitor, pauseMonitor, runScheduledNow, steerMonitor, stopMonitor } from "@/lib/server/agent/monitors";

type Ctx = RouteContext<"/api/agent/tasks/[id]">;

/** Re-attach to a chat run's live event stream (replays everything so far). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const t = getTask((await ctx.params).id);
  if (!t) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(subscribe(t, req.signal), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}

/** POST {action: "ack"} → dismiss a finished background task. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { action, text } = await req.json().catch(() => ({}));
  const id = (await ctx.params).id;
  if (action === "steer") {
    if (typeof text !== "string" || !text.trim()) return Response.json({ error: "empty" }, { status: 400 });
    return Response.json({ ok: steerTask(id, text.trim()) || (await steerMonitor(id, text.trim())) });
  }
  if (action === "pause" || action === "resume") {
    const v = action === "pause";
    return Response.json({ ok: pauseTask(id, v) || (await pauseMonitor(id, v)) });
  }
  if (action === "runnow") return Response.json({ ok: await runScheduledNow(id) });
  if (action === "drain") return Response.json({ results: await drainMonitor(id) });
  if (action !== "ack") return Response.json({ error: "unknown action" }, { status: 400 });
  return Response.json({ ok: await acknowledgeMonitor((await ctx.params).id) });
}

/** Stop a chat run or a background task. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const id = (await ctx.params).id;
  return Response.json({ ok: stopTask(id) || (await stopMonitor(id)) });
}
