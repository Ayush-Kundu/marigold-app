import { execFile } from "child_process";
import { promisify } from "util";

/**
 * An OPTIONAL licensed source for the chat's live answers (scores, news, "what's the latest…").
 * With a Brave Search API key in the Keychain, lookups use Brave's results plus the top pages that
 * allow it (robots.txt and "noai" respected, paywalls skipped, nothing stored). Without a key,
 * lookups fall back to reading DuckDuckGo's page. The browser itself doesn't use this: searches
 * there just open Google's own results page.
 */

const exec = promisify(execFile);
const UA = "Marigold/1.0 (desktop assistant; fetches pages only when its user asks)";
const KEYCHAIN = ["-s", "Marigold Brave Search", "-a", "marigold"];

interface Source { n: number; title: string; url: string; site: string; snippet: string }

let keyCache: string | null | undefined;
/**
 * The search key, in order: one the user saved on this Mac (Keychain) → one shipped inside the app
 * (Resources/brave-key.txt, from build-secrets/brave-key.txt at build time) → the MARIGOLD_BRAVE_KEY variable.
 * With a shipped key, no user ever sees a key prompt.
 */
export async function braveKey(): Promise<string | null> {
  if (keyCache !== undefined) return keyCache;
  let k = await exec("security", ["find-generic-password", ...KEYCHAIN, "-w"]).then((r) => r.stdout.trim() || null, () => null);
  if (!k && process.env.MARIGOLD_RESOURCES) {
    try { k = (await (await import("fs")).promises.readFile(`${process.env.MARIGOLD_RESOURCES}/brave-key.txt`, "utf8")).trim() || null; } catch { /* none shipped */ }
  }
  keyCache = k ?? process.env.MARIGOLD_BRAVE_KEY?.trim() ?? null;
  return keyCache;
}
export async function saveBraveKey(key: string | null) {
  if (key) await exec("security", ["add-generic-password", ...KEYCHAIN, "-w", key.trim(), "-U"]);
  else await exec("security", ["delete-generic-password", ...KEYCHAIN]).catch(() => {});
  keyCache = undefined;
}

const TAVILY_CHAIN = ["-s", "Marigold Tavily Search", "-a", "marigold"];
let tavilyCache: string | null | undefined;
/** A Tavily search key (free plan: 1,000 credits a month, no card), kept in the Keychain. */
export async function tavilyKey(): Promise<string | null> {
  if (tavilyCache !== undefined) return tavilyCache;
  tavilyCache = (await exec("security", ["find-generic-password", ...TAVILY_CHAIN, "-w"]).then((r) => r.stdout.trim() || null, () => null)) ?? process.env.MARIGOLD_TAVILY_KEY?.trim() ?? null;
  return tavilyCache;
}
export async function saveTavilyKey(key: string | null) {
  if (key) await exec("security", ["add-generic-password", ...TAVILY_CHAIN, "-w", key.trim(), "-U"]);
  else await exec("security", ["delete-generic-password", ...TAVILY_CHAIN]).catch(() => {});
  tavilyCache = undefined;
}

const site = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

async function braveSearch(q: string, key: string): Promise<Source[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6&safesearch=moderate`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Brave Search ${r.status}`);
  const j = (await r.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (j.web?.results ?? []).slice(0, 6).map((x, i) => ({ n: i + 1, title: strip(x.title), url: x.url, site: site(x.url), snippet: strip(x.description ?? "") }));
}

// ---------------------------------------------------------------- polite page fetching

const robotsCache = new Map<string, { at: number; rules: { agent: string; disallow: string[]; allow: string[] }[] }>();
async function robotsAllows(u: URL): Promise<boolean> {
  const key = u.origin;
  let hit = robotsCache.get(key);
  if (!hit || Date.now() - hit.at > 3_600_000) {
    const txt = await fetch(`${u.origin}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.text() : ""), () => "");
    const rules: { agent: string; disallow: string[]; allow: string[] }[] = [];
    let cur: (typeof rules)[number] | null = null;
    for (const raw of txt.split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k)) { cur = { agent: v.toLowerCase(), disallow: [], allow: [] }; rules.push(cur); }
      else if (cur && /^disallow$/i.test(k) && v) cur.disallow.push(v);
      else if (cur && /^allow$/i.test(k) && v) cur.allow.push(v);
    }
    hit = { at: Date.now(), rules };
    robotsCache.set(key, hit);
  }
  // Rules for us, for AI fetchers in general, or for everyone.
  const groups = hit.rules.filter((r) => r.agent === "marigold" || r.agent === "*");
  const path = u.pathname + u.search;
  const longest = (list: string[]) => Math.max(-1, ...list.filter((p) => path.startsWith(p.replace(/\*.*$/, ""))).map((p) => p.length));
  for (const g of groups) if (longest(g.disallow) > longest(g.allow)) return false;
  return true;
}

/** Readable text of a page, or null if the site says no (robots / noai) or it's paywalled. */
export async function fetchAllowed(url: string): Promise<string | null> {
  return (await fetchPage(url))?.text ?? null;
}

/** Same, plus the page's own preview image (og:image) and title — only for pages whose site allows it. */
export async function fetchPage(url: string): Promise<{ text: string; image?: string; title?: string } | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !(await robotsAllows(u))) return null;
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r || !r.ok || !(r.headers.get("content-type") ?? "").includes("html")) return null;
  if (/\b(noai|noimageai|none)\b/i.test(r.headers.get("x-robots-tag") ?? "")) return null;
  const html = (await r.text()).slice(0, 1_500_000);
  if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*\b(noai|none)\b/i.test(html)) return null;
  if (/subscribe to (continue|read)|create a free account to (continue|read)|you've reached your (free )?article limit|paywall/i.test(html.slice(0, 200_000))) return null;
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ").trim();
  if (text.length <= 300) return null;
  const meta = (name: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"))?.[1];
  const img = meta("og:image") ?? meta("twitter:image");
  let image: string | undefined;
  try { image = img ? new URL(img.replace(/&amp;/g, "&"), u).toString() : undefined; } catch { /* bad url */ }
  return { text: text.slice(0, 6000), image, title: (meta("og:title") ?? html.match(/<title[^>]*>([^<]+)</i)?.[1] ?? "").replace(/&amp;/g, "&").trim() || undefined };
}

/** For chat lookups: results from Brave (licensed) + the top pages that allow it. null without a key. */
export async function licensedResults(q: string): Promise<{ text: string; source: string } | null> {
  const key = await braveKey();
  if (!key) return null;
  const hits = await braveSearch(q, key).catch(() => [] as Source[]);
  if (!hits.length) return null;
  const pages = await Promise.all(hits.slice(0, 2).map(async (h) => { const t = await fetchAllowed(h.url).catch(() => null); return t ? `From ${h.site}:\n${t}` : ""; }));
  return { text: `${hits.map((h) => `• ${h.title} (${h.site}): ${h.snippet}`).join("\n")}\n\n${pages.filter(Boolean).join("\n\n")}`.slice(0, 9000), source: "Brave Search + the top pages" };
}
