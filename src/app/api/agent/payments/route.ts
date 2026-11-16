import { localOnly } from "@/lib/server/agent/guard";
import { addCard, loadMeta, removeCard, setFrozen, setLimit } from "@/lib/server/agent/payments";

/**
 * Saved payment methods (the Money window). Local only. No response ever contains a card number: just nickname, brand, last 4,
 * expiry, limit, whether use is frozen, and the recent uses (site, card, when).
 * POST {action: add_card | remove_card | limit | freeze | unfreeze}. A security code is refused.
 */
const view = async () => { const m = await loadMeta(); return { cards: m.cards, frozen: m.frozen, uses: m.uses.slice(0, 12) }; };

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json(await view(), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const act = String(b.action ?? "");
  if (act === "add_card") {
    const r = await addCard({ nickname: String(b.nickname ?? ""), number: String(b.number ?? ""), exp: String(b.exp ?? ""), name: String(b.name ?? ""), zip: String(b.zip ?? ""), maxPerPurchase: Number(b.maxPerPurchase) || undefined, cvv: b.cvv, cvc: b.cvc });
    return r.ok ? Response.json({ ...(await view()), added: r.card.id }) : Response.json({ error: r.error }, { status: 422 });
  }
  if (act === "remove_card") { await removeCard(String(b.id ?? "")); return Response.json(await view()); }
  if (act === "limit") { await setLimit(String(b.id ?? ""), Number(b.max) || 0); return Response.json(await view()); }
  if (act === "freeze") { await setFrozen(true, "mac"); return Response.json(await view()); }
  if (act === "unfreeze") { await setFrozen(false, "mac"); return Response.json(await view()); }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
