"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { EllipsisVertical, Pin, Trash2, History as HistoryIcon, FolderOpen, Minus, Printer, Code2, MessageSquare, Volume2, VolumeX, ArrowLeft, ArrowRight, RotateCw, X, Plus, Search, Sparkles, Globe, PanelRightClose, PanelRightOpen, Square, Download, ArrowUp, Star, Clock, Import, CheckCircle2, Loader2, ChevronDown, Check, Puzzle, Folder, Info, Eye } from "lucide-react";
import { syncEmails, connectGoogle, googleStatus, type GoogleStatus } from "@/lib/agent";
import { cn } from "@/lib/utils";
import { useApp, useChatRun } from "@/lib/store";
import { nativeApp, type BrowserDownload, type HistoryItem, type BrowserState, type BrowserTab, type ImportResult, type ImportSource, type Bookmark, type BrowserExtension } from "@/lib/native";
import { MarigoldIcon } from "@/components/marigold-icon";
import { MessageBubble } from "./chats-view";
import { stopAllAgents } from "@/lib/agent";
import { RunControls } from "@/components/shell/run-controls";
import { MicButton } from "@/components/shell/mic-button";
import { attLink } from "@/lib/app-icons";
import { MeetingCard } from "@/components/shell/meeting-control";
import { isMeetingUrl, useMeeting } from "@/lib/meeting";
import { PulseBar } from "./pulse-bar";

/**
 * The Marigold Browser.
 *  • New tab = Marigold's chat space: ask anything right in the tab; type a site to go there.
 *  • Web pages are plain Chromium (drawn by the app's main process into the area this page
 *    reserves); the address bar navigates/searches like any browser — no agent involved.
 *  • On a web page the assistant opens on the right and continues that tab's conversation,
 *    knowing the page you're on (and everything Marigold knows about you).
 */

const looksLikeUrl = (s: string) => /^(https?:\/\/|localhost(:\d+)?)/i.test(s.trim()) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s.trim());
/** The search terms when this address is a search engine's results page (the address bar shows what you searched, not the long URL). */
function searchTerms(url: string): string | null {
  try {
    const u = new URL(url), h = u.hostname.replace(/^www\./, ""), q = u.searchParams.get("q") ?? u.searchParams.get("query");
    if (!q) return null;
    if (/^google\.[a-z.]+$/.test(h) && u.pathname === "/search") return q;
    if (h === "bing.com" && u.pathname === "/search") return q;
    if (h === "duckduckgo.com" && (u.pathname === "/" || u.pathname === "")) return q;
    if (h === "search.brave.com" && u.pathname === "/search") return q;
    if (h === "startpage.com" && /^\/(do|sp)\/search/.test(u.pathname)) return q;
    if (u.origin === window.location.origin && u.pathname === "/search") return q; // an older Marigold results page
  } catch { /* not a URL */ }
  return null;
}
/** Marigold's own results page (it carries its own Brief). */
const isOwnSearch = (url: string) => { try { const u = new URL(url); return u.origin === window.location.origin && u.pathname === "/search"; } catch { return false; } };
const pageOf = (t: BrowserTab | null) => (t && !t.newTab && /^https?:/.test(t.url) ? t : null);

export function BrowserPage() {
  const bridge = nativeApp()?.browser;
  const [st, setSt] = useState<BrowserState | null>(null);
  // Beside a search results page it opens on its own (with the Brief); close it and it stays closed for that search.
  const [assistant, toggleAssistant] = useState(false);
  const dismissedSearch = useRef(new Set<string>());
  const autoOpened = useRef("");
  const activeNow = st?.tabs.find((t) => t.id === st.activeId);
  const resultsKey = activeNow && /^https?:/.test(activeNow.url) && !isOwnSearch(activeNow.url) && searchTerms(activeNow.url) ? `${activeNow.id}|${searchTerms(activeNow.url)}` : "";
  useEffect(() => {
    if (!resultsKey || autoOpened.current === resultsKey) return;
    autoOpened.current = resultsKey;
    if (!dismissedSearch.current.has(resultsKey)) void Promise.resolve().then(() => toggleAssistant(true));
  }, [resultsKey]);
  // Notes begin: the assistant opens, so the notes are taken (and later acted on) right where the user can see them.
  const meetingPhase = useMeeting().phase;
  useEffect(() => { if (meetingPhase === "recording" || meetingPhase === "writing" || meetingPhase === "done") void Promise.resolve().then(() => toggleAssistant(true)); }, [meetingPhase]);
  // A video call tab: the assistant opens (once per call) with the "take notes" card, so notes are offered only when they're needed.
  const callKey = activeNow && isMeetingUrl(activeNow.url, activeNow.title) ? `${activeNow.id}|${activeNow.url.split("?")[0]}` : "";
  const callOpened = useRef("");
  useEffect(() => {
    if (!callKey || callOpened.current === callKey) return;
    callOpened.current = callKey;
    void Promise.resolve().then(() => toggleAssistant(true));
  }, [callKey]);
  const setAssistantByUser = (v: boolean) => { if (!v && resultsKey) dismissedSearch.current.add(resultsKey); toggleAssistant(v); };
  const [findOpen, setFindOpen] = useState(false);
  // A question to hand the assistant as soon as it is open (from the results page, "Go deeper").
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const [panel, setPanel] = useState<"history" | "clear" | null>(null);
  useEffect(() => {
    if (!bridge) return;
    void bridge.state().then(setSt);
    return bridge.onState(setSt);
  }, [bridge]);
  // Tell the app the Browser tab is showing (browser shortcuts like ⌘T work whenever it is, even with a menu open).
  useEffect(() => {
    void bridge?.shown(true);
    return () => { void bridge?.shown(false); };
  }, [bridge]);

  // ⌘Y opens History; ⌘D / the star changed bookmarks → refresh the bar.
  useEffect(() => {
    const offP = bridge?.onPanel((p) => { if (p === "history") setPanel("history"); else if (p === "clear") setPanel("clear"); else if (p === "bookmarks-bar") window.dispatchEvent(new Event("mg-toggle-bookmarks")); else if (p === "tab-search") window.dispatchEvent(new Event("mg-tab-search")); else window.dispatchEvent(new Event("mg-open-downloads")); });
    const offB = bridge?.onBookmarksChanged(() => window.dispatchEvent(new Event("mg-bookmarks")));
    return () => { offP?.(); offB?.(); };
  }, [bridge]);

  // Meeting notes hand their tasks to the assistant here.
  useEffect(() => {
    const f = (e: Event) => { const q = (e as CustomEvent<{ q?: string }>).detail?.q; if (q) { toggleAssistant(true); setPendingAsk(q); } };
    window.addEventListener("mg-ask-assistant", f);
    return () => window.removeEventListener("mg-ask-assistant", f);
  }, []);

  // "Go deeper" / a follow-up on Marigold's results page → open the assistant and ask it there (the page stays put).
  useEffect(() => {
    return nativeApp()?.onAskTab?.((q, deep) => {
      toggleAssistant(true);
      setPendingAsk(deep ? `Give me an in-depth briefing on “${q}”: the big picture, the key details and numbers, what is debated or has changed lately, and the best sources to read next. Then suggest what to dig into.` : q);
    });
  }, []);

  // ⌘F: find in the page (from inside a page, or from the Marigold window).
  useEffect(() => {
    const off = bridge?.onFindOpen(() => setFindOpen(true));
    const key = (e: KeyboardEvent) => { if (e.metaKey && e.key.toLowerCase() === "f") { e.preventDefault(); setFindOpen(true); } };
    window.addEventListener("keydown", key);
    return () => { off?.(); window.removeEventListener("keydown", key); };
  }, [bridge]);

  // Switched account → its bookmarks (bar, star) and shortcuts.
  const profileKey = st?.profile ?? "";
  useEffect(() => { notifyBookmarks(); }, [profileKey]);

  if (!bridge) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Globe size={36} className="text-muted" />
        <p className="max-w-sm text-sm">The Marigold Browser runs inside the Marigold app for Mac.</p>
        <p className="max-w-sm text-xs text-muted">Open Marigold from your Applications folder or the menu-bar flower, then choose Browser.</p>
      </div>
    );
  }
  const active = st?.tabs.find((t) => t.id === st.activeId) ?? null;
  const onWeb = !!pageOf(active);
  const profileEmail = st?.profiles.find((p) => p.key === st.profile)?.email ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabStrip st={st} />
      <TabSearch st={st} />
      <Toolbar st={st} tab={active} assistant={assistant} setAssistant={setAssistantByUser} onWeb={onWeb} onFind={() => setFindOpen(true)} onPanel={setPanel} />
      <BookmarksBar st={st} tab={active} />
      <div className="relative h-0">
        {active?.loading && !active.newTab && <div className="absolute inset-x-0 top-0 z-10 h-[2px] overflow-hidden"><div className="h-full w-1/3 animate-[mgload_1.1s_ease-in-out_infinite] rounded-full bg-accent" /></div>}
      </div>
      {active?.authAsk && <AuthBar key={active.authAsk.id} ask={active.authAsk} />}
      {onWeb && findOpen && <FindBar key={active?.id} onClose={() => setFindOpen(false)} />}
      {panel === "history" && <HistoryPanel onClose={() => setPanel(null)} onOpen={(u) => { void bridge.navigate(active?.id, u); setPanel(null); }} onClear={() => setPanel("clear")} />}
      {panel === "clear" && <ClearDataDialog onClose={() => setPanel(null)} />}
      {onWeb && relevantBlocked(active).length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-danger/10 px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1">
            Parts of this page are blocked on this Mac ({relevantBlocked(active).slice(0, 4).join(", ")}), so it may not load or play. A site blocker or the hosts file is doing this, not Marigold. Chrome is blocked the same way.
          </span>
        </div>
      )}
      {onWeb && active?.permAsk && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate">
            <b>{active.permAsk.site}</b> wants to {({ media: (() => { const m = (active.permAsk as { media?: string[] }).media ?? []; return m.length === 1 ? (m[0] === "audio" ? "use your microphone" : "use your camera") : "use your camera and microphone"; })(), geolocation: "know your location", notifications: "show notifications", "clipboard-read": "read your clipboard", "display-capture": "record your screen", midi: "use MIDI devices" } as Record<string, string>)[active.permAsk.permission] ?? active.permAsk.permission}
          </span>
          <button onClick={() => void nativeApp()?.browser?.answerPermission(active.id, false)} className="h-6 rounded-md border border-border px-2 text-[11.5px] hover:bg-surface-hover">Don&apos;t allow</button>
          <button onClick={() => void nativeApp()?.browser?.answerPermission(active.id, true)} className="h-6 rounded-md bg-accent px-2 text-[11.5px] font-medium text-black">Allow</button>
        </div>
      )}
      {onWeb && active?.googleSignIn && <GoogleSignInBar key={`${st?.profile ?? ""}|${active.id}`} tab={active} />}
      {onWeb && active?.loginPage && <SignInBar key={st?.profile ?? ""} tab={active} />}
      <div className="flex min-h-0 flex-1 bg-surface/50">
        {active && !active.newTab ? <div className="flex min-w-0 flex-1 pb-2 pl-2 pr-0"><BrowserHost which="active" className="min-w-0 flex-1 rounded-[14px] bg-background" /></div> : <NewTabHome tab={active} profile={st?.profile ?? ""} email={profileEmail} />}
        {onWeb && assistant && active && <AssistantPanel tab={active} agentTab={st?.tabs.find((t) => t.id === st.agentId) ?? null} pendingAsk={pendingAsk} onAsked={() => setPendingAsk(null)} />}
      </div>
      <PulseBar />
    </div>
  );
}

// ---------------------------------------------------------------- the page area (live tab drawn here)

/** While a menu is open over the page area, the live page steps aside for a still picture. */
export function useBrowserOverlay(open: boolean) {
  const set = useApp((s) => s.setBrowserOverlay);
  useEffect(() => {
    if (!open) return;
    set(1);
    return () => set(-1);
  }, [open, set]);
}

/** Last picture of each host's page (shown while the layout slides). */
const LAST_SHOT: Record<string, string> = {};

/**
 * Reserves an area; the app's main process places the live tab exactly over it. Follows resizes,
 * and steps aside while a Marigold dialog (Settings, Safety…) is open.
 */
export function BrowserHost({ which, className }: { which: "active" | "agent"; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const bridge = nativeApp()?.browser;
  const animUntil = useApp((s) => s.layoutAnimUntil);
  const overlay = useApp((s) => s.browserOverlay > 0);
  // While the sidebar slides, show a still picture of the page (the live page is a separate native
  // layer that can't follow a CSS animation smoothly), then put the live page back at its final size.
  const [startFrozen] = useState(() => Date.now() < useApp.getState().layoutAnimUntil);
  const [still, setStill] = useState<string | null>(() => (startFrozen ? LAST_SHOT[which] ?? null : null));
  const frozen = useRef(startFrozen);
  const placed = useRef("");

  const place = useCallback(() => {
    const el = ref.current;
    if (!el || !bridge) return;
    if (Date.now() < useApp.getState().layoutAnimUntil || useApp.getState().browserOverlay > 0) {
      if (!frozen.current || placed.current) {
        frozen.current = true;
        placed.current = "";
        void bridge.freeze().then((img) => { if (img) LAST_SHOT[which] = img; setStill(img || LAST_SHOT[which] || null); });
      }
      return;
    }
    const covered = !!document.querySelector('[role="dialog"]');
    const r = el.getBoundingClientRect();
    if (covered || r.width < 20 || r.height < 20) {
      if (placed.current !== "off") { placed.current = "off"; void bridge.host(null); }
      return;
    }
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key !== placed.current) { placed.current = key; void bridge.host({ which, bounds: { x: r.left, y: r.top, width: r.width, height: r.height } }); }
    if (frozen.current) { frozen.current = false; setTimeout(() => setStill(null), 140); } // live page is up — drop the picture
  }, [bridge, which]);

  // A menu opened/closed over the page → step aside / come back.
  useEffect(() => { place(); }, [overlay, place]);

  // When a slide ends, place the live page.
  useEffect(() => {
    const wait = animUntil - Date.now();
    if (wait <= 0) return;
    place();
    const t = setTimeout(place, wait + 30);
    return () => clearTimeout(t);
  }, [animUntil, place]);

  useLayoutEffect(() => {
    if (!bridge) return;
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    const mo = new MutationObserver(place);
    mo.observe(document.body, { childList: true, subtree: false });
    window.addEventListener("resize", place);
    const t = setInterval(place, 1000); // layout shifts the observers can't see
    return () => {
      ro.disconnect(); mo.disconnect(); window.removeEventListener("resize", place); clearInterval(t);
      void bridge.host(null);
      // Keep a picture for next time (e.g. Chats → Browser shows it during the slide, not a blank box).
      void bridge.snapshot?.().then((img) => { if (img) LAST_SHOT[which] = img; }).catch(() => {});
    };
  }, [bridge, place, which]);

  return (
    <div ref={ref} className={cn("relative overflow-hidden", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {still && <img src={still} alt="" className="pointer-events-none absolute left-0 top-0 h-full w-full object-cover object-left-top" />}
    </div>
  );
}

// ---------------------------------------------------------------- tabs + toolbar

const PROFILE_COLORS = ["bg-amber-500", "bg-sky-500", "bg-emerald-500", "bg-rose-500", "bg-violet-500", "bg-orange-500"];

/**
 * Account switcher (right side of the address bar). One profile per email: its own logins and
 * its own saved tabs. Lists every account Marigold knows plus ones found on this Mac (signed
 * into the user's Chrome profiles) — but nothing is used until the user CONFIRMS it.
 */
function ProfileSwitcher({ st }: { st: BrowserState | null }) {
  const bridge = nativeApp()!.browser!;
  const user = useApp((s) => s.user);
  const saveProfile = useApp((s) => s.saveProfile);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState("");
  const [found, setFound] = useState<{ email: string; from: string; id: string; dir: string }[]>([]);
  useBrowserOverlay(open);
  /** After confirming: bringing that Chrome profile's logins/history/bookmarks into the new profile. */
  const [importing, setImporting] = useState<{ email: string; msg: string; done?: boolean } | null>(null);
  /** An email waiting for the user's confirmation (to add) or removal confirmation. */
  const [confirm, setConfirm] = useState<{ email: string; from?: string; remove?: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setConfirm(null); } };
    window.addEventListener("mousedown", close);
    // Accounts signed into the user's other browsers on this Mac (suggestions only).
    void bridge.importSources().then((srcs) => setFound(srcs.flatMap((b) => b.profiles.filter((p) => p.email).map((p) => ({ email: p.email.toLowerCase(), from: `${b.label} · ${p.name}`, id: b.id, dir: p.dir }))))).catch(() => {});
    return () => window.removeEventListener("mousedown", close);
  }, [open, bridge]);

  const list = st?.profiles?.length ? st.profiles : [{ key: "", email: user.email }];
  const idx = Math.max(0, list.findIndex((p) => p.key === (st?.profile ?? "")));
  const cur = list[idx];
  const have = new Set(list.map((p) => p.email.toLowerCase()));
  const suggestions = found.filter((f, i, a) => !have.has(f.email) && a.findIndex((x) => x.email === f.email) === i);

  const ask = (raw: string, from?: string) => {
    const e = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { setErr("That doesn't look like an email."); return; }
    if (have.has(e)) { setErr("That account is already added."); return; }
    setErr("");
    setConfirm({ email: e, from });
  };
  const confirmAdd = async () => {
    if (!confirm) return;
    const extras = [...new Set([...(user.extraEmails ?? []), confirm.email])];
    await saveProfile({ extraEmails: extras });
    await syncEmails(user.email || undefined, extras);
    setAdding(""); setConfirm(null);
    await bridge.setProfile(confirm.email);
    // Signed into this email in Chrome? Bring that profile's logins, history and bookmarks over.
    const src = found.find((f) => f.email === confirm.email);
    if (!src) { setOpen(false); return; }
    setImporting({ email: confirm.email, msg: `Bringing over your ${src.from.split(" · ")[0]} logins, history and bookmarks… If macOS asks about “Safe Storage”, click Allow.` });
    const r = await bridge.importFrom({ id: src.id, profile: src.dir, what: { bookmarks: true, history: true, cookies: true, extensions: true } });
    if (r.ok && r.signins) await bridge.reloadAll();
    setImporting({
      email: confirm.email, done: true,
      msg: r.ok
        ? [`Switched to ${confirm.email}.`, r.signins ? `Signed in with ${r.signins} saved logins.` : "", r.history != null ? `${r.history} history items,` : "", r.bookmarks != null ? `${r.bookmarks} bookmarks.` : "", r.extensions?.length ? `Extensions: ${r.extensions.join(", ")}.` : "", r.signinsError ?? ""].filter(Boolean).join(" ")
        : `Switched to ${confirm.email}, but the import didn't work: ${r.error}`,
    });
  };
  const confirmRemove = async () => {
    if (!confirm) return;
    const extras = (user.extraEmails ?? []).filter((x) => x.toLowerCase() !== confirm.email);
    await saveProfile({ extraEmails: extras });
    await syncEmails(user.email || undefined, extras);
    if (st?.profile === confirm.email) await bridge.setProfile("");
    else await bridge.state();
    setConfirm(null);
  };

  return (
    <div ref={box} className="relative shrink-0">
      <button onClick={() => { setOpen(!open); setConfirm(null); }} title={`Browsing as ${cur?.email || "you"}. Click to switch accounts`} aria-label="Switch account"
        className="flex h-8 items-center gap-1 rounded-full pl-1 pr-1.5 hover:bg-surface-hover">
        <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold uppercase text-white", PROFILE_COLORS[idx % PROFILE_COLORS.length])}>{(cur?.email || "?")[0]}</span>
        <ChevronDown size={11} className="text-muted" />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-[90] w-80 overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          {importing ? (
            <div className="space-y-2.5 p-3 text-[12.5px]">
              <p className="flex items-center gap-1.5 font-medium">
                {importing.done ? <CheckCircle2 size={14} className="text-accent" /> : <Loader2 size={14} className="animate-spin text-accent" />}
                {importing.done ? "Ready" : `Setting up ${importing.email}`}
              </p>
              <p className="text-[11.5px] text-muted">{importing.msg}</p>
              {importing.done && <div className="flex justify-end"><button onClick={() => { setImporting(null); setOpen(false); }} className="h-7 rounded-md bg-accent px-2.5 text-[11.5px] font-medium text-black">Done</button></div>}
            </div>
          ) : confirm ? (
            <div className="space-y-2.5 p-3 text-[12.5px]">
              {confirm.remove ? (
                <>
                  <p className="font-medium">Remove {confirm.email}?</p>
                  <p className="text-[11.5px] text-muted">Its tab list and the agent&apos;s access go away. Its saved logins stay on this Mac in case you add it again.</p>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setConfirm(null)} className="h-7 rounded-md border border-border px-2.5 text-[11.5px] hover:bg-surface-hover">Cancel</button>
                    <button onClick={() => void confirmRemove()} className="h-7 rounded-md bg-danger px-2.5 text-[11.5px] font-medium text-white">Remove</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="font-medium">Use {confirm.email} with Marigold?</p>
                  {confirm.from && <p className="text-[11px] text-muted">Found in {confirm.from}. Its logins, history and bookmarks will come over too.</p>}
                  <ul className="ml-4 list-disc space-y-0.5 text-[11.5px] text-muted">
                    <li>It gets its own browser profile, with its own logins and saved tabs.</li>
                    <li>Marigold can act as this account (open its email, sites, Google) when you name it, with the same approval rules.</li>
                    <li>Only confirm emails that are yours.</li>
                  </ul>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setConfirm(null)} className="h-7 rounded-md border border-border px-2.5 text-[11.5px] hover:bg-surface-hover">Cancel</button>
                    <button onClick={() => void confirmAdd()} className="h-7 rounded-md bg-accent px-2.5 text-[11.5px] font-medium text-black">Yes, it&apos;s mine</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted">Your accounts</p>
              {list.map((p, i) => (
                <div key={p.key || "primary"} className="group flex items-center hover:bg-surface-hover">
                  <button onClick={() => { setOpen(false); void bridge.setProfile(p.key); }} className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-[12.5px]">
                    <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold uppercase text-white", PROFILE_COLORS[i % PROFILE_COLORS.length])}>{(p.email || "?")[0]}</span>
                    <span className="min-w-0 flex-1 truncate">{p.email || "Primary"}{p.key === "" && <span className="ml-1.5 text-[10px] text-muted">primary</span>}</span>
                    {p.key === (st?.profile ?? "") && <Check size={13} className="shrink-0 text-accent" />}
                  </button>
                  {p.key !== "" && (
                    <button onClick={() => setConfirm({ email: p.email.toLowerCase(), remove: true })} title={`Remove ${p.email}`} className="mr-2 hidden rounded p-1 text-muted hover:text-danger group-hover:block"><X size={12} /></button>
                  )}
                </div>
              ))}
              {suggestions.length > 0 && (
                <>
                  <p className="border-t border-border px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted">Found on this Mac</p>
                  {suggestions.map((f) => (
                    <button key={f.email} onClick={() => ask(f.email, f.from)} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-surface-hover">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-[11px] uppercase text-muted">{f.email[0]}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate">{f.email}</span><span className="block truncate text-[10.5px] text-muted">{f.from}</span></span>
                      <Plus size={13} className="shrink-0 text-muted" />
                    </button>
                  ))}
                </>
              )}
              <div className="border-t border-border px-3 py-2">
                <div className="flex gap-1.5">
                  <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask(adding)} placeholder="Add another email" className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent" />
                  <button onClick={() => ask(adding)} className="h-7 rounded-md bg-accent px-2 text-[11px] font-medium text-black">Add</button>
                </div>
                {err && <p className="mt-1 text-[11px] text-danger">{err}</p>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Tab sizing: every tab the same width, up to MAX when there is room; below TITLE the title drops out; MIN is the floor. */
const TAB_MAX = 240, TAB_MIN = 40, TAB_ROOM_FOR_TITLE = 92, PIN_W = 40;

/** ⇧⌘A (or the search button): type a few letters, jump to any open tab. Arrow keys and Enter; Esc closes. */
function TabSearch({ st }: { st: BrowserState | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const setOverlay = useApp((s) => s.setBrowserOverlay);
  useEffect(() => { const f = () => { setQ(""); setI(0); setOpen(true); }; window.addEventListener("mg-tab-search", f); return () => window.removeEventListener("mg-tab-search", f); }, []);
  useEffect(() => { if (!open) return; setOverlay(1); return () => setOverlay(-1); }, [open, setOverlay]);
  const all = (st?.tabs ?? []).filter((t) => !t.agent);
  const ql = q.trim().toLowerCase();
  const hits = (ql ? all.filter((t) => (t.title + " " + t.url).toLowerCase().includes(ql)) : all).slice(0, 12);
  if (!open) return null;
  const go = (id: number) => { setOpen(false); void nativeApp()?.browser?.activate(id); };
  return (
    <Modal onClose={() => setOpen(false)} className="max-w-lg">
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} placeholder={`Search ${all.length} open tabs`} aria-label="Search open tabs"
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => Math.min(hits.length - 1, n + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => Math.max(0, n - 1)); } else if (e.key === "Enter" && hits[i]) go(hits[i].id); }}
        className="h-12 w-full border-b border-border bg-transparent px-4 text-[14px] outline-none" />
      <div className="max-h-[50dvh] overflow-y-auto p-1.5" role="listbox">
        {hits.map((t, n) => (
          <button key={t.id} role="option" aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={() => go(t.id)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", n === i && "bg-surface-hover")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {t.favicon ? <img src={t.favicon} alt="" className="h-4 w-4 shrink-0 rounded-sm" /> : <Globe size={14} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{t.title || t.url}</span><span className="block truncate text-[11px] text-muted">{(() => { try { return new URL(t.url).hostname; } catch { return t.url; } })()}</span></span>
            {t.id === st?.activeId && <span className="shrink-0 text-[10.5px] text-muted">current</span>}
          </button>
        ))}
        {!hits.length && <p className="px-3 py-4 text-[12.5px] text-muted">No open tab matches.</p>}
      </div>
    </Modal>
  );
}

function TabStrip({ st }: { st: BrowserState | null }) {
  const bridge = nativeApp()!.browser!;
  const tabs = st?.tabs ?? [];
  // Closing: the page switches at once, while a "ghost" of the tab folds shut in the strip so nothing jumps.
  const [ghosts, setGhosts] = useState<{ tab: BrowserTab; index: number; w: number; go: boolean }[]>([]);
  const els = useRef(new Map<number, HTMLDivElement>());
  // Tab width is measured, not guessed: every tab gets the same width, as wide as the room allows (up to MAX), never below MIN.
  const stripRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1200);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pinnedN = tabs.filter((t) => t.pinned).length;
  const n = Math.max(1, tabs.length - pinnedN);
  const room = avail - 16 /* strip padding */ - 28 /* the + button */ - 8 /* gap before it */ - pinnedN * (PIN_W + 2) - (n - 1) * 2 /* gaps between tabs */;
  const tabW = Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor(room / n)));
  const tiny = tabW < TAB_ROOM_FOR_TITLE; // no title at this size: just the icon
  const [drag, setDrag] = useState<{ id: number; over: number } | null>(null);

  const close = (t: BrowserTab, index: number) => {
    const w = els.current.get(t.id)?.offsetWidth ?? 160;
    setGhosts((g) => [...g, { tab: t, index, w, go: false }]);
    requestAnimationFrame(() => requestAnimationFrame(() => setGhosts((g) => g.map((x) => (x.tab.id === t.id ? { ...x, go: true } : x)))));
    setTimeout(() => setGhosts((g) => g.filter((x) => x.tab.id !== t.id)), 220);
    void bridge.close(t.id);
  };

  // Real tabs with the folding ghosts slotted back in where they were.
  const items: ({ kind: "tab"; tab: BrowserTab; index: number } | { kind: "ghost"; g: (typeof ghosts)[number] })[] = tabs.map((tab, index) => ({ kind: "tab", tab, index }));
  for (const g of [...ghosts].sort((x, y) => x.index - y.index)) items.splice(Math.min(g.index, items.length), 0, { kind: "ghost", g });

  return (
    <div ref={stripRef} className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface/50 px-2.5" onDoubleClick={(e) => { if (e.target === e.currentTarget) void bridge.newTab(); }}>
      {/* Every tab has the same width and they shrink together; the + never leaves the strip. */}
      <div className="flex shrink-0 items-center gap-1" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag((d) => (d ? { ...d, over: -1 } : d)); }}>
        {items.map((it) => {
          if (it.kind === "ghost") {
            const { g } = it;
            return (
              <div key={`g${g.tab.id}`} aria-hidden className="h-8 shrink-0 overflow-hidden rounded-lg bg-surface-hover/50 transition-[width,opacity] duration-200 ease-out" style={{ width: g.go ? 0 : g.w, opacity: g.go ? 0 : 0.6 }} />
            );
          }
          const { tab: t, index } = it;
          const active = t.id === st?.activeId;
          const small = tiny || !!t.pinned; // pinned tabs are icon-only, like Chrome
          return (
            <div
              key={t.id}
              ref={(el) => { if (el) els.current.set(t.id, el); else els.current.delete(t.id); }}
              draggable
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag({ id: t.id, over: index }); }}
              onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== index) setDrag({ ...drag, over: index }); } }}
              onDrop={(e) => { e.preventDefault(); if (drag && drag.id !== t.id) void bridge.moveTab(drag.id, index); setDrag(null); }}
              onDragEnd={() => setDrag(null)}
              onMouseDown={(e) => { if (e.button === 0) void bridge.activate(t.id); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(t, index); } }}
              onContextMenu={(e) => { e.preventDefault(); void bridge.tabMenu(t.id); }}
              style={{ width: t.pinned ? PIN_W : tabW }}
              className={cn(
                "group relative flex h-8 shrink-0 cursor-default select-none items-center overflow-hidden whitespace-nowrap rounded-lg text-[12.5px] transition-[width,background-color] duration-150 ease-out [animation:mgtabin_.16s_ease-out]",
                small ? "justify-center px-1" : "gap-1.5 pl-2.5 pr-1.5",
                active ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border" : "text-muted hover:bg-surface-hover hover:text-foreground",
                drag?.id === t.id && "opacity-40",
                drag && drag.id !== t.id && drag.over === index && "shadow-[inset_2px_0_0_var(--accent)]",
              )}
              title={t.newTab ? "New tab" : `${t.title}\n${t.url}`}
            >
              {/* On a tiny tab the close button takes the icon's place, and only while the pointer is over it. */}
              <span className={cn("flex shrink-0 items-center justify-center", small && !t.pinned && "group-hover:invisible")}>
                {t.newTab ? <MarigoldIcon size={13} /> : t.loading ? <RotateCw size={12} className="animate-spin" /> : <TabIcon url={t.url} src={t.favicon} />}
              </span>
              {!small && <span className="min-w-0 flex-1 truncate">{t.newTab ? "New tab" : t.title || "Loading…"}</span>}
              {!small && (t.audible || t.muted) && <button onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void bridge.mute(t.id); }} title={t.muted ? "Unmute tab" : "Mute tab"} aria-label={t.muted ? "Unmute tab" : "Mute tab"} className="shrink-0 text-muted hover:text-foreground">{t.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>}
              {tabW >= 120 && t.agent && <Sparkles size={11} className="shrink-0 text-accent" aria-label="Marigold is using this tab" />}
              {!t.pinned && <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); close(t, index); }}
                className={cn(
                  "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-opacity duration-100 hover:bg-surface-hover",
                  tiny ? "absolute inset-0 m-auto bg-surface opacity-0 group-hover:opacity-100" : active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
                aria-label="Close tab"
              >
                <X size={11} />
              </button>}
            </div>
          );
        })}
      </div>
      <button onClick={() => void bridge.newTab()} title="New tab (⌘T)" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground" aria-label="New tab">
        <Plus size={14} />
      </button>
    </div>
  );
}

type Option = { kind: "go" | "search" | "suggest"; label: string; url: string; sub?: string; icon?: "bookmark" | "history" };

/** The address bar: a normal browser address bar (Chromium navigates; Google searches). */
function Toolbar({ st, tab, assistant, setAssistant, onWeb, onFind, onPanel }: { st: BrowserState | null; tab: BrowserTab | null; assistant: boolean; setAssistant: (v: boolean) => void; onWeb: boolean; onFind: () => void; onPanel: (p: "history" | "clear") => void }) {
  const bridge = nativeApp()!.browser!;
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState(0);
  const [sugg, setSugg] = useState<{ url: string; title: string; kind: "bookmark" | "history" }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const pageUrl = pageOf(tab)?.url ?? "";
  /** What the box shows when idle: the page address (or, on Marigold's own results page, what you searched for). */
  const idle = searchTerms(pageUrl) ?? pageUrl;
  const engineName = ({ startpage: "Startpage", duckduckgo: "DuckDuckGo", marigold: "Marigold" } as Record<string, string>)[st?.engine ?? "startpage"] ?? "Startpage";

  useEffect(() => bridge.onFocusOmnibox(() => { input.current?.focus(); input.current?.select(); }), [bridge]);
  useEffect(() => {
    const q = text.trim();
    let live = true;
    if (!focused || !q || q === idle) { void Promise.resolve().then(() => live && setSugg([])); return () => { live = false; }; }
    void bridge.suggest(q).then((r) => live && setSugg(r)).catch(() => {});
    if (looksLikeUrl(q)) void bridge.preconnect?.(q);
    return () => { live = false; };
  }, [text, focused, idle, bridge]);

  const typed = text.trim();
  // (suggestions open over the page → registered below once options are known)
  const options = useMemo<Option[]>(() => {
    if (!typed || typed === idle) return [];
    const first: Option = looksLikeUrl(typed)
      ? { kind: "go", label: typed, url: typed, sub: "Go to site" }
      : { kind: "search", label: typed, url: typed, sub: `Search ${engineName}` };
    return [first, ...sugg.filter((s) => s.url !== first.url).map((s) => ({ kind: "suggest" as const, label: s.title, url: s.url, sub: s.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), icon: s.kind }))];
  }, [typed, idle, sugg]);

  useBrowserOverlay(focused && options.length > 0);
  const go = (o?: Option) => {
    const target = o?.url ?? typed;
    if (!target) return;
    void bridge.navigate(tab?.id, target);
    input.current?.blur();
  };

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-1 bg-surface/50 px-2">
      <IconBtn label="Back" disabled={!tab?.canBack} onClick={() => void bridge.nav(tab?.id, "back")}><ArrowLeft size={15} /></IconBtn>
      <IconBtn label="Forward" disabled={!tab?.canForward} onClick={() => void bridge.nav(tab?.id, "forward")}><ArrowRight size={15} /></IconBtn>
      <IconBtn label={tab?.loading ? "Stop" : "Reload"} onClick={() => void bridge.nav(tab?.id, tab?.loading ? "stop" : "reload")}>
        {tab?.loading ? <X size={15} /> : <RotateCw size={14} />}
      </IconBtn>
      <div className="relative min-w-0 flex-1">
        <div className={cn("flex h-8 items-center gap-2 rounded-full border bg-surface px-3", focused ? "border-accent" : "border-border")}>
          <Search size={13} className="shrink-0 text-muted" />
          <input
            ref={input}
            value={focused ? text : idle}
            onChange={(e) => { setText(e.target.value); setPick(0); }}
            onFocus={(e) => { setText(idle); setFocused(true); const el = e.target; requestAnimationFrame(() => el.select()); }}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => Math.min(p + 1, options.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => Math.max(p - 1, 0)); }
              if (e.key === "Escape") input.current?.blur();
              if (e.key === "Enter") { e.preventDefault(); go(options[pick]); }
            }}
            placeholder={`Search ${engineName} or type a web address`}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
          />
          {!focused && pageUrl && <StarButton tab={tab!} />}
        </div>
        {focused && options.length > 0 && (
          <div className="absolute inset-x-0 top-9 z-50 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-xl">
            {options.map((o, i) => (
              <button key={`${o.kind}-${o.url}`} onMouseDown={(e) => { e.preventDefault(); go(o); }} onMouseEnter={() => setPick(i)}
                className={cn("flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px]", i === pick && "bg-surface-hover")}>
                {o.kind === "search" ? <Search size={13} className="shrink-0 text-muted" /> : o.icon === "bookmark" ? <Star size={13} className="shrink-0 text-muted" /> : o.icon === "history" ? <Clock size={13} className="shrink-0 text-muted" /> : <Globe size={13} className="shrink-0 text-muted" />}
                <span className="min-w-0 truncate">{o.label}</span>
                {o.sub && <span className="ml-auto shrink-0 truncate pl-3 text-[11px] text-muted">{o.sub}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <DownloadsButton downloads={st?.downloads ?? []} />
      <ExtensionsMenu profile={st?.profile ?? ""} />
      <ProfileSwitcher st={st} />
      <MoreMenu st={st} tab={tab} onFind={onFind} onPanel={onPanel} />
      {onWeb && (assistant ? (
        <IconBtn label="Hide Marigold" onClick={() => setAssistant(false)}><PanelRightClose size={15} /></IconBtn>
      ) : (
        <AskMarigoldButton onClick={() => setAssistant(true)} />
      ))}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- connecting Google (one click)

/** Starts the connection: the app ships its own Google client, so this is just a button + Google's approval page. */
function useGoogleConnect(email: string) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "waiting" | "done" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => { void googleStatus().then(setStatus); }, [email]);
  const connected = !!status?.accounts.some((a) => a.email === email.toLowerCase());
  const start = async () => {
    if (!status?.configured) { window.dispatchEvent(new Event("mg-open-settings")); return; } // the developer's one-time setup lives in Settings
    setPhase("waiting"); setError("");
    const r = await connectGoogle(email);
    if (r.ok) { setPhase("done"); setStatus(await googleStatus()); } else { setPhase("error"); setError(r.error ?? ""); }
  };
  return { status, connected, phase, error, start };
}

/** New tab: offers the one-click Google connection for the account you're browsing as. */
function GoogleConnectCard({ email }: { email: string }) {
  const g = useGoogleConnect(email);
  const key = `marigold.googleCard.${email}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === "off"; } catch { return false; } });
  if (!email || hidden || !g.status?.configured || (g.connected && g.phase !== "done")) return null;
  return (
    <div className="mt-8 flex items-center gap-3 rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/[0.09] to-surface p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15"><Sparkles size={17} className="text-accent" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{g.phase === "done" ? "Google is connected" : "Connect your Google account"}</p>
        <p className="text-[12px] text-muted">
          {g.phase === "done" ? `Marigold can now use Gmail, Calendar, Docs, Sheets and Slides for ${email}.`
            : g.phase === "waiting" ? "Approve it on Google's page in your browser, then come back here."
            : g.phase === "error" ? g.error
            : `One click, then Google asks for your OK. Lets Marigold work in Gmail, Calendar, Docs, Sheets and Slides for ${email}.`}
        </p>
      </div>
      {g.phase !== "done" && (
        <button onClick={() => void g.start()} disabled={g.phase === "waiting"} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-black disabled:opacity-60">
          {g.phase === "waiting" ? <><Loader2 size={13} className="animate-spin" /> Waiting…</> : "Connect"}
        </button>
      )}
      {g.phase !== "waiting" && <button onClick={() => { setHidden(true); try { localStorage.setItem(key, "off"); } catch { /* storage off */ } }} className="shrink-0 text-muted hover:text-foreground" aria-label="Not now"><X size={14} /></button>}
    </div>
  );
}

/** A site wants a username and password (HTTP sign-in). You type it; it isn't saved. */
function AuthBar({ ask }: { ask: NonNullable<BrowserTab["authAsk"]> }) {
  const bridge = nativeApp()!.browser!;
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const send = () => void bridge.answerAuth(ask.id, u, p);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-accent-soft px-3 py-2 text-[12px]">
      <span className="min-w-[200px] flex-1"><b>{ask.proxy ? "A proxy" : ask.host}</b> asks you to sign in{ask.realm ? ` (“${ask.realm}”)` : ""}. Marigold doesn&apos;t save this.</span>
      <input autoFocus value={u} onChange={(e) => setU(e.target.value)} placeholder="Username" className="h-7 w-36 rounded-md border border-border bg-background px-2 outline-none focus:border-accent" />
      <input type="password" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Password" className="h-7 w-36 rounded-md border border-border bg-background px-2 outline-none focus:border-accent" />
      <button onClick={send} className="h-7 rounded-md bg-accent px-2.5 font-medium text-black">Sign in</button>
      <button onClick={() => void bridge.answerAuth(ask.id, undefined, undefined, true)} className="h-7 rounded-md border border-border px-2.5 hover:bg-surface-hover">Cancel</button>
    </div>
  );
}

/** ⌘F: find text on the page (Enter = next, Shift+Enter = previous, Esc = close). */
function FindBar({ onClose }: { onClose: () => void }) {
  const bridge = nativeApp()!.browser!;
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ active: number; total: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); return bridge.onFindResult(setRes); }, [bridge]);
  useEffect(() => () => { void bridge.findStop(); }, [bridge]);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <Search size={13} className="text-muted" />
      <input ref={input} value={q} placeholder="Find on page"
        onChange={(e) => { setQ(e.target.value); setRes(null); void bridge.find(e.target.value, true, false); }}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); else if (e.key === "Enter") void bridge.find(q, !e.shiftKey, true); }}
        className="h-6 w-56 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-accent" />
      <span className="text-[11px] text-muted">{q ? (res ? (res.total ? `${res.active} of ${res.total}` : "No matches") : "…") : ""}</span>
      <button onClick={() => void bridge.find(q, false, true)} className="rounded p-1 text-muted hover:bg-surface-hover" aria-label="Previous match"><ArrowUp size={13} /></button>
      <button onClick={() => void bridge.find(q, true, true)} className="rounded p-1 text-muted hover:bg-surface-hover" aria-label="Next match"><ChevronDown size={13} /></button>
      <button onClick={onClose} className="ml-auto rounded p-1 text-muted hover:bg-surface-hover" aria-label="Close find"><X size={13} /></button>
    </div>
  );
}

/** The same three steps for everyone who connects Google. */
// ---------------------------------------------------------------- blocked-site notice

/** Blocked sites that belong to this page's own site (youtube.com for YouTube TV) — not third-party bits like thumbnails on Google. */
function relevantBlocked(t: BrowserTab | null): string[] {
  if (!t?.blocked?.length) return [];
  const base = (h: string) => h.split(".").slice(-2).join(".");
  let page = "";
  try { page = base(new URL(t.url).hostname); } catch { return []; }
  return t.blocked.filter((h) => base(h) === page);
}

// ---------------------------------------------------------------- bookmarks bar · star · extensions

const BAR = /^bookmarks bar$/i;
const notifyBookmarks = () => window.dispatchEvent(new Event("mg-bookmarks"));

function useBookmarks(profile: string) {
  const bridge = nativeApp()!.browser!;
  const [list, setList] = useState<Bookmark[]>([]);
  useEffect(() => {
    const load = () => void bridge.bookmarks().then(setList).catch(() => {});
    load();
    window.addEventListener("mg-bookmarks", load);
    return () => window.removeEventListener("mg-bookmarks", load);
  }, [bridge, profile]);
  return list;
}

/** Chrome-style bookmarks bar (per account). Folders open as menus; ⌘-click opens in a new tab. */
/** A tab's icon: the one the page gave, the one remembered for that site, or the site's own /favicon.ico; a globe if none loads. */
function TabIcon({ url, src }: { url: string; src: string }) {
  const guess = (() => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) && u.hostname !== "localhost" ? `${u.origin}/favicon.ico` : ""; } catch { return ""; } })();
  const [bad, setBad] = useState("");
  const use = src || guess;
  if (!use || bad === use) return <Globe size={12} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={use} alt="" className="h-3.5 w-3.5 rounded-sm" draggable={false} onError={() => setBad(use)} />;
}

/** A site's own icon, or a small colored letter tile while it has none (no network call to anyone). */
function SiteDot({ url, src }: { url: string; src: string }) {
  const [bad, setBad] = useState(false);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "?"; } })();
  const hue = [...host].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  if (src && !bad) return <img src={src} alt="" className="h-4 w-4 shrink-0 rounded-[4px]" onError={() => setBad(true)} />;
  return <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] text-[9px] font-semibold uppercase text-white" style={{ background: `hsl(${hue} 45% 45%)` }}>{host[0]}</span>;
}

function BookmarksBar({ st, tab }: { st: BrowserState | null; tab: BrowserTab | null }) {
  const bridge = nativeApp()!.browser!;
  const list = useBookmarks(st?.profile ?? "");
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // ⇧⌘B shows / hides the bar, like Chrome.
  const [barOff, setBarOff] = useState(() => { try { return localStorage.getItem("marigold.bookmarksBarOff") === "1"; } catch { return false; } });
  useEffect(() => {
    const t = () => setBarOff((v) => { try { localStorage.setItem("marigold.bookmarksBarOff", v ? "0" : "1"); } catch { /* storage off */ } return !v; });
    window.addEventListener("mg-toggle-bookmarks", t);
    return () => window.removeEventListener("mg-toggle-bookmarks", t);
  }, []);
  useBrowserOverlay(!!openFolder);
  useEffect(() => {
    if (!openFolder) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpenFolder(null); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openFolder]);
  const top = list.filter((b) => BAR.test(b.folder));
  const folders = new Map<string, Bookmark[]>();
  for (const b of list) {
    const m = b.folder.match(/^bookmarks bar › ([^›]+)/i);
    const name = m ? m[1].trim() : BAR.test(b.folder) ? null : "Other bookmarks";
    if (name) folders.set(name, [...(folders.get(name) ?? []), b]);
  }
  if ((!top.length && !folders.size) || barOff) return null;
  const open = (b: Bookmark, e: React.MouseEvent) => {
    setOpenFolder(null);
    if (e.metaKey || !tab) void bridge.newTab(b.url); else void bridge.navigate(tab.id, b.url);
  };
  const icon = (u: string) => { try { return `${new URL(u).origin}/favicon.ico`; } catch { return ""; } };
  const Fav = ({ b }: { b: Bookmark }) => <SiteDot url={b.url} src={icon(b.url)} />;
  // Bookmarks saved without a name show their address — use the site name instead.
  const label = (b: Bookmark) => (!b.title || /^https?:\/\//.test(b.title) ? (() => { try { return new URL(b.url).hostname.replace(/^www\./, ""); } catch { return b.url; } })() : b.title);
  return (
    <div ref={box} className="relative flex h-9 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden bg-surface/50 px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {top.slice(0, 30).map((b) => (
        <button key={b.url} onClick={(e) => open(b, e)} title={b.url} className="flex h-7 max-w-[170px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted transition-colors hover:bg-surface-hover hover:text-foreground">
          <Fav b={b} />
          <span className="truncate">{label(b)}</span>
        </button>
      ))}
      {[...folders].map(([name, items]) => (
        <div key={name} className="relative shrink-0">
          <button onClick={() => setOpenFolder(openFolder === name ? null : name)} className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted transition-colors hover:bg-surface-hover hover:text-foreground">
            <Folder size={12} /> {name}
          </button>
          {openFolder === name && (
            <div className="fixed z-[95] mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-border bg-background py-1 shadow-2xl">
              {items.map((b) => (
                <button key={b.url} onClick={(e) => open(b, e)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-hover">
                  <Fav b={b} />
                  <span className="truncate">{label(b)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StarButton({ tab }: { tab: BrowserTab }) {
  const bridge = nativeApp()!.browser!;
  const list = useBookmarks("");
  const on = list.some((b) => b.url === tab.url);
  return (
    <button onClick={() => void bridge.toggleBookmark(tab.url, tab.title).then(notifyBookmarks)} title={on ? "Remove bookmark" : "Bookmark this page"} className="shrink-0 text-muted hover:text-accent">
      <Star size={13} className={on ? "fill-accent text-accent" : ""} />
    </button>
  );
}

/** Extensions imported for this account; ones with a toolbar popup open it. */
function ExtensionsMenu({ profile }: { profile: string }) {
  const bridge = nativeApp()!.browser!;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BrowserExtension[] | null>(null);
  const [adblock, setAdblock] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useBrowserOverlay(open);
  useEffect(() => {
    if (!open) return;
    void bridge.extensions().then(setList).catch(() => setList([]));
    void bridge.adblock().then((r) => setAdblock(r.on)).catch(() => {});
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, bridge, profile]);
  return (
    <div ref={box} className="relative shrink-0">
      <IconBtn label="Extensions" onClick={() => setOpen(!open)}><Puzzle size={15} /></IconBtn>
      {open && (
        <div className="absolute right-0 top-10 z-[90] w-72 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-2xl">
          <label className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1">
              <span className="block">Block ads and trackers</span>
              <span className="block text-[10.5px] text-muted">Built in. Does the job of AdGuard and uBlock here</span>
            </span>
            <input type="checkbox" checked={adblock} onChange={(e) => { setAdblock(e.target.checked); void bridge.adblock(e.target.checked); }} className="accent-[var(--accent)]" />
          </label>
          <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">Extensions</p>
          {list === null ? <p className="px-3 py-2 text-[12px] text-muted">Loading…</p>
            : list.length === 0 ? <p className="px-3 py-2 text-[12px] text-muted">None yet. Open a new tab and use “Import from your browser” to bring your Chrome extensions over.</p>
            : list.filter((x) => !x.held && !x.incompatible && !x.safeMode).map((x) => (
              <div key={x.id} className="group flex items-center hover:bg-surface-hover">
                <button disabled={!x.ok || !x.popup} onClick={() => { void bridge.openExtension(x.id); setOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] disabled:cursor-default">
                  {x.icon ? <img src={x.icon} alt="" className="h-4 w-4 shrink-0" /> : <Puzzle size={14} className="shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{x.name}</span>
                    {!x.ok ? <span className="block truncate text-[10.5px] text-danger">Didn&apos;t load here</span>
                      : (x.errors ?? 0) > 0 ? <span className="block truncate text-[10.5px] text-amber-500" title="Part of this extension uses Chrome features Marigold's browser doesn't have, so some of it won't work.">Partly working</span>
                      : !x.popup ? <span className="block text-[10.5px] text-muted">Works on pages</span> : <span className="block text-[10.5px] text-success">Working</span>}
                  </span>
                </button>
                <button onClick={() => void bridge.removeExtension(x.id).then(() => bridge.extensions().then(setList))} title={`Remove ${x.name}`} className="mr-2 hidden rounded p-1 text-muted hover:text-danger group-hover:block"><X size={12} /></button>
              </div>
            ))}
          {!!list?.some((x) => x.safeMode) && (
            <p className="mx-3 my-1.5 rounded-lg bg-accent-soft px-2.5 py-2 text-[11.5px]">Marigold closed unexpectedly last time, so extensions are off for this launch to keep the browser stable. They load again next time you open Marigold.</p>
          )}
          {!!list?.some((x) => x.incompatible) && (
            <>
              <p className="border-t border-border px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">Not supported in Marigold</p>
              {list.filter((x) => x.incompatible).map((x) => (
                <div key={x.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-muted">
                  <Puzzle size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{x.name}</span>
                  <span className="shrink-0 text-[10.5px]">crashes the browser</span>
                </div>
              ))}
            </>
          )}
          {!!list?.some((x) => x.held) && (
            <>
              <p className="border-t border-border px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">Installed by your organization (off)</p>
              <p className="px-3 pb-1 text-[10.5px] text-muted">Your school or work put these in Chrome. Some report browsing activity, so they stay off here unless you turn them on.</p>
              {list.filter((x) => x.held).map((x) => (
                <div key={x.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                  <Puzzle size={13} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-muted">{x.name}</span>
                  <button onClick={() => void bridge.enableExtension(x.id).then(() => bridge.extensions().then(setList))} className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-surface-hover">Turn on</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- "you're signed in to this in Chrome" bar

/** On a sign-in page, before the user's sign-ins were brought over: offer it in one click. */
/**
 * Google refuses its own sign-in inside apps like this one, so a Google session here comes from Chrome (copied with the
 * user's OK). Google rotates those session cookies while you use Chrome, which leaves the copy stale; copying again fixes it.
 */
function GoogleSignInBar({ tab }: { tab: BrowserTab }) {
  const bridge = nativeApp()!.browser!;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // true while it signs in on its own (decided before the first paint, once every 5 minutes so a refusal can't loop)
  const [auto, setAuto] = useState(() => {
    let last = 0;
    try { last = Number(localStorage.getItem("marigold.googleAutoAt") ?? 0); } catch { /* storage off */ }
    if (Date.now() - last < 5 * 60_000) return false;
    try { localStorage.setItem("marigold.googleAutoAt", String(Date.now())); } catch { /* storage off */ }
    return true;
  });
  const refresh = async () => {
    setBusy(true); setMsg("");
    const h = await bridge.homeData().catch(() => null);
    const sources = await bridge.importSources().catch(() => []);
    const src = sources.find((x) => x.id === h?.last?.id) ?? sources[0];
    if (!src) { setBusy(false); setMsg("No Chrome profile found to copy from."); return; }
    const profile = h?.last?.id === src.id ? h.last.profile : src.profiles[0]?.dir ?? "Default";
    const r = await bridge.importFrom({ id: src.id, profile, what: { bookmarks: false, history: false, cookies: true } });
    setBusy(false);
    if (r.ok && r.signins) { setMsg("Done. Reloading signed in…"); await bridge.reloadAll(); }
    else setMsg(r.signinsError ?? r.error ?? "Couldn't copy your sign-in.");
  };
  // Google asked for a sign-in: do it right away from your Chrome sign-in (once every 5 minutes, so a refusal can't loop).
  // macOS may ask once for permission to read Chrome's saved sign-in: choose Always Allow.
  useEffect(() => {
    if (!auto) return;
    // The page is covered right away (the live page can't be clicked) until the sign-in is copied and the page reloaded.
    const hold = useApp.getState().setBrowserOverlay;
    hold(1);
    void Promise.resolve().then(() => refresh()).finally(() => setTimeout(() => { setAuto(false); hold(-1); }, 900));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (auto && !msg) return <div className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-3 py-1.5 text-[12px]"><RotateCw size={12} className="animate-spin" /> Signing you in to Google with your Chrome sign-in… one moment, the page reloads by itself.</div>;
  return null; // no buttons: it signs in by itself, and stays quiet if Chrome has no sign-in to copy
}

function SignInBar({ tab }: { tab: BrowserTab }) {
  const bridge = nativeApp()!.browser!;
  const host = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const [info, setInfo] = useState<{ signins: string[]; last: { id: string; profile: string } | null } | null>(null);
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(`marigold.signinbar.${host}`) === "off"; } catch { return false; } });

  useEffect(() => {
    void bridge.homeData().then((h) => setInfo({ signins: h.signins, last: h.last })).catch(() => {});
    void bridge.importSources().then(setSources).catch(() => {});
  }, [bridge]);

  if (hidden || !info || info.signins.length > 0 || !sources.length) return null;
  const src = sources.find((s) => s.id === info.last?.id) ?? sources[0];
  const profile = info.last?.id === src.id ? info.last.profile : src.profiles[0]?.dir ?? "Default";
  const pname = src.profiles.find((p) => p.dir === profile)?.name;

  const run = async () => {
    setBusy(true);
    const r = await bridge.importFrom({ id: src.id, profile, what: { bookmarks: false, history: false, cookies: true } });
    setBusy(false);
    if (r.ok && r.signins) { setMsg(`Done. Reloading with your ${src.label} sign-ins…`); await bridge.reloadAll(); setTimeout(() => setHidden(true), 2500); }
    else setMsg(r.signinsError ?? r.error ?? "Couldn't bring your sign-ins over.");
  };
  const dismiss = () => { setHidden(true); try { sessionStorage.setItem(`marigold.signinbar.${host}`, "off"); } catch { /* storage off */ } };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-3 py-1.5 text-[12px]">
      <Import size={13} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">
        {msg ?? <>Signed in to {host || "this site"} in {src.label}? Try using those logins here. Some sites only accept the browser you signed in with, so you may still need to sign in once.</>}
      </span>
      {!msg?.startsWith("Signed in") && (
        <button onClick={() => void run()} disabled={busy} className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-black disabled:opacity-60">
          {busy ? <><Loader2 size={12} className="animate-spin" /> Waiting for macOS…</> : `Use ${src.label}${pname && src.profiles.length > 1 ? ` (${pname})` : ""} logins`}
        </button>
      )}
      <button onClick={dismiss} className="shrink-0 text-muted hover:text-foreground" aria-label="Dismiss"><X size={13} /></button>
    </div>
  );
}

// ---------------------------------------------------------------- shared: one tab's conversation

function useTabChat(tabId: number | undefined) {
  const chatId = useApp((s) => (tabId != null ? s.browserChats[tabId] : undefined));
  const chat = useApp((s) => s.chats.find((c) => c.id === chatId));
  const sending = useApp((s) => s.sending);
  const send = useApp((s) => s.sendBrowserMessage);
  const messages = chat?.messages ?? [];
  const running = messages.at(-1)?.streaming === true;
  const ask = async (t: string, tab: BrowserTab | null) => {
    const v = t.trim();
    if (!v || sending || !tab) return;
    // Hand the assistant what's on the page right now (so "summarize this" is instant).
    const page = pageOf(tab);
    const text = page ? await Promise.race([nativeApp()?.browser?.pageText(tab.id).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3500))]) : null;
    // A picture of the page as it looks right now (layout, charts, images, anything the text can't say), unless it is switched off.
    let shot = "";
    let on = true;
    try { on = localStorage.getItem("marigold.assistantShots") !== "0"; } catch { /* storage off */ }
    if (page && on) {
      try {
        const url = await nativeApp()?.browser?.pageShot(tab.id);
        if (url) {
          const blob = await (await fetch(url)).blob();
          const r = await fetch("/api/agent/upload", { method: "POST", headers: { "x-filename": "page-screenshot.jpg", "Content-Type": "image/jpeg" }, body: blob }).then((x) => x.json()).catch(() => null);
          if (r?.id) shot = `${attLink("Page screenshot", r.id)} `;
        }
      } catch { /* no picture this time: the text still goes */ }
    }
    void send(`${shot}${v}`, page ? { title: page.title, url: page.url, text: text?.text } : null, tab.id);
  };
  return { messages, running, sending, ask, chatId };
}

function Composer({ placeholder, onSend, running, big, chatId, autoFocus }: { placeholder: string; onSend: (t: string) => void; running: boolean; big?: boolean; chatId?: string; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const send = () => { const v = text.trim(); if (!v) return; setText(""); onSend(v); };
  const ta = useRef<HTMLTextAreaElement>(null);
  // Grow with the text (every line stays visible), then scroll inside once it is tall.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const max = big ? 240 : 180;
    const fit = () => { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, max)}px`; el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"; };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, big]);
  return (
    <div className={cn("flex items-end gap-2 rounded-2xl border border-border bg-surface focus-within:border-accent", big ? "px-4 py-3 shadow-sm" : "px-2.5 py-1.5")}>
      <textarea
        ref={ta}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        rows={1}
        placeholder={placeholder}
        className={cn("flex-1 resize-none bg-transparent outline-none placeholder:text-muted", big ? "min-h-[44px] text-[15px]" : "min-h-[22px] text-[12.5px]")}
      />
      <MicButton onText={(t) => setText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : `${p}${t}`))} size={big ? 32 : 24} shortcut />
      {running && chatId ? (
        <RunControls chatId={chatId} size={big ? "md" : "sm"} />
      ) : running ? (
        <button onClick={() => void stopAllAgents()} title="Stop" className={cn("flex items-center justify-center rounded-full bg-foreground text-background", big ? "h-8 w-8" : "h-6 w-6")}><Square size={big ? 12 : 10} /></button>
      ) : (
        <button onClick={send} disabled={!text.trim()} title="Send" className={cn("flex items-center justify-center rounded-full bg-accent text-black disabled:opacity-30", big ? "h-8 w-8" : "h-6 w-6")}><ArrowUp size={big ? 16 : 13} /></button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- new tab = Marigold chat space

const STARTERS = ["What's on my calendar today?", "Summarize my unread emails", "Find a good dinner recipe for tonight", "Plan a study schedule for this week"];

function NewTabHome({ tab, profile, email }: { tab: BrowserTab | null; profile: string; email: string }) {
  const bridge = nativeApp()!.browser!;
  const name = useApp((s) => s.user.name?.split(" ")[0] ?? "");
  const { messages, running, ask, chatId } = useTabChat(tab?.id);
  const [home, setHome] = useState<{ topSites: { url: string; title: string }[]; bookmarks: { url: string; title: string }[]; imported: string[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // Shortcuts, bookmarks and "imported from" belong to the account you're in: refresh on switch.
  useEffect(() => { void bridge.homeData().then(setHome).catch(() => {}); }, [bridge, importing, profile]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [messages.length, messages.at(-1)?.content, messages.at(-1)?.steps?.length]);

  const submit = (t: string) => {
    if (!tab) return;
    if (looksLikeUrl(t)) void bridge.navigate(tab.id, t); // a web address → go there
    else void ask(t, tab); // anything else → Marigold
  };
  const askMarigold = (t: string) => { if (tab) void ask(t, tab); };
  const hour = new Date().getHours();
  const greet = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // A conversation in this tab: chat layout (thread + composer at the bottom).
  if (messages.length) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-5 px-6 py-8">
            {messages.map((m, i) => <MessageBubble key={m.id} message={m} isLast={i === messages.length - 1} />)}
          </div>
        </div>
        <div className="mx-auto w-full max-w-2xl px-6 pb-5">
          <Composer placeholder="Reply" onSend={askMarigold} running={running} big chatId={chatId} autoFocus />
        </div>
      </div>
    );
  }

  const tiles = [...(home?.topSites ?? []), ...(home?.bookmarks ?? []).map((b) => ({ url: b.url, title: b.title }))]
    .filter((t, i, a) => a.findIndex((x) => x.url === t.url) === i).slice(0, 8);

  return (
    <div className="flex min-w-0 flex-1 overflow-y-auto">
      <div className="m-auto w-full max-w-2xl px-6 py-10">
        <div className="mb-6 flex flex-col items-center text-center">
          <MarigoldIcon size={44} state="idle" />
          <h1 className="mt-4 text-2xl font-semibold">{greet}{name ? `, ${name}` : ""}</h1>
          <p className="mt-1 text-sm text-muted">What can I help with?</p>
        </div>
        <Composer placeholder="Ask Marigold anything, or type a web address" onSend={submit} running={running} big />
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {STARTERS.map((s) => (
            <button key={s} onClick={() => askMarigold(s)} className="rounded-full border border-border px-3 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-foreground">{s}</button>
          ))}
        </div>

        {tiles.length > 0 && (
          <div className="mt-10 grid grid-cols-4 gap-3">
            {tiles.map((t) => <SiteTile key={t.url} url={t.url} title={t.title} onOpen={() => tab && void bridge.navigate(tab.id, t.url)} />)}
          </div>
        )}

        <GoogleConnectCard key={email} email={email} />

        <div className="mt-8">
          {importing ? (
            <ImportPanel onDone={() => setImporting(false)} />
          ) : home && home.imported.length === 0 ? (
            <button onClick={() => setImporting(true)} className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border p-4 text-left hover:bg-surface-hover">
              <Import size={20} className="shrink-0 text-accent" />
              <span>
                <span className="block text-[13px] font-medium">Import from your browser</span>
                <span className="block text-[12px] text-muted">Bring over your bookmarks, history and logins from Chrome, Brave, Edge or Arc.</span>
              </span>
            </button>
          ) : home ? (
            <p className="text-center text-[11px] text-muted">
              Imported from {home.imported.join(", ")} · <button onClick={() => setImporting(true)} className="underline hover:text-foreground">Import again</button>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SiteTile({ url, title, onOpen }: { url: string; title: string; onOpen: () => void }) {
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })();
  const [bad, setBad] = useState(false);
  return (
    <button onClick={onOpen} title={url} className="flex flex-col items-center gap-2 rounded-xl p-3 hover:bg-surface-hover">
      <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-surface">
        {bad ? <span className="text-base font-semibold uppercase text-muted">{host[0]}</span>
          : <img src={`${new URL(url).origin}/favicon.ico`} alt="" onError={() => setBad(true)} className="h-6 w-6" />}
      </span>
      <span className="w-full truncate text-[11px] text-muted">{title || host}</span>
    </button>
  );
}

// ---------------------------------------------------------------- connect your browser (import)

function ImportPanel({ onDone }: { onDone: () => void }) {
  const bridge = nativeApp()!.browser!;
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [pickB, setPickB] = useState("");
  const [pickP, setPickP] = useState("");
  const [what, setWhat] = useState({ bookmarks: true, history: true, cookies: true, extensions: true });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);

  useEffect(() => {
    void bridge.importSources().then((s) => {
      setSources(s);
      if (s[0]) {
        setPickB(s[0].id);
        // Default to the Chrome profile signed in with the email you're browsing as.
        void bridge.state().then((st) => {
          const email = st.profiles.find((p) => p.key === st.profile)?.email?.toLowerCase();
          const match = s[0].profiles.find((p) => p.email && p.email.toLowerCase() === email);
          setPickP((match ?? s[0].profiles[0])?.dir ?? "Default");
        });
      }
    });
  }, [bridge]);
  const src = sources?.find((s) => s.id === pickB);

  const run = async () => {
    setBusy(true);
    const r = await bridge.importFrom({ id: pickB, profile: pickP, what });
    setRes(r);
    setBusy(false);
    if (r.ok && r.signins) void bridge.reloadAll(); // open sites pick up the logins
  };

  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Import size={16} className="text-accent" />
        <p className="text-[13px] font-medium">Import from your browser</p>
        <button onClick={onDone} className="ml-auto text-muted hover:text-foreground" aria-label="Close"><X size={14} /></button>
      </div>
      {res ? (
        <div className="space-y-2 text-[12.5px]">
          {res.ok ? (
            <>
              <p className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={15} className="text-accent" /> Imported from {res.from}</p>
              <ul className="ml-5 list-disc text-muted">
                {res.bookmarks != null && <li>{res.bookmarks} bookmarks</li>}
                {res.history != null && <li>{res.history} history entries</li>}
                {res.signins != null && <li>Logins for your sites ({res.signins} cookies)</li>}
                {!!res.extensions?.length && <li>Extensions: {res.extensions.join(", ")}</li>}
                {!!res.extensionsHeld?.length && <li>{res.extensionsHeld.length} installed by your organization, kept off (turn on in the Extensions menu)</li>}
              </ul>
              {res.signinsError && <p className="text-danger">{res.signinsError}</p>}
            </>
          ) : <p className="text-danger">{res.error}</p>}
          <div className="flex gap-2">
            {res.signinsError && (
              <button onClick={() => { setRes(null); setWhat({ bookmarks: false, history: false, cookies: true, extensions: false }); setBusy(true); void bridge.importFrom({ id: pickB, profile: pickP, what: { bookmarks: false, history: false, cookies: true, extensions: false } }).then((r) => { setRes(r); setBusy(false); }); }}
                className="mt-1 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-surface-hover">Try sign-ins again</button>
            )}
            <button onClick={onDone} className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-black">Done</button>
          </div>
        </div>
      ) : !sources ? (
        <p className="flex items-center gap-2 text-[12px] text-muted"><Loader2 size={13} className="animate-spin" /> Looking for browsers…</p>
      ) : sources.length === 0 ? (
        <p className="text-[12px] text-muted">No Chrome, Brave, Edge, Arc, Opera, Vivaldi or Chromium found on this Mac.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <select value={pickB} onChange={(e) => { setPickB(e.target.value); setPickP(sources.find((s) => s.id === e.target.value)?.profiles[0]?.dir ?? "Default"); }} className="h-9 rounded-lg border border-border bg-background px-2 text-[12.5px] outline-none">
              {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <select value={pickP} onChange={(e) => setPickP(e.target.value)} className="h-9 rounded-lg border border-border bg-background px-2 text-[12.5px] outline-none">
              {src?.profiles.map((p) => <option key={p.dir} value={p.dir}>{p.name}{p.email ? ` — ${p.email}` : ""}</option>)}
            </select>
          </div>
          <div className="space-y-1.5 text-[12.5px]">
            {([["bookmarks", "Bookmarks"], ["history", "History (for address-bar suggestions)"], ["cookies", "Logins (stay signed in to your sites)"], ["extensions", "Extensions"]] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={what[k]} onChange={(e) => setWhat({ ...what, [k]: e.target.checked })} className="accent-[var(--accent)]" /> {label}
              </label>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-muted">
            For logins, macOS will ask about “{src?.label} Safe Storage”. Click <b>Allow</b>. Everything stays on this Mac, and passwords are never copied.
          </p>
          <button onClick={() => void run()} disabled={busy || !pickB || !Object.values(what).some(Boolean)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-black disabled:opacity-50">
            {busy ? <><Loader2 size={13} className="animate-spin" /> Importing…</> : "Import"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- assistant (beside a web page)

const QUICK = ["Summarize this page", "What are the key points?", "Explain this simply", "Draft a reply to this"];

/** Whether the assistant gets a picture of the page with each question (on by default). */
function SeesPageToggle() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem("marigold.assistantShots") !== "0"; } catch { return true; } });
  return (
    <button
      onClick={() => { const v = !on; setOn(v); try { localStorage.setItem("marigold.assistantShots", v ? "1" : "0"); } catch { /* storage off */ } }}
      title={on ? "Marigold looks at the page, not just its text. Click to turn off." : "Marigold only reads the page's text. Click to let it look at the page too."}
      aria-pressed={on}
      className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-hover", on ? "text-accent" : "text-muted")}
    >
      <Eye size={14} />
    </button>
  );
}

function AssistantPanel({ tab, agentTab, pendingAsk, onAsked }: { tab: BrowserTab; agentTab: BrowserTab | null; pendingAsk: string | null; onAsked: () => void }) {
  const { messages, running, ask, chatId } = useTabChat(tab.id);
  const [width, setWidth] = useState(() => { try { return Number(localStorage.getItem("marigold.browserAssistantWidth")) || 360; } catch { return 360; } });
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [messages.length, messages.at(-1)?.content, messages.at(-1)?.steps?.length]);
  // A question handed over from the results page ("Go deeper"): ask it once, here.
  useEffect(() => {
    if (!pendingAsk) return;
    void ask(pendingAsk, tab);
    onAsked();
  }, [pendingAsk]); // eslint-disable-line react-hooks/exhaustive-deps -- once per handed-over question

  const startDrag = (e: React.PointerEvent) => {
    const x0 = e.clientX, w0 = width;
    let w = w0;
    const move = (ev: PointerEvent) => { w = Math.max(280, Math.min(620, w0 + (x0 - ev.clientX))); setWidth(w); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); try { localStorage.setItem("marigold.browserAssistantWidth", String(w)); } catch { /* storage off */ } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside style={{ width }} className="relative flex shrink-0 animate-[mgslide_.34s_cubic-bezier(.22,1,.36,1)] flex-col pb-2 pl-2 pr-2">
      <div onPointerDown={startDrag} className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" aria-hidden />
      <div className="flex h-11 shrink-0 items-center gap-2 px-2">
        <MarigoldIcon size={20} state={running ? "stream" : "static"} />
        <span className="text-[14px] font-semibold">Assistant</span>
        <span className="ml-auto truncate text-[11px] text-muted">{tab.title}</span>
        <SeesPageToggle />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[26px] border border-border bg-background shadow-[0_8px_30px_-16px_rgba(0,0,0,.4)]">

      {running && agentTab && agentTab.id !== tab.id && (
        <div className="flex items-center gap-2 border-b border-border bg-accent-soft px-3 py-1.5 text-[11px]">
          <Sparkles size={12} className="text-accent" />
          <span className="min-w-0 flex-1 truncate">Working in “{agentTab.title}”</span>
          <button onClick={() => void nativeApp()?.browser?.activate(agentTab.id)} className="font-medium text-accent hover:underline">Watch</button>
        </div>
      )}

      <div ref={list} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <MeetingCard url={tab.url} title={tab.title} tabId={tab.id} />
        {searchTerms(tab.url) && !isOwnSearch(tab.url) && <BriefSection tab={tab} onAsk={(q, deep) => void ask(deep ? `Give me an in-depth briefing on “${q}”: the big picture, the key details and numbers, what is debated or has changed lately, and the best sources to read next. Then suggest what to dig into.` : q, tab)} />}
        {messages.length === 0 ? (
          <div className="pt-6 text-center">
            <p className="text-[13px] font-medium">{searchTerms(tab.url) ? "Ask a follow-up, or have Marigold dig in." : "Ask about this page, or have Marigold do something on it."}</p>
            <p className="mt-1 text-[11px] text-muted">It can see this page and knows your saved details.</p>
            <div className="mt-4 flex flex-col gap-1.5">
              {QUICK.map((q) => (
                <button key={q} onClick={() => void ask(q, tab)} className="rounded-lg border border-border px-3 py-1.5 text-left text-[12px] hover:bg-surface-hover">{q}</button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => <MessageBubble key={m.id} message={m} isLast={i === messages.length - 1} />)
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <Composer placeholder="Ask about this page" onSend={(t) => void ask(t, tab)} running={running} chatId={chatId} />
      </div>
      </div>
    </aside>
  );
}


// ---------------------------------------------------------------- the Marigold Brief (beside any search results page)

interface BriefData {
  brief: { summary: string; points: { text: string; cites: number[] }[]; keyFacts: { label: string; value: string }[]; followUps: string[]; note?: string } | null;
  knowledge: { title: string; extract: string; image?: string; description?: string; facts?: [string, string][]; url?: string } | null;
  sources: { title: string; url: string; site: string }[];
}

/** Written from the results page you're looking at (its text and links) plus the best pages it links to. Works for any search. */
function BriefSection({ tab, onAsk }: { tab: BrowserTab; onAsk: (q: string, deep?: boolean) => void }) {
  const bridge = nativeApp()!.browser!;
  const q = searchTerms(tab.url) ?? "";
  const key = `${tab.id}|${q}`; // the search itself: engines rewrite the URL while a page loads
  const [state, setState] = useState<{ key: string; data: BriefData | null | "loading" }>({ key: "", data: "loading" });
  const started = useRef("");

  useEffect(() => {
    if (!q || tab.loading || started.current === key) return;
    started.current = key;
    void (async () => {
      setState({ key, data: "loading" });
      await new Promise((r) => setTimeout(r, 900)); // let late-rendering results (shopping, carousels) land
      const [txt, links] = await Promise.all([bridge.pageText(tab.id).catch(() => null), bridge.pageLinks(tab.id).catch(() => [])]);
      const r = (await fetch("/api/agent/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, text: txt?.text ?? "", links }) }).then((x) => x.json()).catch(() => null)) as BriefData | null;
      if (started.current === key) setState({ key, data: r });
    })();
  }, [key, q, tab.loading, tab.id, bridge]);

  const data = state.key === key ? state.data : "loading";
  const open = (url: string) => void bridge.newTab(url);
  const cites = (n: number) => { const sx = data && data !== "loading" ? data.sources[n - 1] : null; return sx ? <button key={n} onClick={() => open(sx.url)} title={`${sx.title} (${sx.site})`} className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-accent hover:bg-accent/30">{n}</button> : null; };
  const withCites = (t: string) => t.replace(/\s*\[wiki\]/g, "").split(/\[(\d+)\]/g).map((part, i) => (i % 2 ? cites(Number(part)) : part));

  if (data === null || (data !== "loading" && !data.brief && !data.knowledge)) {
    return <div className="rounded-xl border border-border bg-surface/60 px-3.5 py-3 text-[12px] text-muted"><span className="font-medium text-foreground">Marigold Brief</span> couldn&apos;t be written for this search: the page may still be loading, or Marigold has no AI connection. Try the reload button.</div>;
  }
  const k = data !== "loading" ? data.knowledge : null;
  const b = data !== "loading" ? data.brief : null;
  return (
    <div className="space-y-3">
      {k && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          {k.image && (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={k.image} alt="" className="h-28 w-full object-cover object-top" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2 pt-8">
                <p className="text-[15px] font-semibold leading-tight text-white">{k.title}</p>
                {k.description && <p className="text-[11px] capitalize text-white/80">{k.description}</p>}
              </div>
            </div>
          )}
          <div className="p-3">
            {!k.image && <p className="text-[14px] font-semibold">{k.title}</p>}
            {k.facts && k.facts.length > 0 && (
              <dl className={cn("grid grid-cols-2 gap-x-3 gap-y-1.5", k.image ? "" : "mt-2")}>
                {k.facts.slice(0, 6).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</dt><dd className="line-clamp-2 text-[12px] leading-snug">{value}</dd></div>)}
              </dl>
            )}
          </div>
        </div>
      )}
      <div className="rounded-xl border border-accent/25 bg-gradient-to-br from-accent/[0.09] to-transparent p-3.5">
        <div className="mb-2 flex items-center gap-1.5">
          <Sparkles size={13} className="text-accent" />
          <span className="text-[11px] font-semibold tracking-wide text-accent">MARIGOLD BRIEF</span>
        </div>
        {data === "loading" && (
          <div className="space-y-2">
            <div className="h-3.5 w-full animate-pulse rounded bg-surface-hover" /><div className="h-3.5 w-11/12 animate-pulse rounded bg-surface-hover" />
            <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-surface-hover" /><div className="h-3 w-3/5 animate-pulse rounded bg-surface-hover" />
            <p className="pt-1 text-[11px] text-muted">Reading the results…</p>
          </div>
        )}
        {data !== "loading" && !b && <p className="text-[12px] text-muted">Couldn&apos;t write a brief for this search (no AI connection, or the page had too little to go on).</p>}
        {b && (
          <>
            <p className="text-[13.5px] font-medium leading-[1.6]">{withCites(b.summary)}</p>
            {b.points.length > 0 && (
              <ul className="mt-2.5 space-y-2">
                {b.points.map((pt) => (
                  <li key={pt.text} className="flex gap-2 text-[12.5px] leading-[1.6] text-foreground/90"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /><span>{withCites(pt.text)}{pt.cites.map((n) => cites(n))}</span></li>
                ))}
              </ul>
            )}
            {b.note && <p className="mt-2.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">{b.note}</p>}
            {b.keyFacts.length > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-1.5">
                {b.keyFacts.map((f) => <div key={f.label} className="rounded-lg border border-border bg-background/70 px-2.5 py-1.5"><dt className="text-[10px] font-medium uppercase tracking-wide text-muted">{f.label}</dt><dd className="text-[12px] leading-snug">{f.value}</dd></div>)}
              </dl>
            )}
            <p className="mb-1.5 mt-3.5 text-[10.5px] font-medium uppercase tracking-wide text-muted">Go deeper</p>
            <div className="flex flex-col gap-1.5">
              {b.followUps.map((f) => (
                <button key={f} onClick={() => onAsk(f)} className="group flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-left text-[12px] hover:border-accent">
                  <span className="min-w-0 flex-1">{f}</span><ArrowRight size={12} className="shrink-0 text-muted group-hover:text-accent" />
                </button>
              ))}
              <button onClick={() => onAsk(q, true)} className="mt-0.5 flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-black hover:opacity-90"><MessageSquare size={13} /> Deep dive in chat</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- downloads · history · clear data · the ⋮ menu

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Chrome's download button: progress while a file comes down, then a list you can open, reveal or clear. */
function DownloadsButton({ downloads }: { downloads: BrowserDownload[] }) {
  const bridge = nativeApp()!.browser!;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useBrowserOverlay(open);
  useEffect(() => { const f = () => setOpen(true); window.addEventListener("mg-open-downloads", f); return () => window.removeEventListener("mg-open-downloads", f); }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  const live = downloads.find((d) => d.state === "progressing");
  if (!downloads.length) return null;
  return (
    <div ref={box} className="relative">
      <IconBtn label="Downloads (⇧⌘J)" onClick={() => setOpen((v) => !v)}>
        {live ? <span className="relative flex h-4 w-4 items-center justify-center"><Download size={13} className="text-accent" /><span className="absolute -bottom-1 left-0 h-[2px] rounded bg-accent" style={{ width: `${live.total ? Math.round((live.received / live.total) * 100) : 40}%` }} /></span> : <Download size={14} />}
      </IconBtn>
      {open && (
        <div className="absolute right-0 top-9 z-[60] w-80 overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2"><span className="text-[13px] font-medium">Downloads</span><button onClick={() => void bridge.download(0, "clear")} className="text-[11px] text-muted hover:text-foreground">Clear finished</button></div>
          <div className="max-h-80 overflow-y-auto">
            {downloads.map((d) => (
              <div key={d.id} className="border-b border-border/60 px-3 py-2.5 last:border-0">
                <p className="truncate text-[12.5px] font-medium">{d.name}</p>
                {d.state === "progressing" ? (
                  <>
                    <div className="mt-1.5 h-1 overflow-hidden rounded bg-surface-hover"><div className="h-full rounded bg-accent transition-[width]" style={{ width: `${d.total ? Math.round((d.received / d.total) * 100) : 30}%` }} /></div>
                    <div className="mt-1 flex items-center text-[11px] text-muted"><span>{fmtBytes(d.received)}{d.total ? ` of ${fmtBytes(d.total)}` : ""}</span><button onClick={() => void bridge.download(d.id, "cancel")} className="ml-auto hover:text-danger">Cancel</button></div>
                  </>
                ) : (
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-muted">
                    <span>{d.state === "completed" ? fmtBytes(d.received) : d.state === "cancelled" ? "Cancelled" : "Failed"}</span>
                    {d.state === "completed" && <><button onClick={() => void bridge.download(d.id, "open")} className="text-accent hover:underline">Open</button><button onClick={() => void bridge.download(d.id, "reveal")} className="hover:text-foreground">Show in Finder</button></>}
                    <button onClick={() => void bridge.download(d.id, "remove")} className="ml-auto hover:text-danger" aria-label="Remove from list"><X size={11} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The browser's full history (⌘Y): search it, open a page, delete entries. */
function HistoryPanel({ onClose, onOpen, onClear }: { onClose: () => void; onOpen: (url: string) => void; onClear: () => void }) {
  const bridge = nativeApp()!.browser!;
  const [q, setQ] = useState("");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [tick, setTick] = useState(0);
  useBrowserOverlay(true);
  useEffect(() => { const t = setTimeout(() => void bridge.historyList(q).then(setItems).catch(() => {}), q ? 120 : 0); return () => clearTimeout(t); }, [bridge, q, tick]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const day = (t: number) => { const d = new Date(t), n = new Date(); return d.toDateString() === n.toDateString() ? "Today" : d.toDateString() === new Date(n.getTime() - 86_400_000).toDateString() ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }); };
  const groups: [string, HistoryItem[]][] = [];
  for (const h of items) { const g = day(h.last); const last = groups.at(-1); if (last && last[0] === g) last[1].push(h); else groups.push([g, [h]]); }
  return (
    <div className="fixed inset-0 z-[95] flex items-start justify-center bg-black/50 p-6 pt-[10vh] backdrop-blur-[2px]" onClick={onClose}>
      <div className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <HistoryIcon size={16} className="text-muted" /><span className="text-[14px] font-semibold">History</span>
          <div className="ml-3 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-surface px-3 focus-within:border-accent"><Search size={13} className="text-muted" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search history" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" /></div>
          <button onClick={onClear} className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] hover:bg-surface-hover"><Trash2 size={12} /> Clear data…</button>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-hover"><X size={15} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 && <p className="px-3 py-10 text-center text-[13px] text-muted">{q ? "Nothing matches." : "No history yet."}</p>}
          {groups.map(([g, list]) => (
            <div key={g} className="mb-2">
              <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{g}</p>
              {list.map((h) => {
                const host = (() => { try { return new URL(h.url).hostname.replace(/^www\./, ""); } catch { return h.url; } })();
                return (
                  <div key={h.url} className="group flex items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-surface-hover">
                    <span className="w-14 shrink-0 text-[11px] text-muted">{new Date(h.last).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`https://${host}/favicon.ico`} alt="" width={14} height={14} className="h-3.5 w-3.5 shrink-0 rounded-sm" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                    <button onClick={() => onOpen(h.url)} className="min-w-0 flex-1 truncate text-left text-[13px]">{h.title || h.url}<span className="ml-2 text-[11.5px] text-muted">{host}</span></button>
                    <button onClick={() => void bridge.historyDelete({ url: h.url }).then(() => setTick((t) => t + 1))} aria-label="Remove from history" className="rounded p-1 text-muted opacity-0 hover:text-danger group-hover:opacity-100"><X size={12} /></button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClearRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1.5"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 accent-[var(--accent)]" /><span><span className="block text-[13px] font-medium">{label}</span><span className="block text-[11.5px] text-muted">{hint}</span></span></label>
  );
}

/** Clear browsing data: history, cookies and site data, cached files, for a time range. */
function ClearDataDialog({ onClose }: { onClose: () => void }) {
  const bridge = nativeApp()!.browser!;
  const [what, setWhat] = useState({ history: true, cookies: false, cache: true });
  const [range, setRange] = useState(0);
  const [busy, setBusy] = useState(false);
  useBrowserOverlay(true);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const go = async () => { setBusy(true); await bridge.clearData({ ...what, sinceMs: range || undefined }); if (what.cookies) await bridge.reloadAll(); onClose(); };
  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-[15px] font-semibold">Clear browsing data</p>
        <p className="mt-0.5 text-[12px] text-muted">For the account you&apos;re browsing as.</p>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="mt-3 h-8 w-full rounded-lg border border-border bg-surface px-2 text-[12.5px]">
          <option value={3_600_000}>Last hour</option><option value={86_400_000}>Last 24 hours</option><option value={604_800_000}>Last 7 days</option><option value={0}>All time</option>
        </select>
        <div className="mt-2">
          <ClearRow checked={what.history} onChange={(v) => setWhat((w) => ({ ...w, history: v }))} label="Browsing history" hint="Pages you visited and address-bar suggestions" />
          <ClearRow checked={what.cookies} onChange={(v) => setWhat((w) => ({ ...w, cookies: v }))} label="Cookies and site data" hint="Signs you out of most sites" />
          <ClearRow checked={what.cache} onChange={(v) => setWhat((w) => ({ ...w, cache: v }))} label="Cached images and files" hint="Frees space; pages may load a little slower once" />
        </div>
        <div className="mt-4 flex justify-end gap-2"><button onClick={onClose} className="h-8 rounded-lg px-3 text-[12.5px] text-muted hover:bg-surface-hover">Cancel</button><button onClick={() => void go()} disabled={busy || !(what.history || what.cookies || what.cache)} className="h-8 rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-black disabled:opacity-50">{busy ? "Clearing…" : "Clear data"}</button></div>
      </div>
    </div>
  );
}

function MenuItem({ label, hint, onClick, disabled, icon }: { label: string; hint?: string; onClick: () => void; disabled?: boolean; icon?: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent"><span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted">{icon}</span><span className="flex-1">{label}</span>{hint && <span className="text-[11px] text-muted">{hint}</span>}</button>
  );
}
const MenuSep = () => <div className="my-1 border-t border-border" />;

/** Marigold's assistant for this page: a normal-size icon in gold, with a dot and a one-time hint until it has been used. */
function AskMarigoldButton({ onClick }: { onClick: () => void }) {
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem("marigold.askSeen") === "1"; } catch { return true; } });
  const [tip, setTip] = useState(false);
  useEffect(() => {
    if (seen) return;
    const a = setTimeout(() => setTip(true), 1200), b = setTimeout(() => setTip(false), 9000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [seen]);
  return (
    <span className="relative inline-flex">
      <button
        onClick={() => { try { localStorage.setItem("marigold.askSeen", "1"); } catch { /* storage off */ } setSeen(true); setTip(false); onClick(); }}
        title="Ask Marigold about this page"
        aria-label="Ask Marigold about this page"
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent/15"
      >
        <MarigoldIcon size={19} />
        {!seen && <span className="absolute right-0.5 top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent ring-2 ring-background" />}
      </button>
      {tip && <span className="pointer-events-none absolute right-0 top-full z-[70] mt-1 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1 text-[12px] font-medium text-background shadow-lg">Ask Marigold about this page</span>}
    </span>
  );
}

/** The ⋮ menu, like Chrome's: tabs, history, downloads, bookmark, zoom, print, find, developer tools, search engine. */
function MoreMenu({ st, tab, onFind, onPanel }: { st: BrowserState | null; tab: BrowserTab | null; onFind: () => void; onPanel: (p: "history" | "clear") => void }) {
  const bridge = nativeApp()!.browser!;
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const box = useRef<HTMLDivElement>(null);
  useBrowserOverlay(open);
  useEffect(() => {
    if (!open) return;
    void bridge.zoom({ delta: 0 }).then(setZoom).catch(() => {});
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open, bridge]);
  const run = (f: () => void) => () => { setOpen(false); f(); };
  const onPage = !!pageOf(tab);
  return (
    <div ref={box} className="relative">
      <IconBtn label="Customize and control Marigold" onClick={() => setOpen((v) => !v)}><EllipsisVertical size={15} /></IconBtn>
      {open && (
        <div className="absolute right-0 top-9 z-[60] w-64 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-2xl">
          <MenuItem label="New tab" hint="⌘T" icon={<Plus size={13} />} onClick={run(() => void bridge.newTab())} />
          <MenuItem label="Search open tabs" hint="⇧⌘A" icon={<Search size={13} />} onClick={run(() => { window.dispatchEvent(new Event("mg-tab-search")); })} />
          <MenuItem label="Reopen closed tab" hint="⇧⌘T" icon={<RotateCw size={13} />} onClick={run(() => void bridge.reopenTab())} />
          <MenuSep />
          <MenuItem label="Show / hide the Pulse bar" icon={<Sparkles size={13} />} onClick={run(() => window.dispatchEvent(new Event("mg-toggle-pulse")))} />
          <MenuSep />
          <p className="px-3 pb-0.5 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-muted">Search engine</p>
          {([["startpage", "Startpage (private)"], ["duckduckgo", "DuckDuckGo"], ["marigold", "Marigold (free sources)"]] as const).map(([id, name]) => (
            <MenuItem key={id} label={name} icon={(st?.engine ?? "startpage") === id ? <Check size={13} /> : <span className="inline-block w-[13px]" />} onClick={run(() => void bridge.setEngine(id))} />
          ))}
          <MenuSep />
          <MenuItem label="Reset site permissions (camera, microphone…)" icon={<RotateCw size={13} />} onClick={run(() => void bridge.resetPermissions())} />
          <MenuItem label="Sources and licenses" icon={<Info size={13} />} onClick={run(() => void bridge.newTab(`${window.location.origin}/sources`))} />
          <MenuItem label="History" hint="⌘Y" icon={<HistoryIcon size={13} />} onClick={run(() => onPanel("history"))} />
          <MenuItem label="Downloads" hint="⇧⌘J" icon={<Download size={13} />} onClick={run(() => window.dispatchEvent(new Event("mg-open-downloads")))} disabled={!st?.downloads?.length} />
          <MenuItem label={onPage ? "Bookmark this page" : "Bookmark"} hint="⌘D" icon={<Star size={13} />} disabled={!onPage} onClick={run(() => { if (tab) void bridge.toggleBookmark(tab.url, tab.title).then(() => window.dispatchEvent(new Event("mg-bookmarks"))); })} />
          <MenuSep />
          <div className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
            <span className="flex-1">Zoom</span>
            <button onClick={() => void bridge.zoom({ delta: -0.5 }).then(setZoom)} aria-label="Zoom out" className="flex h-6 w-6 items-center justify-center rounded hover:bg-surface-hover"><Minus size={12} /></button>
            <button onClick={() => void bridge.zoom({ reset: true }).then(setZoom)} title="Reset" className="w-10 text-center text-[12px] tabular-nums hover:underline">{zoom}%</button>
            <button onClick={() => void bridge.zoom({ delta: 0.5 }).then(setZoom)} aria-label="Zoom in" className="flex h-6 w-6 items-center justify-center rounded hover:bg-surface-hover"><Plus size={12} /></button>
          </div>
          <MenuItem label="Print…" hint="⌘P" icon={<Printer size={13} />} disabled={!onPage} onClick={run(() => void bridge.print())} />
          <MenuItem label="Find in page…" hint="⌘F" icon={<Search size={13} />} disabled={!onPage} onClick={run(onFind)} />
          <MenuItem label="Developer tools" hint="⌥⌘I" icon={<Code2 size={13} />} disabled={!onPage} onClick={run(() => void bridge.devtools())} />
          <MenuSep />
          <MenuItem label="Clear browsing data…" icon={<Trash2 size={13} />} onClick={run(() => onPanel("clear"))} />
        </div>
      )}
    </div>
  );
}
