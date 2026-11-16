import crypto from "crypto";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR, audit } from "./policy";

/**
 * Payment methods, built so that a mistake or a trick costs the user as little as possible.
 *
 *  • Card numbers live ONLY in vault.enc: AES-256-GCM, with a random key kept in the macOS Keychain. The list the app, the
 *    assistant and the phone see (payments.json) holds only a nickname, brand, last 4 digits, expiry and limits.
 *  • No API returns a card number, ever. The only way out of the vault is `spendCard`, which hands the number to the browser
 *    page's own card fields in this Mac's process: the AI model never sees it, and it is not logged.
 *  • The security code (CVC/CVV) is never stored and never asked for here: the user types it on the page.
 *  • Every use needs a fresh Touch ID for that exact site (policy tier 3, never "always allow"), can be capped per purchase,
 *    and is written to the audit log without the number.
 *  • "Freeze" stops all card use at once. The phone can freeze; only the Mac can unfreeze.
 */
const exec = promisify(execFile);
const VAULT = path.join(MARIGOLD_DIR, "vault.enc");
const META = path.join(MARIGOLD_DIR, "payments.json");
const KEYCHAIN = ["-s", "Marigold payment vault", "-a", "marigold"];

export interface CardPublic { id: string; nickname: string; brand: string; last4: string; expMonth: number; expYear: number; maxPerPurchase?: number; addedAt: number }
export interface UseRow { at: string; host: string; card: string; amount?: number; ok: boolean; note?: string }
interface Meta { cards: CardPublic[]; frozen: boolean; uses: UseRow[] }
interface Secret { id: string; pan: string; name: string; zip: string }

const emptyMeta = (): Meta => ({ cards: [], frozen: false, uses: [] });
export async function loadMeta(): Promise<Meta> {
  try { return { ...emptyMeta(), ...(JSON.parse(await fs.readFile(META, "utf8")) as Meta) }; } catch { return emptyMeta(); }
}
async function saveMeta(m: Meta) {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(META, JSON.stringify(m), { mode: 0o600 });
}

let keyCache: Buffer | null = null;
async function key(create: boolean): Promise<Buffer | null> {
  if (keyCache) return keyCache;
  const got = await exec("security", ["find-generic-password", ...KEYCHAIN, "-w"]).then((r) => r.stdout.trim(), () => "");
  if (/^[0-9a-f]{64}$/.test(got)) return (keyCache = Buffer.from(got, "hex"));
  if (!create) return null;
  const k = crypto.randomBytes(32);
  await exec("security", ["add-generic-password", ...KEYCHAIN, "-w", k.toString("hex"), "-U"]);
  return (keyCache = k);
}
async function readVault(): Promise<Secret[]> {
  try {
    const j = JSON.parse(await fs.readFile(VAULT, "utf8")) as { iv: string; tag: string; data: string };
    const k = await key(false);
    if (!k) return [];
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(j.iv, "base64"));
    d.setAuthTag(Buffer.from(j.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, "base64")), d.final()]).toString("utf8")) as Secret[];
  } catch { return []; }
}
async function writeVault(list: Secret[]) {
  const k = (await key(true))!;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(JSON.stringify(list), "utf8"), c.final()]);
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(VAULT, JSON.stringify({ iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
}

// ---------------------------------------------------------------- validating

export function luhn(pan: string): boolean {
  let sum = 0, alt = false;
  for (let i = pan.length - 1; i >= 0; i--) { let n = pan.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return pan.length >= 13 && pan.length <= 19 && sum % 10 === 0;
}
export function brandOf(pan: string): string {
  if (/^4/.test(pan)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(pan)) return "Mastercard";
  if (/^3[47]/.test(pan)) return "Amex";
  if (/^(6011|65|64[4-9])/.test(pan)) return "Discover";
  return "Card";
}

export type AddResult = { ok: true; card: CardPublic } | { ok: false; error: string };
/** Add a card. A security code is refused on purpose: it is never kept. */
export async function addCard(i: { nickname?: string; number?: string; exp?: string; name?: string; zip?: string; maxPerPurchase?: number; cvv?: unknown; cvc?: unknown }): Promise<AddResult> {
  if (i.cvv || i.cvc) return { ok: false, error: "Marigold never stores a security code. Leave it out; you type it on the checkout page." };
  const pan = String(i.number ?? "").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(pan) || !luhn(pan)) return { ok: false, error: "That card number doesn't look right. Check the digits." };
  const m = String(i.exp ?? "").match(/^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/);
  if (!m) return { ok: false, error: "Use the expiry as MM/YY." };
  const expMonth = Number(m[1]), expYear = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (expMonth < 1 || expMonth > 12) return { ok: false, error: "The expiry month must be 1 to 12." };
  const now = new Date();
  if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) return { ok: false, error: "That card has expired." };
  const meta = await loadMeta();
  if (meta.cards.length >= 12) return { ok: false, error: "That's the most cards Marigold keeps (12). Remove one first." };
  const brand = brandOf(pan), last4 = pan.slice(-4);
  if (meta.cards.some((c) => c.last4 === last4 && c.brand === brand && c.expMonth === expMonth && c.expYear === expYear)) return { ok: false, error: "That card is already saved." };
  const id = crypto.randomBytes(6).toString("hex");
  const card: CardPublic = { id, nickname: String(i.nickname ?? "").trim().slice(0, 30) || `${brand} ${last4}`, brand, last4, expMonth, expYear, ...(i.maxPerPurchase && i.maxPerPurchase > 0 ? { maxPerPurchase: Math.round(i.maxPerPurchase) } : {}), addedAt: Date.now() };
  await writeVault([...(await readVault()), { id, pan, name: String(i.name ?? "").trim().slice(0, 60), zip: String(i.zip ?? "").trim().slice(0, 12) }]);
  meta.cards.push(card);
  await saveMeta(meta);
  await audit({ tool: "payments", action: "card_added", card: `${brand} ••${last4}` });
  return { ok: true, card };
}

export async function removeCard(id: string) {
  const meta = await loadMeta();
  const c = meta.cards.find((x) => x.id === id);
  meta.cards = meta.cards.filter((x) => x.id !== id);
  await saveMeta(meta);
  await writeVault((await readVault()).filter((x) => x.id !== id));
  if (c) await audit({ tool: "payments", action: "card_removed", card: `${c.brand} ••${c.last4}` });
}
export async function setLimit(id: string, max: number) {
  const meta = await loadMeta();
  const c = meta.cards.find((x) => x.id === id);
  if (c) { if (max > 0) c.maxPerPurchase = Math.round(max); else delete c.maxPerPurchase; await saveMeta(meta); }
}
export async function setFrozen(on: boolean, by: "mac" | "phone") {
  const meta = await loadMeta();
  if (meta.frozen === on) return meta;
  meta.frozen = on;
  await saveMeta(meta);
  await audit({ tool: "payments", action: on ? "frozen" : "unfrozen", by });
  return meta;
}

export const findCard = (cards: CardPublic[], ref: string) => {
  const r = ref.trim().toLowerCase();
  return cards.find((c) => c.id === r || c.nickname.toLowerCase() === r) ?? cards.find((c) => r && (c.nickname.toLowerCase().includes(r) || c.last4 === r.replace(/\D/g, "").slice(-4) && /\d{4}/.test(r)));
};

/** Is this a page a card may be typed into? https, a real hostname, not a local or look-alike address. */
export function safeCheckoutHost(url: string): { ok: true; host: string } | { ok: false; why: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return { ok: false, why: "the page isn't https (secure)" };
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /\.(local|internal|test|localhost)$/.test(h) || h === "localhost") return { ok: false, why: "that isn't a normal website address" };
    if (/xn--/.test(h)) return { ok: false, why: "the address uses look-alike characters" };
    return { ok: true, host: h };
  } catch { return { ok: false, why: "no page is open" }; }
}

/**
 * The ONLY way a card number leaves the vault: handed straight to a function that types it into the page. Call it only after
 * Touch ID has approved this site. Never log or return what it passes.
 */
export async function spendCard(id: string, host: string, fn: (s: { pan: string; mm: string; yy: string; name: string; zip: string }) => Promise<{ filled: number }>, amount?: number): Promise<{ ok: boolean; filled: number; card?: CardPublic; error?: string }> {
  const meta = await loadMeta();
  const card = meta.cards.find((c) => c.id === id);
  const log = async (ok: boolean, note?: string) => {
    meta.uses = [{ at: new Date().toISOString(), host, card: card ? `${card.nickname} ••${card.last4}` : "?", ...(amount ? { amount } : {}), ok, ...(note ? { note } : {}) }, ...meta.uses].slice(0, 50);
    await saveMeta(meta);
    await audit({ tool: "payments", action: "card_used", host, card: card ? `${card.brand} ••${card.last4}` : "?", amount, ok, note });
  };
  if (!card) return { ok: false, filled: 0, error: "No such card." };
  if (meta.frozen) { await log(false, "frozen"); return { ok: false, filled: 0, card, error: "Card use is frozen. The user can unfreeze it in Money on the Mac." }; }
  if (card.maxPerPurchase && amount && amount > card.maxPerPurchase) { await log(false, "over limit"); return { ok: false, filled: 0, card, error: `That is over this card's limit of $${card.maxPerPurchase} per purchase.` }; }
  const s = (await readVault()).find((x) => x.id === id);
  if (!s) { await log(false, "vault"); return { ok: false, filled: 0, card, error: "The card's details couldn't be unlocked. Remove and add it again." }; }
  try {
    const r = await fn({ pan: s.pan, mm: String(card.expMonth).padStart(2, "0"), yy: String(card.expYear).slice(-2), name: s.name, zip: s.zip });
    await log(r.filled > 0, r.filled ? undefined : "no card fields");
    return { ok: r.filled > 0, filled: r.filled, card, ...(r.filled ? {} : { error: "I found no card fields on this page to fill." }) };
  } catch (e) { await log(false, "error"); return { ok: false, filled: 0, card, error: e instanceof Error ? e.message.replace(/\d{12,19}/g, "••••") : "Couldn't fill the card." }; }
}
