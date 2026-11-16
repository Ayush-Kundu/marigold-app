import { localOnly } from "@/lib/server/agent/guard";
import { googleSearchConfigured, saveGoogleSearch, testGoogleSearch } from "@/lib/server/agent/web-search";

/** GET → { connected }. POST { key, cx } checks the pair with Google, then saves it ({ key: "" } removes it). */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ connected: await googleSearchConfigured() });
}
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { key, cx } = await req.json().catch(() => ({}));
  if (typeof key !== "string" || typeof cx !== "string") return Response.json({ error: "key and cx required" }, { status: 400 });
  if (!key.trim()) { await saveGoogleSearch(null); return Response.json({ ok: true, connected: false }); }
  if (!/^[\w-]{20,80}$/.test(key.trim()) || !/^[\w:.-]{6,80}$/.test(cx.trim())) return Response.json({ error: "That doesn't look like a Google API key and search engine ID." }, { status: 400 });
  const bad = await testGoogleSearch(key.trim(), cx.trim());
  if (bad) return Response.json({ error: `Google didn't accept them: ${bad}` }, { status: 400 });
  await saveGoogleSearch(key, cx);
  return Response.json({ ok: true, connected: true });
}
