import type { ToolDef } from "./tools";
import { pageCache } from "./apps";
import { appBrowserAvailable, mb } from "./app-browser";
import { findCard, loadMeta, safeCheckoutHost, spendCard } from "./payments";

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

/**
 * Paying on a website with one of the user's saved cards. The assistant never sees a card number: it names a card
 * ("Visa 4421"), the user approves THAT site with Touch ID, and Marigold types the number into the page's own card
 * fields. The security code and the final Pay button stay with the user (the Pay click is a Touch ID step of its own).
 */
export const paymentTool: ToolDef = {
  name: "payment",
  description:
    "Pay on a website with the user's saved cards, only when the user asked to buy or pay. action=cards lists the saved cards (nickname, brand, last 4, limit; never numbers). action=fill (card, amount?) types the chosen card's number, expiry, name and ZIP into the checkout page that is open in the Marigold Browser: the user is asked for Touch ID for that exact site first. You never see the card number. It does NOT enter the security code (CVC): tell the user to type it, then ask them to press the pay button (that asks for Touch ID again). Pass amount (the total shown on the page) so a card's per-purchase limit is checked. " +
    "PayPal: when the checkout offers PayPal, click the PayPal button with web_browser and stop at PayPal's own window; the user logs in and approves there (Marigold never has PayPal logins). Apple Pay: Apple doesn't let other apps use it; tell the user to tap Apple Pay themselves. Never fill a card on a page you reached from an email/ad link without saying where it is.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["cards", "fill"] }, card: { type: "string", description: "which card: its nickname or last 4 digits" }, amount: { type: "number", description: "the total about to be paid (for the limit check and the approval card)" } }, required: ["action"] },
  classify: (a) => {
    if (s(a.action) !== "fill") return { tier: 0, summary: "See which cards are saved" };
    const h = safeCheckoutHost(pageCache.url);
    if (!h.ok) return { tier: 0, blocked: `Won't fill a card here: ${h.why}.`, summary: "Fill a card" };
    return { tier: 3, scope: `payment:${h.host}`, outward: true, summary: `Fill your ${s(a.card) || "card"} on ${h.host}${typeof a.amount === "number" ? ` (about $${a.amount})` : ""}` };
  },
  taints: false,
  async exec(a, _sig, ctx) {
    const meta = await loadMeta();
    if (s(a.action) === "cards") {
      if (!meta.cards.length) return "No cards are saved. The user adds one in Money → Payments (Marigold never stores the security code).";
      return `${meta.frozen ? "Card use is FROZEN by the user. " : ""}Saved cards:\n${meta.cards.map((c) => `- ${c.nickname}: ${c.brand} ••${c.last4}, expires ${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}${c.maxPerPurchase ? `, limit $${c.maxPerPurchase} per purchase` : ""}`).join("\n")}`;
    }
    if (s(a.action) !== "fill") return "FAILED: action must be cards or fill.";
    if (!appBrowserAvailable()) return "FAILED: card filling works in the Marigold app's browser only.";
    if (!meta.cards.length) return "FAILED: no cards are saved. Ask the user to add one in Money → Payments.";
    const card = findCard(meta.cards, s(a.card)) ?? (meta.cards.length === 1 ? meta.cards[0] : undefined);
    if (!card) return `FAILED: say which card. Saved: ${meta.cards.map((c) => `${c.nickname} (••${c.last4})`).join(", ")}.`;
    const cur = { current: ctx?.browserCurrent === true };
    const info = (await mb("info", cur)) as { url: string };
    const live = safeCheckoutHost(info.url);
    if (!live.ok) return `BLOCKED: won't fill a card here: ${live.why}.`;
    // The user approved the site the assistant was on a moment ago: it must still be that site.
    if (hostOf(pageCache.url) !== live.host) return `BLOCKED: the page changed to ${live.host} after you were asked, so nothing was filled. Ask again from the checkout page.`;
    const amount = typeof a.amount === "number" && a.amount > 0 ? a.amount : undefined;
    const r = await spendCard(card.id, live.host, async (secret) => {
      const out = (await mb("fill_card", { host: live.host, card: secret, ...cur })) as { filled?: number; error?: string };
      if (out.error) throw new Error(out.error);
      return { filled: out.filled ?? 0 };
    }, amount);
    if (!r.ok) return `FAILED: ${r.error}`;
    return `Filled ${card.brand} ••${card.last4} on ${live.host} (${r.filled} field${r.filled === 1 ? "" : "s"}). The security code was NOT entered: tell the user to type it themselves, check the total, then press the pay button (it asks for Touch ID).`;
  },
};
