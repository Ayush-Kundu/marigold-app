"use client";

import { useChatRun } from "@/lib/store";
import { RunControls } from "@/components/shell/run-controls";
import { nativeApp } from "@/lib/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { signInEmail, syncEmails, type EmailAccountInfo } from "@/lib/agent";
import { cn } from "@/lib/utils";
import { TESTER_BUILD } from "@/lib/channel";
import { useApp, cleanTitle } from "@/lib/store";
import type { AgentTone } from "@/lib/types";
import { TONES, detectTimezone, listTimezones } from "@/lib/profile-options";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Pin,
  PinOff,
  X,
  PanelLeft,
  MoreHorizontal,
  Trash2,
  LogOut,
  Settings,
  ChevronDown,
} from "lucide-react";
import { MarigoldIcon } from "@/components/marigold-icon";
import { SafetyDialog } from "./safety-dialog";
import { Modal } from "@/components/ui/modal";
import { ShieldCheck, Wallet } from "lucide-react";
import { MoneyHost, openMoney } from "@/components/shell/money";
import { VOICES, ensureVoice, getSpeed, getVoice, setSpeed, setVoice, speakText, stopSpeaking, useSpeaking, useVoiceStatus } from "@/lib/voice-client";

export function Sidebar() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const setSidebarOpen = useApp((s) => s.setSidebarOpen);
  const collapsedPref = useApp((s) => s.sidebarCollapsed);
  const autoHidden = useApp((s) => s.sidebarAutoHidden);
  const setCollapsedPref = useApp((s) => s.setSidebarCollapsed);
  const setAutoHidden = useApp((s) => s.setSidebarAutoHidden);
  const collapsed = collapsedPref || autoHidden;
  const setCollapsed = (v: boolean) => { if (v && autoHidden) return; if (!v) setAutoHidden(false); setCollapsedPref(v); };
  const width = useApp((s) => s.sidebarWidth);
  const setWidth = useApp((s) => s.setSidebarWidth);

  // Drag the right edge to resize (desktop only).
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const onMove = (ev: PointerEvent) => setWidth(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setWidth],
  );

  return (
    <>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Desktop: the column's width animates, so hiding/showing slides smoothly. */}
      <div aria-hidden className="hidden shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:block" style={{ width: collapsed ? 0 : width }} />
      <aside
        style={{ width }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-surface transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "md:-translate-x-full" : "md:translate-x-0",
        )}
      >
        {/* Desktop header: brand + collapse toggle lives in the sidebar. */}
        <div className="hidden items-center justify-between px-3 pt-3 md:flex">
          <div className="flex items-center gap-1.5">
            <MarigoldIcon size={20} />
            <span className="text-[13px] font-semibold">Marigold</span>
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
            aria-label="Hide sidebar"
          >
            <PanelLeft size={16} />
          </button>
        </div>

        {/* Mobile header: close the drawer. */}
        <div className="flex items-center justify-between p-3 md:hidden">
          <span className="text-[13px] font-semibold">Menu</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
          >
            <X size={17} />
          </button>
        </div>
        <SidebarBody />
        <SidebarFooter />

        {/* Resize handle */}
        <div
          onPointerDown={startResize}
          className="absolute right-0 top-0 hidden h-full w-1.5 cursor-col-resize md:block"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-colors hover:bg-accent/50" />
        </div>
      </aside>
    </>
  );
}

function SidebarBody() {
  const tab = useApp((s) => s.activeTab);
  return tab === "projects" ? <ProjectList /> : <ChatList />;
}

function SidebarFooter() {
  const backed = useApp((s) => s.backed);
  const user = useApp((s) => s.user);
  const signOut = useApp((s) => s.signOut);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Other pages (e.g. the browser's Google sign-in bar) can open Settings.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("mg-open-settings", open);
    return () => window.removeEventListener("mg-open-settings", open);
  }, []);
  const [safetyOpen, setSafetyOpen] = useState(false);

  // Only meaningful when a real user is signed in.
  if (!backed) return null;

  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();

  return (
    <div className="relative border-t border-border p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-accent-foreground">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium">{user.name}</p>
          <p className="truncate text-[11px] text-muted">{user.email}</p>
        </div>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Account options"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-foreground"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute bottom-full right-2.5 z-20 mb-1 w-44 overflow-hidden rounded-lg border border-border bg-background p-1 shadow-lg">
            <button
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-hover"
            >
              <Settings size={13} /> Settings
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                setSafetyOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-hover"
            >
              <ShieldCheck size={13} /> Safety &amp; permissions
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                signOut();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-hover"
            >
              <LogOut size={13} /> Sign out
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                setConfirmDelete(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-danger hover:bg-surface-hover"
            >
              <Trash2 size={13} /> Delete account
            </button>
          </div>
        </>
      )}

      {confirmDelete && <DeleteAccountDialog onClose={() => setConfirmDelete(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {safetyOpen && <SafetyDialog onClose={() => setSafetyOpen(false)} />}
    </div>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const user = useApp((s) => s.user);
  const saveProfile = useApp((s) => s.saveProfile);

  const [name, setName] = useState(user.name ?? "");
  const [timezone, setTimezone] = useState(user.timezone || detectTimezone());
  const [tone, setTone] = useState<AgentTone>(user.tone ?? "friendly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timezones = useMemo(() => listTimezones(timezone), [timezone]);

  const save = async () => {
    if (!name.trim()) {
      setError("Your name can't be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await saveProfile({ name: name.trim(), timezone, tone });
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onClose();
  };

  return (
    <Modal onClose={onClose} className="max-w-md">
      <div className="overflow-y-auto p-6">
        <h2 className="text-base font-semibold">Settings</h2>
        <p className="mt-1 text-[12px] text-muted">
          How Marigold addresses you and tailors its replies.
        </p>

        <div className="mt-4 space-y-3">
          <Group title="You" hint="name, time zone, tone, emails" open>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none placeholder:text-muted focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Timezone</label>
            <div className="relative">
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="h-10 w-full appearance-none rounded-xl border border-border bg-surface pl-3 pr-9 text-sm outline-none focus:border-accent"
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
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Tone</label>
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
          </div>

          <AboutYou />
          <EmailAccounts />
          </Group>
          <Group title="Connections" hint="Google, setup check">
          <GoogleConnect />
          <ConnectedSites />
          <AppActionsPanel />
          <PhoneLinkPanel />
          <div>
            <label className="mb-1 block text-[13px] font-medium">Setup check</label>
            <p className="mb-2 text-[11px] text-muted">See what Marigold still needs: its AI, macOS permissions, and the optional extras.</p>
            <button onClick={() => window.dispatchEvent(new Event("mg-open-setup"))} className="h-8 rounded-lg border border-border px-3 text-[12px] hover:bg-surface-hover">Open setup check</button>
          </div>
          </Group>
          <Group title="Notifications"><Notifications /></Group>
          <Group title="Voice"><VoiceSettings /></Group>
          {TESTER_BUILD && (
            <Group title="Advanced" hint="for testers">
              <CloudModel />
            </Group>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The user's emails: the login email is the primary identity Marigold uses on the web;
 * extras (school, work…) are used when the user asks. Saved to the account + the local agent.
 */
function EmailAccounts() {
  const user = useApp((s) => s.user);
  const saveProfile = useApp((s) => s.saveProfile);
  const [accounts, setAccounts] = useState<EmailAccountInfo[]>([]);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const extras = user.extraEmails ?? [];

  useEffect(() => { void syncEmails(user.email || undefined, extras).then(setAccounts); }, [user.email, extras.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: string[]) => {
    await saveProfile({ extraEmails: next });
    setAccounts(await syncEmails(user.email || undefined, next));
  };
  const add = async () => {
    const e = draft.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { setMsg("That doesn't look like an email address."); return; }
    setDraft(""); setMsg(null);
    if (e !== user.email.toLowerCase() && !extras.includes(e)) await save([...extras, e]);
  };
  const signIn = async (email: string) => {
    setMsg(`Opening the sign-in page for ${email} in the Marigold Browser — enter your password there (View → Open app, or the Marigold Browser window).`);
    if (!(await signInEmail(email))) setMsg("Couldn't open the Marigold Browser.");
  };

  const rows = accounts.length ? accounts : [user.email, ...extras].filter(Boolean).map((a, i) => ({ address: a, primary: i === 0, provider: "", label: "", inbox: null }));
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Email accounts</label>
      <p className="mb-2 text-[11px] text-muted">Marigold acts on the web as your login email, or another one when you ask (“check my school email”). Sign in once to each in the Marigold Browser.</p>
      <ul className="space-y-1.5">
        {rows.map((a) => (
          <li key={a.address} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px]">{a.address}</p>
              <p className="text-[11px] text-muted">{a.primary ? "Primary · your login" : "Extra"}{a.label ? ` · ${a.label}` : ""}</p>
            </div>
            <button onClick={() => void signIn(a.address)} className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium hover:bg-surface-hover">Sign in</button>
            {!a.primary && (
              <button onClick={() => void save(extras.filter((x) => x !== a.address))} aria-label={`Remove ${a.address}`} className="rounded p-1 text-muted hover:text-danger">
                <X size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          placeholder="Add another email"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-xs outline-none placeholder:text-muted focus:border-accent"
        />
        <button onClick={() => void add()} className="h-9 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-surface-hover">Add</button>
      </div>
      {msg && <p className="mt-1.5 text-[11px] text-muted">{msg}</p>}
    </div>
  );
}

/**
 * Cloud smart mode: a much bigger open-source model hosted online (OpenRouter/Together/
 * Fireworks/Groq) for complex tasks when there's internet; the local model is the fallback.
 */
/** Brave Search API key: licensed web search for AI summaries and lookups (Wikipedia until then). */
function WebSearch() {
  const [has, setHas] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/agent/search-key").then((r) => r.json()).then((j) => setHas(!!j.hasKey)).catch(() => {}); }, []);
  const save = async (k: string) => {
    setMsg(k ? "Checking the key…" : null);
    const r = await fetch("/api/agent/search-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k }) });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error); return; }
    setHas(!!j.hasKey); setKey(""); setMsg(k ? "Saved. Summaries and lookups now use Brave Search." : "Removed.");
  };
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Live answers in chat (optional)</label>
      <p className="mb-2 text-[11px] text-muted">
        For scores, news and other &ldquo;latest&rdquo; questions Marigold reads DuckDuckGo&apos;s page. A{" "}
        <a className="text-accent underline" target="_blank" rel="noreferrer" href="https://api-dashboard.search.brave.com/register">Brave Search API key</a> gives it a licensed source instead
        (Brave gives about 1,000 searches a month on a $5 monthly credit and asks for a card on file). The browser doesn&apos;t use this; searches there open Google.
      </p>
      <div className="flex gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder={has ? "Key saved in Keychain. Paste to replace" : "Brave Search API key"} className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
        <button onClick={() => void save(key)} disabled={!key.trim()} className="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground disabled:opacity-40">Save</button>
        {has && <button onClick={() => void save("")} className="h-8 rounded-lg border border-border px-2 text-xs hover:bg-surface-hover">Remove</button>}
      </div>
      {msg && <p className="mt-1 text-[11px] text-muted">{msg}</p>}
    </div>
  );
}

type PingPrefs = { kinds: Record<string, boolean>; quiet: { from: string; to: string } | null; morningAt: string; briefTimes?: string[] };
const PING_KINDS: [string, string][] = [
  ["task", "When a task finishes"], ["needs_you", "When a task needs your OK"], ["monitor", "Background tasks (things you asked it to watch)"],
  ["calendar", "Before events start (15 min)"], ["reminders", "Reminders that are due"], ["messages", "Texts that need you (it reads new texts)"],
  ["email", "Important email (Gmail, when connected)"], ["classroom", "Google Classroom (announcements, new work, due soon, grades)"], ["docs", "Docs, Slides and Sheets (shared with you, edits, comments)"], ["invites", "Calendar invitations and cancellations"], ["tasks", "Google Tasks due today"], ["briefing", "Daily briefings (what matters today)"], ["pulse", "Pulse alerts (your teams, big stock moves)"], ["battery", "Low battery"],
];

function Notifications() {
  const [p, setP] = useState<PingPrefs | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [os, setOs] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/agent/pings").then((r) => r.json()).then((j) => setP(j.prefs)).catch(() => {}); }, []);
  useEffect(() => { void nativeApp()?.notifyStatus?.().then(setOs).catch(() => {}); }, []);
  const save = async (next: Partial<PingPrefs>) => {
    const r = await fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prefs", prefs: next }) });
    setP((await r.json()).prefs);
  };
  const act = async (action: "test" | "check") => {
    setMsg(action === "check" ? "Checking…" : null);
    await fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    setMsg(action === "check" ? "Checked. Anything worth telling you is in the bell." : "Sent a test notification.");
  };
  if (!p) return null;
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Notifications</label>
      <p className="mb-2 text-[11px] text-muted">Marigold tells you things on its own: finished tasks, what&apos;s coming up, texts and email that need you. Reading texts needs Full Disk Access; calendar and reminders ask once. All of it stays on this Mac.</p>
      {os && os !== "allowed" && os !== "missing" && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-2.5 py-2 text-[11.5px]">
          <span className="min-w-0 flex-1">{os === "denied" ? "macOS is blocking Marigold's notifications, so you'll only see them in the bell." : "macOS hasn't been asked yet. Send a test and click Allow."}</span>
          {os === "denied" && <button onClick={() => void nativeApp()?.openNotifySettings?.()} className="shrink-0 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-black">Turn on</button>}
        </div>
      )}
      <div className="space-y-1 rounded-xl border border-border bg-surface p-2.5">
        {PING_KINDS.map(([k, label]) => (
          <label key={k} className="flex items-center justify-between gap-2 text-[12px]">
            <span>{label}</span>
            <input type="checkbox" checked={p.kinds[k] !== false} onChange={(e) => void save({ kinds: { ...p.kinds, [k]: e.target.checked } })} className="accent-[var(--accent)]" />
          </label>
        ))}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-[12px]">
          <span>Briefings at</span>
          {(p.briefTimes ?? ["06:00", "14:00", "22:00"]).map((t, i) => (
            <input key={i} type="time" value={t} onChange={(e) => { const next = [...(p.briefTimes ?? ["06:00", "14:00", "22:00"])]; next[i] = e.target.value; void save({ briefTimes: next }); }} className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px]" />
          ))}
          <button onClick={() => { setMsg("Reading your calendar, texts and email…"); void fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "briefing", slot: new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening" }) }).then(() => setMsg("Sent. It's in the bell.")); }} className="h-7 rounded-lg border border-border px-2.5 text-[11px] hover:bg-surface-hover">Send one now</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!p.quiet} onChange={(e) => void save({ quiet: e.target.checked ? { from: "22:30", to: "07:00" } : null })} className="accent-[var(--accent)]" /> Quiet hours</label>
          {p.quiet && (
            <>
              <input type="time" value={p.quiet.from} onChange={(e) => void save({ quiet: { ...p.quiet!, from: e.target.value } })} className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px]" />
              <span>to</span>
              <input type="time" value={p.quiet.to} onChange={(e) => void save({ quiet: { ...p.quiet!, to: e.target.value } })} className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px]" />
            </>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => void act("test")} className="h-7 rounded-lg border border-border px-2.5 text-[11px] hover:bg-surface-hover">Send a test</button>
          <button onClick={() => void act("check")} className="h-7 rounded-lg border border-border px-2.5 text-[11px] hover:bg-surface-hover">Check now</button>
        </div>
        {msg && <p className="text-[11px] text-muted">{msg}</p>}
      </div>
    </div>
  );
}

function VoiceSettings() {
  const v = useVoiceStatus();
  const speak = useApp((s) => s.speakReplies);
  const setSpeak = useApp((s) => s.setSpeakReplies);
  const [voice, setVoiceState] = useState(() => getVoice());
  const [speed, setSpeedState] = useState(() => getSpeed());
  const speaking = useSpeaking();
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Voice</label>
      <p className="mb-2 text-[11px] text-muted">Dictate with the mic button or ⌘⇧D. Marigold can read its answers aloud (just the summary, never its steps). Both run on this Mac with open-source models (Whisper and Kokoro); nothing you say or hear leaves it.</p>
      <div className="space-y-2 rounded-xl border border-border bg-surface p-2.5 text-[12px]">
        {!v.installed ? (
          <div className="space-y-1.5">
            <p className="text-muted">{v.installing ? `Setting up: ${v.step || "starting"}…` : v.error ? v.error : "One-time download of the voice models (about 600 MB)."}</p>
            <button onClick={() => void ensureVoice()} disabled={v.installing} className="h-7 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-accent-foreground disabled:opacity-50">{v.installing ? "Setting up…" : v.error ? "Try again" : "Set up voice"}</button>
          </div>
        ) : (
          <>
            <label className="flex items-center justify-between gap-2"><span>Read answers aloud</span><input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} className="accent-[var(--accent)]" /></label>
            <div className="flex items-center justify-between gap-2">
              <span>Voice</span>
              <select value={voice} onChange={(e) => { setVoiceState(e.target.value); setVoice(e.target.value); }} className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px]">
                {VOICES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Speed</span>
              <input type="range" min={0.8} max={1.3} step={0.05} value={speed} onChange={(e) => { const n = Number(e.target.value); setSpeedState(n); setSpeed(n); }} className="w-32 accent-[var(--accent)]" />
            </div>
            <button onClick={() => (speaking ? stopSpeaking() : void speakText("Hi, I'm Marigold. This is how I'll sound when I read your answers."))} className="h-7 rounded-lg border border-border px-2.5 text-[11.5px] hover:bg-surface-hover">{speaking ? "Stop" : "Hear it"}</button>
          </>
        )}
      </div>
    </div>
  );
}

function CloudModel() {
  type Cfg = { mode: string; baseUrl: string; model: string; fastModel?: string; hasKey: boolean; online: boolean; presets: Record<string, { label: string; baseUrl: string; model: string }> };
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/agent/cloud").then((r) => r.json()).then(setCfg).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  const save = async (patch: Record<string, unknown>) => {
    const r = await fetch("/api/agent/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (r.ok) { setKey(""); void load(); }
  };
  const test = async () => {
    setMsg("Testing…");
    const j = await fetch("/api/agent/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test" }) }).then((r) => r.json());
    setMsg(j.ok ? `✓ Works (${((j.ms ?? 0) / 1000).toFixed(1)} s): “${j.reply}”` : `✗ ${j.error}`);
  };
  if (!cfg) return null;
  const preset = Object.entries(cfg.presets).find(([, p]) => p.baseUrl === cfg.baseUrl && p.model === cfg.model)?.[0]
    ?? Object.entries(cfg.presets).find(([, p]) => p.baseUrl === cfg.baseUrl)?.[0] ?? "custom";
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Cloud model (smart mode)</label>
      <p className="mb-2 text-[11px] text-muted">A much bigger open-source model hosted online handles harder tasks when you&apos;re connected (a few cents per task); your Mac&apos;s model is used offline or if the cloud fails. While on, those requests — including personal details in them — go to the provider.</p>
      <div className="space-y-1.5 rounded-xl border border-border bg-surface p-2.5">
        <div className="grid grid-cols-4 gap-1.5">
          {[["off", "Off"], ["plan", "Plans only (free-tier friendly)"], ["complex", "Complex tasks"], ["always", "Everything online"]].map(([m, label]) => (
            <button key={m} onClick={() => void save({ mode: m })} className={cn("rounded-lg border px-2 py-1.5 text-[11px] font-medium", cfg.mode === m ? "border-accent bg-accent-soft" : "border-border hover:border-accent/50")}>{label}</button>
          ))}
        </div>
        <select value={preset} onChange={(e) => e.target.value !== "custom" && void save({ preset: e.target.value })} className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none">
          {Object.entries(cfg.presets).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          {preset === "custom" && <option value="custom">Custom ({cfg.baseUrl})</option>}
        </select>
        <input defaultValue={cfg.model} key={cfg.model} onBlur={(e) => e.target.value !== cfg.model && void save({ model: e.target.value })} placeholder="Model id, e.g. openai/gpt-oss-120b or qwen/qwen3-235b-a22b-2507" className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
        <input defaultValue={cfg.fastModel ?? ""} key={`fast-${cfg.fastModel ?? ""}`} onBlur={(e) => e.target.value.trim() !== (cfg.fastModel ?? "") && void save({ fastModel: e.target.value })} placeholder={/abacus/.test(cfg.baseUrl) ? "Fast model for routine steps (default: claude-haiku-5-5)" : "Fast model for routine steps (optional)"} className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
        <p className="text-[11px] text-muted">The fast model runs routine steps (about twice as quick per step); the main model plans and takes over if a step fails.</p>
        <div className="flex gap-1.5">
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder={cfg.hasKey ? "Key saved in Keychain. Paste to replace" : "API key"} className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
          <button onClick={() => void save({ apiKey: key })} disabled={key.length < 10} className="h-8 rounded-lg border border-border px-2.5 text-xs font-medium disabled:opacity-40">Save key</button>
          <button onClick={() => void test()} disabled={!cfg.hasKey} className="h-8 rounded-lg bg-accent px-2.5 text-xs font-medium text-accent-foreground disabled:opacity-40">Test</button>
        </div>
        <p className="text-[11px] text-muted">{cfg.online ? "● Online" : "○ Offline. Using your Mac's model"}{cfg.hasKey ? "" : " · no key yet"}</p>
      </div>
      {msg && <p className="mt-1.5 text-[11px] text-muted">{msg}</p>}
    </div>
  );
}

/** "About you": facts Marigold uses instead of asking (school, grade…). One per line. Never passwords. */
/** What Marigold has learned to do in each app on this Mac (built from the app's own dictionary, tested, and kept here on the Mac). */
/** One switch for the iPhone: Marigold starts the phone app itself and shows a QR code that opens it already signed in. */
function PhoneLinkPanel() {
  type St = { available: boolean; on: boolean; running: boolean; building: boolean; tailscale: "missing" | "signed-out" | "ready"; url: string; qr: string; lan: string; wifi?: { ready: boolean; host: string; ip: string; qr: string } };
  const [st, setSt] = useState<St | null>(null);
  const load = () => { void fetch("/api/agent/phone-host", { cache: "no-store" }).then((r) => r.json()).then(setSt).catch(() => {}); };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const set = async (on: boolean) => { const r = await fetch("/api/agent/phone-host", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) }).then((x) => x.json()).catch(() => null); if (r) setSt(r); };
  if (!st || !st.available) return null;
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">iPhone</label>
      <p className="mb-2 text-[11px] text-muted">Marigold on your phone: see your Mac&apos;s tabs, send a link to the Mac, ask questions. It can ask, it can&apos;t drive your Mac. Reachable only through your private Tailscale network, behind a PIN built into the code below.</p>
      <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={st.on} onChange={(e) => void set(e.target.checked)} /> Connect my iPhone</label>
      {st.on && (
        <div className="mt-2 rounded-lg border border-border p-3 text-[12px]">
          {st.wifi?.ready ? (
            <div className="mb-3 flex items-center gap-3">
              <div className="h-[130px] w-[130px] shrink-0 overflow-hidden rounded-md bg-white [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: st.wifi.qr }} />
              <div className="min-w-0 text-muted">
                <p className="font-medium text-foreground">Marigold iPhone app · same Wi-Fi</p>
                <p className="mt-1">Open the app, tap Scan the code on my Mac, and point it here. No Tailscale needed; the link is encrypted and only this app&apos;s certificate is accepted. Both must be on the same Wi-Fi. If macOS asks to allow incoming connections, choose Allow.</p>
              </div>
            </div>
          ) : <p className="mb-3 text-muted">{st.building || !st.running ? "Preparing the iPhone link…" : "Looking for this Mac on the Wi-Fi…"}</p>}
          <p className="mb-1 font-medium">From anywhere (optional): Tailscale</p>
          {st.tailscale === "missing" && <p>One-time setup: install <b>Tailscale</b> on this Mac and on your iPhone (tailscale.com/download) and sign in to the same account on both. This page then shows the code by itself.</p>}
          {st.tailscale === "signed-out" && <p>Tailscale is installed but not signed in. Open it from the menu bar, sign in, and the code appears here.</p>}
          {st.tailscale === "ready" && !st.running && <p className="text-muted">{st.building ? "Preparing the phone app (about a minute)…" : "Starting…"}</p>}
          {st.tailscale === "ready" && st.running && st.qr && (
            <div className="flex items-center gap-3">
              <div className="h-[130px] w-[130px] shrink-0 overflow-hidden rounded-md bg-white [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: st.qr }} />
              <ol className="list-decimal space-y-1 pl-4 text-muted">
                <li>Open the iPhone Camera and scan this code.</li>
                <li>Tap the link. You&apos;re signed in.</li>
                <li>Tap Share, then Add to Home Screen.</li>
              </ol>
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted">Keep this Mac awake with Marigold open. Turn this off any time and the link stops working.</p>
        </div>
      )}
    </div>
  );
}

function AppActionsPanel() {
  type Act = { name: string; about: string; status: string; readonly: boolean; params: { name: string }[] };
  type Set = { app: string; version?: string; actions: Act[]; skipped?: string };
  const [sets, setSets] = useState<Set[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => { void fetch("/api/agent/app-actions").then((r) => r.json()).then((j) => setSets(j.apps ?? [])).catch(() => {}); };
  useEffect(() => { load(); void fetch("/api/agent/apps").then((r) => r.json()).then((j) => setApps(((j.apps ?? []) as { name: string; ios: boolean }[]).filter((a) => !a.ios).map((a) => a.name).sort())).catch(() => {}); }, []);
  const build = async (app: string, force: boolean) => {
    if (!app) return;
    setBusy(app); setMsg("");
    const r = await fetch("/api/agent/app-actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app, force }) }).then((x) => x.json()).catch(() => ({ error: "Couldn't reach Marigold." }));
    setBusy("");
    if (r.error) setMsg(r.error); else { setPick(""); setOpen(r.app); load(); }
  };
  const forget = async (app: string) => { await fetch("/api/agent/app-actions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app }) }); load(); };
  const have = new Set(sets.map((x) => x.app));
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">What Marigold can do in your apps</label>
      <p className="mb-2 text-[11px] text-muted">Marigold reads an app&apos;s own description of itself, writes a few actions for it, and tests them. Anything that changes or sends something still asks first. Stored only on this Mac.</p>
      <div className="space-y-1.5">
        {sets.map((t) => {
          const ready = t.actions.filter((a) => a.status !== "failed");
          return (
            <div key={t.app} className="rounded-lg border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => setOpen(open === t.app ? null : t.app)} className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium">{t.app} <span className="font-normal text-muted">{t.skipped ? "· uses menus" : `· ${ready.length} actions, ${ready.filter((a) => a.status === "works").length} tested`}</span></button>
                <button onClick={() => void build(t.app, true)} disabled={busy === t.app} className="text-[11.5px] text-muted hover:text-foreground">{busy === t.app ? "Learning…" : "Refresh"}</button>
                <button onClick={() => void forget(t.app)} className="text-[11.5px] text-muted hover:text-danger">Forget</button>
              </div>
              {open === t.app && (
                <ul className="mt-2 space-y-1 text-[11.5px]">
                  {t.skipped && <li className="text-muted">{t.skipped}</li>}
                  {ready.map((a) => <li key={a.name}><span className="font-medium">{a.name.replace(/_/g, " ")}</span> <span className="text-muted">{a.readonly ? "· only reads" : "· asks first"}{a.params.length ? ` · needs ${a.params.map((p) => p.name).join(", ")}` : ""}</span><br /><span className="text-muted">{a.about}</span></li>)}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent">
          <option value="">Pick an app to learn…</option>
          {apps.filter((a) => !have.has(a)).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <button onClick={() => void build(pick, false)} disabled={!pick || !!busy} className="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground disabled:opacity-40">{busy ? "Learning…" : "Learn"}</button>
      </div>
      {msg && <p className="mt-1.5 text-[11.5px] text-danger">{msg}</p>}
    </div>
  );
}

/** GitHub, Notion, Linear, Todoist: paste a personal token once and Marigold can use that site for you (kept in the Keychain). */
function ConnectedSites() {
  const [rows, setRows] = useState<{ id: string; label: string; help: string; url: string; connected: boolean }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => { void fetch("/api/agent/connections").then((r) => r.json()).then((j) => setRows(j.services ?? [])).catch(() => {}); };
  useEffect(load, []);
  const save = async (id: string, t: string) => {
    setBusy(true); setMsg("");
    const r = await fetch("/api/agent/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: id, token: t }) }).then((x) => x.json()).catch(() => ({ error: "Couldn't reach Marigold." }));
    setBusy(false);
    if (r.error) { setMsg(r.error); return; }
    setToken(""); setOpen(null); setMsg(r.connected ? `Connected${r.who ? ` as ${r.who}` : ""}.` : "Disconnected."); load();
  };
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Connected websites</label>
      <p className="mb-2 text-[11px] text-muted">Let Marigold work in these for you. Each token stays in your Mac&apos;s Keychain.</p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium">{r.label}</span>
              {r.connected
                ? <button onClick={() => void save(r.id, "")} className="text-[11.5px] text-muted hover:text-danger">Connected · Disconnect</button>
                : <button onClick={() => { setOpen(open === r.id ? null : r.id); setToken(""); setMsg(""); }} className="h-6 rounded-md border border-border px-2 text-[11.5px] hover:bg-surface-hover">Connect</button>}
            </div>
            {open === r.id && !r.connected && (
              <div className="mt-2 space-y-1.5">
                <p className="text-[11px] text-muted">{r.help}. <a href={r.url} target="_blank" rel="noreferrer" className="text-accent underline">Get one</a></p>
                <div className="flex gap-2">
                  <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="Paste it here" autoComplete="off" className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
                  <button onClick={() => void save(r.id, token)} disabled={!token.trim() || busy} className="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground disabled:opacity-40">{busy ? "Checking…" : "Save"}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {msg && <p className="mt-1.5 text-[11.5px] text-muted">{msg}</p>}
    </div>
  );
}

function AboutYou() {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { fetch("/api/agent/about").then((r) => r.json()).then((j) => setText((j.facts ?? []).join("\n"))).catch(() => {}); }, []);
  const save = async () => {
    const r = await fetch("/api/agent/about", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ facts: text.split("\n") }) });
    setSaved(r.ok ? "Saved." : "Couldn't save.");
  };
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">About you</label>
      <p className="mb-2 text-[11px] text-muted">Things Marigold should know so it doesn&apos;t have to ask — one per line (e.g. “I go to Dougherty Valley High School”, “I&apos;m in 11th grade”). It also adds facts here when you tell it. Never passwords.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={"I go to …\nMy student ID is …"} className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-[13px] outline-none placeholder:text-muted focus:border-accent" />
      <div className="mt-1.5 flex items-center gap-2">
        <button onClick={() => void save()} className="h-8 rounded-lg border border-border px-3 text-xs font-medium hover:bg-surface-hover">Save</button>
        {saved && <span className="text-[11px] text-muted">{saved}</span>}
      </div>
    </div>
  );
}

/**
 * Google (Gmail · Calendar · Drive) through Google's API — one-time consent in the user's
 * own browser; Marigold keeps the connection encrypted on this Mac. No passwords, no bots.
 */
function GoogleConnect() {
  const user = useApp((s) => s.user);
  const [state, setState] = useState<{ configured: boolean; shipped?: boolean; accounts: { email: string; scopes?: string }[] } | null>(null);
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/google/config").then((r) => r.json()).then(setState).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);

  // The JSON file Google gives you when you create the client ("client_secret_….json").
  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const c = j.installed ?? j.web ?? j;
      if (!c.client_id || !c.client_secret) throw new Error();
      await saveClient(c.client_id, c.client_secret);
    } catch { setMsg("That file isn't a Google OAuth client file. Download it from the client's page (Desktop app)."); }
  };
  const saveClient = async (cid = id, csecret = secret) => {
    const r = await fetch("/api/google/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: cid, clientSecret: csecret }) });
    const j = await r.json();
    setMsg(r.ok ? "Saved. Now press Connect." : j.error);
    if (r.ok) { setId(""); setSecret(""); void load(); }
  };
  const connect = async (email: string) => {
    const r = await fetch("/api/google/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error); return; }
    setMsg(`Google's sign-in is open in your browser. Approve it for ${email}, then come back.`);
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const s = await fetch("/api/google/config").then((x) => x.json()).catch(() => null);
      if (s?.accounts?.some((a: { email: string }) => a.email === email.toLowerCase())) { setState(s); setMsg(`✓ ${email} connected.`); return; }
    }
  };
  const disconnect = async (email: string) => {
    await fetch("/api/google/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    void load();
  };

  // Which Google APIs are switched on in the app's Cloud project (a missing one makes that feature fail with a 403).
  const [apis, setApis] = useState<{ name: string; on: boolean; enableUrl?: string }[] | null>(null);
  const checkApis = async () => { setApis(null); const j = await fetch("/api/google/probe").then((r) => r.json()).catch(() => null); setApis(j?.results ?? []); };
  const emails = [user.email, ...(user.extraEmails ?? [])].filter(Boolean);
  const connected = new Set((state?.accounts ?? []).map((a) => a.email));
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium">Google</label>
      <p className="mb-2 text-[11px] text-muted">Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks and Contacts. {state?.shipped ? "One click: Google asks for your OK on its own page" : "You approve it once on Google's own page"}; the connection is stored encrypted on this Mac.</p>
      {state && !state.configured ? (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-2.5 text-[11px]">
          <p className="font-medium">One-time setup (about 5 minutes)</p>
          <ol className="ml-4 list-decimal space-y-1 text-muted">
            <li><a className="text-accent underline" target="_blank" rel="noreferrer" href="https://console.cloud.google.com/projectcreate">Create a Google Cloud project</a> named Marigold.</li>
            <li><a className="text-accent underline" target="_blank" rel="noreferrer" href="https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com,slides.googleapis.com,tasks.googleapis.com,people.googleapis.com">Turn on the Google APIs</a> (one page, click Enable).</li>
            <li><a className="text-accent underline" target="_blank" rel="noreferrer" href="https://console.cloud.google.com/auth/overview/create">Set up the sign-in screen</a>: app name Marigold, your email, audience <b>External</b>. Then under Audience, click <b>Publish app</b> so access doesn&apos;t expire every 7 days.</li>
            <li><a className="text-accent underline" target="_blank" rel="noreferrer" href="https://console.cloud.google.com/auth/clients/create">Create a client</a>: type <b>Desktop app</b>, then <b>Download JSON</b>.</li>
          </ol>
          <label className="flex h-8 w-fit cursor-pointer items-center rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground">
            Choose the downloaded JSON file
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => void loadFile(e.target.files?.[0])} />
          </label>
          <details className="text-muted"><summary className="cursor-pointer">Or paste the ID and secret</summary>
          <div className="mt-1.5 space-y-1.5">
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Client ID (…apps.googleusercontent.com)" className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client secret" type="password" className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-accent" />
          <button onClick={() => void saveClient()} disabled={!id || !secret} className="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground disabled:opacity-40">Save</button>
          </div></details>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {[...new Set([...emails, ...connected])].map((e) => (
            <li key={e} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px]">{e}</span>
              {connected.has(e.toLowerCase()) && !/documents/.test(state?.accounts.find((a) => a.email === e.toLowerCase())?.scopes ?? "documents") ? (
                <button onClick={() => void connect(e)} title="Adds Docs, Sheets, Slides, Tasks and Contacts" className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-surface-hover">Reconnect</button>
              ) : connected.has(e.toLowerCase()) ? (
                <>
                  <span className="text-[11px] text-success">Connected</span>
                  <button onClick={() => void disconnect(e)} className="rounded-lg px-2 py-1 text-[11px] text-muted hover:text-danger">Disconnect</button>
                </>
              ) : (
                <button onClick={() => void connect(e)} className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground">Connect</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-1.5 text-[11px] text-muted">{msg}</p>}
      {connected.size > 0 && (
        <div className="mt-2 text-[11px]">
          <button onClick={() => void checkApis()} className="text-muted underline hover:text-foreground">Check that every Google feature is switched on</button>
          {apis && (
            <ul className="mt-1.5 space-y-1">
              {apis.map((a) => (
                <li key={a.name} className="flex items-center gap-2">
                  <span className={a.on ? "text-success" : "text-danger"}>{a.on ? "✓" : "✗"}</span>
                  <span className="flex-1">{a.name}</span>
                  {!a.on && a.enableUrl && <a href={a.enableUrl} target="_blank" rel="noreferrer" className="rounded-md bg-accent px-2 py-0.5 font-medium text-accent-foreground">Enable</a>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const deleteAccount = useApp((s) => s.deleteAccount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const res = await deleteAccount();
    if (res.error) {
      setBusy(false);
      setError(res.error);
      return;
    }
    // Session is gone; the app-shell guard will route to /login.
  };

  return (
    <Modal onClose={onClose} className="max-w-md">
      <div className="overflow-y-auto p-6">
        <h2 className="text-base font-semibold">Delete your account?</h2>
        <p className="mt-2 text-[13px] text-muted">
          This permanently deletes your account and <strong>all</strong> of your chats,
          projects, and messages. This cannot be undone.
        </p>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={confirm} disabled={busy}>
            {busy ? "Deleting…" : "Delete account"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChatList() {
  const chats = useApp((s) => s.chats);
  const activeChatId = useApp((s) => s.activeChatId);
  const selectChat = useApp((s) => s.selectChat);
  const newChat = useApp((s) => s.newChat);

  const pinned = chats.filter((c) => c.pinned);
  const recent = chats.filter((c) => !c.pinned);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-3">
        <Button size="sm" variant="outline" className="w-full justify-start" onClick={() => newChat()}>
          <Plus size={15} /> New chat
        </Button>
        <button onClick={() => openMoney()} className="mt-1.5 flex h-8 w-full items-center gap-2 rounded-lg px-3 text-[13px] text-muted hover:bg-surface-hover hover:text-foreground"><Wallet size={15} /> Money<span className="ml-auto text-[10.5px]">cards · spending</span></button>
        <MoneyHost />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pinned.length > 0 && (
          <Section title="Pinned">
            {pinned.map((c) => (
              <ChatRow
                key={c.id}
                id={c.id}
                title={cleanTitle(c.title) || c.title}
                pinned
                active={c.id === activeChatId}
                onClick={() => selectChat(c.id)}
              />
            ))}
          </Section>
        )}
        <Section title="Recent">
          {recent.map((c) => (
            <ChatRow
              key={c.id}
              id={c.id}
              title={cleanTitle(c.title) || c.title}
              active={c.id === activeChatId}
              onClick={() => selectChat(c.id)}
            />
          ))}
        </Section>
      </div>
    </div>
  );
}

function ChatRow({
  id,
  title,
  active,
  pinned,
  onClick,
}: {
  id: string;
  title: string;
  active?: boolean;
  pinned?: boolean;
  onClick: () => void;
}) {
  const run = useChatRun(id);
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-lg pl-2.5 pr-1 text-[13px] transition-colors",
        active ? "bg-surface-hover font-medium" : "hover:bg-surface-hover",
      )}
    >
      {pinned && <Pin size={11} className="shrink-0 text-muted" />}
      <button onClick={onClick} className="min-w-0 flex-1 truncate py-2 text-left">
        {title || "New chat"}
      </button>
      {/* Agent working in this chat: live dot (pulses) or paused, with pause/resume. */}
      {run && (
        <span className="flex shrink-0 items-center gap-0.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", run.paused ? "bg-muted" : "animate-pulse bg-accent")} title={run.paused ? "Paused" : "Working"} />
          <RunControls chatId={id} size="sm" stop={false} />
        </span>
      )}
      <ChatMenu id={id} pinned={pinned} />
    </div>
  );
}

function ChatMenu({ id, pinned }: { id: string; pinned?: boolean }) {
  const [open, setOpen] = useState(false);
  const togglePinChat = useApp((s) => s.togglePinChat);
  const deleteChat = useApp((s) => s.deleteChat);

  return (
    <div
      className={cn(
        "relative shrink-0",
        // Always available on touch (no hover); hover-revealed on desktop.
        open ? "block" : "block md:hidden md:group-hover:block",
      )}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label="Chat options"
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground"
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-background p-1 shadow-lg">
            <button
              onClick={() => {
                togglePinChat(id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-hover"
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
              {pinned ? "Unpin" : "Pin"}
            </button>
            <button
              onClick={() => {
                deleteChat(id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-danger hover:bg-surface-hover"
            >
              <Trash2 size={13} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProjectList() {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const selectProject = useApp((s) => s.selectProject);
  const newProject = useApp((s) => s.newProject);
  const deleteProject = useApp((s) => s.deleteProject);
  const [sure, setSure] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-3">
        <Button size="sm" variant="outline" className="w-full justify-start" onClick={newProject}>
          <Plus size={15} /> New project
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Section title="Projects">
          {projects.map((p) => (
            <div key={p.id} className="group relative">
              <button
                onClick={() => selectProject(p.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                  p.id === activeProjectId ? "bg-surface-hover font-medium" : "hover:bg-surface-hover",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{p.name || "Untitled project"}</span>
                <span className="shrink-0 text-[11px] text-muted group-hover:invisible">{p.chatIds.length}</span>
              </button>
              {sure === p.id ? (
                <div className="absolute inset-y-0 right-1 flex items-center gap-1 text-[11.5px]">
                  <button onClick={() => { deleteProject(p.id); setSure(null); }} className="rounded-md bg-danger px-1.5 py-0.5 font-medium text-white">Delete</button>
                  <button onClick={() => setSure(null)} className="rounded-md bg-surface px-1.5 py-0.5 text-muted">Keep</button>
                </div>
              ) : (
                <button onClick={() => setSure(p.id)} aria-label="Delete project" title="Delete project" className="absolute inset-y-0 right-1 my-auto h-6 w-6 rounded-md text-muted opacity-0 hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"><Trash2 size={13} className="mx-auto" /></button>
              )}
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

/** A collapsible block of settings, so the page opens short and calm. */
function Group({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group rounded-xl border border-border">
      <summary className="flex cursor-pointer select-none items-center justify-between px-3.5 py-3 text-[13.5px] font-medium [&::-webkit-details-marker]:hidden">
        <span>{title}{hint && <span className="ml-2 text-[11.5px] font-normal text-muted">{hint}</span>}</span>
        <ChevronDown size={15} className="text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-border p-3.5">{children}</div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <h3 className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </h3>
      <div className="space-y-px">{children}</div>
    </div>
  );
}
