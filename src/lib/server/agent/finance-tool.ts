import type { ToolDef } from "./tools";
import { aiContext, loadFinance, search, subscriptions, summarize, saveFinance, type Period } from "./finance";

const s = (v: unknown) => (typeof v === "string" ? v : "");
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The user's spending, read-only. It cannot move money, open a bank or pay anything. */
export const financeTool: ToolDef = {
  name: "finance",
  description: "The user's own spending, from the bank/card statements they added to Marigold (read-only; this tool can NOT move or send money). action=summary (period: this_month|last_month|last_30|last_90|year|all) gives totals, categories, top places, change vs the period before, unusual charges, budgets; action=subscriptions lists recurring charges and what they cost a year; action=search (text, category, from, to, min) lists transactions; action=budget (category, amount) sets a monthly budget for a category (amount 0 removes it); action=overview gives everything at once. Use for “how much did I spend on…”, “what subscriptions do I pay for”, “am I over budget”, “anything weird on my card”.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["summary", "subscriptions", "search", "budget", "overview"] }, period: { type: "string" }, text: { type: "string" }, category: { type: "string" }, from: { type: "string" }, to: { type: "string" }, min: { type: "number" }, amount: { type: "number" } }, required: ["action"] },
  classify: (a) => (s(a.action) === "budget" ? { tier: 1, summary: `Set a ${s(a.category)} budget` } : { tier: 0, summary: "Look at your spending" }),
  taints: true, // merchant names come from outside
  async exec(a) {
    const db = await loadFinance();
    if (!db.txns.length) return "FAILED: the user hasn't added any bank or card statements yet. Tell them to open Money (the wallet icon at the top) and drop in a CSV or OFX file downloaded from their bank.";
    const { cloudConfig, hasCloudKey } = await import("./cloud");
    if (!db.aiOk && cloudConfig().mode !== "off" && (await hasCloudKey())) return "FAILED: the user hasn't allowed the AI to see their spending. Tell them to open Money and switch on “AI can see my spending” (only totals and merchant names are shared, never account numbers).";
    const act = s(a.action);
    if (act === "overview") return aiContext(db);
    if (act === "subscriptions") {
      const l = subscriptions(db);
      return l.length ? l.map((x) => `${x.merchant}: ${money(x.amount)} ${x.every}, last ${x.last} (${money(x.perYear)}/year)`).join("\n") + `\nTotal ${money(l.reduce((n, x) => n + x.perYear, 0))}/year.` : "No repeating charges found yet.";
    }
    if (act === "budget") {
      const cat = s(a.category), amt = Number(a.amount);
      if (!cat || !(amt >= 0)) return "FAILED: give category and amount.";
      if (amt === 0) delete db.budgets[cat]; else db.budgets[cat] = amt;
      await saveFinance(db);
      return `Budget for ${cat}: ${amt ? `${money(amt)} a month` : "removed"}.`;
    }
    if (act === "search") {
      const l = search(db, { text: s(a.text), cat: s(a.category), from: s(a.from), to: s(a.to), min: typeof a.min === "number" ? a.min : undefined });
      return l.length ? l.map((t) => `${t.date}  ${t.amount < 0 ? "-" : "+"}${money(Math.abs(t.amount))}  ${t.merchant}  [${t.cat}]`).join("\n") : "No matching transactions.";
    }
    const p = (["this_month", "last_month", "last_30", "last_90", "year", "all"].includes(s(a.period)) ? s(a.period) : "last_30") as Period;
    const x = summarize(db, p);
    return [
      `${x.label} (${x.from} to ${x.to}): spent ${money(x.spent)}, income ${money(x.income)}, net ${money(x.net)}.`,
      x.vsBefore ? `Before that: ${money(x.vsBefore.spent)} (${x.vsBefore.change >= 0 ? "+" : ""}${x.vsBefore.change}%).` : "",
      `By category: ${x.byCategory.map((c) => `${c.cat} ${money(c.amount)} (${c.pct}%)${c.budget ? ` of ${money(c.budget)} budget${c.over ? " — OVER" : ""}` : ""}`).join("; ") || "none"}.`,
      `Top places: ${x.topMerchants.map((m) => `${m.merchant} ${money(m.amount)}`).join("; ")}.`,
      x.unusual.length ? `Unusual: ${x.unusual.map((u) => `${u.date} ${u.merchant} ${money(u.amount)} (${u.why})`).join("; ")}.` : "",
    ].filter(Boolean).join("\n");
  },
};
