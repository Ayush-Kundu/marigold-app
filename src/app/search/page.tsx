"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, ChevronDown, Code2, Eye, ExternalLink, Image as ImageIcon, Loader2, MessageSquare, Newspaper, Play, Search, ShoppingBag, Sparkles, BookOpen, Globe, X, ChevronLeft, ChevronRight } from "lucide-react";
import { MarigoldIcon } from "@/components/marigold-icon";
import { cn } from "@/lib/utils";

type Kind = "news" | "video" | "forum" | "reference" | "code" | "shop" | "web";
interface WebResult { title: string; url: string; site: string; snippet: string; age?: string; thumb?: string; favicon?: string; kind: Kind; extra?: string[] }
interface NewsItem { title: string; url: string; site: string; snippet: string; age?: string; thumb?: string; favicon?: string }
interface VideoItem { title: string; url: string; site: string; snippet: string; age?: string; thumb?: string; duration?: string; creator?: string; views?: string }
interface Discussion { title: string; url: string; site: string; forum?: string; answers?: number; snippet: string; age?: string }
interface Faq { question: string; answer: string; url?: string; site?: string }
interface ImageItem { title: string; thumb: string; full: string; page: string; site: string; credit?: string }
interface Knowledge { title: string; extract: string; url: string; image?: string; description?: string; facts?: [string, string][]; related?: { title: string; description?: string; image?: string }[]; source?: string }
interface Out { q: string; source: "google" | "brave" | "tavily" | "open"; keyless: boolean; web: WebResult[]; news: NewsItem[]; videos: VideoItem[]; discussions: Discussion[]; faq: Faq[]; images: ImageItem[]; knowledge: Knowledge | null; instant: string | null }
interface Brief { summary: string; points: { text: string; cites: number[] }[]; cites: number[]; keyFacts: { label: string; value: string }[]; followUps: string[]; note?: string }

const KIND: Record<Kind, { label: string; icon: typeof Globe; cls: string }> = {
  news: { label: "News", icon: Newspaper, cls: "bg-sky-500/15 text-sky-500" },
  video: { label: "Video", icon: Play, cls: "bg-rose-500/15 text-rose-500" },
  forum: { label: "Discussion", icon: MessageSquare, cls: "bg-violet-500/15 text-violet-500" },
  reference: { label: "Reference", icon: BookOpen, cls: "bg-emerald-500/15 text-emerald-500" },
  code: { label: "Docs & code", icon: Code2, cls: "bg-slate-500/20 text-muted" },
  shop: { label: "Shopping", icon: ShoppingBag, cls: "bg-amber-500/15 text-amber-500" },
  web: { label: "Web", icon: Globe, cls: "bg-surface-hover text-muted" },
};

/** Bold the words you searched for in a snippet. */
function Highlight({ text, q }: { text: string; q: string }) {
  const STOP = /^(the|who|what|how|why|when|where|which|does|did|and|for|are|was|were|can|with|from|about|that|this|you|your|has|have|had|not|but|into|than|then|them|they|its|his|her)$/;
  const words = [...new Set(q.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !STOP.test(w)))];
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i} className="bg-transparent font-semibold text-foreground">{p}</mark> : p))}</>;
}

const go = (q: string) => { window.location.href = `/search?q=${encodeURIComponent(q)}`; };

function Cite({ n, list }: { n: number; list: { url: string; site: string; title: string }[] }) {
  const s = list[n - 1];
  if (!s) return null;
  return <a href={s.url} title={`${s.title} (${s.site})`} className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-[var(--accent)] no-underline hover:bg-accent/30">{n}</a>;
}
function WithCites({ text, list }: { text: string; list: { url: string; site: string; title: string }[] }) {
  return <>{text.replace(/\s*\[wiki\]/g, "").split(/\[(\d)\]/g).map((p, i) => (i % 2 ? <Cite key={i} n={Number(p)} list={list} /> : p))}</>;
}

function Favicon({ site, src }: { site: string; src?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src || `https://${site}/favicon.ico`} alt="" width={16} height={16} loading="lazy" className="h-4 w-4 shrink-0 rounded-sm" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />;
}

// ---------------------------------------------------------------- image viewer

function Lightbox({ images, index, onClose, onIndex }: { images: ImageItem[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const im = images[index];
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); else if (e.key === "ArrowRight") onIndex((index + 1) % images.length); else if (e.key === "ArrowLeft") onIndex((index - 1 + images.length) % images.length); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [index, images.length, onClose, onIndex]);
  if (!im) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center justify-end p-3"><button onClick={onClose} aria-label="Close" className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20"><X size={18} /></button></div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => onIndex((index - 1 + images.length) % images.length)} aria-label="Previous" className="absolute left-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"><ChevronLeft size={20} /></button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={im.full} src={im.full} alt={im.title} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" onError={(e) => { const t = e.currentTarget as HTMLImageElement; if (t.src !== im.thumb) t.src = im.thumb; }} />
        <button onClick={() => onIndex((index + 1) % images.length)} aria-label="Next" className="absolute right-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"><ChevronRight size={20} /></button>
      </div>
      <div className="flex items-center justify-center gap-3 p-4 text-[13px] text-white/90" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 max-w-xl truncate">{im.title}</span>
        <span className="text-white/50">{im.site}{im.credit ? ` · ${im.credit}` : ""}</span>
        <a href={im.page} className="flex shrink-0 items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-[12px] font-medium text-white no-underline hover:bg-white/25">Visit page <ExternalLink size={11} /></a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the brief

function BriefCard({ q, out }: { q: string; out: Out }) {
  const [brief, setBrief] = useState<Brief | null | undefined>(undefined);
  const [all, setAll] = useState(false);
  const list = useMemo(() => [...out.web.slice(0, 7), ...out.news.slice(0, 2)], [out]);

  const [restReady, setRestReady] = useState(false);
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/agent/search?q=${encodeURIComponent(q)}&brief=1&stream=1`, { signal: ctl.signal });
        if (!res.body) throw new Error("no stream");
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "", got = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim() || !live) continue;
            let e: { type: string; text?: string; brief?: Brief; points?: Brief["points"]; keyFacts?: Brief["keyFacts"]; followUps?: string[]; note?: string };
            try { e = JSON.parse(line); } catch { continue; }
            if (e.type === "answer") { got = true; setBrief((b) => ({ summary: e.text ?? "", points: b?.points ?? [], cites: [], keyFacts: b?.keyFacts ?? [], followUps: b?.followUps ?? [], note: b?.note })); }
            else if (e.type === "rest") setBrief((b) => (b ? { ...b, points: e.points ?? [], keyFacts: e.keyFacts ?? [], followUps: e.followUps ?? [], note: e.note } : b)), setRestReady(true);
            else if (e.type === "full" && e.brief) { got = true; setBrief(e.brief); setRestReady(true); }
            else if (e.type === "none") setBrief((b) => b ?? null);
          }
        }
        if (live) { setRestReady(true); setBrief((b) => (got ? b : null)); }
      } catch { if (live) setBrief((b) => b ?? null); }
    })();
    return () => { live = false; ctl.abort(); };
  }, [q]);

  if (brief === null) return null;
  const points = brief?.points ?? [];
  const shown = all ? points : points.slice(0, 3);
  return (
    <section className="mb-6 rounded-2xl border border-border bg-surface/50 px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={14} className="text-[var(--accent)]" />
        <span className="text-[12px] font-semibold tracking-wide text-[var(--accent)]">MARIGOLD BRIEF</span>
      </div>
      {brief === undefined && <div className="space-y-2"><div className="h-4 w-full animate-pulse rounded bg-surface-hover" /><div className="h-4 w-11/12 animate-pulse rounded bg-surface-hover" /><div className="h-4 w-4/5 animate-pulse rounded bg-surface-hover" /></div>}
      {brief && (
        <>
          <p className="text-[15.5px] leading-[1.7]"><WithCites text={brief.summary} list={list} /></p>
          {!restReady && shown.length === 0 && <div className="mt-4 space-y-2 border-t border-border/70 pt-4"><div className="h-3.5 w-full animate-pulse rounded bg-surface-hover" /><div className="h-3.5 w-10/12 animate-pulse rounded bg-surface-hover" /></div>}
          {shown.length > 0 && (
            <ul className="mt-4 space-y-3 border-t border-border/70 pt-4">
              {shown.map((p) => (
                <li key={p.text} className="text-[13.5px] leading-[1.7] text-foreground/90">
                  {p.text.replace(/\s*\[wiki\]/g, "")}{p.cites.map((n) => <Cite key={n} n={n} list={list} />)}
                </li>
              ))}
            </ul>
          )}
          {points.length > 3 && <button onClick={() => setAll((v) => !v)} className="mt-3 flex items-center gap-1 text-[12.5px] font-medium text-[var(--accent)] hover:underline"><ChevronDown size={13} className={cn("transition-transform", all && "rotate-180")} />{all ? "Show less" : `Show ${points.length - 3} more`}</button>}
          {brief.note && <p className="mt-3 text-[12px] text-muted">{brief.note}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
            {brief.followUps.slice(0, 3).map((f) => (
              <button key={f} onClick={() => go(f)} className="rounded-full border border-border px-3 py-1 text-[12.5px] text-foreground no-underline transition-colors hover:border-accent hover:bg-accent/10">{f}</button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Who or what the search is about: a picture, what it is, its common facts, and related things. */
function KnowledgePanel({ k, className }: { k: Knowledge; className?: string }) {
  const tiles = (k.facts ?? []).slice(0, 3), rows = (k.facts ?? []).slice(3);
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border bg-surface", className)}>
      {k.image && (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={k.image} alt="" className="h-56 w-full object-cover object-top" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent px-4 pb-3 pt-14">
            <p className="text-[21px] font-semibold leading-tight text-white drop-shadow">{k.title}</p>
            {k.description && <p className="mt-0.5 text-[12.5px] capitalize text-white/80">{k.description}</p>}
          </div>
        </div>
      )}
      <div className="p-4">
        {!k.image && (<><p className="text-[20px] font-semibold leading-tight">{k.title}</p>{k.description && <p className="mt-0.5 text-[12.5px] capitalize text-muted">{k.description}</p>}</>)}
        {tiles.length > 0 && (
          <div className={cn("grid gap-2", k.image ? "" : "mt-3", tiles.length === 1 ? "grid-cols-1" : tiles.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {tiles.map(([label, value]) => (
              <div key={label} className="rounded-xl bg-background/70 px-2.5 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</p>
                <p className="mt-0.5 line-clamp-3 text-[12.5px] font-medium leading-snug">{value}</p>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[13px] leading-[1.65] text-foreground/85">{k.extract}</p>
        {rows.length > 0 && (
          <dl className="mt-3 divide-y divide-border rounded-xl border border-border text-[12.5px]">
            {rows.map(([label, value]) => <div key={label} className="flex gap-3 px-3 py-1.5"><dt className="w-24 shrink-0 text-muted">{label}</dt><dd className="min-w-0 flex-1">{value}</dd></div>)}
          </dl>
        )}
        {k.related && k.related.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Related</p>
            <div className="flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
              {k.related.map((r) => (
                <button key={r.title} onClick={() => go(r.title)} className="group w-[84px] shrink-0 text-center">
                  {r.image ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={r.image} alt="" loading="lazy" className="mx-auto h-[68px] w-[68px] rounded-full border border-border object-cover transition-transform group-hover:scale-105" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} /> : <span className="mx-auto flex h-[68px] w-[68px] items-center justify-center rounded-full bg-surface-hover"><Globe size={18} className="text-muted" /></span>}
                  <span className="mt-1.5 line-clamp-2 block text-[11.5px] leading-tight group-hover:text-[var(--accent)]">{r.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {k.url && <a href={k.url} className="mt-3 inline-flex items-center gap-1 text-[12px] text-[var(--accent)] hover:underline">{k.source ?? "Read more"} <ExternalLink size={11} /></a>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- result cards

const ThumbsCtx = createContext<Record<string, string>>({});

function ResultCard({ r: r0, q }: { r: WebResult; q: string }) {
  const extraThumb = useContext(ThumbsCtx)[r0.url];
  const r = extraThumb && !r0.thumb ? { ...r0, thumb: extraThumb } : r0;
  const [peek, setPeek] = useState<{ summary: string; image?: string } | null | "loading" | undefined>(undefined);
  const k = KIND[r.kind];
  const doPeek = () => {
    if (peek !== undefined) { setPeek(undefined); return; }
    setPeek("loading");
    fetch(`/api/agent/search?q=${encodeURIComponent(q)}&peek=${encodeURIComponent(r.url)}`).then((x) => x.json()).then((j) => setPeek(j.peek ?? null)).catch(() => setPeek(null));
  };
  const path = (() => { try { const p = new URL(r.url).pathname.replace(/\/$/, ""); return p ? `› ${p.split("/").filter(Boolean).slice(0, 2).join(" › ")}` : ""; } catch { return ""; } })();
  return (
    <li className="group rounded-2xl px-4 py-3.5 transition-colors hover:bg-surface/60">
      <div className="flex gap-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Favicon site={r.site} src={r.favicon} />
            <span className="truncate font-medium text-foreground/80">{r.site}</span>
            <span className="hidden truncate text-[11px] opacity-60 sm:inline">{path}</span>
            {r.kind !== "web" && <span className={cn("ml-1 flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[10.5px] font-medium", k.cls)}><k.icon size={10} />{k.label}</span>}
            {r.age && <span className="shrink-0 text-[11px]">{r.age}</span>}
          </div>
          <a href={r.url} className="mt-1 block text-[16.5px] font-semibold leading-snug text-foreground no-underline decoration-[var(--accent)] underline-offset-2 transition-colors hover:text-[var(--accent)] hover:underline">{r.title}</a>
          <p className="mt-1 line-clamp-3 text-[13.5px] leading-[1.6] text-foreground/70"><Highlight text={r.snippet} q={q} /></p>
          {r.extra && r.extra.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5">{r.extra.map((e) => <li key={e} className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">{e}</li>)}</ul>}
          <button onClick={doPeek} className={cn("mt-2 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] text-muted transition-all hover:bg-surface-hover hover:text-foreground", peek === undefined && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}><Eye size={12} /> {peek === undefined ? "Peek inside" : "Hide peek"}</button>
          {peek === "loading" && <p className="mt-1.5 flex items-center gap-2 text-[12px] text-muted"><Loader2 size={12} className="animate-spin" /> Reading the page…</p>}
          {peek === null && <p className="mt-1.5 text-[12px] text-muted">This site doesn&apos;t allow automated reading. Open it to see for yourself.</p>}
          {peek && peek !== "loading" && <p className="mt-1.5 rounded-xl bg-accent/[0.07] px-3 py-2 text-[12.5px] leading-[1.6]"><Sparkles size={11} className="mr-1 inline text-[var(--accent)]" />{peek.summary}</p>}
        </div>
        {r.thumb && (
          <a href={r.url} className="hidden shrink-0 sm:block" tabIndex={-1} aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.thumb} alt="" loading="lazy" className="h-[84px] w-[112px] rounded-xl border border-border object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          </a>
        )}
      </div>
    </li>
  );
}

function NewsRow({ items }: { items: NewsItem[] }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold"><Newspaper size={14} className="text-sky-500" /> Top stories</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
        {items.map((n) => (
          <a key={n.url} href={n.url} className="group w-[220px] shrink-0 overflow-hidden rounded-2xl border border-border bg-surface/60 text-inherit no-underline transition-colors hover:border-accent">
            {n.thumb ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={n.thumb} alt="" loading="lazy" className="h-[118px] w-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} /> : <div className="flex h-[118px] items-center justify-center bg-surface-hover"><Newspaper size={22} className="text-muted" /></div>}
            <div className="p-2.5">
              <p className="line-clamp-3 text-[13px] font-medium leading-snug group-hover:text-[var(--accent)]">{n.title}</p>
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted"><Favicon site={n.site} src={n.favicon} /><span className="truncate">{n.site}</span>{n.age && <span className="shrink-0">· {n.age}</span>}</p>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function VideoRow({ items }: { items: VideoItem[] }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold"><Play size={14} className="text-rose-500" /> Videos</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
        {items.map((v) => (
          <a key={v.url} href={v.url} className="group w-[230px] shrink-0 text-inherit no-underline">
            <span className="relative block overflow-hidden rounded-xl border border-border bg-surface-hover">
              {v.thumb ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={v.thumb} alt="" loading="lazy" className="aspect-video w-full object-cover transition-transform duration-200 group-hover:scale-105" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} /> : <span className="flex aspect-video items-center justify-center"><Play size={22} className="text-muted" /></span>}
              <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white"><Play size={16} fill="currentColor" /></span></span>
              {v.duration && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-px text-[10.5px] font-medium text-white">{v.duration}</span>}
            </span>
            <p className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug group-hover:text-[var(--accent)]">{v.title}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted">{[v.creator ?? v.site, v.views ? `${v.views} views` : "", v.age].filter(Boolean).join(" · ")}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

function Discussions({ items, q }: { items: Discussion[]; q: string }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold"><MessageSquare size={14} className="text-violet-500" /> What people are saying</h2>
      <div className="grid gap-2.5 md:grid-cols-2">
        {items.map((d) => (
          <a key={d.url} href={d.url} className="rounded-2xl border border-border bg-surface/60 p-3 text-inherit no-underline transition-colors hover:border-accent">
            <p className="flex items-center gap-1.5 text-[11.5px] text-muted"><Favicon site={d.site} /><span className="truncate">{d.forum ?? d.site}</span>{d.answers !== undefined && <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 text-[10.5px] text-violet-500">{d.answers} replies</span>}{d.age && <span className="shrink-0">· {d.age}</span>}</p>
            <p className="mt-1 line-clamp-2 text-[13.5px] font-medium leading-snug">{d.title}</p>
            {d.snippet && <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted"><Highlight text={d.snippet} q={q} /></p>}
          </a>
        ))}
      </div>
    </section>
  );
}

function Quick({ items }: { items: Faq[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 text-[13px] font-semibold">Quick questions</h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
        {items.map((f, i) => (
          <div key={f.question}>
            <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13.5px] font-medium hover:bg-surface/60">
              <span className="flex-1">{f.question}</span><ChevronDown size={15} className={cn("shrink-0 text-muted transition-transform", open === i && "rotate-180")} />
            </button>
            {open === i && <div className="bg-surface/40 px-4 pb-3 pt-1 text-[13px] leading-[1.65]">{f.answer}{f.url && <a href={f.url} className="ml-2 text-[12px] text-[var(--accent)]">{f.site}</a>}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- page

/** Marigold's free sources can't match a full search engine for images, video, news or shopping. These open that engine's own page in this tab (you navigating, like any browser). */
function LinkOut({ label, href, extra = [], lead = false }: { label: string; href: string; extra?: [string, string][]; lead?: boolean }) {
  return (
    <div className={cn("mt-6 rounded-2xl border border-border bg-surface/50 px-4 py-3", lead && "mt-0")}>
      <p className="text-[12.5px] text-muted">{lead ? "Marigold's free sources don't cover this well." : "Want more or more exact results?"} See the full results on:</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={href} className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-black no-underline hover:opacity-90"><ExternalLink size={12} /> {label}</a>
        {extra.map(([name, url]) => <a key={name} href={url} className="flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-foreground no-underline hover:border-accent">{name}</a>)}
      </div>
    </div>
  );
}

type Tab = "all" | "images" | "news" | "videos" | "shopping" | "books" | "scholar";

function Results() {
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const [box, setBox] = useState(q);
  const [data, setData] = useState<{ q: string; out: Out | null } | null>(null);
  const [more, setMore] = useState<{ q: string; web: WebResult[]; page: number; done: boolean }>({ q: "", web: [], page: 0, done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [vert, setVert] = useState<{ q: string; images?: ImageItem[]; videos?: VideoItem[]; lists: Partial<Record<Tab, WebResult[]>> }>({ q: "", lists: {} });
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => { document.title = q ? `${q} - Marigold Search` : "Marigold Search"; }, [q]);
  // This page is always dark (also the area behind it while it scrolls).
  useEffect(() => {
    const el = document.documentElement, was = el.className, bg = document.body.style.background;
    el.classList.add("dark"); el.style.colorScheme = "dark"; document.body.style.background = "#0c0c0e";
    return () => { el.className = was; el.style.colorScheme = ""; document.body.style.background = bg; };
  }, []);
  useEffect(() => {
    if (!q) return;
    let live = true;
    fetch(`/api/agent/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((out: Out) => live && setData({ q, out })).catch(() => live && setData({ q, out: null }));
    return () => { live = false; };
  }, [q]);

  const out = data?.q === q ? data.out : null;
  // Images, Videos, Shopping, Books and Scholar load when their tab is opened (one request each).
  const v = vert.q === q ? vert : { q, lists: {} } as typeof vert;
  const googled = out?.source === "google";
  useEffect(() => {
    if (!q || !out || tab === "all") return;
    if ((tab === "images" && v.images) || (tab === "videos" && v.videos) || (tab === "shopping" && !googled && out.source !== "brave") || v.lists[tab]) return;
    let live = true;
    const kind = tab;
    fetch(`/api/agent/search?q=${encodeURIComponent(q)}&vertical=${kind}`).then((r) => r.json()).then((j: { images?: ImageItem[]; videos?: VideoItem[]; web?: WebResult[] }) => {
      if (!live) return;
      setVert((p) => { const b = p.q === q ? p : { q, lists: {} as typeof p.lists }; return kind === "images" ? { ...b, images: j.images ?? [] } : kind === "videos" ? { ...b, videos: j.videos ?? [] } : { ...b, lists: { ...b.lists, [kind]: j.web ?? [] } }; });
    }).catch(() => {});
    return () => { live = false; };
  }, [tab, q, out, googled, v.images, v.videos, v.lists]);
  const pics = googled ? (v.images ?? []) : (v.images ?? out?.images ?? []);
  const loading = !!q && data?.q !== q;
  const extra = more.q === q ? more : { q, web: [] as WebResult[], page: 0, done: false };
  const web = useMemo(() => { const seen = new Set<string>(); return [...(out?.web ?? []), ...extra.web].filter((r) => !seen.has(r.url) && seen.add(r.url)); }, [out, extra.web]);
  // Results that came without a picture get their page's preview image, filled in a moment after the list shows.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const skip = /(^|\.)(wikipedia\.org|wikivoyage\.org|stackexchange\.com|stackoverflow\.com|doi\.org|arxiv\.org|openlibrary\.org|medlineplus\.gov)$/;
    const need = web.filter((r) => !r.thumb && !thumbs[r.url] && !skip.test(r.site)).slice(0, 10).map((r) => r.url);
    if (!need.length) return;
    let live = true;
    fetch("/api/agent/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thumbs: need }) })
      .then((r) => r.json()).then((m: Record<string, string>) => { if (live && m && Object.keys(m).length) setThumbs((t) => ({ ...t, ...m })); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [web]);
  const nextPage = useCallback(async () => {
    setLoadingMore(true);
    const page = extra.page + 1;
    const j = (await fetch(`/api/agent/search?q=${encodeURIComponent(q)}&page=${page}`).then((r) => r.json()).catch(() => null)) as Out | null;
    const seen = new Set(web.map((r) => r.url));
    const fresh = (j?.web ?? []).filter((r) => !seen.has(r.url));
    setMore({ q, web: [...extra.web, ...fresh], page, done: fresh.length === 0 });
    setLoadingMore(false);
  }, [q, extra, web]);

  // The first 4 web results sit under the brief; the rest follow the news / videos / discussions blocks.
  const topWeb = web.slice(0, 4), restWeb = web.slice(4);
  const tabs: [Tab, string, number][] = [["all", "All", 1], ["images", "Images", 1], ["videos", "Videos", 1], ["news", "News", 1], ["shopping", "Shopping", 1], ["books", "Books", 1], ["scholar", "Scholar", 1]];

  return (
    <ThumbsCtx.Provider value={thumbs}>
      <div className="dark min-h-dvh bg-background text-foreground" ref={topRef} style={{ colorScheme: "dark" }}>
        <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <form action="/search" className="mx-auto flex max-w-6xl items-center gap-3 px-5 pb-1 pt-3">
            <a href="/search" className="shrink-0" aria-label="Marigold Search"><MarigoldIcon size={26} /></a>
            <div className="flex h-10 min-w-0 max-w-2xl flex-1 items-center gap-2 rounded-full border border-border bg-surface px-4 focus-within:border-accent">
              <Search size={15} className="shrink-0 text-muted" />
              <input name="q" value={box} onChange={(e) => setBox(e.target.value)} autoFocus={!q} placeholder="Search the web" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted" />
            </div>
  
          </form>
          {out && (
            <nav className="mx-auto flex max-w-6xl gap-1 px-5 pl-[66px]">
              {tabs.filter(([, , n]) => n > 0).map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{ borderBottomWidth: 2, borderBottomStyle: "solid", borderBottomColor: tab === id ? "var(--accent)" : "transparent" }} className={cn("flex items-center gap-1.5 px-3 py-2 text-[13px] transition-colors", tab === id ? "font-medium text-foreground" : "text-muted hover:text-foreground")}>
                  {id === "images" && <ImageIcon size={13} />}{id === "news" && <Newspaper size={13} />}{id === "videos" && <Play size={13} />}{label}
                </button>
              ))}
            </nav>
          )}
        </header>
  
        <main className="mx-auto grid max-w-6xl gap-8 px-5 py-5 lg:grid-cols-[minmax(0,700px)_320px]">
          <div className="min-w-0">
            {!q && <p className="py-16 text-center text-[14px] text-muted">Type something to search.</p>}
            {loading && <div className="space-y-5"><div className="h-44 animate-pulse rounded-2xl bg-surface-hover/70" />{[0, 1, 2].map((i) => <div key={i} className="space-y-2 px-3"><div className="h-3 w-40 animate-pulse rounded bg-surface-hover" /><div className="h-4 w-3/4 animate-pulse rounded bg-surface-hover" /><div className="h-3 w-full animate-pulse rounded bg-surface-hover" /></div>)}</div>}
            {data && !data.out && <p className="py-10 text-[14px] text-muted">Couldn&apos;t search right now. Check your connection and try again.</p>}
  
            {out?.instant && tab === "all" && (
              <div className="mb-5 rounded-2xl border border-border bg-surface px-5 py-4"><p className="text-[12px] text-muted">{q.replace(/^=/, "")} =</p><p className="text-3xl font-semibold tabular-nums">{out.instant}</p></div>
            )}
  
            {out && tab === "all" && (
              <>
                {out.knowledge && <KnowledgePanel k={out.knowledge} className="mb-6 lg:hidden" />}
                <BriefCard q={q} out={out} />
                {topWeb.length > 0 && <ol className="mb-4 space-y-1">{topWeb.map((r) => <ResultCard key={r.url} r={r} q={q} />)}</ol>}
                {out.news.length > 0 && <NewsRow items={out.news} />}
                {out.videos.length > 0 && <VideoRow items={out.videos} />}
                {out.discussions.length > 0 && <Discussions items={out.discussions} q={q} />}
                {out.faq.length > 0 && <Quick items={out.faq} />}
                {restWeb.length > 0 && <ol className="space-y-1">{restWeb.map((r) => <ResultCard key={r.url} r={r} q={q} />)}</ol>}
                {web.length === 0 && !out.knowledge && out.images.length === 0 && <p className="py-10 text-[14px] text-muted">No results for “{q}”. Try different words.</p>}
                {web.length >= 8 && !extra.done && !out.keyless && (
                  <button onClick={() => void nextPage()} disabled={loadingMore} className="mt-6 flex h-9 items-center gap-2 rounded-full border border-border px-5 text-[13px] hover:bg-surface-hover disabled:opacity-60">{loadingMore && <Loader2 size={14} className="animate-spin" />} More results</button>
                )}
                {(web.length > 0 || out.images.length > 0) && (
                  <p className="mt-8 border-t border-border pt-3 text-[11px] text-muted">{out.source === "brave" ? "Results from Brave Search. " : out.source === "tavily" ? "Results from Tavily. " : ""}Pictures belong to their sources. Marigold doesn&apos;t track what you search. <a href="/sources" className="underline hover:text-foreground">Sources and licenses</a></p>
                )}
              </>
            )}
  
            {out && tab === "images" && (
              <div className="columns-2 gap-3 sm:columns-3">
                {pics.map((im, i) => (
                  <button key={im.thumb} onClick={() => setLightbox(i)} className="group relative mb-3 block w-full overflow-hidden rounded-xl border border-border bg-surface-hover">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={im.thumb} alt={im.title} loading="lazy" className="w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" onError={(e) => { (e.currentTarget.closest("button") as HTMLElement).style.display = "none"; }} />
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-left text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">{im.site}</span>
                  </button>
                ))}
              </div>
            )}
            {out && tab === "images" && <LinkOut label="Google Images" href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`} extra={[["Bing Images", `https://www.bing.com/images/search?q=${encodeURIComponent(q)}`]]} lead={!pics.length} />}
            {out && tab === "news" && <>
              {(v.lists.news?.length || out.news.length) ? <ol className="space-y-1">{(v.lists.news?.length ? v.lists.news : out.news.map((n) => ({ ...n, kind: "news" as const }))).map((n) => <ResultCard key={n.url} q={q} r={n} />)}</ol> : <p className="py-6 text-[14px] text-muted">{v.lists.news ? "No recent articles found." : "Loading…"}</p>}
              <LinkOut label="Google News" href={`https://news.google.com/search?q=${encodeURIComponent(q)}`} extra={[["Bing News", `https://www.bing.com/news/search?q=${encodeURIComponent(q)}`]]} />
            </>}
            {out && tab === "videos" && <>
              {((googled ? v.videos : out.videos)?.length ?? 0) > 0 && <VideoRow items={(googled ? v.videos : out.videos) ?? []} />}
              <LinkOut label="Google Videos" href={`https://www.google.com/search?tbm=vid&q=${encodeURIComponent(q)}`} extra={[["YouTube", `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`]]} lead={!((googled ? v.videos : out.videos)?.length)} />
            </>}
            {out && (tab === "shopping" || tab === "books" || tab === "scholar") && <>
              {v.lists[tab]?.length ? <ol className="space-y-1">{v.lists[tab]!.map((r) => <ResultCard key={r.url} q={q} r={r} />)}</ol> : tab !== "shopping" && <p className="py-6 text-[14px] text-muted">{v.lists[tab] ? `No ${tab} results found.` : "Loading…"}</p>}
              {tab === "shopping" && <LinkOut label="Google Shopping" href={`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`} extra={[["Amazon", `https://www.amazon.com/s?k=${encodeURIComponent(q)}`], ["eBay", `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`]]} lead={!v.lists.shopping?.length} />}
            </>}
          </div>
  
          <aside className="hidden lg:block">
            {out?.knowledge && tab === "all" && <KnowledgePanel k={out.knowledge} className="sticky top-[110px]" />}
          </aside>
        </main>
        {lightbox !== null && out && <Lightbox images={pics} index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} />}
      </div>
    </ThumbsCtx.Provider>
  );
}

export default function SearchPage() {
  return <Suspense fallback={<div className="dark min-h-dvh bg-background" />}><Results /></Suspense>;
}
