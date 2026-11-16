import type { User as SupabaseUser } from "@supabase/supabase-js";
import { getSupabase } from "./client";
import type { AgentTone, User } from "../types";

/** Onboarding details collected before the magic link is sent. */
export interface OnboardingProfile {
  name: string;
  timezone: string;
  tone: AgentTone;
  /** Optional extra emails (school, work…) — the login email is the primary. */
  extraEmails?: string[];
}

/**
 * Auth helpers over Supabase Auth.
 *
 * Flow: passwordless magic link. `signInWithEmail` emails a link; clicking it
 * returns the user to the app with a session in the URL, which the client
 * (detectSessionInUrl) turns into a session and fires `subscribeAuth`.
 */

const TONES: AgentTone[] = ["concise", "friendly", "formal"];

/** Map a Supabase auth user to our domain User. */
export function toDomainUser(u: SupabaseUser): User {
  const meta = u.user_metadata ?? {};
  const name =
    (typeof meta.name === "string" && meta.name) ||
    (typeof meta.full_name === "string" && meta.full_name) ||
    (u.email ? u.email.split("@")[0] : "there");
  const tone =
    typeof meta.tone === "string" && TONES.includes(meta.tone as AgentTone)
      ? (meta.tone as AgentTone)
      : undefined;
  return {
    id: u.id,
    name,
    email: u.email ?? "",
    ...(typeof meta.avatar_url === "string" ? { avatarUrl: meta.avatar_url } : {}),
    ...(typeof meta.timezone === "string" ? { timezone: meta.timezone } : {}),
    ...(tone ? { tone } : {}),
    ...(Array.isArray(meta.extraEmails) ? { extraEmails: meta.extraEmails.filter((e: unknown): e is string => typeof e === "string") } : {}),
  };
}

/**
 * Send a magic-link sign-in email. The onboarding profile rides along as user
 * metadata, so a new user's name/timezone/tone land in their profile on signup
 * (via the handle_new_user trigger). Returns an error message on failure.
 */
export async function signInWithEmail(
  email: string,
  profile?: OnboardingProfile,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Backend is not configured." };
  const emailRedirectTo =
    typeof window !== "undefined" ? window.location.origin + "/" : undefined;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo,
      shouldCreateUser: true,
      ...(profile ? { data: profile } : {}),
    },
  });
  return error ? { error: friendlyAuthError(error.message) } : {};
}

/** Auth errors in Marigold's words (never the backend's name or jargon). */
export function friendlyAuthError(msg: string): string {
  if (/rate limit|too many|for security purposes/i.test(msg)) return "Too many sign-in emails in a short time — wait a minute, then try again.";
  if (/expired|invalid|not found|otp/i.test(msg)) return "That code or link has expired or was already used — send a new one.";
  if (/network|fetch/i.test(msg)) return "Couldn't reach Marigold's sign-in service — check your internet connection.";
  if (/signups? not allowed/i.test(msg)) return "New sign-ups are closed right now.";
  return msg.replace(/supabase/gi, "Marigold");
}

/** Sign in with the 6-digit code from the email (typed in the app — no browser needed). */
export async function verifyEmailCode(email: string, code: string): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Sign-in isn't set up." };
  const { error } = await sb.auth.verifyOtp({ email: email.trim(), token: code.replace(/\s/g, ""), type: "email" });
  return error ? { error: friendlyAuthError(error.message) } : {};
}

/** Sign in from the email's link (Marigold-branded link carrying a one-time token hash). */
export async function verifyEmailLink(tokenHash: string, type = "email"): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Sign-in isn't set up." };
  const t = (["email", "magiclink", "signup", "invite", "email_change", "recovery"].includes(type) ? type : "email") as "email";
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: t });
  return error ? { error: friendlyAuthError(error.message) } : {};
}

/**
 * Update the signed-in user's profile (name / timezone / tone). Writes to auth
 * user_metadata (the source of truth the app reads on load) and best-effort
 * mirrors into the profiles row. Returns an error message on failure.
 */
export async function updateProfile(
  patch: Partial<OnboardingProfile>,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return {};
  const { data, error } = await sb.auth.updateUser({ data: patch });
  if (error) return { error: friendlyAuthError(error.message) };

  const uid = data.user?.id;
  if (uid) {
    const row: Record<string, unknown> = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.timezone !== undefined) row.timezone = patch.timezone;
    if (patch.tone !== undefined) row.tone = patch.tone;
    if (Object.keys(row).length) {
      // Best-effort: if the profiles columns don't exist yet (schema not re-run),
      // metadata still carries the values, so don't fail the save.
      const { error: rowErr } = await sb.from("profiles").update(row).eq("id", uid);
      if (rowErr) console.warn("[marigold] profile row update failed:", rowErr.message);
    }
  }
  return {};
}

export async function signOut(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb.auth.signOut();
}

/**
 * Permanently delete the signed-in user's account and all their data, then
 * sign out. Backed by the `delete_user` RPC (security definer). Returns an
 * error message on failure.
 */
export async function deleteAccount(): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Backend is not configured." };
  const { error } = await sb.rpc("delete_user");
  if (error) return { error: friendlyAuthError(error.message) };
  await sb.auth.signOut();
  return {};
}

/** The currently signed-in user, or null. */
export async function currentUser(): Promise<User | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data.user ? toDomainUser(data.user) : null;
}

/**
 * Subscribe to sign-in / sign-out. Calls `cb` with the domain user (or null on
 * sign-out). Returns an unsubscribe function.
 */
export function subscribeAuth(cb: (user: User | null) => void): () => void {
  const sb = getSupabase();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_event, session) => {
    cb(session?.user ? toDomainUser(session.user) : null);
  });
  return () => data.subscription.unsubscribe();
}
