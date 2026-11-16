import { localOnly } from "@/lib/server/agent/guard";
import { fromApp, inApp } from "@/lib/server/agent/app-secret";

/**
 * Sign-in handoff. Magic links open in the user's browser, not the app: that page posts the
 * new session here, and the Mac app (the only holder of the secret) collects it within 3 min.
 */
const g = globalThis as unknown as { __marigoldHandoff?: { tokens: Record<string, string>; at: number } };

export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  if (!inApp()) return Response.json({ ok: false, reason: "not running in the Mac app" }, { status: 409 });
  const b = await req.json().catch(() => ({}));
  // Either a finished session (old-style link) or the email link's one-time token, which the
  // app redeems itself — so the session is created directly in the app.
  if (typeof b.token_hash === "string" && /^[\w-]{10,200}$/.test(b.token_hash)) {
    g.__marigoldHandoff = { tokens: { token_hash: b.token_hash, type: typeof b.type === "string" ? b.type.slice(0, 20) : "email" }, at: Date.now() };
    return Response.json({ ok: true });
  }
  if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string") return Response.json({ error: "tokens required" }, { status: 400 });
  g.__marigoldHandoff = { tokens: { access_token: b.access_token, refresh_token: b.refresh_token }, at: Date.now() };
  return Response.json({ ok: true });
}

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  if (!fromApp(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const h = g.__marigoldHandoff;
  g.__marigoldHandoff = undefined;
  if (!h || Date.now() - h.at > 180_000) return new Response(null, { status: 204 });
  return Response.json(h.tokens);
}
