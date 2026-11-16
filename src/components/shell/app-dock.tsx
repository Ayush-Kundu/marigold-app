"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelRightClose, Search } from "lucide-react";
import { useApp } from "@/lib/store";
import { appUseCounts, bumpAppUse, iconUrl, tileHue, useMacApps, type MacApp } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/** An app's icon: the real macOS one when we have it, else a coloured letter tile. */
export function AppIcon({ app, name, size = 36, className }: { app?: MacApp; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (app && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={iconUrl(app.path)} alt="" draggable={false} loading="lazy" decoding="async" onError={() => setFailed(true)} className={cn("shrink-0 select-none", className)} style={{ width: size, height: size }} />;
  }
  return (
    <span className={cn("flex shrink-0 select-none items-center justify-center rounded-[22%] font-semibold text-white", className)} style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${tileHue(name)} 45% 48%)` }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** A small app chip (icon + name) for the composer and for messages that carry a picked app. */
export function AppChip({ name, bare }: { name: string; bare?: boolean }) {
  const { apps } = useMacApps();
  const app = apps.find((a) => a.name === decodeURIComponent(name) || a.name === name);
  const label = (() => { try { return decodeURIComponent(name); } catch { return name; } })();
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", !bare && "mx-0.5 rounded-md border border-accent/30 bg-accent/10 py-px pl-1 pr-1.5 text-[12px] font-medium")}>
      <AppIcon app={app} name={label} size={14} className="rounded-[4px]" />
      {label}
    </span>
  );
}

const W = 64;          // the dock's width
const REACH = 96;      // how far (px) the Mac-dock "swell" reaches from the pointer
const MAX_SCALE = 1.45;

/**
 * Every app on this Mac as an icon strip on the right edge of the chat, like the Dock: hover for the name
 * (the icons swell under the pointer), click to attach that app to your message so the agent uses it.
 * It slides away when the live view panel slides in (the shell collapses its width).
 */
export function AppDock() {
  const { apps, ready } = useMacApps();
  const chosen = useApp((s) => s.chosenApps);
  const toggle = useApp((s) => s.toggleChosenApp);
  const [tip, setTip] = useState<{ name: string; kind: string; y: number; x: number } | null>(null);
  const [q, setQ] = useState("");
  const setHidden = useApp((s) => s.setDockHidden);
  const [searching, setSearching] = useState(false);
  const [hi, setHi] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const raf = useRef(0);

  // Most-used first (apps you pick often float up), then A–Z.
  const [uses] = useState<Record<string, number>>(() => appUseCounts());
  const sorted = useMemo(() => [...apps].sort((a, b) => (uses[b.name] ?? 0) - (uses[a.name] ?? 0) || a.name.localeCompare(b.name)), [apps, uses]);
  // The search box is a roomy pop-over beside the dock (not squeezed inside it): best matches first.
  const matches = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return sorted.slice(0, 30);
    const score = (n: string) => (n === f ? 0 : n.startsWith(f) ? 1 : n.split(" ").some((w) => w.startsWith(f)) ? 2 : n.includes(f) ? 3 : 9);
    return sorted.map((a) => ({ a, s: score(a.name.toLowerCase()) })).filter((x) => x.s < 9).sort((x, y) => x.s - y.s).map((x) => x.a).slice(0, 30);
  }, [sorted, q]);
  useEffect(() => {
    if (!searching) return;
    const close = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-dock-search]")) { setSearching(false); setQ(""); } };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [searching]);

  /** Swell the icons near the pointer (direct style writes: no re-render per mouse move). */
  const swell = (clientY: number | null) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      for (const el of items.current.values()) {
        if (clientY == null) { el.style.transform = ""; continue; }
        const r = el.getBoundingClientRect();
        const d = Math.abs(clientY - (r.top + r.height / 2));
        const k = Math.max(0, 1 - d / REACH);
        el.style.transform = k > 0.02 ? `scale(${1 + (MAX_SCALE - 1) * Math.sin((k * Math.PI) / 2)})` : "";
      }
    });
  };

  const pick = (a: MacApp) => {
    toggle(a.name);
    bumpAppUse(a.name);
    window.dispatchEvent(new Event("mg-focus-composer"));
  };

  return (
    <div className="flex h-full shrink-0 flex-col items-center border-l border-border bg-surface/40" style={{ width: W }}>
      <div className="flex w-full shrink-0 flex-col items-center gap-1 border-b border-border/70 py-2">
        <button onClick={() => setHidden(true)} title="Hide apps" aria-label="Hide apps" className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground">
          <PanelRightClose size={15} />
        </button>
        <button
          data-dock-search
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAnchor({ top: r.top, left: r.left }); setSearching((v) => !v); setQ(""); setHi(0); }}
          title="Find an app" aria-label="Find an app"
          className={cn("flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground", searching && "bg-surface-hover text-foreground")}
        >
          <Search size={15} />
        </button>
      </div>
      {searching && anchor && (
        <div ref={popRef} className="fixed z-[210] w-[260px] animate-fade-in overflow-hidden rounded-xl border border-border bg-background shadow-2xl" style={{ top: Math.max(8, Math.min(anchor.top, window.innerHeight - 380)), right: `calc(100vw - ${anchor.left}px + 10px)` }}>
          <div className="flex h-10 items-center gap-2 border-b border-border px-3">
            <Search size={14} className="shrink-0 text-muted" />
            <input
              autoFocus value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} placeholder="Find an app"
              onKeyDown={(e) => {
                if (e.key === "Escape") { setSearching(false); setQ(""); }
                else if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(matches.length - 1, i + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
                else if (e.key === "Enter" && matches[hi]) { pick(matches[hi]); setSearching(false); setQ(""); }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
            />
          </div>
          <div className="max-h-[320px] overflow-y-auto p-1">
            {matches.length === 0 && <p className="px-3 py-4 text-center text-[12px] text-muted">No app matches “{q}”.</p>}
            {matches.map((a, i) => (
              <button key={a.path} onMouseEnter={() => setHi(i)} onClick={() => { pick(a); setSearching(false); setQ(""); }} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px]", i === hi ? "bg-surface-hover" : "")}>
                <AppIcon app={a} name={a.name} size={24} className="rounded-[6px]" />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                {chosen.includes(a.name) && <span className="text-[10.5px] font-medium text-accent">added</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        ref={listRef}
        onMouseMove={(e) => swell(e.clientY)}
        onMouseLeave={() => { swell(null); setTip(null); }}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {!ready && <span className="mt-4 h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />}
        {ready && sorted.length === 0 && <span className="px-1 text-center text-[10px] text-muted">No apps found</span>}
        {sorted.map((a) => {
          const on = chosen.includes(a.name);
          return (
            <button
              key={a.path}
              ref={(el) => { if (el) items.current.set(a.path, el); else items.current.delete(a.path); }}
              onClick={() => pick(a)}
              onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ name: a.name, kind: a.kind, y: r.top + r.height / 2, x: r.left }); }}
              aria-label={`Use ${a.name}`}
              aria-pressed={on}
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[22%] outline-none transition-transform duration-100 ease-out focus-visible:ring-2 focus-visible:ring-accent"
            >
              <AppIcon app={a} name={a.name} size={34} className={cn(on && "drop-shadow-[0_0_6px_var(--accent)]")} />
              {on && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-accent" />}
            </button>
          );
        })}
      </div>
      {tip && (
        <div className="pointer-events-none fixed z-[200] -translate-y-1/2 animate-fade-in whitespace-nowrap rounded-lg border border-border bg-background/95 px-2.5 py-1 text-[12px] font-medium shadow-lg backdrop-blur" style={{ top: tip.y, right: `calc(100vw - ${tip.x}px + 12px)` }}>
          {tip.name}
          <span className="ml-1.5 text-[10.5px] font-normal text-muted">{chosen.includes(tip.name) ? "added · click to remove" : "click to use"}</span>
        </div>
      )}
    </div>
  );
}
