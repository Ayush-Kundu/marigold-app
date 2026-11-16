import { localOnly } from "@/lib/server/agent/guard";
import { briefFromPage, ogImage, searchBrief, searchPeek, streamBrief, verticalSearch, webSearch } from "@/lib/server/agent/web-search";

/**
 * GET ?q=…&page=0      → results (web, news, videos, discussions, quick questions, images, knowledge card)
 * GET ?q=…&brief=1     → the AI brief (separate call, so results appear instantly)
 * GET ?peek=<url>&q=…  → a two-sentence look inside one result
 */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 300);
  const peek = u.searchParams.get("peek");
  if (peek) return Response.json({ peek: await searchPeek(peek, q).catch(() => null) });
  if (!q) return Response.json({ error: "q required" }, { status: 400 });
  const vertical = u.searchParams.get("vertical");
  if (vertical === "images" || vertical === "videos" || vertical === "shopping" || vertical === "books" || vertical === "scholar" || vertical === "news") return Response.json(await verticalSearch(q, vertical));
  const page = Math.max(0, Math.min(9, Number(u.searchParams.get("page")) || 0));
  const out = await webSearch(q, page);
  if (u.searchParams.get("brief") && u.searchParams.get("stream")) {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        const send = (e: unknown) => { try { c.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { /* the page went away */ } };
        try { await streamBrief(out, send); } catch { send({ type: "none" }); }
        try { c.close(); } catch { /* already closed */ }
      },
    }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (u.searchParams.get("brief")) return Response.json({ brief: await searchBrief(out).catch(() => null) });
  return Response.json(out);
}

/** POST { q, text, links } → the Brief for the results page the user is looking at (from the page's own text and links). */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  if (Array.isArray(b.thumbs)) { // preview pictures for results that came without one
    const urls = (b.thumbs as unknown[]).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 10);
    const got = await Promise.all(urls.map(async (u) => [u, await ogImage(u).catch(() => null)] as const));
    return Response.json(Object.fromEntries(got.filter(([, v]) => v)));
  }
  const q = typeof b.q === "string" ? b.q.trim().slice(0, 300) : "";
  if (!q) return Response.json({ error: "q required" }, { status: 400 });
  const links = (Array.isArray(b.links) ? b.links : []).filter((l: { text?: unknown; href?: unknown }) => typeof l?.text === "string" && typeof l?.href === "string").slice(0, 14) as { text: string; href: string }[];
  return Response.json(await briefFromPage(q, typeof b.text === "string" ? b.text.slice(0, 20_000) : "", links).catch(() => ({ brief: null, knowledge: null, sources: [] })));
}
