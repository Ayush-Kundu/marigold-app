import { promises as dns } from "dns";
import { prefs, setPrefs } from "./prefs";
import { searchUrl } from "./web-search";

/**
 * The user's email accounts — the identity the agent uses on the web.
 * The primary is the email they log in to Marigold with; extras are optional
 * (school, work…). For each one we work out the provider from the domain's mail
 * servers (MX), so browser tasks open THEIR inbox / Google account, and a
 * "Sign in" button can open the right sign-in page with the email filled in.
 */

export type Provider = "google" | "microsoft" | "microsoft-work" | "yahoo" | "icloud" | "other";
export interface EmailAccount { address: string; primary: boolean; provider: Provider }

const KNOWN: Record<string, Provider> = {
  "gmail.com": "google", "googlemail.com": "google",
  "outlook.com": "microsoft", "hotmail.com": "microsoft", "live.com": "microsoft", "msn.com": "microsoft",
  "yahoo.com": "yahoo", "ymail.com": "yahoo", "rocketmail.com": "yahoo",
  "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud",
};

export async function detectProvider(address: string): Promise<Provider> {
  const domain = address.split("@")[1]?.toLowerCase().trim() ?? "";
  if (KNOWN[domain]) return KNOWN[domain];
  // Custom domains (school/work): look at who runs their mail.
  try {
    const mx = (await Promise.race([dns.resolveMx(domain), new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 4000))]))
      .map((m) => m.exchange.toLowerCase()).join(" ");
    if (/google\.com|googlemail\.com/.test(mx)) return "google";
    if (/outlook\.com|protection\.outlook/.test(mx)) return "microsoft-work";
    if (/yahoodns|yahoo\.com/.test(mx)) return "yahoo";
    if (/icloud\.com|me\.com|apple\.com/.test(mx)) return "icloud";
  } catch { /* unknown */ }
  return "other";
}

const LABEL: Record<Provider, string> = {
  google: "Google (Gmail)", microsoft: "Microsoft (Outlook)", "microsoft-work": "Microsoft 365 (Outlook)",
  yahoo: "Yahoo Mail", icloud: "iCloud Mail", other: "email",
};
export const providerLabel = (p: Provider, address = "") =>
  p === "google" && !/@(gmail|googlemail)\.com$/i.test(address) ? "Google Workspace" : LABEL[p];

/** The provider's web inbox, opened as THIS account. */
export function inboxUrl(a: EmailAccount): string | undefined {
  const e = encodeURIComponent(a.address);
  switch (a.provider) {
    case "google": return `https://mail.google.com/mail/?authuser=${e}`;
    case "microsoft": return "https://outlook.live.com/mail/";
    case "microsoft-work": return `https://outlook.office.com/mail/?login_hint=${e}`;
    case "yahoo": return "https://mail.yahoo.com/";
    case "icloud": return "https://www.icloud.com/mail/";
  }
}

/** Sign-in page with the email already filled in (the user types the password themselves). */
export function signInUrl(a: EmailAccount): string {
  const e = encodeURIComponent(a.address);
  switch (a.provider) {
    case "google": return `https://accounts.google.com/AccountChooser?Email=${e}&continue=${encodeURIComponent("https://mail.google.com/mail/")}`;
    case "microsoft": return `https://login.live.com/login.srf?username=${e}`;
    case "microsoft-work": return `https://login.microsoftonline.com/?login_hint=${e}`;
    case "yahoo": return "https://login.yahoo.com/";
    case "icloud": return "https://www.icloud.com/";
    default: return searchUrl(`${a.address.split("@")[1]} webmail sign in`);
  }
}

export const accounts = (): EmailAccount[] => prefs().emails ?? [];
export const primaryAccount = () => accounts().find((a) => a.primary) ?? accounts()[0];

export function accountFor(nameOrEmail?: string): EmailAccount | undefined {
  const q = (nameOrEmail ?? "").toLowerCase().trim();
  if (!q) return primaryAccount();
  return accounts().find((a) => a.address.toLowerCase() === q)
    ?? accounts().find((a) => a.address.toLowerCase().includes(q) || q.includes(a.address.split("@")[1]?.split(".")[0] ?? "\0"));
}

/** Did the user's message explicitly name this (non-primary) account? Address, its name part, or its school/work domain. */
export function namedInText(acc: EmailAccount, text: string): boolean {
  const t = text.toLowerCase();
  const [local, domain = ""] = acc.address.split("@");
  const org = domain.split(".").slice(-2, -1)[0] ?? ""; // "srvusd" from students.srvusd.net
  if (t.includes(acc.address) || (local.length > 3 && t.includes(local))) return true;
  if (org.length > 2 && new RegExp(`\\b${org}\\b`).test(t)) return true;
  // "my school/work email" → the only Workspace-type extra account, if there's exactly one.
  const others = accounts().filter((a) => !a.primary && a.provider !== "google" || (!a.primary && !/@gmail\.com$/.test(a.address)));
  return /\b(school|work|college|university|uni|office)\b/.test(t) && others.length === 1 && others[0].address === acc.address;
}

/**
 * The ONE saved account the user's message names ("in my 251552 account", "from kunduayush7", "my school email").
 * Matches the full address, the part before @ (≥3 chars; digits like 251552 count), or the school/work domain.
 * Null when nothing is named, or when the words fit more than one account (then the agent must ask).
 */
export function accountNamedBy(text: string): { account?: EmailAccount; ambiguous?: boolean } {
  const t = text.toLowerCase();
  const hits = accounts().filter((a) => {
    const [local, domain = ""] = a.address.toLowerCase().split("@");
    if (t.includes(a.address.toLowerCase())) return true;
    if (local.length >= 3 && new RegExp(`(^|[^a-z0-9])${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t)) return true;
    const org = domain.split(".").slice(-2, -1)[0] ?? "";
    return org.length > 2 && !/^(gmail|googlemail|outlook|hotmail|yahoo|icloud|live|aol|proton|protonmail|me)$/.test(org) && new RegExp(`\\b${org}\\b`).test(t);
  });
  if (hits.length === 1) return { account: hits[0] };
  if (hits.length > 1) return { ambiguous: true };
  const others = accounts().filter((a) => !a.primary);
  if (/\b(school|work|college|university|office)\b/.test(t) && others.length === 1) return { account: others[0] };
  return {};
}

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

/** Save primary + extras (provider detection is cached per address). */
export async function saveAccounts(primary: string | undefined, extras: string[]) {
  const before = new Map(accounts().map((a) => [a.address.toLowerCase(), a.provider]));
  const list = [...new Set([primary, ...extras].filter((e): e is string => !!e && valid(e.trim())).map((e) => e.trim().toLowerCase()))];
  const out: EmailAccount[] = [];
  for (const [i, address] of list.entries()) {
    out.push({ address, primary: i === 0 && !!primary, provider: before.get(address) ?? (await detectProvider(address)) });
  }
  await setPrefs({ emails: out });
  return out;
}

/** Google services → open them as the right account (authuser). */
const GOOGLE_HOSTS = /(^|\.)(mail|calendar|docs|drive|meet|contacts|keep|photos|myaccount|sheets|slides|chat)\.google\.com$/;
export function withAccount(url: string, account?: EmailAccount): string {
  if (!account || account.provider !== "google") return url;
  try {
    const u = new URL(url);
    if (GOOGLE_HOSTS.test(u.hostname) && !u.searchParams.has("authuser")) u.searchParams.set("authuser", account.address);
    return u.toString();
  } catch { return url; }
}

/** One stable block for the agent's instructions (changes only when the accounts change). */
export function accountsBlock(): string {
  const list = accounts();
  if (!list.length) return "";
  const rows = list.map((a) => `• ${a.address}${a.primary ? " (PRIMARY — the email they log in to Marigold with)" : ""} — ${providerLabel(a.provider, a.address)}${inboxUrl(a) ? `, web inbox: ${inboxUrl(a)}` : ""}, sign-in page: ${signInUrl(a)}`);
  return `THE USER'S EMAIL ACCOUNTS (their identity on the web):
${rows.join("\n")}
- Tasks that need the user's email (forms in apps, sign-ins, receipts) use the PRIMARY account unless the user explicitly names another. Never invent one.
- NEVER type passwords or verification codes yourself.`;
}
