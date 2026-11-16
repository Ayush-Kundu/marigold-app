import { execFile } from "child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";

/**
 * Google connection (auth layer, separate from browser control).
 *
 * One-time consent with Google's own OAuth screen, opened in the user's REAL browser
 * (no bot detection, no passwords typed by Marigold). Marigold keeps the long-lived
 * refresh token — encrypted with a key held in the macOS Keychain — and silently swaps
 * it for short-lived access tokens whenever the agent needs Gmail / Calendar / Drive.
 * Nothing leaves the Mac except calls to Google's own APIs.
 *
 * The OAuth client (ID + secret) is registered ONCE by the developer in Google Cloud
 * ("Desktop app" type) and shipped with the app; users only click Connect.
 */

const exec = promisify(execFile);
const CONFIG = path.join(MARIGOLD_DIR, "google-oauth.json");   // { clientId, clientSecret }
const TOKENS = path.join(MARIGOLD_DIR, "google-tokens.enc");   // encrypted { email: { refresh, scopes, at } }
const REDIRECT = "http://localhost:3000/api/google/callback";

export const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.readonly",   // restricted (needs CASA for public launch)
  "https://www.googleapis.com/auth/gmail.compose",    // drafts + send
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",   // restricted
  "https://www.googleapis.com/auth/documents",        // Docs: create / append
  "https://www.googleapis.com/auth/spreadsheets",     // Sheets
  "https://www.googleapis.com/auth/presentations",    // Slides
  "https://www.googleapis.com/auth/tasks",            // Google Tasks
  "https://www.googleapis.com/auth/contacts.readonly",
  // Classroom (read-only, for notifications): announcements, new work, due dates, grades
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
];

// ---------------------------------------------------------------- config

/**
 * Marigold's own Google app. The developer registers it ONCE and ships it inside the app
 * (Resources/google-client.json — see scripts/pack-google-client.sh); users then only ever see a
 * "Connect Google" button and Google's own approval page. A desktop-app client secret is not
 * confidential (Google's docs say so for installed apps). Falls back to a client set in Settings.
 */
async function bundledClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  const dir = process.env.MARIGOLD_RESOURCES;
  if (!dir) return null;
  try {
    const j = JSON.parse(await fs.readFile(path.join(dir, "google-client.json"), "utf8"));
    const c = j.installed ?? j.web ?? j;
    const clientId = c.clientId ?? c.client_id, clientSecret = c.clientSecret ?? c.client_secret;
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  } catch { return null; }
}

export async function oauthConfig(): Promise<{ clientId: string; clientSecret: string } | null> {
  const id = process.env.MARIGOLD_GOOGLE_CLIENT_ID, secret = process.env.MARIGOLD_GOOGLE_CLIENT_SECRET;
  if (id && secret) return { clientId: id, clientSecret: secret };
  try { const j = JSON.parse(await fs.readFile(CONFIG, "utf8")); if (j.clientId && j.clientSecret) return j; } catch { /* none set in Settings */ }
  return bundledClient();
}
/** True when the client ships with the app (users never see the Cloud Console steps). */
export async function clientIsShipped(): Promise<boolean> {
  if (process.env.MARIGOLD_GOOGLE_CLIENT_ID) return true;
  try { await fs.access(CONFIG); return false; } catch { return !!(await bundledClient()); }
}
export async function saveOauthConfig(clientId: string, clientSecret: string) {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG, JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }), { mode: 0o600 });
}

// ---------------------------------------------------------------- encrypted token store

/** 32-byte key kept in the macOS Keychain (created on first use). */
async function storeKey(): Promise<Buffer> {
  const args = ["-s", "Marigold Google tokens", "-a", "marigold"];
  try {
    const { stdout } = await exec("security", ["find-generic-password", ...args, "-w"]);
    return Buffer.from(stdout.trim(), "hex");
  } catch {
    const key = randomBytes(32);
    await exec("security", ["add-generic-password", ...args, "-w", key.toString("hex"), "-U"]);
    return key;
  }
}

interface Stored { refresh: string; scopes: string; at: string }
async function readTokens(): Promise<Record<string, Stored>> {
  try {
    const raw = await fs.readFile(TOKENS);
    const key = await storeKey();
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  } catch { return {}; }
}
async function writeTokens(t: Record<string, Stored>) {
  const key = await storeKey();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(t), "utf8"), c.final()]);
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(TOKENS, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
}

export async function connectedAccounts(): Promise<{ email: string; scopes: string; at: string }[]> {
  return Object.entries(await readTokens()).map(([email, s]) => ({ email, scopes: s.scopes, at: s.at }));
}
export async function disconnect(email: string) {
  const t = await readTokens();
  const s = t[email.toLowerCase()];
  if (s) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh)}`, { method: "POST" }).catch(() => {});
  delete t[email.toLowerCase()];
  await writeTokens(t);
}

// ---------------------------------------------------------------- consent flow (PKCE)

const g = globalThis as unknown as { __marigoldOauth?: Map<string, { verifier: string; hint?: string; at: number }> };
const pending = (g.__marigoldOauth ??= new Map());

export async function consentUrl(loginHint?: string): Promise<string> {
  const cfg = await oauthConfig();
  if (!cfg) throw new Error("NOT_CONFIGURED");
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { verifier, hint: loginHint, at: Date.now() });
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    state, code_challenge: challenge, code_challenge_method: "S256",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Google redirected back: swap the code for tokens and keep the refresh token. */
export async function finishConsent(code: string, state: string): Promise<string> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error("This sign-in link expired — start Connect Google again.");
  const cfg = (await oauthConfig())!;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code", code_verifier: p.verifier }),
  });
  const j = (await r.json()) as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string; id_token?: string; error_description?: string };
  if (!r.ok || !j.refresh_token) throw new Error(j.error_description ?? "Google didn't return a long-lived token — try Connect again.");
  const email = (JSON.parse(Buffer.from((j.id_token ?? "..").split(".")[1] ?? "", "base64url").toString() || "{}").email ?? p.hint ?? "").toLowerCase();
  if (!email) throw new Error("Couldn't tell which Google account was connected.");
  const t = await readTokens();
  t[email] = { refresh: j.refresh_token, scopes: j.scope ?? "", at: new Date().toISOString() };
  await writeTokens(t);
  if (j.access_token) cacheAccess(email, j.access_token, j.expires_in ?? 3600);
  return email;
}

// ---------------------------------------------------------------- access tokens + API calls

const access = new Map<string, { token: string; exp: number }>();
const cacheAccess = (email: string, token: string, secs: number) => access.set(email, { token, exp: Date.now() + (secs - 60) * 1000 });

async function accessToken(email: string): Promise<string> {
  const hit = access.get(email);
  if (hit && hit.exp > Date.now()) return hit.token;
  const s = (await readTokens())[email];
  if (!s) throw new Error(`NOT_CONNECTED ${email}`);
  const cfg = await oauthConfig();
  if (!cfg) throw new Error("NOT_CONFIGURED");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: s.refresh, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw new Error(j.error === "invalid_grant" ? `NOT_CONNECTED ${email} (access was revoked or expired — reconnect in Settings)` : `Google token refresh failed: ${j.error}`);
  cacheAccess(email, j.access_token, j.expires_in ?? 3600);
  return j.access_token;
}

/** Authenticated Google API call as this account (the agent never sees tokens). */
export async function gapi(email: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const tok = await accessToken(email);
  const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tok}`, ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}) } });
  const text = await r.text();
  const isJson = (r.headers.get("content-type") ?? "").includes("json");
  const body = isJson && text ? JSON.parse(text) : text; // Drive exports are plain text
  if (!r.ok) throw new Error(`Google API ${r.status}: ${(body as { error?: { message?: string } }).error?.message ?? text.slice(0, 200)}`);
  return body;
}
