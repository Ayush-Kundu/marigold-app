"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGrid, Radar, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { nativeApp } from "@/lib/native";
import { ConversationControl } from "@/components/shell/conversation-control";
import { MarigoldIcon } from "@/components/marigold-icon";
import { useChatAgentState } from "@/components/views/view-page";

const SEEN_KEY = "marigold.viewButtonSeen";
const seen = () => { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; } };

/** Open the side-by-side view (only inside the Mac app, where windows can be arranged). */
export function useOpenView() {
  const setSideView = useApp((s) => s.setSideView);
  const can = typeof window !== "undefined" && !!nativeApp()?.viewEnter;
  return {
    can,
    /** `apps`: open these now (launching them if needed); otherwise the apps the user has picked in the dock. */
    open: async (apps?: string[]) => {
      viewApps = (apps ?? useApp.getState().chosenApps).slice(0, 4);
      // Start the apps NOW, while the window glides into place, so they are already open when the layout asks for them.
      if (viewApps.length) void fetch("/api/agent/view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ launchOnly: true, apps: viewApps }) }).catch(() => {});
      try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
      window.dispatchEvent(new Event("mg-view-seen"));
      // Fade the page, glide the window to its strip, then show the compact layout and fade back in.
      await fade(true);
      viewRect = (await nativeApp()?.viewEnter?.().catch(() => null)) ?? null;
      setSideView(true);
      requestAnimationFrame(() => void fade(false));
    },
  };
}

/** Apps to put in the view from the start (the ones the user picked); apps the agent uses later are added to them. */
let viewApps: string[] = [];
/** The area (screen points) the app should fill; set by open(). */
let viewRect: { x: number; y: number; w: number; h: number } | null = null;
const fade = (on: boolean) => { document.body.classList.toggle("mg-fade", on); return new Promise<void>((r) => setTimeout(r, on ? 160 : 0)); };

/** "Open view" in the top bar once the agent has worked in apps. Shakes until it's been clicked once, so it isn't missed. */
export function OpenViewButton() {
  const { working, hasWork } = useChatAgentState();
  const tab = useApp((s) => s.activeTab);
  const picked = useApp((s) => s.chosenApps);
  const { can, open } = useOpenView();
  const [shake, setShake] = useState(false);
  useEffect(() => {
    const sync = () => setShake(!seen());
    sync();
    window.addEventListener("mg-view-seen", sync);
    return () => window.removeEventListener("mg-view-seen", sync);
  }, []);
  if (!can || tab === "browser" || (!hasWork && !picked.length)) return null;
  return (
    <button
      onClick={() => void open()}
      title={picked.length ? `Open ${picked.join(", ")} beside Marigold` : "Open view: Marigold and the app it's working in, side by side"}
      className={cn("flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground", shake && "animate-[mgshake_3s_ease-in-out_infinite] bg-accent/15 text-foreground")}
    >
      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
        <Radar size={14} />
        {working && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
      </span>
      <span className="hidden sm:inline">{picked.length ? `Open view · ${picked.length} app${picked.length > 1 ? "s" : ""}` : "Open view"}</span>
    </button>
  );
}

/**
 * The strip shown while the side-by-side view is on: shrinks this window (main process), then keeps the
 * window of whichever app the agent is using right now in the area beside it, swapping as the agent moves on.
 */
export function SideViewBar() {
  const setSideView = useApp((s) => s.setSideView);
  const activeChat = useApp((s) => s.activeChatId);
  const chatId = activeChat ?? "workspace";
  const { working } = useChatAgentState();
  const [current, setCurrent] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const rect = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const applied = useRef("");
  const tries = useRef(0);
  const inflight = useRef(false);

  const leaving = useRef(false);
  const exit = async () => {
    if (leaving.current) return;
    leaving.current = true;
    await fade(true);
    await nativeApp()?.viewExit?.();
    setSideView(false);
    requestAnimationFrame(() => void fade(false));
  };

  useEffect(() => {
    rect.current = viewRect;
    applied.current = "";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) void exit(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per view
  }, []);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const r = rect.current;
      if (!r || dead) return;
      const j = await fetch(`/api/agent/screen?chat=${encodeURIComponent(chatId)}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null) as { apps?: { app: string }[] } | null;
      // The Marigold Browser lives in this window, so it isn't one to arrange.
      const list = [...new Set([...viewApps, ...(j?.apps?.map((a) => a.app) ?? [])])].filter((a) => a !== "Marigold Browser").slice(0, 4);
      if (dead) return;
      setCurrent(list);
      // Re-arrange only when the SET of apps changes (not on every swap of which one is active), so windows don't jump around.
      const key = `${chatId}:${[...list].sort().join("|")}`;
      const have = applied.current.slice(chatId.length + 1).split("|").filter(Boolean);
      const added = list.some((a) => !have.includes(a));
      if (!list.length || applied.current === key || inflight.current || (applied.current.startsWith(`${chatId}:`) && !added)) return;
      inflight.current = true;
      const res = await fetch("/api/agent/view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat: chatId, apps: list, area: r }) }).then((x) => x.json()).catch(() => ({ error: "Couldn't arrange the apps." })) as { ok?: boolean; error?: string; apps?: { app: string; status: string }[] };
      inflight.current = false;
      if (dead) return;
      const st = (s: string) => res.apps?.filter((a) => a.status === s).map((a) => a.app) ?? [];
      const waiting = st("nowindow"), away = st("otherspace"), skipped = st("skipped");
      // Apps that are still starting get another try every moment (for about a minute); the rest are done.
      tries.current += 1;
      if (waiting.length && tries.current < 45) { setNote(`Opening ${waiting.join(", ")}…`); return; }
      applied.current = key; tries.current = 0;
      setNote(away.length ? `${away.join(", ")} ${away.length > 1 ? "are" : "is"} on another desktop. Bring ${away.length > 1 ? "them" : "it"} to this one.`
        : waiting.length ? `${waiting.join(", ")} didn't open a window. Open ${waiting.length > 1 ? "them" : "it"} yourself and they'll be arranged.`
        : skipped.length ? `No room for ${skipped.join(", ")} here.` : res.ok ? "" : res.error ?? "Couldn't arrange the apps.");
    };
    // Quick checks (0.5 s) while apps are still opening, relaxed (2 s) once they're placed; nothing while the window is hidden.
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (dead) return;
      if (!document.hidden) await tick().catch(() => {});
      if (!dead) timer = setTimeout(loop, applied.current ? 2000 : 500);
    };
    void loop();
    return () => { dead = true; clearTimeout(timer); };
  }, [chatId]);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <MarigoldIcon size={20} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[12.5px] font-medium">{current.length ? current.join(" · ") : working ? "Starting…" : "Waiting for an app"}</p>
        <p className="truncate text-[11px] text-muted">{note || (working ? "Marigold is working here" : "Side by side")}</p>
      </div>
      <ConversationControl compact />
      <button onClick={() => void exit()} title="Close view (Esc)" className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11.5px] text-muted hover:bg-surface-hover hover:text-foreground" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <X size={13} /> Close
      </button>
    </div>
  );
}

interface JobRow { id: string; label: string; blurb: string; installed: string[]; prompts: string[] }
interface Space { id: string; name: string; apps: string[] }
interface InstalledApp { name: string; kind?: string }

/**
 * Workspaces: apps that open together beside the chat. Yours come first (name them, pick up to four apps, rename or
 * delete any time); suggestions made from what's installed sit below and can be saved as your own with one click.
 * (Only in the Mac app.)
 */
export function WorkspacesButton() {
  const tab = useApp((s) => s.activeTab);
  const setChosen = useApp((s) => s.setChosenApps);
  const setOverlay = useApp((s) => s.setBrowserOverlay);
  const { can, open } = useOpenView();
  const [show, setShow] = useState(false);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [mine, setMine] = useState<Space[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [edit, setEdit] = useState<Space | null>(null);
  const [find, setFind] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // Look at everything ahead of time, so the menu is full the moment it opens.
  useEffect(() => {
    if (!can) return;
    void fetch("/api/agent/jobs").then((r) => r.json()).then((j) => setJobs(j.jobs ?? [])).catch(() => {});
    void fetch("/api/agent/workspaces").then((r) => r.json()).then((j) => setMine(j.workspaces ?? [])).catch(() => {});
    void fetch("/api/agent/apps").then((r) => r.json()).then((j) => setInstalled(j.apps ?? [])).catch(() => {});
  }, [can]);
  useEffect(() => {
    if (!show) return;
    setOverlay(1);
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setShow(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { if (edit) setEdit(null); else setShow(false); } };
    window.addEventListener("mousedown", away); window.addEventListener("keydown", esc);
    return () => { setOverlay(-1); window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [show, edit, setOverlay]);
  if (!can || tab === "browser") return null;
  const save = async (list: Space[]) => {
    const r = await fetch("/api/agent/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaces: list }) }).then((x) => x.json()).catch(() => null) as { workspaces?: Space[] } | null;
    if (r?.workspaces) setMine(r.workspaces);
  };
  const go = (apps: string[]) => { const a = apps.slice(0, 4); setChosen(a); setShow(false); void open(a); };
  const startEdit = (w: Space | null, seed?: { name: string; apps: string[] }) => { setFind(""); setEdit(w ?? { id: "", name: seed?.name ?? "", apps: seed?.apps ?? [] }); };
  const commit = async () => {
    if (!edit || !edit.name.trim() || !edit.apps.length) return;
    const next = edit.id ? mine.map((w) => (w.id === edit.id ? edit : w)) : [...mine, { ...edit, id: Math.random().toString(36).slice(2, 10) }];
    await save(next); setEdit(null);
  };
  const shown = installed.filter((a) => !find || a.name.toLowerCase().includes(find.toLowerCase())).slice(0, 60);
  const mineApps = new Set(mine.map((w) => w.name.toLowerCase()));
  return (
    <div ref={box} className="relative">
      <button onClick={() => setShow((v) => !v)} title="Workspaces: open the apps for a kind of work together" className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground">
        <LayoutGrid size={14} /> <span className="hidden xl:inline">Workspaces</span>
      </button>
      {show && (
        <div className="absolute right-0 top-full z-[60] mt-1 max-h-[75vh] w-80 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-2xl">
          {edit ? (
            <div className="space-y-2 p-1.5">
              <input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Name, e.g. Homework" maxLength={40} className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-accent" />
              <div className="flex flex-wrap gap-1">
                {edit.apps.map((a) => <button key={a} onClick={() => setEdit({ ...edit, apps: edit.apps.filter((x) => x !== a) })} className="flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-[11.5px]">{a}<X size={10} /></button>)}
                {!edit.apps.length && <span className="text-[11.5px] text-muted">Pick up to 4 apps below.</span>}
              </div>
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search your apps" className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[12.5px] outline-none focus:border-accent" />
              <div className="max-h-48 overflow-y-auto">
                {shown.map((a) => {
                  const on = edit.apps.includes(a.name);
                  return <button key={a.name} disabled={!on && edit.apps.length >= 4} onClick={() => setEdit({ ...edit, apps: on ? edit.apps.filter((x) => x !== a.name) : [...edit.apps, a.name] })} className={cn("flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-surface-hover disabled:opacity-40", on && "bg-accent/15")}><span className="truncate">{a.name}</span>{on && <span className="text-[11px] text-accent">added</span>}</button>;
                })}
                {!shown.length && <p className="px-2 py-2 text-[12px] text-muted">No app by that name.</p>}
              </div>
              <div className="flex items-center gap-2 pt-1">
                {edit.id && <button onClick={async () => { await save(mine.filter((w) => w.id !== edit.id)); setEdit(null); }} className="h-7 rounded-md px-2 text-[12px] text-danger hover:bg-surface-hover">Delete</button>}
                <span className="flex-1" />
                <button onClick={() => setEdit(null)} className="h-7 rounded-md px-2 text-[12px] text-muted hover:bg-surface-hover">Cancel</button>
                <button onClick={() => void commit()} disabled={!edit.name.trim() || !edit.apps.length} className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-black disabled:opacity-50">Save</button>
              </div>
            </div>
          ) : (
            <>
              <p className="flex items-center justify-between px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-muted"><span>Your workspaces</span><button onClick={() => startEdit(null)} className="rounded-md px-1.5 py-0.5 normal-case text-accent hover:bg-surface-hover">+ New</button></p>
              {!mine.length && <p className="px-2.5 pb-2 text-[12px] text-muted">None yet. Make one with + New, or save a suggestion below as your own.</p>}
              {mine.map((w) => (
                <div key={w.id} className="group flex items-center rounded-lg hover:bg-surface-hover">
                  <button onClick={() => go(w.apps)} className="flex min-w-0 flex-1 flex-col px-2.5 py-2 text-left">
                    <span className="truncate text-[13px] font-medium">{w.name}</span>
                    <span className="truncate text-[11.5px] text-muted">{w.apps.join(" · ")}</span>
                  </button>
                  <button onClick={() => startEdit(w)} className="mr-1.5 hidden h-6 rounded-md px-2 text-[11.5px] text-muted hover:text-foreground group-hover:block">Edit</button>
                </div>
              ))}
              <p className="px-2.5 pb-1 pt-2.5 text-[11px] uppercase tracking-wide text-muted">Suggested from your apps</p>
              {!jobs && <p className="px-3 py-3 text-[12.5px] text-muted">Looking at what you have installed…</p>}
              {jobs?.length === 0 && <p className="px-3 py-3 text-[12.5px] text-muted">No matching apps found.</p>}
              {jobs?.filter((j) => !mineApps.has(j.label.toLowerCase())).map((j) => (
                <div key={j.id} className="group flex items-center rounded-lg hover:bg-surface-hover">
                  <button onClick={() => go(j.installed)} className="flex min-w-0 flex-1 flex-col px-2.5 py-2 text-left">
                    <span className="text-[13px] font-medium">{j.label}</span>
                    <span className="truncate text-[11.5px] text-muted">{j.installed.slice(0, 3).join(" · ")}</span>
                  </button>
                  <button onClick={() => startEdit(null, { name: j.label, apps: j.installed.slice(0, 4) })} className="mr-1.5 hidden h-6 rounded-md px-2 text-[11.5px] text-muted hover:text-foreground group-hover:block">Customize</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
