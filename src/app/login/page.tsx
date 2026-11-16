"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import type { AgentTone } from "@/lib/types";
import { TONES, detectTimezone, listTimezones } from "@/lib/profile-options";
import { Button } from "@/components/ui/button";
import { MarigoldIcon } from "@/components/marigold-icon";
import { BrowserPicker, saveBrowser } from "@/components/browser-picker";
import { Mail, ArrowRight, ArrowLeft, CheckCircle2, ChevronDown, Plus, X } from "lucide-react";
import { syncEmails } from "@/lib/agent";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { currentUser, signInWithEmail, subscribeAuth, verifyEmailCode } from "@/lib/supabase/auth";

type Step = "profile" | "email" | "signin" | "sent";

export default function LoginPage() {
  const router = useRouter();
  const setProfile = useApp((s) => s.setProfile);

  const [step, setStep] = useState<Step>("profile");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [tone, setTone] = useState<AgentTone>("friendly");
  const [email, setEmail] = useState("");
  const [browser, setBrowser] = useState("");
  // Other emails (school, work…) Marigold can use; the sign-in email is the primary.
  const [extras, setExtras] = useState<string[]>([]);
  const [extraDraft, setExtraDraft] = useState("");
  const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
  const addExtra = () => {
    const e = extraDraft.trim().toLowerCase();
    if (!validEmail(e)) { setError("That doesn't look like an email address."); return; }
    if (e === email.trim().toLowerCase() || extras.includes(e)) { setExtraDraft(""); return; }
    setError(null);
    setExtras((x) => [...x, e]);
    setExtraDraft("");
  };
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timezones = useMemo(() => listTimezones(timezone), [timezone]);

  // Prefill the timezone from the browser; the user picks from the dropdown.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser-only values after hydration (avoids a server/client mismatch)
    setTimezone(detectTimezone());
  }, []);

  // Already signed in → straight to the app. And the moment a sign-in lands (the email's
  // link handed to the app, or the code typed below), open the chat — no reload needed.
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    currentUser().then((u) => {
      if (u) router.replace("/");
    });
    return subscribeAuth((u) => { if (u) router.replace("/"); });
  }, [router]);

  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const submitCode = async () => {
    const c = code.replace(/\D/g, "");
    if (c.length < 6) { setError("Enter the code from the email."); return; }
    setError(null);
    setVerifying(true);
    const { error } = await verifyEmailCode(email, c);
    setVerifying(false);
    if (error) setError(error); // success → the auth listener above opens the chat
  };
  // Returning user: just the email, no setup questions.
  const sendSignIn = async () => {
    setError(null);
    const trimmed = email.trim();
    if (!validEmail(trimmed)) { setError("Enter the email you signed up with."); return; }
    setSending(true);
    const { error } = await signInWithEmail(trimmed);
    setSending(false);
    if (error) { setError(error); return; }
    void syncEmails(trimmed, []);
    setCode("");
    setCooldown(30);
    setStep("sent");
  };

  const toProfile = () => {
    setError(null);
    setStep("profile");
  };

  const toEmail = () => {
    setError(null);
    if (!name.trim()) {
      setError("Let me know what to call you.");
      return;
    }
    // Remember the profile locally so it personalizes the app immediately.
    setProfile({ name: name.trim(), timezone: timezone.trim() || undefined, tone });
    if (browser) void saveBrowser(browser);
    setStep("email");
  };

  const finish = async () => {
    setError(null);
    // An email still sitting in the "add" box counts too.
    const allExtras = validEmail(extraDraft) ? [...new Set([...extras, extraDraft.trim().toLowerCase()])] : extras;
    const profile = { name: name.trim(), timezone: timezone.trim(), tone, extraEmails: allExtras };
    if (email.trim()) void syncEmails(email.trim(), allExtras); // the local agent learns who you are right away

    // No backend yet → keep the original mock flow (into the capabilities page).
    if (!isSupabaseConfigured) {
      router.push("/onboarding");
      return;
    }

    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email to continue.");
      return;
    }

    setSending(true);
    const { error } = await signInWithEmail(trimmed, profile);
    setSending(false);
    if (error) {
      setError(error);
      return;
    }
    setCode("");
    setCooldown(30);
    setStep("sent");
  };

  // --- Sent confirmation ----------------------------------------------------

  if (step === "sent") {
    return (
      <Shell>
        <div className="text-center">
          <div className="mb-4 flex justify-center">
            <CheckCircle2 size={48} className="text-accent" />
          </div>
          <h1 className="text-2xl font-semibold">Check your email</h1>
          <p className="mt-2 text-sm text-muted">
            We sent a sign-in email to <span className="text-foreground">{email}</span>.
            Click <b className="text-foreground">Sign in to Marigold</b> in it on this Mac and Marigold will open.
          </p>
        </div>
        <div className="mt-6 space-y-2">
          <p className="px-1 text-[13px] font-medium">Or type the code from the email</p>
          <div className="flex gap-2">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, "").slice(0, 12))}
              onKeyDown={(e) => e.key === "Enter" && submitCode()}
              placeholder="123456"
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-center font-mono text-lg tracking-[0.3em] outline-none placeholder:tracking-normal placeholder:text-muted focus:border-accent"
            />
            <Button variant="primary" className="justify-center" onClick={submitCode} disabled={verifying}>
              {verifying ? "Signing in…" : <>Sign in <ArrowRight size={16} /></>}
            </Button>
          </div>
          {error && <p className="px-1 text-xs text-danger">{error}</p>}
        </div>
        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-muted">
          <button
            disabled={cooldown > 0 || sending}
            onClick={() => (name.trim() ? finish() : sendSignIn())}
            className="hover:text-foreground disabled:opacity-50"
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : sending ? "Sending…" : "Resend email"}
          </button>
          <span>·</span>
          <button onClick={() => { setError(null); setStep(name.trim() ? "email" : "signin"); }} className="hover:text-foreground">
            Use a different email
          </button>
        </div>
      </Shell>
    );
  }

  // --- Sign in (returning user) ---------------------------------------------

  if (step === "signin") {
    return (
      <Shell>
        <Header title="Welcome back" subtitle="Enter your email and I'll send you a sign-in link and code." />
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-accent">
            <Mail size={16} className="text-muted" />
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendSignIn()}
              placeholder="you@email.com"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </div>
          {error && <p className="px-1 text-xs text-danger">{error}</p>}
          <Button variant="primary" className="w-full justify-center" onClick={sendSignIn} disabled={sending}>
            {sending ? "Sending…" : <>Sign in <ArrowRight size={16} /></>}
          </Button>
          <button onClick={() => { setError(null); setStep("profile"); }} className="mx-auto flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
            New to Marigold? Set it up
          </button>
        </div>
      </Shell>
    );
  }

  // --- Email step -----------------------------------------------------------

  if (step === "email") {
    return (
      <Shell>
        <Header
          title={`Nice to meet you, ${name.trim() || "there"}.`}
          subtitle="Where should I reach you? I'll send a secure sign-in link."
        />
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-accent">
            <Mail size={16} className="text-muted" />
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && finish()}
              placeholder="you@email.com"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </div>
          <div className="rounded-xl border border-border bg-surface/50 p-3">
            <p className="text-[13px] font-medium">Do you use any other emails?</p>
            <p className="mt-0.5 text-[11px] text-muted">
              Optional — e.g. school or work. Marigold uses the email above for web tasks, and these when you ask (“check my school email”). You can add more later in Settings.
            </p>
            {extras.length > 0 && (
              <ul className="mt-2 space-y-1">
                {extras.map((e) => (
                  <li key={e} className="flex items-center justify-between rounded-lg bg-background px-2.5 py-1.5 text-xs">
                    <span className="truncate">{e}</span>
                    <button onClick={() => setExtras((x) => x.filter((y) => y !== e))} className="text-muted hover:text-danger" aria-label={`Remove ${e}`}>
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              <input
                type="email"
                value={extraDraft}
                onChange={(e) => setExtraDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addExtra())}
                placeholder="another@email.com"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs outline-none placeholder:text-muted focus:border-accent"
              />
              <button onClick={addExtra} className="flex h-9 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-surface-hover">
                <Plus size={13} /> Add
              </button>
            </div>
          </div>

          {error && <p className="px-1 text-xs text-danger">{error}</p>}
          <Button
            variant="primary"
            className="w-full justify-center"
            onClick={finish}
            disabled={sending}
          >
            {sending ? (
              "Sending link…"
            ) : (
              <>
                {isSupabaseConfigured ? "Send sign-in email" : "Continue"} <ArrowRight size={16} />
              </>
            )}
          </Button>
          <button
            onClick={toProfile}
            className="mx-auto flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            <ArrowLeft size={13} /> Back
          </button>
        </div>
      </Shell>
    );
  }

  // --- Profile step ---------------------------------------------------------

  return (
    <Shell>
      <Header
        title="Welcome to Marigold"
        subtitle="A couple of quick things so I can work the way you like."
      />
      <div className="space-y-5">
        <Field label="What should I call you?">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && toEmail()}
            placeholder="Your name"
            className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
        </Field>

        <Field label="Your timezone" hint="Detected automatically. Change it if it's wrong.">
          <div className="relative">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-11 w-full appearance-none rounded-xl border border-border bg-surface pl-3 pr-9 text-sm outline-none focus:border-accent"
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
            />
          </div>
        </Field>

        <Field label="How should I talk to you?">
          <div className="grid grid-cols-3 gap-2">
            {TONES.map((t) => {
              const active = tone === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTone(t.id)}
                  className={cn(
                    "rounded-xl border p-2.5 text-left transition-colors",
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-surface hover:border-accent/50",
                  )}
                >
                  <p className="text-[13px] font-medium">{t.label}</p>
                  <p className="mt-0.5 text-[11px] leading-tight text-muted">{t.blurb}</p>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Your main browser" hint="I'll use it whenever I browse the web for you. You can change it later in Safety & permissions.">
          <BrowserPicker value={browser} onChange={setBrowser} />
        </Field>

        {error && <p className="px-1 text-xs text-danger">{error}</p>}
        <Button variant="primary" className="w-full justify-center" onClick={toEmail}>
          Continue <ArrowRight size={16} />
        </Button>
      </div>

      {isSupabaseConfigured && (
        <p className="mt-5 text-center text-sm text-muted">
          Already use Marigold?{" "}
          <button onClick={() => { setError(null); setStep("signin"); }} className="font-medium text-accent hover:underline">Sign in</button>
        </p>
      )}

      <p className="mt-4 text-center text-xs text-muted">
        By continuing you agree to let Marigold act on your behalf, with your
        approval before anything leaves your accounts.
      </p>
    </Shell>
  );
}

// --- Layout helpers ---------------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <div className="mb-4">
        <MarigoldIcon size={56} />
      </div>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted">{subtitle}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block px-1 text-[13px] font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1 px-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
