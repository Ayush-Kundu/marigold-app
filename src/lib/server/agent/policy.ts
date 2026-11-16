import { promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Marigold safety policy.
 *
 * Goal: the agent can drive any app on the Mac, but the user is only asked
 * when it actually matters.
 *
 *   Tier 0  read           → runs automatically, logged
 *   Tier 1  reversible     → runs automatically, logged + undoable (backups / Trash)
 *   Tier 2  consequential  → ask ONCE per scope ("app:Mail", "shell", …);
 *                            "Always allow" is remembered in ~/.marigold/grants.json
 *   Tier 3  financial      → ask EVERY time, can never be remembered
 *   Blocked                → hard-denied, no prompt (keychain dumps, sudo, rm -rf /, …)
 *
 * Prompt-injection rule: once a run has read untrusted content (web pages,
 * emails, files from others), remembered grants for OUTWARD scopes (sending
 * messages, network posts, shell) are suspended for that run and re-asked.
 */

export type Tier = 0 | 1 | 2 | 3;

export const MARIGOLD_DIR = path.join(os.homedir(), ".marigold");
const GRANTS_FILE = path.join(MARIGOLD_DIR, "grants.json");
const AUDIT_FILE = path.join(MARIGOLD_DIR, "audit.jsonl");

export interface Grant {
  scope: string;
  grantedAt: string;
}

export type Decision =
  | { kind: "allow"; via: "tier" | "grant" | "user" }
  | { kind: "ask"; scope: string; rememberable: boolean; reason: string }
  | { kind: "deny"; reason: string };

/** What a tool call wants to do, as classified by the tool itself. */
export interface Classified {
  tier: Tier;
  /** Grant scope, e.g. "app:Mail". Required for tier >= 2. */
  scope?: string;
  /** Sends data out of the machine (email, message, HTTP POST, shell). */
  outward?: boolean;
  /** Never offer "Always allow" (e.g. keystrokes into whatever app is in front). */
  noRemember?: boolean;
  /** Hard block reason, if any. */
  blocked?: string;
  /** Human summary of exactly what will happen. */
  summary: string;
}

// ---------------------------------------------------------------- financial

const FINANCE_APPS = [
  "wallet", "apple pay", "stocks", "paypal", "venmo", "cash app", "zelle", "coinbase",
  "robinhood", "binance", "kraken", "chase", "bank of america", "wells fargo", "citi",
  "capital one", "amex", "american express", "schwab", "fidelity", "vanguard", "revolut",
  "wise", "stripe", "quickbooks", "mint", "monarch", "turbotax", "amazon", "app store", "e\\*trade", "etrade", "webull", "sofi", "ally", "discover", "td ameritrade", "interactive brokers", "public\\.com", "acorns", "betterment", "wealthfront", "crypto\\.com",
];
const FINANCE_TEXT =
  /(\$\s?\d|\b\d+(\.\d+)?\s?(usd|eur|gbp|btc|eth)\b|\b(pay|payment|purchase|buy now|checkout|place order|transfer|wire|withdraw|deposit|invoice|subscribe|card number|cvv|iban|routing number|send money|tip)\b)/i;

export function looksFinancial(...parts: (string | undefined)[]): boolean {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (FINANCE_TEXT.test(text)) return true;
  return FINANCE_APPS.some((a) => new RegExp(`\\b${a.replace(/ /g, "\\s")}\\b`).test(text));
}

// ---------------------------------------------------------------- paths

const SENSITIVE = [
  ".ssh", ".gnupg", ".aws", ".marigold", "Library/Keychains", "Library/Cookies",
  "Library/Application Support/Google/Chrome", "Library/Safari", "Library/Messages",
].map((p) => path.join(os.homedir(), p));

export function expandPath(p: string): string {
  const e = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(e);
}

/** Returns a block reason if the path is off-limits to the agent. */
export function sensitivePath(p: string): string | undefined {
  const abs = expandPath(p);
  // Files the user attached in chat live here on purpose; the agent may open them (nothing else in ~/.marigold).
  const uploads = path.join(os.homedir(), ".marigold", "uploads");
  if (abs.startsWith(uploads + path.sep)) return undefined;
  if (SENSITIVE.some((s) => abs === s || abs.startsWith(s + path.sep))) {
    return `"${abs}" holds credentials or Marigold's own safety settings`;
  }
  if (/(^|\/)\.env(\.|$)/.test(abs)) return "environment/secret files are off-limits";
  return undefined;
}

// ---------------------------------------------------------------- grants

async function ensureDir() {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
}

export async function loadGrants(): Promise<Grant[]> {
  try {
    return JSON.parse(await fs.readFile(GRANTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export async function addGrant(scope: string) {
  if (scope.startsWith("finance:")) return; // never remembered
  const grants = await loadGrants();
  if (grants.some((g) => g.scope === scope)) return;
  grants.push({ scope, grantedAt: new Date().toISOString() });
  await ensureDir();
  await fs.writeFile(GRANTS_FILE, JSON.stringify(grants, null, 2), { mode: 0o600 });
}

export async function revokeGrant(scope?: string) {
  const grants = scope ? (await loadGrants()).filter((g) => g.scope !== scope) : [];
  await ensureDir();
  await fs.writeFile(GRANTS_FILE, JSON.stringify(grants, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------- decide

/** Commands that can send things off this Mac. Even with "always allow terminal", these are double-checked when the task just read web or email content. */
export const NETWORK_OUT = /\b(curl|wget|scp|sftp|ssh|rsync|nc|ncat|ftp|telnet|git\s+push|npm\s+publish|twine|gh\s+(pr|issue|release|gist)\s+(create|edit)|aws\s+s3\s+(cp|sync)|gsutil)\b/;

export async function decide(c: Classified, ctx: { tainted: boolean; preapproved?: boolean }): Promise<Decision> {
  if (c.blocked) return { kind: "deny", reason: c.blocked };
  if (c.tier <= 1) return { kind: "allow", via: "tier" };

  const scope = c.scope ?? "unknown";
  if (c.tier === 3) {
    return {
      kind: "ask",
      scope,
      rememberable: false,
      reason: "Money or financial action — Marigold always confirms these with Touch ID.",
    };
  }

  // A task the user scheduled was approved, in full, when it was scheduled. Ordinary approvals are pre-granted for that
  // run (unless it read outside content and is now sending something outward, or the action needs the app in front).
  if (ctx.preapproved && !c.noRemember && !(c.outward && ctx.tainted)) return { kind: "allow", via: "grant" };

  const granted = (await loadGrants()).some((g) => g.scope === scope);
  if (granted && !(c.outward && ctx.tainted)) return { kind: "allow", via: "grant" };

  if (c.noRemember) {
    return { kind: "ask", scope, rememberable: false, reason: "This acts on whatever app is in front, so I'll confirm each time." };
  }
  return {
    kind: "ask",
    scope,
    rememberable: true,
    reason:
      granted && c.outward && ctx.tainted
        ? "You normally allow this, but this task read outside content (web/email), so I'm double-checking before anything leaves your Mac."
        : scope === "terminal"
          ? "Marigold wants to run a command in Terminal. Choose “Always allow” and it will never ask about terminal commands again, or “Allow once” and it will ask next time."
          : "First time Marigold is doing this. Choose “Always allow” and I won't ask again.",
  };
}

// ---------------------------------------------------------------- audit

export async function audit(entry: Record<string, unknown>) {
  try {
    await ensureDir();
    await fs.appendFile(
      AUDIT_FILE,
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    console.error("[marigold] audit write failed", err);
  }
}
