import { localOnly } from "@/lib/server/agent/guard";
import { braveKey, saveBraveKey, saveTavilyKey, tavilyKey } from "@/lib/server/agent/summarize";

/** GET → { hasKey, provider }. POST { key } saves a Brave Search or Tavily API key in the Keychain ({ key: "" } removes both). */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const [b, t] = await Promise.all([braveKey(), tavilyKey()]);
  return Response.json({ hasKey: !!(b || t), provider: t ? "tavily" : b ? "brave" : null });
}
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { key } = await req.json().catch(() => ({}));
  if (typeof key !== "string") return Response.json({ error: "key required" }, { status: 400 });
  const k = key.trim();
  if (!k) { await Promise.all([saveBraveKey(null), saveTavilyKey(null)]); return Response.json({ ok: true, hasKey: false }); }
  if (!/^[\w-]{20,100}$/.test(k)) return Response.json({ error: "That doesn't look like a Brave Search or Tavily API key." }, { status: 400 });
  if (k.startsWith("tvly-")) {
    const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify({ query: "test", max_results: 1 }) }).catch(() => null);
    if (!r?.ok) return Response.json({ error: `Tavily didn't accept that key (${r?.status ?? "no answer"}).` }, { status: 400 });
    await saveTavilyKey(k);
    return Response.json({ ok: true, hasKey: true, provider: "tavily" });
  }
  const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", { headers: { Accept: "application/json", "X-Subscription-Token": k } }).catch(() => null);
  if (!r?.ok) return Response.json({ error: `Brave didn't accept that key (${r?.status ?? "no answer"}).` }, { status: 400 });
  await saveBraveKey(k);
  return Response.json({ ok: true, hasKey: true, provider: "brave" });
}
