/**
 * Reading a video link, the way a person who can't watch it would: the title, channel, description, chapters and the full
 * transcript (the video's own captions, with timestamps). Marigold can't see or hear the video itself.
 * It reads ONLY the link the user gave it, once, as a normal page visit with Marigold's own User-Agent.
 * The parsing is separate from the fetching so it can be checked without the network.
 */

const UA = "Marigold/1.0 (desktop assistant; reads a video page when its user shares the link)";
const MAX_TRANSCRIPT = 40_000;

export function youtubeId(link: string): string | null {
  try {
    const u = new URL(link.trim());
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    let id: string | null = null;
    if (h === "youtu.be") id = u.pathname.slice(1).split("/")[0] || null;
    else if (h === "youtube.com" || h === "youtube-nocookie.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else id = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1] ?? null;
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

/** The JSON object that follows `marker` in a page (balanced braces, string-aware). */
export function extractJson(html: string, marker: string): unknown | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at + marker.length);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

interface Track { baseUrl?: string; languageCode?: string; kind?: string; name?: { simpleText?: string } }
export interface Player {
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string; shortDescription?: string; viewCount?: string };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
}

/** The best caption track: English by a person, then English automatic, then whatever comes first. */
export function pickTrack(tracks: Track[]): Track | null {
  if (!tracks.length) return null;
  const en = (t: Track) => /^en/i.test(t.languageCode ?? "");
  return tracks.find((t) => en(t) && t.kind !== "asr") ?? tracks.find(en) ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
}

const stamp = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** YouTube's caption JSON ("json3") → timestamped paragraphs of about 20 seconds each. */
export function captionsToText(json: unknown): string {
  const events = ((json as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] })?.events ?? []).filter((e) => e.segs?.length);
  const lines: string[] = [];
  let bucketStart = -1, buf = "";
  for (const e of events) {
    const t = e.tStartMs ?? 0;
    const text = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (bucketStart < 0) bucketStart = t;
    if (t - bucketStart > 20_000 && buf) { lines.push(`[${stamp(bucketStart)}] ${buf.trim()}`); bucketStart = t; buf = ""; }
    buf += ` ${text}`;
  }
  if (buf.trim()) lines.push(`[${stamp(Math.max(0, bucketStart))}] ${buf.trim()}`);
  return lines.join("\n");
}

/** Lines of the description that look like chapters ("0:00 Intro"). */
export function chapters(description: string): string[] {
  return description.split("\n").map((l) => l.trim()).filter((l) => /^(\d{1,2}:)?\d{1,2}:\d{2}\s+\S/.test(l)).slice(0, 40);
}

const fmtLen = (secs?: string) => { const n = Number(secs); return Number.isFinite(n) && n > 0 ? stamp(n * 1000) : ""; };

async function get(url: string, ms = 12_000): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(ms), redirect: "follow" });
}

async function readYoutube(id: string): Promise<string> {
  const page = await get(`https://www.youtube.com/watch?v=${id}&hl=en`).catch((e) => { throw new Error(`couldn't reach YouTube (${(e as Error).cause ? ((e as { cause?: { code?: string } }).cause?.code ?? "network") : "network"}). It may be blocked on this Mac or network.`); });
  if (!page.ok) throw new Error(`YouTube answered ${page.status}`);
  const html = await page.text();
  const player = extractJson(html, "ytInitialPlayerResponse") as Player | null;
  if (!player?.videoDetails) throw new Error("couldn't read that video's page (it may be private, age-restricted, or YouTube showed a consent page)");
  const d = player.videoDetails;
  const desc = (d.shortDescription ?? "").trim();
  const ch = chapters(desc);
  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  let transcript = "", how = "";
  if (track?.baseUrl) {
    const r = await get(`${track.baseUrl}${track.baseUrl.includes("?") ? "&" : "?"}fmt=json3`).catch(() => null);
    const j = r?.ok ? await r.json().catch(() => null) : null;
    transcript = j ? captionsToText(j) : "";
    how = `${track.kind === "asr" ? "automatic" : "written"} captions, ${track.name?.simpleText ?? track.languageCode ?? "language unknown"}`;
  }
  const head = [
    `Title: ${d.title ?? "(unknown)"}`,
    `Channel: ${d.author ?? "(unknown)"}${fmtLen(d.lengthSeconds) ? ` · Length: ${fmtLen(d.lengthSeconds)}` : ""}${player.microformat?.playerMicroformatRenderer?.publishDate ? ` · Published: ${player.microformat.playerMicroformatRenderer.publishDate}` : ""}`,
    desc ? `Description: ${desc.slice(0, 1800)}` : "",
    ch.length ? `Chapters:\n${ch.join("\n")}` : "",
  ].filter(Boolean).join("\n");
  if (!transcript) return `${head}\n\nThis video has no captions Marigold could read, so there is no transcript. Say so, and work only from the title, description and chapters.`;
  const body = transcript.length > MAX_TRANSCRIPT ? `${transcript.slice(0, MAX_TRANSCRIPT)}\n[transcript cut here: it is longer than Marigold reads at once]` : transcript;
  return `${head}\n\nTranscript (${how}):\n${body}\n\nNote: this is the transcript only. You cannot see the video, so do not claim to have seen gestures, slides, scenery or on-screen text.`;
}

const meta = (html: string, prop: string) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i")) ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"));
  return m?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() ?? "";
};

/** Any other video link: what its page says about it (title, description). No transcript. */
async function readOther(link: string): Promise<string> {
  const r = await get(link).catch(() => null);
  if (!r?.ok) throw new Error(`couldn't open that link${r ? ` (${r.status})` : ""}`);
  const html = (await r.text()).slice(0, 400_000);
  const title = meta(html, "og:title") || html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || "";
  const desc = meta(html, "og:description") || meta(html, "description");
  if (!title && !desc) throw new Error("that page doesn't describe a video Marigold can read");
  return `Title: ${title || "(unknown)"}\nSite: ${new URL(link).hostname.replace(/^www\./, "")}${desc ? `\nDescription: ${desc.slice(0, 1800)}` : ""}\n\nMarigold can only read the page's own title and description for this site, not a transcript. You cannot see or hear the video: say so, and don't invent what happens in it.`;
}

export async function readVideo(link: string): Promise<string> {
  if (!/^https?:\/\//i.test(link)) return "FAILED: give a video link that starts with https://";
  try {
    const id = youtubeId(link);
    return id ? await readYoutube(id) : await readOther(link);
  } catch (e) { return `FAILED: ${(e as Error).message}. Tell the user plainly, and offer to work from their own notes or a transcript they paste.`; }
}
