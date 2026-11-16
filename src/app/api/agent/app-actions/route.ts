import { localOnly } from "@/lib/server/agent/guard";
import { buildToolset, forgetToolset, listToolsets } from "@/lib/server/agent/app-actions";

/** GET → every app with ready-made actions. POST {app, force?} → build (or rebuild) one app's actions. DELETE {app} → forget them. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ apps: await listToolsets() });
}
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as { app?: string; force?: boolean };
  if (!b.app) return Response.json({ error: "Which app?" }, { status: 400 });
  const r = await buildToolset(String(b.app), b.force === true);
  return "error" in r ? Response.json({ error: r.error }, { status: 422 }) : Response.json(r);
}
export async function DELETE(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as { app?: string };
  if (b.app) await forgetToolset(String(b.app));
  return Response.json({ ok: true });
}
