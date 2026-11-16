"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Newspaper, ShieldAlert, BatteryLow, X, Bell } from "lucide-react";
import { nativeApp } from "@/lib/native";
import { useApp } from "@/lib/store";
import { useBrowserOverlay } from "@/components/views/browser-page";

interface Toast { id: string; kind: string; title: string; body: string; chatId?: string; url?: string; priority?: string }
const ICON: Record<string, typeof Bell> = { briefing: Newspaper, calendar: CalendarClock, needs_you: ShieldAlert, battery: BatteryLow };
/** How long a card stays: the bar along its bottom fills over this long, then the card goes away. */
const SECONDS = 5;

/**
 * Important things (a task needs you, a meeting is about to start, your daily briefing, low battery) also appear as a
 * card inside Marigold while you're using it, so they can't be missed. Everything routine stays in the bell.
 */
export function PingToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const selectChat = useApp((s) => s.selectChat);
  const setTab = useApp((s) => s.setTab);
  useBrowserOverlay(toasts.length > 0); // the card can sit over a web page in the Browser tab

  const dismiss = useCallback((id: string) => setToasts((l) => l.filter((t) => t.id !== id)), []);

  useEffect(() => {
    const off = nativeApp()?.onPing?.((p) => {
      if (p.priority !== "critical") return;
      const t: Toast = { id: p.id, kind: p.kind, title: p.title, body: p.body, chatId: p.chatId, url: p.url, priority: p.priority };
      setToasts((l) => [...l.filter((x) => x.id !== t.id), t].slice(-2)); // never a pile
    });
    return () => { off?.(); };
  }, []);

  const open = (t: Toast) => {
    void fetch("/api/agent/pings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", ids: [t.id] }) });
    if (t.chatId) { selectChat(t.chatId); setTab("chats"); }
    else if (t.url && /^https?:/.test(t.url)) { void nativeApp()?.browser?.newTab(t.url); setTab("browser"); }
    else window.dispatchEvent(new Event("mg-open-pings"));
    dismiss(t.id);
  };

  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-[120] flex w-[370px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => {
        const I = ICON[t.kind] ?? Bell;
        return (
          <div key={t.id} role="alert" className="group pointer-events-auto relative animate-fade-in overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
            <div className="flex gap-3 p-3.5 pb-4">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><I size={16} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold leading-snug">{t.title}</p>
                {t.body && <p className="mt-1 line-clamp-6 whitespace-pre-line text-[12.5px] leading-[1.55] text-muted">{t.body}</p>}
                <div className="mt-2.5 flex items-center gap-2">
                  <button onClick={() => open(t)} className="h-7 rounded-lg bg-accent px-3 text-[12px] font-medium text-black">{t.kind === "needs_you" ? "Review" : "Open"}</button>
                  <button onClick={() => dismiss(t.id)} className="h-7 rounded-lg px-2.5 text-[12px] text-muted hover:bg-surface-hover hover:text-foreground">Dismiss</button>
                </div>
              </div>
              <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"><X size={13} /></button>
            </div>
            {/* Time left: fills over 5 seconds, then the card goes away (holding the pointer over it pauses it). */}
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-foreground/10">
              <div
                className="h-full origin-left bg-accent group-hover:[animation-play-state:paused]"
                style={{ animationName: "mgtoast", animationDuration: `${SECONDS}s`, animationTimingFunction: "linear", animationFillMode: "forwards" }}
                onAnimationEnd={() => dismiss(t.id)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
