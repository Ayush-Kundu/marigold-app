"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronRight, Settings2, X, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { nativeApp } from "@/lib/native";

/**
 * The Pulse bar: a live strip under the toolbar with your stocks, crypto, scores, weather and the latest headlines.
 * Quotes and scores refresh every 30 s (and the moment you come back to the window), headlines every few minutes;
 * a dot marks headlines you haven't seen. Clicking anything opens it in a tab.
 */

interface Quote { sym: string; label: string; price: number; change: number; pct: number; kind: "stock" | "index" | "crypto" }
interface Score { id: string; league: string; state: "pre" | "in" | "post"; detail: string; away: { abbr: string; name: string; score: string; win?: boolean }; home: { abbr: string; name: string; score: string; win?: boolean }; url?: string; at: string }
interface Weather { city: string; temp: number; label: string; icon: string; high?: number; low?: number }
interface Headline { title: string; url: string; site: string; at: string }
interface Config { symbols: string[]; crypto: string[]; leagues: string[]; teams: string[]; city: string; topics: string[]; alerts: { scores: boolean; stocks: boolean; stockPct: number; breaking: boolean } }
interface Story { key: string; title: string; url: string; sites: string[]; at: string; topic?: string; breaking: boolean }
interface Breaking { now: Story[]; topics: Story[]; day: Story[]; week: Story[] }
interface Data { at: string; quotes: Quote[]; scores: Score[]; weather: Weather | null; news: Headline[]; breaking?: Breaking; config: Config; leagues: Record<string, string> }

const SEEN_KEY = "marigold.pulseSeen", OFF_KEY = "marigold.pulseOff";
const readSeen = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")); } catch { return new Set(); } };
const money = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2));
const ago = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

export function PulseBar() {
  const bridge = nativeApp()?.browser;
  const setOverlay = useApp((s) => s.setBrowserOverlay);
  const [off, setOff] = useState(() => { try { return localStorage.getItem(OFF_KEY) === "1"; } catch { return false; } });
  const [data, setData] = useState<Data | null>(null);
  const [panel, setPanel] = useState<null | "card" | "news" | "scores" | "edit">(null);
  const [newsTab, setNewsTab] = useState<"latest" | "day" | "week">("latest");
  const [seen, setSeen] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readSeen()));
  const [tick, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try { setData(await fetch("/api/agent/pulse", { cache: "no-store" }).then((r) => r.json())); } catch { /* offline: keep the last numbers */ }
  }, []);
  useEffect(() => {
    if (off) return;
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    const vis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("focus", vis);
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener("visibilitychange", vis); window.removeEventListener("focus", vis); };
  }, [off, load]);
  useEffect(() => {
    const t = () => setOff((v) => { try { localStorage.setItem(OFF_KEY, v ? "0" : "1"); } catch { /* storage off */ } return !v; });
    window.addEventListener("mg-toggle-pulse", t);
    return () => window.removeEventListener("mg-toggle-pulse", t);
  }, []);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 7000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!panel) return;
    setOverlay(1);
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setPanel(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPanel(null); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", esc);
    return () => { setOverlay(-1); window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [panel, setOverlay]);

  const fresh = useMemo(() => (data?.news ?? []).filter((h) => !seen.has(h.url)), [data, seen]);
  const markSeen = () => {
    if (!data) return;
    const s = new Set([...seen, ...data.news.map((h) => h.url)]);
    setSeen(s);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-80))); } catch { /* storage off */ }
  };
  const openUrl = (u: string) => { setPanel(null); void bridge?.newTab(u); };
  const searchFor = (q: string) => openUrl(`${window.location.origin}/search?q=${encodeURIComponent(q)}`);

  if (!bridge) return null;
  if (off) return (
    <div className="flex h-6 shrink-0 items-center justify-end border-t border-border bg-surface/40 px-2">
      <button onClick={() => window.dispatchEvent(new Event("mg-toggle-pulse"))} title="Show the Pulse bar" className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] text-muted hover:bg-surface-hover hover:text-foreground">
        <Activity size={12} /> Show Pulse
      </button>
    </div>
  );
  const q3 = data?.quotes.slice(0, 3) ?? [];
  const live = (data?.scores ?? []).filter((x) => x.state === "in");
  const games = live.length ? live : (data?.scores ?? []).filter((x) => x.state !== "post").concat((data?.scores ?? []).filter((x) => x.state === "post"));
  const list = fresh.length ? fresh : data?.news ?? [];
  const hot = new Set([...(data?.breaking?.now ?? []), ...(data?.breaking?.topics ?? [])].slice(0, 2).map((x) => x.url));
  const top = list[tick % Math.max(1, list.length)];
  const pop = "absolute bottom-full z-[60] mb-2 rounded-2xl border border-border bg-background/95 shadow-2xl backdrop-blur-xl";
  const pill = (pct: number) => cn("rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums", pct >= 0 ? "bg-success/15 text-success" : "bg-danger/15 text-danger");
  const save = async (c: Partial<Config>) => { setData(await fetch("/api/agent/pulse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }).then((r) => r.json())); setPanel(null); };

  return (
    <div ref={box} className="relative shrink-0 border-t border-border bg-background/80 backdrop-blur">
      <div className="flex h-9 items-center gap-1 px-2 text-[12px]">
        <button onClick={() => setPanel(panel === "card" ? null : "card")} title="Today at a glance" className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium transition-colors hover:bg-surface-hover", panel === "card" && "bg-surface-hover")}>
          <Activity size={13} className="text-accent" /> Pulse
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {!data && <span className="px-2 text-muted">Loading…</span>}
          {q3.map((q) => (
            <button key={q.sym} onClick={() => setPanel("card")} title={`${q.label} ${money(q.price)}`} className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 hover:bg-surface-hover">
              <span className="font-medium">{q.label}</span><span className={cn("tabular-nums", q.pct >= 0 ? "text-success" : "text-danger")}>{q.pct >= 0 ? "▲" : "▼"} {Math.abs(q.pct).toFixed(1)}%</span>
            </button>
          ))}
          {live.slice(0, 2).map((g) => (
            <button key={g.id} onClick={() => setPanel("card")} className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 hover:bg-surface-hover" title={`${g.away.name} at ${g.home.name}`}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
              <span className="font-medium">{g.away.abbr} {g.away.score}</span><span className="text-muted">–</span><span className="font-medium">{g.home.abbr} {g.home.score}</span>
            </button>
          ))}
        </div>
        {data?.breaking?.now?.[0] && (
          <button onClick={() => openUrl(data.breaking!.now[0].url)} className="hidden min-w-0 max-w-[40%] items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-foreground hover:bg-danger/20 lg:flex" title={`${data.breaking.now[0].sites.length} outlets: ${data.breaking.now[0].sites.join(", ")}`}>
            <span className="shrink-0 rounded-full bg-danger px-1.5 text-[10px] font-semibold uppercase text-white">Breaking</span>
            <span className="truncate">{data.breaking.now[0].title}</span>
          </button>
        )}
        {top && !data?.breaking?.now?.length && (
          <button onClick={() => { setPanel("news"); markSeen(); }} className="hidden min-w-0 max-w-[34%] items-center gap-1.5 rounded-full px-2.5 py-1 text-muted hover:bg-surface-hover hover:text-foreground lg:flex" title="Latest headlines">
            {fresh.length > 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-black">{fresh.length} new</span>}
            <span className="truncate">{top.title}</span>
          </button>
        )}
        <button onClick={() => setPanel(panel === "edit" ? null : "edit")} title="Choose what Pulse shows" className="shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"><Settings2 size={13} /></button>
        <button onClick={() => window.dispatchEvent(new Event("mg-toggle-pulse"))} title="Hide Pulse (a Show Pulse button stays at the bottom)" className="shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"><X size={13} /></button>
      </div>

      {panel === "card" && data && (
        <div className={cn(pop, "left-2 max-h-[75vh] w-[380px] max-w-[94vw] space-y-3 overflow-y-auto p-4")}>
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-semibold">Today</p>
            {data.weather ? (
              <button onClick={() => searchFor(`weather ${data.weather!.city}`)} className="flex items-center gap-1.5 rounded-full bg-surface-hover px-2.5 py-1 text-[12px]"><span>{data.weather.icon}</span><span className="tabular-nums">{data.weather.temp}°</span><span className="text-muted">{data.weather.city}</span></button>
            ) : <button onClick={() => setPanel("edit")} className="rounded-full bg-surface-hover px-2.5 py-1 text-[12px] text-muted hover:text-foreground">Set city</button>}
          </div>
          {(data.breaking?.now?.length ?? 0) + (data.breaking?.topics?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-2">
              <p className="mb-1 flex items-center justify-between px-1 text-[10.5px] font-medium uppercase tracking-wide text-danger"><span>Breaking and your topics</span><button onClick={() => { setNewsTab("day"); setPanel("news"); }} className="flex items-center normal-case text-muted hover:text-foreground">Day and week <ChevronRight size={11} /></button></p>
              {[...(data.breaking?.now ?? []), ...(data.breaking?.topics ?? []).filter((t) => !(data.breaking?.now ?? []).some((n) => n.key === t.key))].slice(0, 2).map((x) => <StoryRow key={x.key} x={x} onOpen={openUrl} compact />)}
              {(data.breaking?.now?.length ?? 0) + (data.breaking?.topics?.length ?? 0) > 2 && <button onClick={() => { setNewsTab("day"); setPanel("news"); }} className="w-full px-2 pt-0.5 text-left text-[11px] text-muted hover:text-foreground">+ more in Day and week</button>}
            </div>
          )}
          {data.quotes.length > 0 && (
            <div>
              <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted">Markets</p>
              {data.quotes.slice(0, 4).map((q) => (
                <button key={q.sym} onClick={() => searchFor(`${q.sym.replace(/^\^/, "")} ${q.kind === "crypto" ? "price" : "stock"}`)} className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[13px] hover:bg-surface-hover">
                  <span className="font-medium">{q.label}</span>
                  <span className="flex items-center gap-2"><span className="tabular-nums text-muted">{money(q.price)}</span><span className={pill(q.pct)}>{q.pct >= 0 ? "+" : ""}{q.pct.toFixed(1)}%</span></span>
                </button>
              ))}
            </div>
          )}
          {games.length > 0 && (
            <div>
              <p className="mb-1 flex items-center justify-between text-[10.5px] font-medium uppercase tracking-wide text-muted"><span>{live.length ? "Live now" : "Games"}</span>{games.length > 3 && <button onClick={() => setPanel("scores")} className="flex items-center normal-case text-muted hover:text-foreground">All {games.length} <ChevronRight size={11} /></button>}</p>
              {games.slice(0, 3).map((g) => (
                <button key={g.id} onClick={() => (g.url ? openUrl(g.url) : searchFor(`${g.away.name} vs ${g.home.name}`))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-hover">
                  {g.state === "in" ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-danger" /> : <span className="w-1.5 shrink-0" />}
                  <span className={cn("font-medium", g.away.win && "text-foreground")}>{g.away.abbr}{g.state !== "pre" ? ` ${g.away.score}` : ""}</span>
                  <span className="text-muted">{g.state === "pre" ? "at" : "–"}</span>
                  <span className="font-medium">{g.home.abbr}{g.state !== "pre" ? ` ${g.home.score}` : ""}</span>
                  <span className={cn("ml-auto truncate text-[11.5px]", g.state === "in" ? "text-danger" : "text-muted")}>{g.detail}</span>
                </button>
              ))}
            </div>
          )}
          {data.news.length > 0 && (
            <div>
              <p className="mb-1 flex items-center justify-between text-[10.5px] font-medium uppercase tracking-wide text-muted"><span>Top stories</span><button onClick={() => { setPanel("news"); markSeen(); }} className="flex items-center normal-case text-muted hover:text-foreground">All {fresh.length > 0 ? `(${fresh.length} new)` : ""} <ChevronRight size={11} /></button></p>
              {data.news.filter((h) => !hot.has(h.url)).slice(0, 3).map((h) => (
                <button key={h.url} onClick={() => openUrl(h.url)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover">
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", fresh.some((f) => f.url === h.url) ? "bg-accent" : "bg-transparent")} />
                  <span className="min-w-0 flex-1"><span className="line-clamp-2 text-[13px] leading-snug">{h.title}</span><span className="text-[11px] text-muted">{h.site} · {ago(h.at)}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {panel === "news" && data && (
        <div className={cn(pop, "right-2 max-h-[65vh] w-[440px] max-w-[94vw] overflow-y-auto p-1.5")}>
          <div className="flex items-center gap-1 px-1.5 pb-1 pt-1" role="tablist">
            {([["latest", "Latest"], ["day", "Biggest today"], ["week", "This week"]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={newsTab === id} onClick={() => setNewsTab(id)} className={cn("h-7 rounded-lg px-2.5 text-[12px]", newsTab === id ? "bg-accent/20 font-medium text-foreground" : "text-muted hover:bg-surface-hover")}>{label}</button>)}
            <span className="ml-auto text-[10.5px] text-muted">updated {ago(data.at)} ago</span>
          </div>
          {newsTab !== "latest" && ((newsTab === "day" ? data.breaking?.day : data.breaking?.week) ?? []).map((x) => <StoryRow key={x.key} x={x} onOpen={openUrl} />)}
          {newsTab !== "latest" && !((newsTab === "day" ? data.breaking?.day : data.breaking?.week) ?? []).length && <p className="px-3 py-4 text-[12.5px] text-muted">Nothing stands out yet. Stories that several outlets carry, or match your topics, appear here, and the week fills up as Marigold keeps running.</p>}
          {newsTab === "latest" && data.news.map((h) => (
            <button key={h.url} onClick={() => openUrl(h.url)} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover">
              <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", fresh.some((f) => f.url === h.url) ? "bg-accent" : "bg-transparent")} />
              <span className="min-w-0 flex-1"><span className="block text-[13px] leading-snug">{h.title}</span><span className="text-[11px] text-muted">{h.site} · {ago(h.at)}</span></span>
            </button>
          ))}
          {newsTab === "latest" && !data.news.length && <p className="px-3 py-4 text-[12.5px] text-muted">Couldn&apos;t reach the news feeds. Check your connection.</p>}
        </div>
      )}
      {panel === "scores" && data && (
        <div className={cn(pop, "right-2 max-h-[65vh] w-[400px] max-w-[94vw] overflow-y-auto p-1.5")}>
          <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-muted"><Trophy size={11} /> Scores · live games first</p>
          {data.scores.map((s) => (
            <button key={s.id} onClick={() => (s.url ? openUrl(s.url) : searchFor(`${s.away.name} vs ${s.home.name}`))} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover">
              <span className="w-12 shrink-0 text-[10.5px] uppercase text-muted">{s.league}</span>
              <span className="min-w-0 flex-1 text-[13px]">
                <span className={cn("flex justify-between", s.away.win && "font-semibold")}><span className="truncate">{s.away.name}</span><span className="tabular-nums">{s.state === "pre" ? "" : s.away.score}</span></span>
                <span className={cn("flex justify-between", s.home.win && "font-semibold")}><span className="truncate">{s.home.name}</span><span className="tabular-nums">{s.state === "pre" ? "" : s.home.score}</span></span>
              </span>
              <span className={cn("w-20 shrink-0 text-right text-[11px]", s.state === "in" ? "text-danger" : "text-muted")}>{s.detail}</span>
            </button>
          ))}
          {!data.scores.length && <p className="px-3 py-4 text-[12.5px] text-muted">No games right now in the leagues you follow.</p>}
        </div>
      )}
      {panel === "edit" && data && <EditPanel data={data} onSave={save} />}
    </div>
  );
}

function StoryRow({ x, onOpen, compact }: { x: Story; onOpen: (u: string) => void; compact?: boolean }) {
  return (
    <button onClick={() => onOpen(x.url)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover">
      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", x.breaking ? "animate-pulse bg-danger" : x.topic ? "bg-accent" : "bg-transparent")} />
      <span className="min-w-0 flex-1"><span className={cn("text-[13px] leading-snug", compact ? "line-clamp-1" : "line-clamp-2")}>{x.title}</span><span className="text-[11px] text-muted">{x.topic ? `${x.topic} · ` : ""}{x.sites.length > 1 ? `${x.sites.length} outlets` : x.sites[0]} · {ago(x.at)}</span></span>
    </button>
  );
}

function EditPanel({ data, onSave }: { data: Data; onSave: (c: Partial<Config>) => Promise<void> }) {
  const c = data.config;
  const [symbols, setSymbols] = useState(c.symbols.join(", "));
  const [crypto, setCrypto] = useState(c.crypto.join(", "));
  const [teams, setTeams] = useState(c.teams.join(", "));
  const [city, setCity] = useState(c.city);
  const [topics, setTopics] = useState((c.topics ?? []).join(", "));
  const [alertBreaking, setAlertBreaking] = useState(c.alerts?.breaking ?? true);
  const [alertScores, setAlertScores] = useState(c.alerts?.scores ?? true);
  const [alertStocks, setAlertStocks] = useState(c.alerts?.stocks ?? true);
  const [pct, setPct] = useState(c.alerts?.stockPct ?? 5);
  const [leagues, setLeagues] = useState(new Set(c.leagues));
  const [busy, setBusy] = useState(false);
  const split = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const field = "h-8 w-full rounded-lg border border-border bg-background px-2 text-[12.5px]";
  return (
    <div className="absolute bottom-full right-2 z-[60] mb-1 max-h-[75vh] w-[380px] max-w-[94vw] space-y-3 overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-2xl">
      <p className="text-[13px] font-semibold">What the bar tracks</p>
      <label className="block text-[11.5px] text-muted">Stocks and indexes (tickers, like AAPL, MSFT, ^DJI)<input value={symbols} onChange={(e) => setSymbols(e.target.value)} className={cn(field, "mt-1 text-foreground")} /></label>
      <label className="block text-[11.5px] text-muted">Crypto (names, like bitcoin, ethereum)<input value={crypto} onChange={(e) => setCrypto(e.target.value)} className={cn(field, "mt-1 text-foreground")} /></label>
      <div className="text-[11.5px] text-muted">Sports leagues
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {Object.entries(data.leagues).map(([k, label]) => (
            <button key={k} onClick={() => setLeagues((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
              className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px]", leagues.has(k) ? "border-accent bg-accent/20 text-foreground" : "border-border text-muted hover:bg-surface-hover")}>{label}</button>
          ))}
        </div>
      </div>
      <label className="block text-[11.5px] text-muted">Favorite teams (always shown first)<input value={teams.replace(/,\s*/g, ", ")} onChange={(e) => setTeams(e.target.value)} placeholder="Warriors, 49ers" className={cn(field, "mt-1 text-foreground")} /></label>
      <label className="block text-[11.5px] text-muted">Topics to follow in the news (people, agencies, companies)<input value={topics.replace(/,\s*/g, ", ")} onChange={(e) => setTopics(e.target.value)} placeholder="FAA, Jensen Huang, NASA" className={cn(field, "mt-1 text-foreground")} /></label>
      <label className="block text-[11.5px] text-muted">City for weather<input value={city} onChange={(e) => setCity(e.target.value)} placeholder="San Francisco" className={cn(field, "mt-1 text-foreground")} /></label>
      <div className="space-y-1.5 rounded-xl bg-surface-hover/60 p-3 text-[12px]">
        <p className="font-medium">Alerts</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={alertScores} onChange={(e) => setAlertScores(e.target.checked)} /> Tell me when my favorite teams start and finish a game</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={alertBreaking} onChange={(e) => setAlertBreaking(e.target.checked)} /> Tell me about breaking news and anything on my topics</label>
        <label className="flex flex-wrap items-center gap-2"><input type="checkbox" checked={alertStocks} onChange={(e) => setAlertStocks(e.target.checked)} /> Tell me when a stock moves
          <select value={pct} onChange={(e) => setPct(Number(e.target.value))} className="h-6 rounded-md border border-border bg-background px-1">{[3, 5, 7, 10].map((n) => <option key={n} value={n}>{n}%</option>)}</select> in a day</label>
        <p className="text-[10.5px] text-muted">Alerts arrive as Marigold notifications, respect quiet hours, and need the Mac app to be running. Turn the whole kind off in Settings → Notifications.</p>
      </div>
      <button disabled={busy} onClick={async () => { setBusy(true); await onSave({ symbols: split(symbols), crypto: split(crypto), leagues: [...leagues], topics: topics.split(",").map((x) => x.trim()).filter(Boolean), alerts: { scores: alertScores, stocks: alertStocks, stockPct: pct, breaking: alertBreaking }, teams: teams.split(",").map((x) => x.trim()).filter(Boolean), city }); setBusy(false); }}
        className="h-8 w-full rounded-lg bg-accent text-[12.5px] font-medium text-black disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
      <p className="text-[10.5px] leading-snug text-muted">Prices come from Yahoo Finance and CoinGecko, scores from ESPN, weather from Open-Meteo, headlines from BBC, NPR, The Guardian, The New York Times, Al Jazeera, CNBC, TechCrunch, the FAA and NVIDIA (their own public feeds). A story counts as breaking when several outlets carry it at once. Quotes can be delayed.</p>
    </div>
  );
}
