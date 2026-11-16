"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, Snowflake, Upload, Wallet, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

interface Summary {
  label: string; from: string; to: string; spent: number; income: number; net: number; count: number;
  byCategory: { cat: string; amount: number; pct: number; budget?: number; over?: boolean }[];
  topMerchants: { merchant: string; amount: number; count: number }[];
  vsBefore: { spent: number; change: number } | null;
  unusual: { date: string; merchant: string; amount: number; why: string }[];
  months: { month: string; spent: number; income: number }[];
}
interface Sub { merchant: string; amount: number; every: string; last: string; perYear: number }
interface Txn { id: string; date: string; amount: number; merchant: string; cat: string; account: string }
interface Overview { has: boolean; aiOk: boolean; accounts: Record<string, { flip: boolean; count: number }>; budgets: Record<string, number>; summary?: Summary | null; subs?: Sub[]; txns?: Txn[] }

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const PERIODS = [["this_month", "This month"], ["last_month", "Last month"], ["last_30", "30 days"], ["last_90", "90 days"], ["year", "This year"]] as const;
const TABS = [["overview", "Overview"], ["subs", "Subscriptions"], ["txns", "Transactions"], ["ask", "Ask"], ["pay", "Cards & wallets"]] as const;
const post = (b: Record<string, unknown>) => fetch("/api/agent/finance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) })).catch(() => ({ ok: false, error: "Couldn't reach Marigold." }) as { ok: boolean; error?: string });

export const openMoney = (tab?: string) => window.dispatchEvent(new CustomEvent("mg-open-money", { detail: { tab } }));

/** Mounted once (in the sidebar): opens the Money window when something asks for it. */
export function MoneyHost() {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState<string | undefined>();
  useEffect(() => { const f = (e: Event) => { setFirst((e as CustomEvent<{ tab?: string }>).detail?.tab); setOpen(true); }; window.addEventListener("mg-open-money", f); return () => window.removeEventListener("mg-open-money", f); }, []);
  return open ? <MoneyWindow onClose={() => setOpen(false)} first={first} /> : null;
}

function MoneyWindow({ onClose, first }: { onClose: () => void; first?: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(TABS.some(([id]) => id === first) ? (first as (typeof TABS)[number][0]) : "overview");
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>("this_month");
  const [d, setD] = useState<Overview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [ask, setAsk] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const view = tab === "subs" ? "subs" : tab === "txns" ? "txns" : "overview";
    const j = await fetch(`/api/agent/finance?view=${view}&period=${period}&q=${encodeURIComponent(q)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (j) setD(j);
  }, [tab, period, q]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch, then set
  useEffect(() => { void load(); }, [load]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setNote("");
    const msgs: string[] = [];
    for (const f of Array.from(files).slice(0, 12)) {
      const r = await post({ action: "import", name: f.name, text: await f.text() });
      msgs.push(r.ok ? `${f.name}: ${(r as { added?: number }).added} new${(r as { duplicates?: number }).duplicates ? `, ${(r as { duplicates?: number }).duplicates} already there` : ""}.` : `${f.name}: ${(r as { error?: string }).error}`);
    }
    setBusy(false); setNote(msgs.join(" ")); void load();
  };
  const flip = async (account: string) => { await post({ action: "flip", account }); void load(); };
  const setAi = async (on: boolean) => { await post({ action: "ai", on }); void load(); };
  const [editing, setEditing] = useState<{ cat: string; v: string } | null>(null);
  const [sure, setSure] = useState(false);
  const saveBudget = async () => {
    if (!editing) return;
    await post({ action: "budget", category: editing.cat, amount: Number(editing.v) || 0 });
    setEditing(null); void load();
  };
  const doAsk = async (text: string) => {
    if (!text.trim()) return;
    setAsking(true); setAnswer(""); setAsk(text);
    const r = await post({ action: "ask", question: text }) as { answer?: string; error?: string };
    setAsking(false); setAnswer(r.answer ?? r.error ?? "No answer.");
  };

  const s = d?.summary;
  const dropZone = (
    <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }} onClick={() => file.current?.click()} className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center hover:bg-surface-hover">
      {busy ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} className="text-muted" />}
      <p className="text-[13px] font-medium">{d?.has ? "Add another statement" : "Drop a bank or card statement here"}</p>
      <p className="max-w-sm text-[11.5px] text-muted">Download a CSV or OFX/QFX file from your bank&apos;s website or app (look for Download or Export under Activity). Marigold reads it on this Mac. It never asks for your bank login and can&apos;t move money.</p>
      <input ref={file} type="file" multiple accept=".csv,.ofx,.qfx,.txt" className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
    </div>
  );

  return (
    <Modal onClose={onClose} className="h-[80dvh] max-w-3xl">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Wallet size={16} />
        <p className="text-[14px] font-semibold">Money</p>
        <nav className="ml-3 flex gap-0.5 rounded-lg bg-surface p-0.5" role="tablist">
          {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("rounded-md px-2.5 py-1 text-[12.5px]", tab === id ? "bg-background font-medium shadow-sm" : "text-muted hover:text-foreground")}>{label}</button>)}
        </nav>
        <button onClick={onClose} aria-label="Close" className="ml-auto text-muted hover:text-foreground"><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {note && <p className="rounded-lg bg-accent-soft px-3 py-2 text-[12px]">{note}</p>}
        {d && !d.has && tab !== "pay" && dropZone}
        {d?.has && Object.entries(d.accounts).filter(([, a]) => a.flip).map(([name]) => (
          <p key={name} className="rounded-lg border border-border px-3 py-2 text-[11.5px] text-muted">Marigold read purchases in <b>{name}</b> as positive numbers (some card exports do). If the totals look backwards, <button onClick={() => void flip(name)} className="text-accent underline">flip it</button>.</p>
        ))}

        {d?.has && tab === "overview" && s && (
          <>
            <div className="flex flex-wrap gap-1">{PERIODS.map(([id, label]) => <button key={id} onClick={() => setPeriod(id)} className={cn("h-7 rounded-lg px-2.5 text-[12px]", period === id ? "bg-accent/20 font-medium" : "text-muted hover:bg-surface-hover")}>{label}</button>)}</div>
            <div className="grid grid-cols-3 gap-2">
              {[["Spent", money(s.spent), s.vsBefore ? `${s.vsBefore.change >= 0 ? "+" : ""}${s.vsBefore.change}% vs before` : ""], ["Income", money(s.income), ""], ["Net", `${s.net < 0 ? "-" : ""}${money(Math.abs(s.net))}`, ""]].map(([l, v, sub]) => (
                <div key={l} className="rounded-xl border border-border p-3"><p className="text-[11px] uppercase tracking-wide text-muted">{l}</p><p className="text-[20px] font-semibold tabular-nums">{v}</p><p className="text-[11px] text-muted">{sub}</p></div>
              ))}
            </div>
            <div>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Where it went <span className="normal-case">· click a bar to set a monthly budget</span></p>
              <div className="space-y-1.5">
                {s.byCategory.map((c) => (
                  <div key={c.cat}>
                    {editing?.cat === c.cat ? (
                      <div className="mb-1 flex items-center gap-2 text-[12.5px]"><span>{c.cat} budget per month: $</span><input autoFocus value={editing.v} onChange={(e) => setEditing({ cat: c.cat, v: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void saveBudget(); if (e.key === "Escape") setEditing(null); }} inputMode="decimal" placeholder="0 removes" className="h-7 w-24 rounded-md border border-border bg-surface px-2 outline-none focus:border-accent" /><button onClick={() => void saveBudget()} className="rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-black">Save</button></div>
                    ) : null}
                  <button onClick={() => setEditing({ cat: c.cat, v: c.budget ? String(c.budget) : "" })} className="block w-full text-left">
                    <div className="flex justify-between text-[12.5px]"><span>{c.cat}</span><span className="tabular-nums">{money(c.amount)} <span className="text-muted">· {c.pct}%{c.budget ? ` · budget ${money(c.budget)}` : ""}</span></span></div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-hover"><div className={cn("h-full rounded-full", c.over ? "bg-danger" : "bg-accent")} style={{ width: `${Math.min(100, c.budget ? (c.amount / c.budget) * 100 : c.pct)}%` }} /></div>
                  </button></div>
                ))}
                {!s.byCategory.length && <p className="text-[12.5px] text-muted">Nothing spent in this period.</p>}
              </div>
            </div>
            {!!s.unusual.length && (
              <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-danger">Worth a look</p>
                {s.unusual.map((u) => <p key={u.date + u.merchant} className="text-[12.5px]"><b>{money(u.amount)}</b> at {u.merchant} on {u.date} <span className="text-muted">· {u.why}</span></p>)}
              </div>
            )}
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">Top places</p>
              {s.topMerchants.map((m) => <p key={m.merchant} className="flex justify-between text-[12.5px]"><span>{m.merchant} <span className="text-muted">· {m.count}×</span></span><span className="tabular-nums">{money(m.amount)}</span></p>)}
            </div>
          </>
        )}

        {d?.has && tab === "subs" && (
          <>
            {(d.subs ?? []).length ? <>
              <p className="text-[12.5px]">About <b>{money((d.subs ?? []).reduce((n, x) => n + x.perYear, 0))}</b> a year in repeating charges. To cancel one, open that service yourself; Marigold doesn&apos;t cancel or pay anything.</p>
              {(d.subs ?? []).map((x) => <div key={x.merchant} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-[12.5px]"><span><b>{x.merchant}</b> <span className="text-muted">· {x.every}, last {x.last}</span></span><span className="tabular-nums">{money(x.amount)} <span className="text-muted">· {money(x.perYear)}/yr</span></span></div>)}
            </> : <p className="text-[12.5px] text-muted">No repeating charges found yet. Add a few months of statements and they show up here.</p>}
          </>
        )}

        {d?.has && tab === "txns" && (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search merchants" className="h-8 w-full rounded-lg border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent" />
            <div>{(d.txns ?? []).map((t) => <p key={t.id} className="flex justify-between gap-3 border-b border-border/50 py-1.5 text-[12.5px]"><span className="min-w-0 truncate"><span className="text-muted">{t.date}</span> {t.merchant} <span className="text-muted">· {t.cat}</span></span><span className={cn("shrink-0 tabular-nums", t.amount > 0 && "text-accent")}>{t.amount < 0 ? "-" : "+"}{money(Math.abs(t.amount))}</span></p>)}</div>
          </>
        )}

        {d?.has && tab === "ask" && (
          <>
            {!d.aiOk && <p className="rounded-lg border border-border px-3 py-2 text-[12px]">To answer questions, the AI needs to see your totals and merchant names (never account numbers or file names). Turn that on below.</p>}
            <div className="flex gap-2">
              <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void doAsk(ask)} placeholder="e.g. Why was last month higher?" className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent" />
              <button onClick={() => void doAsk(ask)} disabled={asking} className="h-9 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-black disabled:opacity-60">{asking ? "Thinking…" : "Ask"}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">{["Where does most of my money go?", "What subscriptions could I cut?", "Am I spending more than last month?", "Anything unusual on my card?"].map((x) => <button key={x} onClick={() => void doAsk(x)} className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted hover:bg-surface-hover hover:text-foreground">{x}</button>)}</div>
            {answer && <p className="whitespace-pre-wrap rounded-xl bg-surface px-4 py-3 text-[13px] leading-relaxed">{answer}</p>}
            <p className="text-[11px] text-muted">Information, not financial advice. Marigold can read your spending, never move money.</p>
          </>
        )}

        {d?.has && tab === "overview" && dropZone}
        {tab === "pay" && <PaymentsTab />}
        {d?.has && tab !== "pay" && (
          <div className="flex items-center justify-between border-t border-border pt-3 text-[12px]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={d.aiOk} onChange={(e) => void setAi(e.target.checked)} /> AI can see my spending (totals and merchant names only)</label>
            <button onClick={async () => { if (!sure) { setSure(true); return; } await post({ action: "clear" }); setSure(false); void load(); }} onBlur={() => setSure(false)} className={sure ? "text-danger" : "text-muted hover:text-danger"}>{sure ? "Click again to remove everything" : "Remove my data"}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

interface Card { id: string; nickname: string; brand: string; last4: string; expMonth: number; expYear: number; maxPerPurchase?: number }
interface Use { at: string; host: string; card: string; amount?: number; ok: boolean; note?: string }
const pay = (b: Record<string, unknown>) => fetch("/api/agent/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) })).catch(() => ({ ok: false, error: "Couldn't reach Marigold." }) as { ok: boolean; error?: string });

/** Saved cards and wallets. Numbers are kept encrypted on this Mac; every use is a Touch ID for that one site. */
function PaymentsTab() {
  const [d, setD] = useState<{ cards: Card[]; frozen: boolean; uses: Use[] } | null>(null);
  const [form, setForm] = useState({ nickname: "", number: "", exp: "", name: "", zip: "", max: "" });
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const [sure, setSure] = useState("");
  const load = useCallback(async () => { const j = await fetch("/api/agent/payments", { cache: "no-store" }).then((r) => r.json()).catch(() => null); if (j) setD(j); }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch, then set
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setErr("");
    const r = await pay({ action: "add_card", nickname: form.nickname, number: form.number, exp: form.exp, name: form.name, zip: form.zip, maxPerPurchase: Number(form.max) || undefined }) as { ok: boolean; error?: string; cards?: Card[] };
    setForm({ nickname: "", number: "", exp: "", name: "", zip: "", max: "" }); // the number never stays in the page
    if (!r.ok) { setErr(r.error ?? "Couldn't save the card."); setForm((f) => f); return; }
    setAdding(false); void load();
  };
  const field = "h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[12.5px] outline-none focus:border-accent";
  return (
    <div className="space-y-4">
      {d?.frozen && <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px]"><Snowflake size={14} className="text-danger" /> <span className="flex-1"><b>Card use is frozen.</b> Marigold can&apos;t fill any card until you unfreeze it.</span><button onClick={async () => { await pay({ action: "unfreeze" }); void load(); }} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-black">Unfreeze</button></div>}
      <div>
        <p className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted"><span>Your cards</span>{!d?.frozen && !!d?.cards.length && <button onClick={async () => { await pay({ action: "freeze" }); void load(); }} className="flex items-center gap-1 normal-case text-muted hover:text-danger"><Snowflake size={11} /> Freeze all card use</button>}</p>
        {!d?.cards.length && !adding && <p className="rounded-xl border border-dashed border-border p-4 text-center text-[12.5px] text-muted">No cards yet. Add one and Marigold can fill it in on checkouts you ask it to complete, with your Touch ID each time.</p>}
        <div className="space-y-1.5">
          {d?.cards.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              <CreditCard size={18} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1 text-[12.5px]"><p className="truncate font-medium">{c.nickname}</p><p className="text-muted">{c.brand} ••{c.last4} · expires {String(c.expMonth).padStart(2, "0")}/{String(c.expYear).slice(-2)}{c.maxPerPurchase ? ` · up to $${c.maxPerPurchase} per purchase` : ""}</p></div>
              <LimitEditor card={c} onDone={load} />
              <button onClick={async () => { if (sure !== c.id) { setSure(c.id); return; } await pay({ action: "remove_card", id: c.id }); setSure(""); void load(); }} onBlur={() => setSure("")} className={cn("text-[11.5px]", sure === c.id ? "text-danger" : "text-muted hover:text-danger")}>{sure === c.id ? "Click again to remove" : "Remove"}</button>
            </div>
          ))}
        </div>
        {adding ? (
          <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-2 space-y-2 rounded-xl border border-border p-3">
            <div className="grid grid-cols-2 gap-2">
              <input className={cn(field, "col-span-2")} placeholder="Nickname (e.g. Everyday Visa)" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} autoComplete="off" />
              <input className={cn(field, "col-span-2")} placeholder="Card number" inputMode="numeric" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} autoComplete="off" />
              <input className={field} placeholder="Expires MM/YY" inputMode="numeric" value={form.exp} onChange={(e) => setForm({ ...form, exp: e.target.value })} autoComplete="off" />
              <input className={field} placeholder="Billing ZIP" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} autoComplete="off" />
              <input className={cn(field, "col-span-2")} placeholder="Name on card" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
              <input className={cn(field, "col-span-2")} placeholder="Per-purchase limit in $ (optional)" inputMode="numeric" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} autoComplete="off" />
            </div>
            <p className="text-[11px] text-muted">No security code (CVC) here, on purpose: Marigold never keeps it. You type it on the checkout page.</p>
            {err && <p className="text-[12px] text-danger">{err}</p>}
            <div className="flex justify-end gap-2"><button type="button" onClick={() => { setAdding(false); setErr(""); setForm({ nickname: "", number: "", exp: "", name: "", zip: "", max: "" }); }} className="h-8 rounded-lg px-3 text-[12px] text-muted hover:bg-surface-hover">Cancel</button><button className="h-8 rounded-lg bg-accent px-4 text-[12px] font-semibold text-black">Save card</button></div>
          </form>
        ) : <button onClick={() => setAdding(true)} className="mt-2 h-8 rounded-lg border border-border px-3 text-[12px] hover:bg-surface-hover">+ Add a card</button>}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Wallets</p>
        <div className="space-y-1.5 text-[12.5px]">
          <div className="rounded-xl border border-border px-3 py-2.5"><p className="font-medium">PayPal</p><p className="text-muted">When a checkout offers PayPal, Marigold can click it and stop at PayPal&apos;s own window. You log in and approve there. Marigold never has your PayPal login.</p></div>
          <div className="rounded-xl border border-border px-3 py-2.5"><p className="font-medium">Apple Pay</p><p className="text-muted">Apple doesn&apos;t let other apps use Apple Pay cards. Marigold can get the cart ready, then you tap Apple Pay yourself on your iPhone or in Safari.</p></div>
        </div>
      </div>

      <div className="rounded-xl bg-surface px-3 py-2.5 text-[11.5px] leading-relaxed text-muted">
        <p className="mb-1 font-medium text-foreground">How your money stays safe</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>Card numbers are encrypted on this Mac, with a key in your Keychain. They never go to the AI, the phone, or any server.</li>
          <li>Marigold names a card (&quot;Visa 4421&quot;); the number goes straight into the page&apos;s card fields and is never shown to the assistant.</li>
          <li>Every card fill asks for your Touch ID for that one website. Pressing Pay asks again. There is no &quot;always allow&quot;.</li>
          <li>The security code is never saved. Per-purchase limits, a freeze switch (also on your phone), and a log of every use.</li>
        </ul>
      </div>

      {!!d?.uses.length && (
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Recent card use</p>
          {d.uses.map((u) => <p key={u.at + u.host} className="flex justify-between gap-3 border-b border-border/50 py-1.5 text-[12px]"><span className="min-w-0 truncate">{u.card} on {u.host}{u.amount ? ` · $${u.amount}` : ""}</span><span className={cn("shrink-0", u.ok ? "text-muted" : "text-danger")}>{u.ok ? new Date(u.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : `blocked${u.note ? ` (${u.note})` : ""}`}</span></p>)}
        </div>
      )}
    </div>
  );
}

function LimitEditor({ card, onDone }: { card: Card; onDone: () => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(card.maxPerPurchase ? String(card.maxPerPurchase) : "");
  if (!edit) return <button onClick={() => setEdit(true)} className="text-[11.5px] text-muted hover:text-foreground">{card.maxPerPurchase ? "Change limit" : "Set limit"}</button>;
  return <span className="flex items-center gap-1 text-[11.5px]">$<input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={async (e) => { if (e.key === "Enter") { await pay({ action: "limit", id: card.id, max: Number(v) || 0 }); setEdit(false); onDone(); } if (e.key === "Escape") setEdit(false); }} inputMode="numeric" placeholder="0 = none" className="h-6 w-16 rounded-md border border-border bg-surface px-1.5 outline-none focus:border-accent" /></span>;
}
