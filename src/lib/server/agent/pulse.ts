import { promises as fs } from "fs";
import path from "path";
import { MARIGOLD_DIR } from "./policy";

/**
 * The Pulse bar: stocks, crypto, live sports scores, weather and headlines, kept fresh.
 *   stocks    Yahoo Finance chart endpoint (unofficial, undocumented: fine for personal use, swap for a licensed feed before a public launch)
 *   crypto    CoinGecko free API
 *   scores    ESPN's public scoreboard JSON (unofficial, same caveat)
 *   weather   Open-Meteo (free for non-commercial use)
 *   headlines the publishers' own RSS feeds (BBC, NPR, The Guardian)
 *   breaking  the same feeds plus more (NYT, Al Jazeera, CNBC, TechCrunch, BBC Business/Tech, the FAA and NVIDIA's own newsrooms), grouped into stories:
 *             a story reported by several outlets at once is "breaking"; topics you follow (e.g. FAA, Jensen Huang) are flagged from any feed.
 *             Seen stories are remembered for a week so the Pulse can show the day's and the week's biggest.
 * Each part is cached for a short time so the bar can poll every 30 s without hammering anyone.
 */

const FILE = path.join(MARIGOLD_DIR, "pulse.json");
const UA = "Marigold/1.0 (desktop assistant; personal dashboard)";

export interface PulseConfig { symbols: string[]; crypto: string[]; leagues: string[]; teams: string[]; city: string; topics: string[]; alerts: { scores: boolean; stocks: boolean; stockPct: number; breaking: boolean } }
export const DEFAULTS: PulseConfig = { symbols: ["^GSPC", "^IXIC", "AAPL", "NVDA", "TSLA"], crypto: ["bitcoin"], leagues: ["nba", "nfl"], teams: [], city: "", topics: [], alerts: { scores: true, stocks: true, stockPct: 5, breaking: true } };
export const LEAGUES: Record<string, { path: string; label: string }> = {
  nba: { path: "basketball/nba", label: "NBA" }, nfl: { path: "football/nfl", label: "NFL" }, mlb: { path: "baseball/mlb", label: "MLB" },
  nhl: { path: "hockey/nhl", label: "NHL" }, wnba: { path: "basketball/wnba", label: "WNBA" }, ncaaf: { path: "football/college-football", label: "NCAAF" },
  ncaam: { path: "basketball/mens-college-basketball", label: "NCAAM" }, mls: { path: "soccer/usa.1", label: "MLS" }, epl: { path: "soccer/eng.1", label: "Premier League" },
  ucl: { path: "soccer/uefa.champions", label: "Champions League" },
};
const INDEX_NAMES: Record<string, string> = { "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow", "^RUT": "Russell 2000", "^VIX": "VIX" };

export async function getConfig(): Promise<PulseConfig> {
  try { const j = JSON.parse(await fs.readFile(FILE, "utf8")); return { ...DEFAULTS, ...j, alerts: { ...DEFAULTS.alerts, ...(j.alerts ?? {}) } }; } catch { return { ...DEFAULTS, alerts: { ...DEFAULTS.alerts } }; }
}
const list = (v: unknown, re: RegExp, max: number) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => re.test(x)).slice(0, max);
export async function saveConfig(b: Partial<PulseConfig>): Promise<PulseConfig> {
  const cur = await getConfig();
  const next: PulseConfig = {
    symbols: b.symbols ? list(b.symbols.map((s) => String(s).toUpperCase()), /^[\^A-Z0-9.\-=]{1,12}$/, 12) : cur.symbols,
    crypto: b.crypto ? list(b.crypto.map((s) => String(s).toLowerCase()), /^[a-z0-9\-]{2,40}$/, 6) : cur.crypto,
    leagues: b.leagues ? list(b.leagues, /^[a-z]+$/, 6).filter((l) => LEAGUES[l]) : cur.leagues,
    teams: b.teams ? list(b.teams, /^[\w .'&\-]{2,30}$/, 8) : cur.teams,
    city: typeof b.city === "string" ? b.city.trim().slice(0, 60) : cur.city,
    topics: b.topics ? list(b.topics, /^[\w .'&\-]{2,40}$/, 10) : cur.topics,
    alerts: { scores: b.alerts?.scores ?? cur.alerts.scores, stocks: b.alerts?.stocks ?? cur.alerts.stocks, stockPct: Math.min(25, Math.max(1, Number(b.alerts?.stockPct ?? cur.alerts.stockPct) || 5)), breaking: b.alerts?.breaking ?? cur.alerts.breaking },
  };
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// ---- tiny TTL cache that also shares in-flight requests
const memo = new Map<string, { at: number; v: unknown; p?: Promise<unknown> }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  if (hit?.p) return hit.p as Promise<T>;
  const p = fn().then((v) => { memo.set(key, { at: Date.now(), v }); return v; }, (e) => { if (hit) memo.set(key, { at: Date.now() - ttl + 5000, v: hit.v }); if (!hit) memo.delete(key); throw e; });
  memo.set(key, { at: hit?.at ?? 0, v: hit?.v, p });
  return p;
}
async function get(url: string, ms = 5000): Promise<Response> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r;
}

// ---- stocks + crypto
export interface Quote { sym: string; label: string; price: number; change: number; pct: number; kind: "stock" | "index" | "crypto"; open?: boolean }
export async function stock(sym: string): Promise<Quote | null> {
  try {
    const j = (await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`)).json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; marketState?: string; shortName?: string } }[] } };
    const m = j.chart?.result?.[0]?.meta;
    const price = m?.regularMarketPrice, prev = m?.chartPreviousClose ?? m?.previousClose;
    if (typeof price !== "number" || typeof prev !== "number" || !prev) return null;
    return { sym, label: INDEX_NAMES[sym] ?? sym.replace(/^\^/, ""), price, change: price - prev, pct: ((price - prev) / prev) * 100, kind: sym.startsWith("^") ? "index" : "stock" };
  } catch { return null; }
}
async function coins(ids: string[]): Promise<Quote[]> {
  if (!ids.length) return [];
  try {
    const j = (await (await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`)).json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
    const SYM: Record<string, string> = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL", dogecoin: "DOGE", ripple: "XRP", cardano: "ADA" };
    return ids.flatMap((id) => {
      const c = j[id]; if (typeof c?.usd !== "number") return [];
      const pct = c.usd_24h_change ?? 0;
      return [{ sym: SYM[id] ?? id.toUpperCase(), label: SYM[id] ?? id, price: c.usd, change: c.usd - c.usd / (1 + pct / 100), pct, kind: "crypto" as const }];
    });
  } catch { return []; }
}
async function quotes(cfg: PulseConfig): Promise<Quote[]> {
  const [s, c] = await Promise.all([
    cached(`q:${cfg.symbols.join(",")}`, 30_000, async () => (await Promise.all(cfg.symbols.map(stock))).filter((x): x is Quote => !!x)),
    cached(`c:${cfg.crypto.join(",")}`, 45_000, () => coins(cfg.crypto)),
  ]);
  return [...s, ...c];
}

// ---- sports
export interface Score { id: string; league: string; state: "pre" | "in" | "post"; detail: string; away: { abbr: string; name: string; score: string; win?: boolean; logo?: string }; home: { abbr: string; name: string; score: string; win?: boolean; logo?: string }; url?: string; at: string }
type Comp = { team?: { abbreviation?: string; displayName?: string; shortDisplayName?: string; logo?: string }; score?: string; homeAway?: string; winner?: boolean };
export async function league(key: string): Promise<Score[]> {
  const L = LEAGUES[key]; if (!L) return [];
  try {
    const j = (await (await get(`https://site.api.espn.com/apis/site/v2/sports/${L.path}/scoreboard`)).json()) as { events?: { id: string; date: string; links?: { href?: string; rel?: string[] }[]; status?: { type?: { state?: string; shortDetail?: string } }; competitions?: { competitors?: Comp[] }[] }[] };
    return (j.events ?? []).flatMap((e): Score[] => {
      const cs = e.competitions?.[0]?.competitors ?? [];
      const h = cs.find((c) => c.homeAway === "home"), a = cs.find((c) => c.homeAway === "away");
      if (!h || !a) return [];
      const state = (e.status?.type?.state as Score["state"]) ?? "pre";
      const side = (c: Comp) => ({ abbr: c.team?.abbreviation ?? "?", name: c.team?.displayName ?? c.team?.shortDisplayName ?? "", score: c.score ?? "", win: c.winner, logo: c.team?.logo });
      return [{ id: `${key}:${e.id}`, league: L.label, state, detail: e.status?.type?.shortDetail ?? "", away: side(a), home: side(h), url: e.links?.find((l) => l.rel?.includes("summary") || l.rel?.includes("desktop"))?.href, at: e.date }];
    });
  } catch { return []; }
}
async function scores(cfg: PulseConfig): Promise<Score[]> {
  const all = (await Promise.all(cfg.leagues.map((l) => cached(`s:${l}`, 30_000, () => league(l))))).flat();
  const teams = cfg.teams.map((t) => t.toLowerCase());
  const mine = (s: Score) => teams.some((t) => [s.home.name, s.away.name, s.home.abbr, s.away.abbr].some((n) => n.toLowerCase().includes(t)));
  const rank = (s: Score) => (mine(s) ? 0 : 10) + (s.state === "in" ? 0 : s.state === "pre" ? 1 : 2);
  const today = Date.now() - 18 * 3600_000, soon = Date.now() + 30 * 3600_000;
  return all.filter((s) => mine(s) || (new Date(s.at).getTime() > today && new Date(s.at).getTime() < soon))
    .sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at)).slice(0, 14);
}

// ---- weather
export interface Weather { city: string; temp: number; label: string; icon: string; high?: number; low?: number }
const WMO: [number[], string, string][] = [[[0], "Clear", "☀️"], [[1, 2], "Partly cloudy", "⛅"], [[3], "Cloudy", "☁️"], [[45, 48], "Fog", "🌫️"], [[51, 53, 55, 56, 57], "Drizzle", "🌦️"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "Rain", "🌧️"], [[71, 73, 75, 77, 85, 86], "Snow", "❄️"], [[95, 96, 99], "Thunderstorm", "⛈️"]];
async function weather(city: string): Promise<Weather | null> {
  if (!city) return null;
  return cached(`w:${city.toLowerCase()}`, 15 * 60_000, async () => {
    try {
      const g = (await (await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)).json()) as { results?: { name: string; latitude: number; longitude: number; country_code?: string; admin1?: string }[] };
      const p = g.results?.[0]; if (!p) return null;
      const us = p.country_code === "US";
      const w = (await (await get(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1${us ? "&temperature_unit=fahrenheit" : ""}`)).json()) as { current?: { temperature_2m?: number; weather_code?: number }; daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] } };
      const code = w.current?.weather_code ?? 0, hit = WMO.find(([cs]) => cs.includes(code)) ?? WMO[0];
      if (typeof w.current?.temperature_2m !== "number") return null;
      return { city: p.name, temp: Math.round(w.current.temperature_2m), label: hit[1], icon: hit[2], high: w.daily?.temperature_2m_max?.[0] === undefined ? undefined : Math.round(w.daily.temperature_2m_max[0]), low: w.daily?.temperature_2m_min?.[0] === undefined ? undefined : Math.round(w.daily.temperature_2m_min[0]) };
    } catch { return null; }
  }).catch(() => null);
}

// ---- headlines
export interface Headline { title: string; url: string; site: string; at: string; thumb?: string }
const FEEDS: [string, string][] = [["BBC News", "https://feeds.bbci.co.uk/news/rss.xml"], ["NPR", "https://feeds.npr.org/1001/rss.xml"], ["The Guardian", "https://www.theguardian.com/world/rss"]];
const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
async function feed([site, url]: [string, string]): Promise<Headline[]> {
  try {
    const xml = await (await get(url)).text();
    return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].slice(0, 12).flatMap((m): Headline[] => {
      const t = m[0], title = unxml(t.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""), link = unxml(t.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ""), d = unxml(t.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
      const at = new Date(d); if (!title || !/^https?:\/\//.test(link) || isNaN(at.getTime())) return [];
      const imgs = [...t.matchAll(/<media:(?:thumbnail|content)\b[^>]*\burl="([^"]+)"[^>]*>/g)].map((x) => x[1]).filter((u) => /^https:\/\/.+\.(jpe?g|png|webp)|^https:\/\/.*(ichef|npr|guim)/i.test(u));
      return [{ title, url: link.replace(/\?at_.*$/, ""), site, at: at.toISOString(), thumb: imgs[imgs.length - 1]?.replace(/\/standard\/\d+\//, "/standard/480/") }];
    });
  } catch { return []; }
}
export const cachedLeague = (key: string) => cached(`s:${key}`, 30_000, () => league(key));
export async function headlines(): Promise<Headline[]> {
  return cached("news", 4 * 60_000, async () => {
    const all = (await Promise.all(FEEDS.map(feed))).flat().sort((a, b) => b.at.localeCompare(a.at));
    const seen = new Set<string>();
    return all.filter((h) => { const k = h.title.toLowerCase().slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 24);
  }).catch(() => [] as Headline[]);
}


// ---- breaking news: group the same story across outlets, remember a week, follow topics
export interface Story { key: string; title: string; url: string; sites: string[]; at: string; first: string; topic?: string; breaking: boolean; score: number }
/** Publisher-provided RSS feeds. [name, address]. The first three also feed the plain headline list. */
const MORE_FEEDS: [string, string][] = [
  ["The New York Times", "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"], ["Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"], ["CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"],
  ["BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"], ["BBC Tech", "https://feeds.bbci.co.uk/news/technology/rss.xml"], ["TechCrunch", "https://techcrunch.com/feed/"],
  ["FAA", "https://www.faa.gov/rss.xml"], ["NVIDIA", "https://blogs.nvidia.com/feed/"],
];
const STORE = path.join(MARIGOLD_DIR, "pulse-news.json");
interface Seen { title: string; url: string; site: string; at: string; first: string }
const BREAKING_WORDS = /\b(breaking|just in|developing|live updates?|urgent|alert|emergency|grounded|ground stop|evacuat\w*|explosion|earthquake|resigns?|dies|killed)\b/i;
const STOP = new Set("with from that this have will what when their about after over into more than they says said amid".split(" "));
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
export const sameStory = (a: string, b: string) => { const x = words(a), y = words(b); const small = Math.min(x.size, y.size); if (!small) return false; let n = 0; for (const w of x) if (y.has(w)) n++; return n >= 3 || (n >= 2 && n / small >= 0.6); };
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const topicHit = (title: string, topics: string[]) => topics.find((t) => new RegExp(`\\b${esc(t)}\\b`, "i").test(title));

async function loadSeen(): Promise<Record<string, Seen>> { try { return JSON.parse(await fs.readFile(STORE, "utf8")); } catch { return {}; } }
async function everything(): Promise<Headline[]> {
  return cached("news-all", 4 * 60_000, async () => {
    const all = (await Promise.all([...FEEDS, ...MORE_FEEDS].map(feed))).flat();
    const store = await loadSeen(); const cutoff = Date.now() - 8 * 86_400_000; const now = new Date().toISOString();
    for (const h of all) { const k = h.url.replace(/[?#].*$/, ""); store[k] = { title: h.title, url: h.url, site: h.site, at: h.at, first: store[k]?.first ?? now }; }
    for (const k of Object.keys(store)) if (Date.parse(store[k].at) < cutoff) delete store[k];
    await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 }).catch(() => {});
    await fs.writeFile(STORE, JSON.stringify(store), { mode: 0o600 }).catch(() => {});
    return all;
  }).catch(() => [] as Headline[]);
}

/** Group what outlets have published into stories (newest first), scoring each by how many outlets carry it, how fresh it is, and your topics. */
export function groupStories(items: Seen[], topics: string[], now = Date.now()): Story[] {
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
  const clusters: { items: Seen[] }[] = [];
  for (const it of sorted) { const c = clusters.find((x) => x.items.some((y) => y.site === it.site ? y.title === it.title : sameStory(y.title, it.title))); if (c) c.items.push(it); else clusters.push({ items: [it] }); }
  return clusters.map((c): Story => {
    const lead = c.items[0], sites = [...new Set(c.items.map((i) => i.site))];
    const topic = c.items.map((i) => topicHit(i.title, topics)).find(Boolean);
    const ageH = (now - Date.parse(lead.at)) / 3600_000;
    const word = c.items.some((i) => BREAKING_WORDS.test(i.title));
    const breaking = ageH < 8 && (sites.length >= 3 || (sites.length >= 2 && word) || (!!topic && word));
    const score = sites.length * 3 + (word ? 3 : 0) + (ageH < 3 ? 2 : ageH < 12 ? 1 : 0) + (topic ? 4 : 0);
    return { key: lead.url.replace(/[?#].*$/, ""), title: lead.title, url: lead.url, sites, at: lead.at, first: c.items.map((i) => i.first).sort()[0] ?? lead.at, topic, breaking, score };
  });
}

export interface BreakingNews { now: Story[]; topics: Story[]; day: Story[]; week: Story[] }
export async function breaking(cfg: PulseConfig, now = Date.now()): Promise<BreakingNews> {
  await everything();
  const store = Object.values(await loadSeen());
  const within = (ms: number) => store.filter((i) => now - Date.parse(i.at) < ms);
  const top = (xs: Story[], n: number) => xs.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at)).slice(0, n);
  const day = groupStories(within(24 * 3600_000), cfg.topics, now), week = groupStories(within(7 * 86_400_000), cfg.topics, now);
  return {
    now: top(day.filter((x) => x.breaking), 4),
    topics: day.filter((x) => x.topic).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6),
    day: top(day.filter((x) => x.sites.length >= 2 || x.topic), 6),
    week: top(week.filter((x) => x.sites.length >= 2 || x.topic), 8),
  };
}

export async function pulse() {
  const cfg = await getConfig();
  const [q, s, w, n, b] = await Promise.all([quotes(cfg).catch(() => []), scores(cfg).catch(() => []), weather(cfg.city), headlines(), breaking(cfg).catch(() => ({ now: [], topics: [], day: [], week: [] }) as BreakingNews)]);
  return { at: new Date().toISOString(), quotes: q, scores: s, weather: w, news: n, breaking: b, config: cfg, leagues: Object.fromEntries(Object.entries(LEAGUES).map(([k, v]) => [k, v.label])) };
}

/** Lower-case team names (and last words) from the scoreboards fetched so far, so a search for "warriors" can find the game. */
export function teamNames(): string[] {
  const out = new Set<string>();
  for (const [k, v] of memo) {
    if (!k.startsWith("s:") || !Array.isArray(v.v)) continue;
    for (const g of v.v as Score[]) for (const n of [g.home.name, g.away.name]) { const l = n.toLowerCase(); if (l) { out.add(l); const last = l.split(" ").pop(); if (last && last.length >= 4) out.add(last); } }
  }
  return [...out];
}

// ---- alerts: the watcher calls this every couple of minutes (inside the Mac app)
const dayKey = () => new Date().toISOString().slice(0, 10);
export async function pulseAlerts(): Promise<void> {
  const cfg = await getConfig();
  const { ping } = await import("./notifications");
  if (cfg.alerts.scores && cfg.teams.length) {
    const teams = cfg.teams.map((t) => t.toLowerCase());
    const games = (await Promise.all(cfg.leagues.map((l) => cachedLeague(l).catch(() => [] as Score[])))).flat()
      .filter((g) => [g.home.name, g.away.name, g.home.abbr, g.away.abbr].some((n) => teams.some((t) => n.toLowerCase().includes(t))));
    for (const g of games) {
      const started = Date.parse(g.at);
      const line = `${g.away.abbr} ${g.away.score} – ${g.home.abbr} ${g.home.score}`;
      if (g.state === "in") await ping({ kind: "pulse", key: `pulse:game:${g.id}:in`, title: `${g.away.name} at ${g.home.name} is on`, body: `${line} · ${g.detail}`, url: g.url });
      if (g.state === "post" && Date.now() - started < 9 * 3600_000) {
        const winner = g.home.win ? g.home : g.away.win ? g.away : null;
        await ping({ kind: "pulse", key: `pulse:game:${g.id}:post`, title: winner ? `Final: ${winner.name} win` : "Final", body: `${g.away.name} ${g.away.score}, ${g.home.name} ${g.home.score}`, url: g.url });
      }
    }
  }
  if (cfg.alerts.breaking) {
    const b = await breaking(cfg).catch(() => null);
    let sent = 0;
    for (const x of b?.now ?? []) { if (sent >= 3 || Date.now() - Date.parse(x.at) > 6 * 3600_000) continue; if (await ping({ kind: "pulse", key: `pulse:breaking:${x.key}`, title: `Breaking: ${x.title}`.slice(0, 80), body: `${x.sites.length} outlets are reporting this (${x.sites.slice(0, 3).join(", ")}).`, url: x.url, urgent: true })) sent++; }
    for (const x of b?.topics ?? []) { if (sent >= 5 || Date.now() - Date.parse(x.at) > 3 * 3600_000) continue; if (await ping({ kind: "pulse", key: `pulse:topic:${x.topic}:${x.key}`, title: `${x.topic}: ${x.title}`.slice(0, 80), body: `From ${x.sites.slice(0, 3).join(", ")}.`, url: x.url })) sent++; }
  }
  if (cfg.alerts.stocks) {
    for (const q of await quotes(cfg).catch(() => [] as Quote[])) {
      const limit = q.kind === "index" ? Math.min(2, cfg.alerts.stockPct) : q.kind === "crypto" ? cfg.alerts.stockPct * 1.5 : cfg.alerts.stockPct;
      if (Math.abs(q.pct) < limit) continue;
      await ping({ kind: "pulse", key: `pulse:${q.sym}:${dayKey()}:${q.pct > 0 ? "up" : "down"}`, title: `${q.label} is ${q.pct > 0 ? "up" : "down"} ${Math.abs(q.pct).toFixed(1)}% today`, body: `Now ${q.price >= 1000 ? q.price.toFixed(0) : q.price.toFixed(2)}. Tap to look.`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(q.sym)}` });
    }
  }
}
