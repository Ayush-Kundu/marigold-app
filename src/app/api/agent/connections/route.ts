import { localOnly } from "@/lib/server/agent/guard";
import { SERVICES, checkToken, getToken, isService, saveToken } from "@/lib/server/agent/connections";

/** GET → which websites are connected. POST { service, token } → check the token and keep it in the Keychain ({ token: "" } disconnects). */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const entries = await Promise.all(Object.entries(SERVICES).map(async ([id, v]) => ({ id, ...v, connected: !!(await getToken(id as keyof typeof SERVICES)) })));
  return Response.json({ services: entries });
}
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { service, token } = await req.json().catch(() => ({}));
  if (!isService(service) || typeof token !== "string") return Response.json({ error: "service and token required" }, { status: 400 });
  const t = token.trim();
  if (!t) { await saveToken(service, null); return Response.json({ ok: true, connected: false }); }
  if (t.length < 12 || t.length > 400 || /\s/.test(t)) return Response.json({ error: "That doesn't look like a token." }, { status: 400 });
  try { const who = await checkToken(service, t); await saveToken(service, t); return Response.json({ ok: true, connected: true, who }); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : "That token didn't work." }, { status: 400 }); }
}
