import { localOnly } from "@/lib/server/agent/guard";
import { askMoney, clearFinance, flipAccount, importStatement, loadFinance, saveFinance, setCategory, subscriptions, summarize, search, type Period } from "@/lib/server/agent/finance";

/**
 * Money (read-only). GET ?view=overview|subs|txns → what the Money window shows.
 * POST {action: import|ask|ai|budget|flip|category|clear}. Local only. Nothing here can move money.
 */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const u = new URL(req.url);
  const db = await loadFinance();
  const period = (u.searchParams.get("period") ?? "last_30") as Period;
  const base = { has: db.txns.length > 0, aiOk: db.aiOk, accounts: db.accounts, budgets: db.budgets };
  const view = u.searchParams.get("view") ?? "overview";
  if (view === "subs") return Response.json({ ...base, subs: subscriptions(db) });
  if (view === "txns") return Response.json({ ...base, txns: search(db, { text: u.searchParams.get("q") ?? "", cat: u.searchParams.get("cat") ?? "", limit: 60 }) });
  return Response.json({ ...base, summary: db.txns.length ? summarize(db, period) : null, subs: subscriptions(db).slice(0, 5) });
}

export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const act = String(b.action ?? "");
  if (act === "import") {
    const text = String(b.text ?? "");
    if (!text || text.length > 20_000_000) return Response.json({ error: "Empty or too large a file." }, { status: 400 });
    const r = await importStatement(String(b.name ?? "statement"), text, b.account ? String(b.account) : undefined);
    return Response.json(r, { status: r.ok ? 200 : 422 });
  }
  if (act === "ask") {
    const r = await askMoney(String(b.question ?? ""));
    return Response.json(r, { status: r.error ? 422 : 200 });
  }
  const db = await loadFinance();
  if (act === "ai") { db.aiOk = b.on === true; await saveFinance(db); return Response.json({ aiOk: db.aiOk }); }
  if (act === "budget") {
    const c = String(b.category ?? ""), n = Number(b.amount);
    if (!c) return Response.json({ error: "category" }, { status: 400 });
    if (n > 0) db.budgets[c] = n; else delete db.budgets[c];
    await saveFinance(db);
    return Response.json({ budgets: db.budgets });
  }
  if (act === "flip") { await flipAccount(String(b.account ?? "")); return Response.json({ ok: true }); }
  if (act === "category") { await setCategory(String(b.merchant ?? ""), String(b.cat ?? "Other")); return Response.json({ ok: true }); }
  if (act === "clear") { await clearFinance(); return Response.json({ ok: true }); }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
