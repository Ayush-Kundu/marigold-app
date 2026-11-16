import { tavilyKey, braveKey, fetchPage } from "./summarize";

/**
 * Marigold's own search. Only LICENSED / OPEN sources, never a search engine's page:
 *   • Brave Search API (the user's key): web, news, videos, discussions, quick questions, an info box, and images.
 *   • No key: Wikipedia articles (with pictures) and Wikimedia Commons images — open content.
 * Google results come ONLY through Google's own licensed API (Programmable Search: a free key + engine ID from a Google
 *   account, ~100 searches a day free). Never scraped, never embedded.
 * Results are shown on Marigold's own page (src/app/search) with an AI brief written at query time.
 * Nothing is scraped from Google, Bing or DuckDuckGo.
 */

export type ResultKind = "news" | "video" | "forum" | "reference" | "code" | "shop" | "web";
export interface WebResult { title: string; url: string; site: string; snippet: string; age?: string; thumb?: string; favicon?: string; kind: ResultKind; extra?: string[] }
export interface NewsItem { title: string; url: string; site: string; snippet: string; age?: string; thumb?: string; favicon?: string }
export interface VideoItem { title: string; url: string; site: string; snippet: string; age?: string; thumb?: string; duration?: string; creator?: string; views?: string }
export interface Discussion { title: string; url: string; site: string; forum?: string; answers?: number; snippet: string; age?: string }
export interface Faq { question: string; answer: string; url?: string; site?: string }
export interface ImageItem { title: string; thumb: string; full: string; page: string; site: string; credit?: string }
export interface Knowledge { title: string; extract: string; url: string; image?: string; description?: string; facts?: [string, string][]; related?: { title: string; description?: string; image?: string }[]; source?: string }
export interface SearchOut {
  q: string; page: number; source: "google" | "brave" | "tavily" | "open"; keyless: boolean;
  web: WebResult[]; news: NewsItem[]; videos: VideoItem[]; discussions: Discussion[]; faq: Faq[]; images: ImageItem[];
  knowledge: Knowledge | null; instant: string | null;
}

const UA = "Marigold/1.0 (desktop assistant; web search for its user)";
const site = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const decode = (h: unknown) => String(h ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&hellip;/g, "…").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).trim();
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const compact = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n) : String(v); };

/** Where Marigold's own results page lives (the engine's address). */
export const searchUrl = (q: string) => `${process.env.MARIGOLD_ORIGIN ?? "http://localhost:3000"}/search?q=${encodeURIComponent(q)}`;

const NEWS = /(^|\.)(bbc\.(com|co\.uk)|cnn\.com|nytimes\.com|reuters\.com|apnews\.com|theguardian\.com|washingtonpost\.com|wsj\.com|npr\.org|nbcnews\.com|abcnews\.go\.com|cbsnews\.com|bloomberg\.com|espn\.com|theverge\.com|techcrunch\.com|wired\.com|axios\.com|politico\.com|usatoday\.com|latimes\.com|foxnews\.com|aljazeera\.com|forbes\.com)$/;
function kindOf(url: string, type?: string): ResultKind {
  const h = site(url);
  if (type === "video" || /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitch\.tv)$/.test(h)) return "video";
  if (type === "news" || NEWS.test(h)) return "news";
  if (/(^|\.)(reddit\.com|quora\.com|stackexchange\.com|stackoverflow\.com|news\.ycombinator\.com|discord\.com)$/.test(h) || /^forum|^community|^discuss/.test(h)) return "forum";
  if (/(^|\.)(wikipedia\.org|britannica\.com|wikihow\.com|investopedia\.com|khanacademy\.org|nih\.gov|mayoclinic\.org)$/.test(h)) return "reference";
  if (/(^|\.)(github\.com|gitlab\.com|npmjs\.com|developer\.mozilla\.org|docs\.[a-z0-9.-]+|readthedocs\.io)$/.test(h) || /^docs\./.test(h)) return "code";
  if (/(^|\.)(amazon\.[a-z.]+|ebay\.com|etsy\.com|walmart\.com|target\.com|bestbuy\.com|aliexpress\.com)$/.test(h)) return "shop";
  return "web";
}

// ---------------------------------------------------------------- Brave (licensed API)

type J = Record<string, unknown>;
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const obj = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});

async function brave(q: string, key: string, page: number): Promise<Omit<SearchOut, "q" | "page" | "source" | "keyless" | "knowledge" | "instant"> & { knowledge: Knowledge | null }> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&offset=${page}&safesearch=moderate&text_decorations=false&spellcheck=1`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Brave Search ${r.status}`);
  const j = (await r.json()) as J;
  const web = arr(obj(j.web).results).map((x): WebResult => {
    const url = str(x.url) ?? "";
    const meta = obj(x.meta_url);
    return {
      title: decode(x.title), url, site: str(meta.hostname)?.replace(/^www\./, "") ?? site(url), snippet: decode(x.description),
      age: str(x.page_age) ? new Date(String(x.page_age)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : str(x.age),
      thumb: str(obj(x.thumbnail).src), favicon: str(meta.favicon), kind: kindOf(url, str(x.subtype)),
      extra: (Array.isArray(x.extra_snippets) ? (x.extra_snippets as unknown[]).map(decode).filter(Boolean).slice(0, 2) : undefined),
    };
  }).filter((x) => x.url && x.title);
  const news = arr(obj(j.news).results).map((x): NewsItem => ({ title: decode(x.title), url: str(x.url) ?? "", site: str(obj(x.meta_url).hostname)?.replace(/^www\./, "") ?? site(str(x.url) ?? ""), snippet: decode(x.description), age: str(x.age), thumb: str(obj(x.thumbnail).src), favicon: str(obj(x.meta_url).favicon) })).filter((x) => x.url && x.title).slice(0, 8);
  const videos = arr(obj(j.videos).results).map((x): VideoItem => {
    const v = obj(x.video);
    return { title: decode(x.title), url: str(x.url) ?? "", site: site(str(x.url) ?? ""), snippet: decode(x.description), age: str(x.age), thumb: str(obj(x.thumbnail).src), duration: str(v.duration), creator: str(v.creator) ?? str(v.publisher), views: v.views !== undefined ? compact(v.views) : undefined };
  }).filter((x) => x.url && x.title).slice(0, 8);
  const discussions = arr(obj(j.discussions).results).map((x): Discussion => {
    const d = obj(x.data);
    return { title: decode(x.title), url: str(x.url) ?? "", site: site(str(x.url) ?? ""), forum: str(d.forum_name), answers: typeof d.num_answers === "number" ? d.num_answers : undefined, snippet: decode(str(d.question) ?? x.description), age: str(x.age) };
  }).filter((x) => x.url && x.title).slice(0, 5);
  const faq = arr(obj(j.faq).results).map((x): Faq => ({ question: decode(x.question), answer: decode(x.answer), url: str(x.url), site: str(x.url) ? site(str(x.url)!) : undefined })).filter((x) => x.question && x.answer).slice(0, 5);
  const ib = arr(obj(j.infobox).results)[0];
  const knowledge: Knowledge | null = ib ? {
    title: decode(ib.title), extract: decode(str(ib.long_desc) ?? ib.description).slice(0, 700), url: str(ib.url) ?? "", description: str(ib.subtype) ?? undefined,
    image: str(obj(ib.thumbnail).src) ?? str(obj(ib.thumbnail).original),
    facts: Array.isArray(ib.attributes) ? (ib.attributes as unknown[]).slice(0, 6).filter((a): a is [string, string] => Array.isArray(a) && typeof a[0] === "string").map((a) => [decode(a[0]), decode(a[1])] as [string, string]) : undefined,
  } : null;
  return { web, news, videos, discussions, faq, images: [], knowledge: knowledge?.title && knowledge.extract ? knowledge : null };
}

/** Google Programmable Search (Custom Search JSON API). Key + engine ID: ~/.marigold/google-search.json, the app's Resources/google-search.json, or MARIGOLD_GOOGLE_CSE_KEY / MARIGOLD_GOOGLE_CSE_CX. */
let cseCache: { key: string; cx: string } | null | undefined;
async function googleCse(): Promise<{ key: string; cx: string } | null> {
  if (cseCache !== undefined) return cseCache;
  const fs = await import("fs"), os = await import("os"), path = await import("path");
  for (const f of [path.join(os.homedir(), ".marigold", "google-search.json"), process.env.MARIGOLD_RESOURCES ? path.join(process.env.MARIGOLD_RESOURCES, "google-search.json") : ""]) {
    if (!f) continue;
    try { const j = JSON.parse(await fs.promises.readFile(f, "utf8")) as { key?: string; cx?: string }; if (j.key && j.cx) return (cseCache = { key: j.key.trim(), cx: j.cx.trim() }); } catch { /* not there */ }
  }
  const key = process.env.MARIGOLD_GOOGLE_CSE_KEY?.trim(), cx = process.env.MARIGOLD_GOOGLE_CSE_CX?.trim();
  return (cseCache = key && cx ? { key, cx } : null);
}
/** Save the user's Google Programmable Search key + engine ID (~/.marigold/google-search.json, owner-only). */
export async function saveGoogleSearch(key: string | null, cx = "") {
  const fs = await import("fs"), os = await import("os"), path = await import("path");
  const f = path.join(os.homedir(), ".marigold", "google-search.json");
  if (key && cx) { await fs.promises.mkdir(path.dirname(f), { recursive: true }); await fs.promises.writeFile(f, JSON.stringify({ key: key.trim(), cx: cx.trim() }), { mode: 0o600 }); }
  else await fs.promises.rm(f, { force: true });
  cseCache = undefined; cache.clear();
}
export const googleSearchConfigured = async () => !!(await googleCse());
/** Check a key + engine ID against Google before saving it. */
export async function testGoogleSearch(key: string, cx: string): Promise<string | null> {
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=test&num=1`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (r?.ok) return null;
  const j = (await r?.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? "Google didn't answer.";
}

const SHOP = /(^|\.)(amazon\.[a-z.]+|ebay\.com|etsy\.com|walmart\.com|target\.com|bestbuy\.com|aliexpress\.com|costco\.com|homedepot\.com|lowes\.com|apple\.com|newegg\.com|wayfair\.com|macys\.com|nike\.com)$/;
/** The Images / Videos / Shopping tabs, from Google's own API (images, YouTube, shops), fetched when the tab is opened. */
export async function verticalSearch(q: string, kind: "images" | "videos" | "shopping" | "books" | "scholar" | "news"): Promise<{ images?: ImageItem[]; videos?: VideoItem[]; web?: WebResult[] }> {
  if (kind === "books") return { web: await books(q).catch(() => []) };
  if (kind === "scholar") return { web: await scholar(q, 10).catch(() => []) };
  if (kind === "news") return { web: await newsSearch(q).catch(() => []) };
  const c = await googleCse();
  const get = async (extra: string) => {
    const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(c!.key)}&cx=${encodeURIComponent(c!.cx)}&q=${encodeURIComponent(extra.startsWith("&") ? q : extra)}&safe=active${extra.startsWith("&") ? extra : ""}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Google Search ${r.status}`);
    return arr(((await r.json()) as J).items);
  };
  try {
    if (kind === "images") {
      if (c) {
        const items = await get("&searchType=image&num=10");
        const images = items.map((x): ImageItem => { const im = obj(x.image); return { title: decode(x.title), thumb: str(im.thumbnailLink) ?? str(x.link) ?? "", full: str(x.link) ?? "", page: str(im.contextLink) ?? str(x.link) ?? "", site: str(x.displayLink)?.replace(/^www\./, "") ?? "" }; }).filter((i) => i.thumb && i.full);
        if (images.length) return { images };
      }
      const ov = await openverse(q).catch(() => []);
      return { images: ov.length >= 6 ? ov : [...ov, ...(await commonsImages(q))] };
    }
    if (!c) return {};
    if (kind === "videos") {
      const items = await get("&siteSearch=youtube.com&siteSearchFilter=i&num=10");
      return { videos: items.map((x): VideoItem => { const pm = obj(x.pagemap); return { title: decode(x.title).replace(/ - YouTube$/, ""), url: str(x.link) ?? "", site: "youtube.com", snippet: decode(x.snippet), thumb: str(arr(pm.cse_thumbnail)[0]?.src) ?? str(arr(pm.cse_image)[0]?.src) }; }).filter((v) => v.url && v.title) };
    }
    const items = await get(`${q} buy price`);
    const web = items.map((x): WebResult => { const url = str(x.link) ?? "", pm = obj(x.pagemap); return { title: decode(x.title), url, site: str(x.displayLink)?.replace(/^www\./, "") ?? site(url), snippet: decode(x.snippet), thumb: str(arr(pm.cse_thumbnail)[0]?.src), kind: "shop" as ResultKind }; }).filter((x) => x.url && x.title);
    return { web: [...web.filter((w) => SHOP.test(w.site)), ...web.filter((w) => !SHOP.test(w.site))] };
  } catch { return {}; }
}

// ---------------------------------------------------------------- free, open sources (no key, no account)
// Scholarly papers (OpenAlex), books (Open Library), and the independent web (Marginalia).

async function scholar(q: string, n = 8): Promise<WebResult[]> {
  const j = await getJSON<{ results?: J[] }>(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}&filter=has_abstract:true&select=display_name,doi,publication_year,cited_by_count,authorships,primary_location,abstract_inverted_index`, 7000);
  return (j?.results ?? []).map((w): WebResult | null => {
    const doi = str(w.doi), loc = obj(w.primary_location), url = str(loc.landing_page_url) ?? doi ?? "";
    if (!url || !str(w.display_name)) return null;
    const inv = obj(w.abstract_inverted_index), words: string[] = [];
    for (const [word, pos] of Object.entries(inv)) for (const p of pos as number[]) words[p] = word;
    const abs = words.filter(Boolean).join(" ").slice(0, 260);
    const authors = arr(w.authorships).slice(0, 3).map((a) => str(obj(a.author).display_name)).filter(Boolean).join(", ");
    const venue = str(obj(loc.source).display_name);
    return { title: decode(w.display_name), url, site: site(url), kind: "reference", snippet: `${authors}${w.publication_year ? ` · ${w.publication_year}` : ""}${venue ? ` · ${venue}` : ""}${w.cited_by_count ? ` · cited ${w.cited_by_count} times` : ""}${abs ? `. ${abs}${abs.length >= 260 ? "…" : ""}` : ""}` };
  }).filter((x): x is WebResult => !!x);
}
async function books(q: string, n = 8): Promise<WebResult[]> {
  const j = await getJSON<{ docs?: J[] }>(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${n}&fields=key,title,author_name,first_publish_year,cover_i,subject`, 7000);
  return (j?.docs ?? []).map((d): WebResult | null => {
    const key = str(d.key), title = str(d.title);
    if (!key || !title) return null;
    const subjects = Array.isArray(d.subject) ? (d.subject as string[]).slice(0, 4).join(", ") : "";
    return { title, url: `https://openlibrary.org${key}`, site: "openlibrary.org", kind: "reference", thumb: typeof d.cover_i === "number" ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined,
      snippet: `${Array.isArray(d.author_name) ? (d.author_name as string[]).slice(0, 2).join(", ") : "Unknown author"}${d.first_publish_year ? ` · first published ${d.first_publish_year}` : ""}${subjects ? ` · ${subjects}` : ""}` };
  }).filter((x): x is WebResult => !!x);
}
async function indieWeb(q: string, n = 8): Promise<WebResult[]> {
  const j = await getJSON<{ results?: J[] }>(`https://api.marginalia.nu/public/search/${encodeURIComponent(q)}?count=${n}`, 1200);
  return (j?.results ?? []).map((r): WebResult | null => {
    const url = str(r.url), title = decode(r.title);
    return url && title ? { title, url, site: site(url), snippet: decode(r.description), kind: kindOf(url) } : null;
  }).filter((x): x is WebResult => !!x);
}
const dedupe = (list: WebResult[]) => { const seen = new Set<string>(); return list.filter((r) => !seen.has(r.url) && seen.add(r.url)); };

/** CC-licensed pictures from many sites (Openverse). More varied than Wikimedia alone; can be slow or down, so it has a short timeout. */
async function openverse(q: string, n = 18): Promise<ImageItem[]> {
  const j = await getJSON<{ results?: J[] }>(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}&mature=false`, 2500);
  return (j?.results ?? []).map((x): ImageItem | null => {
    const thumb = str(x.thumbnail), full = str(x.url), page = str(x.foreign_landing_url);
    if (!thumb || !full || !page) return null;
    return { title: decode(x.title) || q, thumb, full, page, site: site(page), credit: [str(x.creator), str(x.license)?.toUpperCase()].filter(Boolean).join(" · ") || undefined };
  }).filter((x): x is ImageItem => !!x);
}
/** Headlines from the publishers' own RSS feeds (BBC, NPR, The Guardian) that match the search words. */
async function newsSearch(q: string): Promise<WebResult[]> {
  const { headlines } = await import("./pulse");
  const w = q.toLowerCase().split(/\W+/).filter((x) => x.length > 2 && !STOP_WORDS.test(x));
  const all = await headlines();
  const hits = w.length ? all.filter((h) => w.some((x) => h.title.toLowerCase().includes(x))) : all;
  return hits.slice(0, 20).map((h): WebResult => ({ title: h.title, url: h.url, site: h.site, snippet: new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), kind: "news" }));
}

async function googleWeb(q: string, c: { key: string; cx: string }, page: number): Promise<WebResult[]> {
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(c.key)}&cx=${encodeURIComponent(c.cx)}&q=${encodeURIComponent(q)}&num=10&start=${Math.min(91, page * 10 + 1)}&safe=active`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Google Search ${r.status}`);
  const j = (await r.json()) as J;
  return arr(j.items).map((x): WebResult => {
    const url = str(x.link) ?? "", pm = obj(x.pagemap);
    const thumb = str(arr(pm.cse_image)[0]?.src) ?? str(arr(pm.cse_thumbnail)[0]?.src);
    return { title: decode(x.title), url, site: str(x.displayLink)?.replace(/^www\./, "") ?? site(url), snippet: decode(x.snippet), thumb: thumb && /^https:/.test(thumb) ? thumb : undefined, kind: kindOf(url) };
  }).filter((x) => x.url && x.title);
}

async function braveImages(q: string, key: string): Promise<ImageItem[]> {
  try {
    const r = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(q)}&count=16&safesearch=strict`, { headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = (await r.json()) as J;
    return arr(j.results).map((x): ImageItem => ({
      title: decode(x.title), thumb: str(obj(x.thumbnail).src) ?? "", full: str(obj(x.properties).url) ?? str(obj(x.thumbnail).src) ?? "",
      page: str(x.url) ?? "", site: str(x.source) ?? site(str(x.url) ?? ""),
    })).filter((x) => x.thumb && x.page);
  } catch { return []; }
}

// ---------------------------------------------------------------- open sources (no key)

const backoff = new Map<string, number>();
async function getJSON<T>(url: string, ms = 5000, retried = false): Promise<T | null> {
  let host = "";
  try { host = new URL(url).host; } catch { return null; }
  if ((backoff.get(host) ?? 0) > Date.now()) return null; // this site asked us to slow down
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
    if (r.status === 429) {
      const wait = Math.min(300, Math.max(30, Number(r.headers.get("retry-after")) || 60));
      backoff.set(host, Date.now() + wait * 1000);
      return null;
    }
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

/** Wikipedia articles for the query (only used for the agent's own lookups when there is no search key). */
const wikiCache = new Map<string, { at: number; list: WebResult[] }>();
async function wikiResults(q: string): Promise<WebResult[]> {
  const wk = q.toLowerCase().trim();
  const wh = wikiCache.get(wk);
  if (wh && Date.now() - wh.at < 3600_000) return wh.list;
  const list = await wikiResultsRaw(q);
  if (list.length) { wikiCache.set(wk, { at: Date.now(), list }); if (wikiCache.size > 150) wikiCache.delete(wikiCache.keys().next().value as string); }
  return list;
}
async function wikiResultsRaw(q: string): Promise<WebResult[]> {
  const j = await getJSON<{ query?: { pages?: Record<string, { index: number; title: string; extract?: string; fullurl?: string; thumbnail?: { source: string } }> } }>(
    `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=8&prop=extracts|pageimages|info&exintro=1&explaintext=1&exsentences=3&piprop=thumbnail&pithumbsize=400&inprop=url&format=json&origin=*`, 6000);
  return Object.values(j?.query?.pages ?? {}).sort((a, b) => a.index - b.index).filter((p) => p.extract && p.fullurl)
    .map((p): WebResult => ({ title: `${p.title} - Wikipedia`, url: p.fullurl!, site: "en.wikipedia.org", snippet: p.extract!.replace(/\s+/g, " ").slice(0, 280), thumb: p.thumbnail?.source, favicon: "https://en.wikipedia.org/static/favicon/wikipedia.ico", kind: "reference" }));
}

// ---- The knowledge panel: who/what the search is about, with its common facts (Wikipedia + Wikidata, both open data)

const STOP_WORDS = /^(the|who|what|how|why|when|where|which|does|did|and|for|are|was|were|can|with|from|about|invented|inventor|stats|news|age|net|worth|height|wife|husband|salary|score|scores|schedule|roster|latest|today|vs|best|top|new|first|last)$/;
const wikidataProps: [string, string, number][] = [ // [label, property, max values]
  ["Born", "P569", 1], ["Died", "P570", 1], ["Height", "P2048", 1], ["Team", "P54", 2], ["Position", "P413", 2], ["Occupation", "P106", 3], ["Nationality", "P27", 1],
  ["Spouse", "P26", 2], ["Sport", "P641", 1], ["League", "P118", 1], ["Coach", "P286", 1], ["Venue", "P115", 1], ["Founded", "P571", 1], ["Founder", "P112", 2],
  ["Headquarters", "P159", 1], ["CEO", "P169", 1], ["Industry", "P452", 2], ["Country", "P17", 1], ["Population", "P1082", 1], ["Elevation", "P2044", 1],
  ["Release date", "P577", 1], ["Director", "P57", 2], ["Starring", "P161", 3], ["Genre", "P136", 2],
];
type Claim = { mainsnak?: { datavalue?: { value?: unknown; type?: string } }; qualifiers?: Record<string, unknown[]>; rank?: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtTime(v: { time?: string; precision?: number }): { text: string; date?: Date } | null {
  const m = String(v.time ?? "").match(/^([+-])(\d{4})-(\d\d)-(\d\d)/);
  if (!m) return null;
  const y = Number(m[2]), mo = Number(m[3]), d = Number(m[4]), pr = v.precision ?? 11;
  const text = pr >= 11 && mo && d ? `${MONTHS[mo - 1]} ${d}, ${y}` : pr === 10 && mo ? `${MONTHS[mo - 1]} ${y}` : String(y);
  return { text, date: pr >= 11 ? new Date(Date.UTC(y, mo - 1, d)) : new Date(Date.UTC(y, 0, 1)) };
}
function fmtQty(v: { amount?: string; unit?: string }, prop: string): string | null {
  const n = Number(v.amount); if (!Number.isFinite(n)) return null;
  const unit = String(v.unit ?? "").split("/").pop();
  if (prop === "P2048") { // height
    const m = unit === "Q11573" ? n : unit === "Q174728" ? n / 100 : unit === "Q218593" ? n * 0.0254 : unit === "Q3710" ? n * 0.3048 : null;
    if (m === null) return null;
    const inches = Math.round(m / 0.0254);
    return `${Math.floor(inches / 12)} ft ${inches % 12} in (${m.toFixed(2)} m)`;
  }
  if (prop === "P2044") return `${Math.round(n).toLocaleString("en-US")} m`;
  return Math.round(n).toLocaleString("en-US");
}

const panelCache = new Map<string, { at: number; v: Knowledge | null }>();
async function entityPanel(q: string): Promise<Knowledge | null> {
  const key = q.toLowerCase().trim();
  const hit = panelCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.v;
  const v = await entityPanelRaw(q);
  if (v?.facts?.length || v === null) panelCache.set(key, { at: Date.now(), v }); // don't cache a half-filled panel (rate limit)
  if (panelCache.size > 200) panelCache.delete(panelCache.keys().next().value as string);
  return v;
}
async function entityPanelRaw(q: string): Promise<Knowledge | null> {
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !STOP_WORDS.test(w));
  if (!words.length || words.length > 5) return null;
  const search = await getJSON<{ query?: { search?: { title: string }[] } }>(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&origin=*`, 4000);
  const title = (search?.query?.search ?? []).map((x) => x.title).find((t) => {
    const l = t.toLowerCase();
    return !/^(list|lists|outline|index) of /.test(l) && words.filter((w) => l.includes(w)).length / words.length >= 0.6;
  });
  if (!title) return null;
  const sum = await getJSON<{ title?: string; extract?: string; description?: string; thumbnail?: { source: string }; originalimage?: { source: string; width?: number }; content_urls?: { desktop?: { page?: string } }; type?: string; wikibase_item?: string }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, 4000);
  if (!sum?.extract || sum.type === "disambiguation") return null;
  const panel: Knowledge = {
    title: sum.title ?? title, extract: sum.extract.replace(/\s+/g, " ").slice(0, 650), url: sum.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    image: (sum.originalimage && (sum.originalimage.width ?? 9999) <= 1800 ? sum.originalimage.source : sum.thumbnail?.source), description: sum.description, source: "Wikipedia",
  };
  // Facts + related, in parallel.
  const [facts, related] = await Promise.all([
    sum.wikibase_item ? wikidataFacts(sum.wikibase_item).catch(() => null) : Promise.resolve(null),
    getJSON<{ query?: { pages?: Record<string, { index: number; title: string; description?: string; thumbnail?: { source: string } }> } }>(
      `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`morelike:${title}`)}&gsrlimit=8&prop=pageimages|description&piprop=thumbnail&pithumbsize=160&format=json&origin=*`, 4000),
  ]);
  if (facts?.facts.length) panel.facts = facts.facts;
  if (facts?.description) panel.description = facts.description;
  panel.related = Object.values(related?.query?.pages ?? {}).sort((a, b) => a.index - b.index).filter((p) => p.title !== title && !/\d{4}|season|album|rivalry|^history of|^demographics|rights in|^list|^lists|discography|\btour\b|\(song\)|\(film\)|\(band\)|\bstatistics\b|\bcareer\b|\bawards\b|\bculture of|\bpolitics of|\beconomy of/i.test(p.title)).slice(0, 6)
    .map((p) => ({ title: p.title, description: p.description, image: p.thumbnail?.source }));
  if (panel.related.length < 3) panel.related = []; // a thin "related" row looks broken: show it only when it's real
  return panel;
}

const wdCache = new Map<string, { at: number; v: { facts: [string, string][]; description?: string } | null }>();
async function wikidataFacts(qid: string): Promise<{ facts: [string, string][]; description?: string } | null> {
  const hit = wdCache.get(qid);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.v;
  const v = await wikidataFactsRaw(qid);
  if (v) wdCache.set(qid, { at: Date.now(), v });
  return v;
}
async function wikidataFactsRaw(qid: string): Promise<{ facts: [string, string][]; description?: string } | null> {
  const ent = await getJSON<{ entities?: Record<string, { claims?: Record<string, Claim[]>; descriptions?: { en?: { value?: string } } }> }>(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|descriptions&languages=en&format=json&origin=*`, 5000);
  const e = ent?.entities?.[qid];
  if (!e?.claims) return null;
  // The current value(s): claims with no end date, best-ranked first.
  const current = (cs: Claim[] = [], prop: string) => cs.filter((c) => c.rank !== "deprecated" && !(prop === "P54" && c.qualifiers?.P582)).sort((a, b) => (b.rank === "preferred" ? 1 : 0) - (a.rank === "preferred" ? 1 : 0));
  const ids = new Set<string>();
  for (const [, prop, max] of wikidataProps) for (const c of current(e.claims[prop], prop).slice(0, max)) {
    const v = c.mainsnak?.datavalue?.value as { id?: string } | undefined;
    if (c.mainsnak?.datavalue?.type === "wikibase-entityid" && v?.id) ids.add(v.id);
  }
  const labels = new Map<string, string>();
  if (ids.size) {
    const l = await getJSON<{ entities?: Record<string, { labels?: { en?: { value?: string } } }> }>(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${[...ids].slice(0, 50).join("|")}&props=labels&languages=en&format=json&origin=*`, 5000);
    for (const [id, x] of Object.entries(l?.entities ?? {})) if (x.labels?.en?.value) labels.set(id, x.labels.en.value);
  }
  const facts: [string, string][] = [];
  const died = !!e.claims.P570?.length;
  const human = !!e.claims.P569?.length;
  const TEAM_ONLY = new Set(["P118", "P115", "P286", "P159", "P169", "P452", "P112", "P1082", "P2044"]);
  for (const [label, prop, max] of wikidataProps) {
    if (human && TEAM_ONLY.has(prop)) continue; // a person's "league" is their college's, "headquarters" their employer's…
    const vals: string[] = [];
    for (const c of current(e.claims[prop], prop).slice(0, max)) {
      const dv = c.mainsnak?.datavalue; if (!dv) continue;
      const v = dv.value as Record<string, unknown>;
      if (dv.type === "time") {
        const t = fmtTime(v as { time?: string; precision?: number });
        if (!t) continue;
        let text = t.text;
        if (prop === "P569" && !died && t.date && (v.precision as number ?? 11) >= 11) { const age = Math.floor((Date.now() - t.date.getTime()) / 31_557_600_000); if (age > 0 && age < 120) text += ` (age ${age})`; }
        vals.push(text);
      } else if (dv.type === "quantity") { const f = fmtQty(v as { amount?: string; unit?: string }, prop); if (f) vals.push(f); }
      else if (dv.type === "wikibase-entityid") { const l = labels.get(String((v as { id?: string }).id)); if (l) vals.push(l); }
      else if (dv.type === "string" && typeof dv.value === "string") vals.push(String(dv.value).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
    }
    if (vals.length) facts.push([label, [...new Set(vals)].join(", ")]);
    if (facts.length >= 9) break;
  }
  return { facts, description: e.descriptions?.en?.value };
}

/** Openly licensed pictures from Wikimedia Commons, with credit. */
async function commonsImages(q: string): Promise<ImageItem[]> {
  try {
    const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q + " filetype:bitmap")}&gsrnamespace=6&gsrlimit=14&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=420&format=json&origin=*`;
    const j = (await (await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) })).json()) as { query?: { pages?: Record<string, { title: string; imageinfo?: { thumburl?: string; url?: string; descriptionurl?: string; width?: number; extmetadata?: Record<string, { value?: string }> }[] }> } };
    return Object.values(j.query?.pages ?? {}).map((p): ImageItem | null => {
      const i = p.imageinfo?.[0];
      if (!i?.thumburl || !i.descriptionurl || (i.width ?? 0) < 300 || !/\.(jpe?g|png)$/i.test((i.url ?? "").split("?")[0])) return null;
      const m = i.extmetadata ?? {};
      return { title: decode(m.ObjectName?.value ?? p.title.replace(/^File:/, "").replace(/\.\w+$/, "")), thumb: i.thumburl, full: i.url ?? i.thumburl, page: i.descriptionurl, site: "commons.wikimedia.org", credit: decode(m.Artist?.value ?? "").slice(0, 60) || undefined };
    }).filter((x): x is ImageItem => !!x).slice(0, 12);
  } catch { return []; }
}

/** A free-to-use picture for a slide (Wikimedia Commons), as a direct JPG/PNG address. */
export async function slideImage(q: string): Promise<string | null> {
  const list = await commonsImages(q);
  return list[0]?.thumb ?? null;
}

/** "12*(3+4)" → "84". Only plain arithmetic ever reaches the evaluator. */
function instant(q: string): string | null {
  const e = q.trim().replace(/^=/, "").replace(/\s+/g, "").replace(/x/gi, "*").replace(/×/g, "*").replace(/÷/g, "/").replace(/\^/g, "**");
  if (!/^[\d.+\-*/%()]+$/.test(e) || !/[+\-*/%]/.test(e) || e.length > 60 || /\*\*\*|\/\/|\.\./.test(e)) return null;
  try { const v = Function(`"use strict";return (${e})`)() as number; return Number.isFinite(v) ? String(Math.round(v * 1e10) / 1e10) : null; } catch { return null; }
}

// ---- More open sources, each with an official keyless API (no scraping of any search engine)

const SE_SITES: [RegExp, string][] = [
  [/\b(travel|trip|visa|flight|hotel|airport|itinerary|visit)\b/, "travel"],
  [/\b(cook|recipe|bake|baking|roast|dough|sauce)\b/, "cooking"],
  [/\b(repair|fix|leak|leaking|tap|plumb|paint|drywall|wiring|diy|install(ing)? (a )?(shelf|door|floor))\b/, "diy"],
  [/\b(mac|macos|iphone|ipad|ios|airpods|safari|xcode)\b/, "apple"],
  [/\b(linux|ubuntu|bash|terminal|windows|network|wifi|router)\b/, "superuser"],
  [/\b(gaming|minecraft|zelda|steam|elden ring|playstation|xbox|nintendo)\b/, "gaming"],
  [/\b(money|invest|tax|loan|credit|budget|mortgage|retire)\b/, "money"],
  [/\b(fitness|workout|gym|run|running|marathon|diet)\b/, "fitness"],
  [/\b(javascript|python|java|react|css|html|sql|git|api|error|exception|compile|function|array|typescript|node|swift|rust|code|bug)\b/, "stackoverflow"],
];
const isCodeQ = (q: string) => /\b(javascript|python|java|react|css|html|sql|git|api|error|exception|compile|function|array|typescript|node|swift|rust|code|bug|npm|docker|regex|json)\b/i.test(q);
const isAcademicQ = (q: string) => /\b(paper|papers|study|studies|research|journal|doi|arxiv|theory|theorem|thesis|literature|peer.reviewed|meta.analysis|et al)\b/i.test(q);
const isBookQ = (q: string) => /\b(book|books|novel|author|isbn)\b/i.test(q);

async function stackAnswers(q: string): Promise<WebResult[]> {
  if (/\b(reviews?|vs|versus|price|prices|deals?|buy|best|top|cheap(est)?)\b/i.test(q)) return []; // opinion and shopping questions: Q&A sites give off-topic answers
  const sites = [...new Set(SE_SITES.filter(([re]) => re.test(q.toLowerCase())).map(([, s]) => s))].slice(0, 2);
  if (!sites.length) return [];
  const lists = await Promise.all(sites.map((site) => getJSON<{ items?: J[] }>(
    `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=${site}&pagesize=5&filter=default`, 2500)));
  return lists.flatMap((j, i) => (j?.items ?? []).filter((x) => x.is_answered || x.question_score).map((x): WebResult | null => {
    const id = x.question_id ?? x.answer_id; const title = decode(x.title);
    if (!id || !title) return null;
    const host = `${sites[i] === "stackoverflow" ? "stackoverflow.com" : `${sites[i]}.stackexchange.com`}`;
    const url = `https://${host}/questions/${id}`;
    return { title, url, site: host, snippet: decode(String(x.excerpt ?? "").replace(/<[^>]+>/g, "")).slice(0, 260), kind: "forum" as ResultKind, extra: [`${Number(x.score ?? 0)} votes`, ...(x.is_answered ? ["answered"] : [])] };
  }).filter((r): r is WebResult => !!r).slice(0, 4));
}
async function hnStories(q: string): Promise<WebResult[]> {
  const j = await getJSON<{ hits?: J[] }>(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=6`, 2500);
  return (j?.hits ?? []).filter((h) => str(h.url) && str(h.title) && Number(h.points ?? 0) >= 20).slice(0, 4).map((h): WebResult => ({
    title: decode(h.title), url: String(h.url), site: site(String(h.url)), kind: kindOf(String(h.url)),
    snippet: `Discussed on Hacker News · ${Number(h.points)} points · ${Number(h.num_comments ?? 0)} comments`,
  }));
}
async function wikiSister(q: string, host: "en.wikivoyage.org" | "en.wikibooks.org"): Promise<WebResult[]> {
  const j = await getJSON<{ query?: { search?: { title: string; snippet: string }[] } }>(
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&origin=*`, 2500);
  const label = host === "en.wikivoyage.org" ? "Wikivoyage" : "Wikibooks";
  return (j?.query?.search ?? []).map((x): WebResult => ({
    title: `${x.title} - ${label}`, url: `https://${host}/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`, site: host,
    snippet: decode(x.snippet.replace(/<[^>]+>/g, "")).slice(0, 260), kind: "reference" as ResultKind,
  }));
}
/** Runs the promises and returns whatever has finished by the deadline (a slow source never holds the page up). */
async function within<T>(ms: number, ps: Promise<T[]>[]): Promise<T[][]> {
  const out: T[][] = ps.map(() => []);
  await Promise.race([Promise.all(ps.map((p, i) => p.then((v) => { out[i] = v; }, () => {}))), new Promise((res) => setTimeout(res, ms))]);
  return out;
}
/** Word overlap with the query: demotes results that merely share one word. */
function relevance(q: string, r: WebResult): number {
  const w = q.toLowerCase().split(/\W+/).filter((x) => x.length > 2 && !STOP_WORDS.test(x));
  if (!w.length) return 1;
  const t = `${r.title} ${r.snippet}`.toLowerCase();
  return w.filter((x) => t.includes(x)).length / w.length;
}

// ---- Big-site results from open feeds: ESPN (scoreboards), Yahoo Finance (quotes), BBC/NPR/Guardian (RSS), MedlinePlus, MDN, GitHub

const SPORTS_WORDS = /\b(scores?|games?|vs|versus|schedule|standings|playoffs?|nba|nfl|mlb|nhl|wnba|mls|ncaa|football|basketball|baseball|hockey|soccer|tonight|live)\b/i;
async function sportsHits(q: string): Promise<WebResult[]> {
  const pulse = await import("./pulse");
  const ql = q.toLowerCase();
  const teams = pulse.teamNames().filter((t) => ql.includes(t));
  if (!teams.length && !SPORTS_WORDS.test(q)) return [];
  const asked = Object.keys(pulse.LEAGUES).filter((l) => new RegExp("\\b" + l + "\\b", "i").test(q));
  const leagues = asked.length ? asked : ["nba", "nfl", "mlb", "nhl"];
  const games = (await Promise.all(leagues.map((l) => pulse.cachedLeague(l).catch(() => [])))).flat();
  const mine = teams.length ? games.filter((g) => [g.home.name, g.away.name].some((n) => teams.some((t) => n.toLowerCase().includes(t)))) : games.filter((g) => g.state === "in").concat(games.filter((g) => g.state === "pre"));
  return mine.slice(0, 4).map((g): WebResult => {
    const line = g.state === "pre" ? `${g.detail}` : `${g.away.abbr} ${g.away.score} – ${g.home.abbr} ${g.home.score} · ${g.state === "in" ? "Live, " : ""}${g.detail}`;
    return { title: `${g.away.name} at ${g.home.name}`, url: g.url ?? "https://www.espn.com/", site: "espn.com", snippet: line, thumb: g.home.logo ?? g.away.logo, kind: "web", extra: [g.league] };
  });
}
async function financeHit(q: string): Promise<WebResult[]> {
  const t = q.trim();
  const m = t.match(/^\$([A-Za-z]{1,5})$/) ?? t.match(/^([A-Za-z]{1,5})\s+(?:stock|share price|shares|stock price|quote|price)$/i) ?? t.match(/^(?:stock|price of)\s+([A-Za-z]{1,5})$/i) ?? t.match(/^([A-Z]{2,5})$/);
  if (!m) return [];
  const sym = m[1].toUpperCase();
  const quote = await (await import("./pulse")).stock(sym);
  if (!quote) return [];
  return [{ title: `${sym} stock price: $${quote.price.toFixed(2)} (${quote.pct >= 0 ? "+" : ""}${quote.pct.toFixed(2)}% today)`, url: `https://finance.yahoo.com/quote/${sym}`, site: "finance.yahoo.com", snippet: `${sym} is ${quote.pct >= 0 ? "up" : "down"} ${Math.abs(quote.change).toFixed(2)} (${Math.abs(quote.pct).toFixed(2)}%) today. Open for the chart, news and key numbers.`, kind: "web" }];
}
async function newsHits(q: string): Promise<WebResult[]> {
  const w = q.toLowerCase().split(/\W+/).filter((x) => x.length > 2 && !STOP_WORDS.test(x));
  if (!w.length) return [];
  const need = w.length === 1 ? 1 : 2;
  const { headlines } = await import("./pulse");
  return (await headlines()).filter((h) => w.filter((x) => h.title.toLowerCase().includes(x)).length >= need).slice(0, 4)
    .map((h): WebResult => ({ title: h.title, url: h.url, site: site(h.url), snippet: `${h.site} · ${new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`, thumb: h.thumb, kind: "news" }));
}
const HEALTH = /\b(symptoms?|treatments?|disease|cancer|diabetes|pain|fever|flu|vaccines?|allerg(y|ies)|infection|medicine|medication|dose|blood pressure|heart|anxiety|depression|insomnia|vitamin|injury|cough|rash|asthma|arthritis|migraine|cholesterol)\b/i;
async function healthHits(q: string): Promise<WebResult[]> {
  if (!HEALTH.test(q)) return [];
  try {
    const xml = await (await fetch(`https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=${encodeURIComponent(q)}&retmax=3`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(2500) })).text();
    return [...xml.matchAll(/<document\b[^>]*\burl="([^"]+)"[\s\S]*?<\/document>/g)].flatMap((m): WebResult[] => {
      const get = (n: string) => decode((m[0].match(new RegExp('<content name="' + n + '">([\\s\\S]*?)</content>')) ?? [])[1] ?? "").replace(/<[^>]+>/g, "");
      const title = get("title"); if (!title) return [];
      return [{ title: `${title} | MedlinePlus`, url: m[1], site: "medlineplus.gov", snippet: get("FullSummary").replace(/\s+/g, " ").slice(0, 280), kind: "reference" }];
    });
  } catch { return []; }
}
async function devHits(q: string): Promise<WebResult[]> {
  if (!isCodeQ(q) && !/\b(css|html|dom|flexbox|grid|fetch|promise|regex)\b/i.test(q)) return [];
  const REPO = /\b(library|libraries|framework|package|repo|github|tool|open.?source|alternative)\b/gi;
  const wantRepos = new RegExp(REPO.source, "i").test(q);
  const webPlatform = /\b(css|html|dom|flexbox|grid|fetch|promise|regex|javascript|array|async|await|selector|svg|canvas|web ?api)\b/i.test(q);
  const [mdn, gh] = await Promise.all([
    !webPlatform || wantRepos ? Promise.resolve(null) : getJSON<{ documents?: { mdn_url: string; title: string; summary?: string }[] }>(`https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(q)}&locale=en-US&size=3`, 2500),
    wantRepos ? getJSON<{ items?: { full_name: string; html_url: string; description?: string; stargazers_count: number; owner: { avatar_url: string } }[] }>(`https://api.github.com/search/repositories?q=${encodeURIComponent(q.replace(REPO, "").trim() || q)}&per_page=3&sort=stars`, 2500) : Promise.resolve(null),
  ]);
  return [
    ...(mdn?.documents ?? []).map((d): WebResult => ({ title: `${d.title} | MDN`, url: `https://developer.mozilla.org${d.mdn_url}`, site: "developer.mozilla.org", snippet: decode(d.summary ?? "").slice(0, 280), kind: "reference" })),
    ...(gh?.items ?? []).map((i): WebResult => ({ title: i.full_name, url: i.html_url, site: "github.com", snippet: `${i.description ?? ""} · ${compact(i.stargazers_count)} stars`, thumb: `${i.owner.avatar_url}${i.owner.avatar_url.includes("?") ? "&" : "?"}s=112`, kind: "code" })),
  ];
}

/** A page's preview picture (og:image), read from the top of the page. Used to give results without a picture one. */
const ogCache = new Map<string, { at: number; img: string | null }>();
export async function ogImage(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const hit = ogCache.get(url);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.img;
  let img: string | null = null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(2200), redirect: "follow" });
    if (r.ok && /html/i.test(r.headers.get("content-type") ?? "") && r.body) {
      const reader = r.body.getReader(); let html = "", n = 0;
      while (n < 90_000) { const { done, value } = await reader.read(); if (done) break; n += value.length; html += new TextDecoder().decode(value); if (/<\/head>/i.test(html)) break; }
      reader.cancel().catch(() => {});
      const tag = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/i)?.[0] ?? html.match(/<meta[^>]+content=["'][^"']+["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i)?.[0];
      const c = tag?.match(/content=["']([^"']+)["']/i)?.[1];
      if (c) { try { img = new URL(decode(c), r.url).toString(); } catch { img = null; } }
    }
  } catch { img = null; }
  if (img && !/^https:/.test(img)) img = null;
  ogCache.set(url, { at: Date.now(), img });
  if (ogCache.size > 400) ogCache.delete(ogCache.keys().next().value as string);
  return img;
}

/**
 * Tavily Search API: real web results with page text and pictures. With the user's key it uses their account (free plan: 1,000
 * credits a month, no card). Without one it uses Tavily's documented keyless mode (free, rate-limited, no account), and if that
 * says no it rests for 15 minutes and the open sources below take over.
 */
let keylessUntil = 0;
const keylessOk = () => Date.now() >= keylessUntil;
async function tavily(q: string, key: string | null, page: number): Promise<{ web: WebResult[]; images: ImageItem[] }> {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", signal: AbortSignal.timeout(9000),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" }) },
      body: JSON.stringify({ query: q, max_results: 15, include_images: page === 0, include_image_descriptions: true, search_depth: "basic" }),
    });
    if (!r.ok) throw new Error(`Tavily ${r.status}`);
    const j = (await r.json()) as J;
    const imgs = (Array.isArray(j.images) ? (j.images as unknown[]) : []).map((x): ImageItem | null => {
      const u = typeof x === "string" ? x : str(obj(x).url);
      if (!u) return null;
      return { title: (typeof x === "string" ? "" : decode(obj(x).description)) || q, thumb: u, full: u, page: u, site: site(u) };
    }).filter((x): x is ImageItem => !!x).slice(0, 12);
    const web = arr(j.results).map((x): WebResult => {
      const url = str(x.url) ?? "";
      return { title: decode(x.title), url, site: site(url), snippet: decode(x.content).slice(0, 300), kind: kindOf(url), favicon: str(x.favicon) };
    }).filter((x) => x.url && x.title);
    if (!web.length && !key) throw new Error("keyless gave nothing");
    return { web, images: imgs };
  } catch (e) {
    if (!key) keylessUntil = Date.now() + 15 * 60_000;
    throw e;
  }
}

const cache = new Map<string, { at: number; out: SearchOut }>();

/**
 * @param opts.wiki  The agent's own lookups (web_search tool, live answers) may fall back to Wikipedia articles when
 *                   there is no search key. The results PAGE never does: it shows a connect prompt instead.
 */
export async function webSearch(q: string, page = 0, opts: { key?: string; fresh?: boolean; wiki?: boolean } = {}): Promise<SearchOut> {
  const k = `${q.toLowerCase()}|${page}|${opts.wiki ? "w" : ""}`;
  const hit = cache.get(k);
  if (hit && !opts.fresh && Date.now() - hit.at < 5 * 60_000) return hit.out;
  const key = opts.key ?? (await braveKey());
  const panel = page === 0 ? entityPanel(q).catch(() => null) : Promise.resolve(null);
  let out: SearchOut | null = null;
  const cse = await googleCse();
  if (cse) {
    try {
      const [web, images] = await Promise.all([googleWeb(q, cse, page), page === 0 ? commonsImages(q) : Promise.resolve([] as ImageItem[])]);
      if (web.length) out = { q, page, source: "google", keyless: false, web, news: [], videos: [], discussions: [], faq: [], images, knowledge: await panel, instant: page === 0 ? instant(q) : null };
    } catch { /* quota used up / key rejected → the next source */ }
  }
  if (!out && key) {
    try {
      const [b, images] = await Promise.all([brave(q, key, page), page === 0 ? braveImages(q, key) : Promise.resolve([] as ImageItem[])]);
      const kp = (await panel) ?? b.knowledge;
      out = { q, page, source: "brave", keyless: false, web: b.web, news: b.news, videos: b.videos, discussions: b.discussions, faq: b.faq, images: images.length ? images : page === 0 ? await commonsImages(q) : [], knowledge: kp, instant: page === 0 ? instant(q) : null };
    } catch { /* key rejected / offline → open sources below */ }
  }
  if (!out) {
    const tkey = await tavilyKey();
    if (tkey) { // only with a key someone chose to add (there is no keyless fallback)
      try {
        const t = await tavily(q, tkey, page);
        if (t.web.length) out = { q, page, source: "tavily", keyless: false, web: t.web, news: [], videos: [], discussions: [], faq: [], images: t.images.length ? t.images : page === 0 ? await commonsImages(q) : [], knowledge: await panel, instant: page === 0 ? instant(q) : null };
      } catch { /* key rejected / out of credits / offline → the open sources below */ }
    }
  }
  if (!out) {
    const first = page === 0;
    const academic = isAcademicQ(q), books = isBookQ(q);
    // Everything runs at once; whatever has answered within 2.8 s is used.
    const [[wiki], [indie], [papers], [stack], [hn], [voyage], [images], [kpArr], [sports], [fin], [newsH], [health], [dev]] = await Promise.all([
      within(1200, [wikiResults(q)]),
      within(1200, [first ? indieWeb(q, 6) : Promise.resolve([] as WebResult[])]),
      within(1200, [first && (academic || books) ? scholar(q, 5) : Promise.resolve([] as WebResult[])]),
      within(1200, [first ? stackAnswers(q) : Promise.resolve([] as WebResult[])]),
      within(1200, [first && (isCodeQ(q) || /\b(news|startup|launch|review|vs|best)\b/i.test(q)) ? hnStories(q) : Promise.resolve([] as WebResult[])]),
      within(1200, [first && /\b(travel|trip|trail|trails|hike|hiking|visit|things to do|beach|park|itinerary|camp|camping|near)\b/i.test(q) ? wikiSister(q, "en.wikivoyage.org") : Promise.resolve([] as WebResult[])]),
      within(1200, [first ? commonsImages(q) : Promise.resolve([] as ImageItem[])]),
      within(2000, [panel.then((k) => (k ? [k] : []))]),
      within(1200, [first ? sportsHits(q) : Promise.resolve([] as WebResult[])]),
      within(1200, [first ? financeHit(q) : Promise.resolve([] as WebResult[])]),
      within(1200, [first ? newsHits(q) : Promise.resolve([] as WebResult[])]),
      within(1200, [first ? healthHits(q) : Promise.resolve([] as WebResult[])]),
      within(1200, [first ? devHits(q) : Promise.resolve([] as WebResult[])]),
    ]);
    // Real web pages first (Marginalia, Q&A, discussions), then reference, with Wikipedia limited to two so it never fills the page.
    const ranked = (rs: WebResult[]) => rs.map((r) => ({ r, s: relevance(q, r) })).filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).map((x) => x.r);
    const web0 = stack.length + indie.length + voyage.length > 0;
    const wikiTop = ranked(wiki).slice(0, 2), wikiRest = ranked(wiki).slice(2, web0 ? 4 : 8);
    const web = dedupe([...fin, ...sports, ...health, ...dev, ...newsH, ...ranked(stack), ...ranked(indie), ...ranked(voyage), ...wikiTop, ...ranked(hn), ...ranked(papers), ...wikiRest]);
    out = { q, page, source: "open", keyless: !key, web: web.length ? web : dedupe([...wiki, ...indie]), news: [], videos: [], discussions: [], faq: [], images, knowledge: kpArr[0] ?? null, instant: page === 0 ? instant(q) : null };
  }
  if (out.web.length || out.images.length || out.knowledge) { cache.set(k, { at: Date.now(), out }); if (cache.size > 100) cache.delete(cache.keys().next().value as string); }
  return out;
}

/** Is there a real web-search source (Google Programmable Search or a Brave key)? Without one, lookups only see Wikipedia. */
export async function hasSearchBackend(): Promise<boolean> {
  return !!(await googleCse()) || !!(await braveKey()) || !!(await tavilyKey());
}

/** Plain text of the results for the agent's own tools (web_search, live answers). */
export async function searchText(q: string): Promise<string> {
  const o = await webSearch(q, 0, { wiki: true });
  const lines = [
    ...o.web.slice(0, 8).map((r) => `- ${r.title}${r.age ? ` (${r.age})` : ""}\n  ${r.url}\n  ${r.snippet}`),
    ...o.news.slice(0, 3).map((r) => `- [news] ${r.title}${r.age ? ` (${r.age})` : ""}\n  ${r.url}\n  ${r.snippet}`),
  ];
  if (!lines.length) return o.keyless ? "No results. (Marigold's web search isn't connected yet, so it can only look at Wikipedia. Tell the user once, briefly: a free Tavily key pasted into Setup → Web search key (tavily.com, no card) unlocks full web results.)" : "No results.";
  return `${lines.join("\n")}${o.keyless ? "\n(Only Wikipedia results: web search isn't connected. Tell the user once, briefly: a free Tavily key pasted into Setup → Web search key (tavily.com, no card) unlocks full web results.)" : ""}`;
}

// ---------------------------------------------------------------- model helper (cloud first, local fallback)

async function ai(system: string, user: string, json: boolean, signal?: AbortSignal, fast?: { maxTokens: number }): Promise<string> {
  const { cloudAll, cloudJson, cloudText } = await import("./cloud");
  if (await cloudAll()) {
    const { stepModel } = await import("./cloud");
    const o = fast ? { model: stepModel(), maxTokens: fast.maxTokens } : undefined;
    const out = json ? await cloudJson(system, user, signal, o) : await cloudText(system, user, signal, o).catch(() => "");
    if (out) return out;
  }
  try {
    const r = await fetch(`${process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: signal ?? AbortSignal.timeout(90_000),
      body: JSON.stringify({ model: "gpt-oss:20b", stream: false, think: "low", ...(json ? { format: "json" } : {}), options: { temperature: 0.3, num_ctx: 16384, num_predict: 2600 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    return (((await r.json()) as { message?: { content?: string } }).message?.content ?? "").trim();
  } catch { return ""; }
}

// ---------------------------------------------------------------- the brief

export interface Brief { summary: string; points: { text: string; cites: number[] }[]; cites: number[]; keyFacts: { label: string; value: string }[]; followUps: string[]; note?: string }

/** The numbered sources the Brief cites: the top web results, then top news. The page shows the same list. */
export const briefSources = (o: SearchOut) => [...o.web.slice(0, 7), ...o.news.slice(0, 2).map((n) => ({ ...n, kind: "news" as const }))];
const briefCache = new Map<string, { at: number; brief: Brief }>();
const briefFlight = new Map<string, Promise<Brief | null>>();

/**
 * A direct answer first, then the few things worth knowing, written from what the top pages actually say
 * (not just their snippets): the best three pages are read where their sites allow it.
 */
export function searchBrief(o: SearchOut, pageText = ""): Promise<Brief | null> {
  // The results request starts the Brief in the background; the page's own request then joins it (no second run).
  const k = `${o.q.toLowerCase()}|${pageText.length > 0 ? "p" : ""}`;
  const running = briefFlight.get(k);
  if (running) return running;
  const p = writeBrief(o, pageText).finally(() => briefFlight.delete(k));
  briefFlight.set(k, p);
  return p;
}
async function briefPrompt(o: SearchOut, pageText = "") {
  const t0 = Date.now();
  const list = briefSources(o);
  // Read the best few pages in parallel (fast ones only); the rest contribute their snippets.
  const readable = list.map((r, i) => ({ r, i })).filter(({ r }) => r.kind !== "video" && r.kind !== "shop").slice(0, 2);
  const pages = new Map<number, string>();
  await Promise.all(readable.map(async ({ r, i }) => {
    const p = await Promise.race([fetchPage(r.url).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 1400))]);
    if (p?.text) pages.set(i, p.text.slice(0, 1800));
  }));
  const ctx = `${o.knowledge ? `[wiki] ${o.knowledge.title}${o.knowledge.description ? ` (${o.knowledge.description})` : ""}: ${o.knowledge.extract}${o.knowledge.facts?.length ? ` Facts: ${o.knowledge.facts.map(([k, v]) => `${k}: ${v}`).join("; ")}.` : ""}\n\n` : ""}${list.map((r, i) => `[${i + 1}] ${r.title} (${r.site}${r.age ? `, ${r.age}` : ""})\n${[r.snippet, ...(("extra" in r && r.extra) || [])].filter(Boolean).join(" ")}${pages.get(i) ? `\nPage text: ${pages.get(i)}` : ""}`).join("\n\n")}`;
  const resultsPage = pageText ? `\n\nThe search results page the user is looking at right now (its text, may be cut; use it for what the results say):\n${pageText.replace(/\s+/g, " ").slice(0, 6500)}` : "";
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const t1 = Date.now();
  const rules = `Today is ${today}. Use ONLY the sources below, in your own words (never copy a sentence). Prefer the most recent information. Never invent anything or pad. No greeting, no emoji, no markdown, no em dashes. The [wiki] item needs no number.`;
  const user = `Query: ${o.q}\n\nSources:\n${ctx}${resultsPage}`;
  return { list, rules, user, t0, t1 };
}

async function writeBrief(o: SearchOut, pageText = ""): Promise<Brief | null> {
  if (!o.web.length && !o.knowledge && pageText.replace(/\s/g, "").length < 200) return null;
  const cacheKey = `${o.q.toLowerCase()}|${pageText.length > 0 ? "p" : ""}`;
  const hit = briefCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.brief;
  const { list, rules, user, t0, t1 } = await briefPrompt(o, pageText);
  // Two short requests at once (each has about 1.9 s of fixed cloud overhead, so splitting further doesn't help).
  const [first, more] = await Promise.all([
    ai(`You write the top of a search page: the part a busy person reads instead of opening ten tabs. ${rules} Return JSON:
{"answer":"the direct answer in 2-3 short sentences (about 60 words): lead with the answer itself, then the one most important piece of context. Specific (names, numbers, dates), with [n] after each claim it rests on. If the query isn't a question, say what the thing is and why it matters",
 "keyFacts":[{"label":"short label","value":"fact stated in the sources"}] (0-4, ONLY exact facts such as dates, numbers, names, places, records),
 "note":"ONLY if sources conflict, look old for a fast-changing topic, or are thin: one short honest sentence. Otherwise omit"}`, user, true, AbortSignal.timeout(30_000), { maxTokens: 360 }),
    ai(`You write the "worth knowing" part of a search page. ${rules} Return JSON:
{"points":[{"text":"one distinct, concrete thing worth knowing (a detail, the latest development, a number, or what people disagree about). ONE sentence, under 28 words, specific, no filler","cites":[source numbers]}] (4 points, each a different angle, most useful first),
 "followUps":["4 sharp next questions a curious person would ask, each under 60 characters, each different"]}`, user, true, AbortSignal.timeout(30_000), { maxTokens: 420 }),
  ]);
  if (process.env.NODE_ENV !== "production") console.log(`[brief] pages ${t1 - t0}ms, model ${Date.now() - t1}ms`);
  const out = (() => { const j = (x: string) => { try { return JSON.parse(x || "{}"); } catch { return {}; } }; return JSON.stringify({ ...j(more), ...j(first) }); })();
  try {
    const j = JSON.parse(out) as { answer?: string; summary?: string; points?: { text?: string; cites?: number[] }[]; keyFacts?: { label?: string; value?: string }[]; followUps?: string[]; note?: string };
    const summary = String(j.answer ?? j.summary ?? "").trim();
    if (!summary) return null;
    const valid = (n: number) => n >= 1 && n <= list.length;
    const points = (j.points ?? []).filter((p) => p?.text).slice(0, 7).map((p) => ({ text: String(p.text), cites: (p.cites ?? []).map(Number).filter(valid) }));
    const brief: Brief = {
      summary, points,
      cites: [...new Set([...summary.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).concat(points.flatMap((p) => p.cites)))].filter(valid),
      keyFacts: (j.keyFacts ?? []).filter((f) => f?.label && f?.value).slice(0, 5).map((f) => ({ label: String(f.label), value: String(f.value) })),
      followUps: (j.followUps ?? []).map(String).filter((x) => x.length > 6 && x.length < 100).slice(0, 4),
      note: j.note ? String(j.note).slice(0, 200) : undefined,
    };
    briefCache.set(cacheKey, { at: Date.now(), brief });
    if (briefCache.size > 60) briefCache.delete(briefCache.keys().next().value as string);
    return brief;
  } catch { return null; }
}


/** What the streaming Brief sends the page: the answer as it is written, then the rest. */
export type BriefEvent =
  | { type: "answer"; text: string }
  | { type: "rest"; points: Brief["points"]; keyFacts: Brief["keyFacts"]; followUps: string[]; note?: string }
  | { type: "full"; brief: Brief }
  | { type: "none" };

/**
 * The Brief, delivered as it is written: the answer streams word by word while the points, facts and follow-ups are
 * written alongside it and arrive a moment later. A repeat search is answered from the cache in one piece.
 */
export async function streamBrief(o: SearchOut, send: (e: BriefEvent) => void): Promise<void> {
  if (!o.web.length && !o.knowledge) { send({ type: "none" }); return; }
  const cacheKey = `${o.q.toLowerCase()}|`;
  const hit = briefCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) { send({ type: "full", brief: hit.brief }); return; }
  const { list, rules, user } = await briefPrompt(o);
  const valid = (n: number) => n >= 1 && n <= list.length;
  const answerSystem = `You write the top of a search page: the part a busy person reads instead of opening ten tabs. ${rules} Write ONLY the direct answer, as plain text in 2-3 short sentences (about 60 words): lead with the answer itself, then the one most important piece of context. Specific (names, numbers, dates), with [n] after each claim it rests on. If the query isn't a question, say what the thing is and why it matters.`;
  const restSystem = `You write the "worth knowing" part of a search page. ${rules} Return JSON:
{"points":[{"text":"one distinct, concrete thing worth knowing (a detail, the latest development, a number, or what people disagree about). ONE sentence, under 28 words, specific, no filler","cites":[source numbers]}] (4 points, each a different angle, most useful first),
 "followUps":["4 sharp next questions a curious person would ask, each under 60 characters, each different"],
 "note":"ONLY if sources conflict, look old for a fast-changing topic, or are thin: one short honest sentence. Otherwise omit"}`;
  let answer = "";
  const answerP = (async () => {
    const { cloudAll, cloudStream, stepModel } = await import("./cloud");
    if (await cloudAll()) {
      try {
        for await (const t of cloudStream(answerSystem, [{ role: "user", content: user }], AbortSignal.timeout(30_000), 260, stepModel())) { answer += t; send({ type: "answer", text: answer }); }
      } catch { /* fall through to the one-shot path below if nothing arrived */ }
    }
    if (!answer.trim()) { answer = (await ai(answerSystem, user, false, AbortSignal.timeout(45_000), { maxTokens: 260 })).trim(); if (answer) send({ type: "answer", text: answer }); }
  })();
  const restP = ai(restSystem, user, true, AbortSignal.timeout(30_000), { maxTokens: 400 }).then((out) => {
    try {
      const j = JSON.parse(out) as { points?: { text?: string; cites?: number[] }[]; keyFacts?: { label?: string; value?: string }[]; followUps?: string[]; note?: string };
      const rest = {
        points: (j.points ?? []).filter((p) => p?.text).slice(0, 5).map((p) => ({ text: String(p.text), cites: (p.cites ?? []).map(Number).filter(valid) })),
        keyFacts: (j.keyFacts ?? []).filter((f) => f?.label && f?.value).slice(0, 4).map((f) => ({ label: String(f.label), value: String(f.value) })),
        followUps: (j.followUps ?? []).map(String).filter((x) => x.length > 6 && x.length < 100).slice(0, 4),
        note: j.note ? String(j.note).slice(0, 200) : undefined,
      };
      send({ type: "rest", ...rest });
      return rest;
    } catch { return null; }
  }).catch(() => null);
  const [, rest] = await Promise.all([answerP, restP]);
  if (!answer.trim()) { send({ type: "none" }); return; }
  const r = rest ?? { points: [], keyFacts: [], followUps: [], note: undefined };
  if (!rest) send({ type: "rest", ...r });
  const brief: Brief = { summary: answer.trim(), ...r, cites: [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).concat(r.points.flatMap((p) => p.cites)))].filter(valid) };
  briefCache.set(cacheKey, { at: Date.now(), brief });
  if (briefCache.size > 60) briefCache.delete(briefCache.keys().next().value as string);
}

// ---------------------------------------------------------------- peek (2-sentence look inside one result)

const peekCache = new Map<string, { summary: string; image?: string }>();
export async function searchPeek(url: string, q: string): Promise<{ summary: string; image?: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const key = `${q}|${url}`;
  const hit = peekCache.get(key);
  if (hit) return hit;
  const p = await fetchPage(url).catch(() => null);
  if (!p) return null; // the site doesn't allow automated reading, or it's paywalled
  const summary = (await ai(`In 2 plain sentences, say what this page tells the reader about “${q}”. Your own words, no quotes, no greeting, no emoji, no em dashes. If it's not relevant, say what it's actually about.`, `${p.title ?? ""}\n${p.text.slice(0, 4000)}`, false, AbortSignal.timeout(30_000))).trim();
  if (!summary) return null;
  const out = { summary: summary.slice(0, 400), image: p.image };
  peekCache.set(key, out);
  if (peekCache.size > 200) peekCache.delete(peekCache.keys().next().value as string);
  return out;
}

/**
 * The Brief for the search results page the user is looking at in the Marigold browser (any engine, any query).
 * The page's own text and links come from the user's tab; the best few linked pages are read where their sites allow.
 */
export async function briefFromPage(q: string, pageText: string, links: { text: string; href: string }[]): Promise<{ brief: Brief | null; knowledge: Knowledge | null; sources: { title: string; url: string; site: string }[] }> {
  const web: WebResult[] = links.filter((l) => /^https?:\/\//.test(l.href)).slice(0, 10).map((l) => ({ title: l.text, url: l.href, site: site(l.href), snippet: "", kind: kindOf(l.href) }));
  const knowledge = await entityPanel(q).catch(() => null);
  const o: SearchOut = { q, page: 0, source: "open", keyless: false, web, news: [], videos: [], discussions: [], faq: [], images: [], knowledge, instant: instant(q) };
  const brief = await searchBrief(o, pageText);
  return { brief, knowledge, sources: briefSources(o).map((r) => ({ title: r.title, url: r.url, site: r.site })) };
}
