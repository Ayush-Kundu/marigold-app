"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { Sidebar } from "./sidebar";
import { TopNav } from "./top-nav";
import { BackgroundStrip } from "./background-strip";
import { PromptBar } from "./prompt-bar";
import { ChatsView } from "@/components/views/chats-view";
import { BrowserPage } from "@/components/views/browser-page";
import { ProjectsView } from "@/components/views/projects-view";
import { AppDock } from "./app-dock";
import { SideViewBar } from "./side-view";
import { ConversationHost } from "./conversation-control";
import { MeetingHost, MeetingChatCard } from "./meeting-control";
import { VoiceOut } from "./voice-out";
import { SetupGate } from "./setup-dialog";
import { PingToasts } from "./ping-toasts";
import { isAux } from "@/lib/aux";
import { syncEmails } from "@/lib/agent";
import { nativeApp } from "@/lib/native";

export function AppShell() {
  const [aux] = useState(() => isAux()); // an extra window: no browser, voice or meeting helpers (the main window has them)
  const router = useRouter();
  const tab = useApp((s) => s.activeTab);
  const projectChatOpen = useApp((s) => s.projectChatOpen);
  const hydratePrefs = useApp((s) => s.hydratePrefs);
  const initAuth = useApp((s) => s.initAuth);
  const authResolved = useApp((s) => s.authResolved);
  const backed = useApp((s) => s.backed);
  const fullFlag = useApp((s) => s.fullWindow);
  const sideView = useApp((s) => s.sideView);
  const dockHidden = useApp((s) => s.dockHidden);
  const rowRef = useRef<HTMLDivElement>(null);
  const [dockHint, setDockHint] = useState(false);

  // This shell is time-sensitive and fully interactive; render it only on the
  // client to avoid prerendering relative timestamps (Date.now) and a theme flash.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    hydratePrefs();
    initAuth();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser-only values after hydration (avoids a server/client mismatch)
    setMounted(true);
  }, [hydratePrefs, initAuth]);

  // Poll the local agent for background tasks (they run even if this tab closes).
  const syncAgentTasks = useApp((s) => s.syncAgentTasks);
  useEffect(() => {
    if (!mounted) return;
    void syncAgentTasks();
    const t = setInterval(() => void syncAgentTasks(), 2500);
    return () => clearInterval(t);
  }, [mounted, syncAgentTasks]);

  // Keep the local agent in sync with WHO the user is: their login email (primary) + extras.
  const user = useApp((s) => s.user);
  useEffect(() => {
    if (!mounted || !backed || !user.email) return;
    void syncEmails(user.email, user.extraEmails ?? []);
  }, [mounted, backed, user.email, (user.extraEmails ?? []).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a backend is configured, the app requires sign-in; send guests to /login.
  useEffect(() => {
    if (mounted && authResolved && isSupabaseConfigured && !backed) {
      router.replace("/login");
    }
  }, [mounted, authResolved, backed, router]);

  // Esc leaves full screen (there's no on-screen exit button over the page).
  const setFullWindow = useApp((s) => s.setFullWindow);
  useEffect(() => {
    if (!fullFlag) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setFullWindow(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [fullFlag, setFullWindow]);

  // "Deep dive" on a search result page → a fresh chat about that topic, ready to keep talking.
  useEffect(() => {
    if (!mounted) return;
    const go = (q: string) => {
      const st = useApp.getState();
      st.setTab("chats");
      st.newChat();
      void st.sendUserMessage(`Let's do a deep dive on “${q}”. Look it up properly: the big picture, the key details and numbers, what's debated or has changed recently. Keep it conversational, and end by asking which part I want to dig into.`);
    };
    const off = nativeApp()?.onDeepDive?.(go);
    const onEvt = (e: Event) => { const q = (e as CustomEvent<string>).detail; if (q) go(q); };
    window.addEventListener("mg-deep-dive", onEvt);
    return () => { off?.(); window.removeEventListener("mg-deep-dive", onEvt); };
  }, [mounted]);

  // Two-finger swipe on the trackpad: fingers to the right tuck the app dock away, fingers to the left bring it back.
  // (Only clear horizontal swipes, and never inside something that scrolls sideways itself.)
  const dockOn = tab === "chats" || (tab === "projects" && projectChatOpen);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !dockOn) return;
    let acc = 0, last = 0, locked = false;
    const scrollsSideways = (n: EventTarget | null) => {
      for (let e = n as HTMLElement | null; e && e !== el; e = e.parentElement) {
        if (e.scrollWidth > e.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowX)) return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) < 2 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.6 || scrollsSideways(e.target)) return;
      const now = Date.now();
      if (now - last > 320) { acc = 0; locked = false; } // a new gesture
      last = now;
      if (locked) return;
      // Which way the fingers moved (macOS flips the sign when "natural scrolling" is on).
      const natural = (e as unknown as { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice === true;
      acc += (natural ? -e.deltaX : e.deltaX);
      const hidden = useApp.getState().dockHidden;
      if (acc > 70 && !hidden) { locked = true; useApp.getState().setDockHidden(true); }
      else if (acc < -70 && hidden) { locked = true; useApp.getState().setDockHidden(false); }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [dockOn]);
  // After the dock is tucked away, say once how to bring it back.
  useEffect(() => {
    if (!dockHidden) { void Promise.resolve().then(() => setDockHint(false)); return; }
    void Promise.resolve().then(() => setDockHint(true));
    const t = setTimeout(() => setDockHint(false), 3500);
    return () => clearTimeout(t);
  }, [dockHidden]);

  // Wait for mount + the initial session check before rendering anything.
  if (!mounted || !authResolved) return <div className="h-dvh bg-background" />;

  // Configured but signed out → the redirect above is in flight; show nothing.
  if (isSupabaseConfigured && !backed) return <div className="h-dvh bg-background" />;

  const isChats = tab === "chats";
  const fullWindow = fullFlag;
  // The composer appears on the Chats tab and when a chat is open inside a project.
  const showComposer = isChats || (tab === "projects" && projectChatOpen);

  // Side-by-side view: just the chat (no sidebar, tabs or dock) beside the app Marigold is working in.
  if (sideView) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        {!aux && <VoiceOut />}
        {!aux && <ConversationHost />}
      {!aux && <MeetingHost />}
        {!aux && <SetupGate />}
        {!aux && <PingToasts />}
        <SideViewBar />
        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"><ChatsView /></main>
        <PromptBar />
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {!aux && <VoiceOut />}
      {!aux && <ConversationHost />}
      {!aux && <MeetingHost />}
      {!aux && <SetupGate />}
      {!aux && <PingToasts />}
      {!fullWindow && <Sidebar />}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {fullWindow ? (
          // A brief hint that fades by itself (no button left floating over the page).
          <div className="pointer-events-none absolute left-1/2 top-3 z-[100] -translate-x-1/2 animate-[mghint_3s_ease-out_forwards] rounded-full bg-black/70 px-3 py-1 text-[12px] text-white">Press Esc to exit full screen</div>
        ) : (
          <TopNav />
        )}
        <div ref={rowRef} className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {isChats && !fullWindow && <BackgroundStrip />}
            {isChats && !fullWindow && <div className="px-4 pt-3 empty:hidden"><MeetingChatCard /></div>}
            <main className={tab === "browser" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto overflow-x-hidden"}>
              {tab === "browser" ? <BrowserPage /> : tab === "projects" ? <ProjectsView /> : <ChatsView />}
            </main>
            {showComposer && <PromptBar />}
          </div>
          {/* Every app on this Mac, Dock-style. Folds away while the live view panel is open. */}
          {showComposer && !fullWindow && (
            <div className="shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-out" style={{ width: dockHidden ? 0 : 64, opacity: dockHidden ? 0 : 1 }} aria-hidden={dockHidden}>
              <AppDock />
            </div>
          )}
          {dockHint && dockOn && (
            <div className="pointer-events-none absolute right-4 top-1/2 z-20 -translate-y-1/2 animate-fade-in rounded-full bg-black/75 px-3 py-1.5 text-[12px] text-white">Tap Apps at the top right (or swipe left with two fingers) to bring your apps back</div>
          )}
        </div>
      </div>
    </div>
  );
}
