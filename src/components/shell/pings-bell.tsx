"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CalendarClock, MessageCircle, Mail, ListChecks, BatteryLow, Sun, CheckCircle2, Radar, ShieldAlert, Newspaper } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { nativeApp } from "@/lib/native";
import { useBrowserOverlay } from "@/components/views/browser-page";

interface Ping { id: string; kind: string; title: string; body: string; at: string; chatId?: string; url?: string; read?: boolean }

const ICON: Record<string, typeof Bell> = {
  task: CheckCircle2, monitor: Radar, calendar: CalendarClock, messages: MessageCircle, email: Mail,
  reminders: ListChecks, battery: BatteryLow, morning: Sun, needs_you: ShieldAlert, briefing: Newspaper,
};

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The bell: what Marigold told you on its own (finished tasks, background finds, things it noticed). */
export function PingsBell() {
  const [open, setOpen] = useState(false);
  const [pings, setPings] = useState<Ping[]>([]);
  useBrowserOverlay(open); // the dropdown can hang over a web page in the Browser tab
  const box = useRef<HTMLDivElement>(null);
  const selectChat = useApp((s) => s.selectChat);
  const setTab = useApp((s) => s.setTab);
  const activeTab = useApp((s) => s.activeTab);
  const activeChatId = useApp((s) => s.activeChatId);
  const browserChats = useApp((s) => s.browserChats);
  // Is this chat on screen right now (and the window focused)?
  const viewing = useCallback((chatId?: string) => !!chatId && typeof document !== "undefined" && document.hasFocus()
    && ((activeTab === "chats" && activeChatId === chatId) || (activeTab === "browser" && Object.values(browserChats).includes(chatId))), [activeTab, activeChatId, browserChats]);
  const markRead = useCallback((ids: string[]) => ids.length ? fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", ids }) }).then(() => void 0).catch(() => {}) : Promise.resolve(), []);

  const load = useCallback(() => fetch("/api/agent/pings").then((r) => r.json()).then((j) => setPings(j.pings ?? [])).catch(() => {}), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    const native = nativeApp();
    const off = native?.onPing?.((p) => {
      // Already looking at that chat → it's read; the bell stays quiet.
      if (viewing(p.chatId)) void markRead([p.id]).then(load); else void load();
    });
    native?.onOpenPings?.(() => setOpen(true));
    const openBell = () => setOpen(true);
    window.addEventListener("mg-open-pings", openBell);
    native?.onOpenTab?.((tab) => { if (tab === "browser" || tab === "chats" || tab === "projects") setTab(tab); });
    return () => { clearInterval(t); off?.(); window.removeEventListener("mg-open-pings", openBell); };
  }, [load, setTab, viewing, markRead]);
  // Opening a chat reads its pings.
  useEffect(() => {
    const ids = pings.filter((p) => !p.read && viewing(p.chatId)).map((p) => p.id);
    if (ids.length) void markRead(ids).then(load);
  }, [pings, viewing, markRead, load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const unread = pings.filter((p) => !p.read).length;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unread) { void fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read" }) }).then(load); }
  };
  const go = (p: Ping) => {
    setOpen(false);
    if (p.url && nativeApp()?.browser) { setTab("browser"); void nativeApp()!.browser!.newTab(p.url); }
    else if (p.url) window.open(p.url, "_blank");
    else if (p.chatId) selectChat(p.chatId);
  };

  return (
    <div ref={box} className="relative">
      <button onClick={toggle} title="Notifications" aria-label="Notifications" className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-foreground">
        <Bell size={16} />
        {unread > 0 && <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-black">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-[90] w-80 overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[13px] font-medium">Notifications</span>
            {pings.length > 0 && (
              <button onClick={() => void fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) }).then(load)} className="text-[11px] text-muted hover:text-foreground">Clear</button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {pings.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-muted">Nothing yet. Marigold will tell you when a task finishes, when something&apos;s about to start, or when a text or email needs you.</p>
            ) : pings.map((p) => {
              const I = ICON[p.kind] ?? Bell;
              return (
                <button key={p.id} onClick={() => go(p)} className={cn("flex w-full gap-2.5 border-b border-border/60 px-3 py-2.5 text-left last:border-0 hover:bg-surface-hover", !p.read && "bg-accent-soft/40")}>
                  <I size={15} className="mt-0.5 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2"><span className="truncate text-[12.5px] font-medium">{p.title}</span><span className="ml-auto shrink-0 text-[10px] text-muted">{ago(p.at)}</span></span>
                    <span className={cn("mt-0.5 block text-[11.5px] text-muted", p.kind === "briefing" ? "whitespace-pre-line" : "line-clamp-2")}>{p.body}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
