import { Agent as UndiciAgent, fetch as ufetch } from "undici";

/**
 * Quick answers without the agent:
 *  • answerDirect — the model replies from its own knowledge (no tools).
 *  • answerFromWeb — searches Marigold's open sources (or a search key someone added), and the model answers
 *    from those results, naming its sources. No search engine's page is scraped and no browser tab is opened.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const ollama = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });
/** Read a page in a background tab of the Marigold Browser (real Chrome, so JavaScript-built
 *  content like live scores shows up). Falls back to a plain fetch. */
async function readPage(url: string): Promise<string> {
  // Plain download only — browser automation is paused, so no Marigold Browser tabs.
  try {
    const html = await (await fetch(url, { headers: { "User-Agent": "Marigold/1.0 (personal assistant)" }, signal: AbortSignal.timeout(8000) })).text();
    return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  } catch { return ""; }
}

const clean = (t: string) => t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** No Brave key: answer from Wikipedia (open content). Never a search engine's page. */
async function openSources(query: string): Promise<{ text: string; source: string } | null> {
  const { webSearch } = await import("./web-search");
  const o = await webSearch(query, 0, { wiki: true }).catch(() => null);
  if (!o?.web.length) return null;
  const pages = await Promise.all(o.web.slice(0, 2).map(async (h) => {
    const t = clean(await readPage(h.url));
    return t ? `From ${h.site}:\n${t.slice(0, 3500)}` : "";
  }));
  return { text: `${o.web.map((h) => `• ${h.title} (${h.site}): ${h.snippet}`).join("\n")}\n\n${pages.filter(Boolean).join("\n\n")}`.slice(0, 9000), source: "Wikipedia" };
}

/** Stream a reply from the model with a short prompt (no tools). */
export { stream as streamText };
async function* stream(system: string, history: { role: string; content: string; cloudImages?: string[] }[], signal: AbortSignal): AsyncGenerator<string> {
  // Cloud "always" mode (e.g. Abacus RouteLLM): the strongest model answers; local if it fails.
  const { cloudAll, cloudStream } = await import("./cloud");
  if (await cloudAll()) {
    let any = false;
    try {
      const { answerTier, modelFor } = await import("./cloud");
      const lastQ = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
      const tier = history.some((m) => m.cloudImages?.length) ? "standard" : answerTier(lastQ.replace(/\[attached:[^\]]*\]\s*/g, ""));
      for await (const t of cloudStream(system, history.slice(-10).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content, cloudImages: m.cloudImages })), signal, 1200, modelFor(tier))) { any = true; yield t; }
      if (any) return;
    } catch { if (any) return; /* fall back to local */ }
  }
  const res = await ufetch(`${OLLAMA_URL}/api/chat`, {
    dispatcher: ollama,
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-oss:20b", stream: true, think: "low", keep_alive: "60m",
      options: { temperature: 0.5, num_ctx: 16384, num_predict: 1500 },
      messages: [{ role: "system", content: system }, ...history.slice(-10)],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      const c = JSON.parse(l).message?.content;
      if (c) yield c;
    }
  }
}

const now = () => new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

export async function* answerDirect(persona: string, history: { role: string; content: string; cloudImages?: string[] }[], signal: AbortSignal) {
  yield* stream(`${persona}\nIt is ${now()}. Answer the user directly and concisely from your own knowledge. Don't mention tools. If the answer depends on recent events after your training, say it may be out of date.`, history, signal);
}

export async function* answerFromWeb(persona: string, query: string, history: { role: string; content: string }[], signal: AbortSignal) {
  // "last / latest / current / most recent" → search for this year's answer, not an old page.
  const year = new Date().getFullYear();
  // Check the user's own words too — the router may have rewritten "last Super Bowl" as "Super Bowl winner".
  const userText = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const recent = /\b(last|latest|current|most recent|recent|newest|this (year|season|week)|today|now|right now|live|who won)\b/i.test(`${query} ${userText}`) && !new RegExp(`\\b${year}\\b`).test(query);
  const q = recent ? `${query} ${year}` : query;
  // A licensed search key if someone added one; otherwise Marigold's open sources.
  const { licensedResults } = await import("./summarize");
  const found = (await licensedResults(q).catch(() => null)) ?? (await openSources(q));
  console.info(`[marigold] lookup "${q}" → ${found ? `${found.text.length} chars from ${found.source}` : "nothing"}`);
  if (!found) {
    yield* stream(`${persona}\nIt is ${now()}. You could not reach the internet just now. Answer from your knowledge if you reliably can and say it may be out of date; otherwise say you couldn't look it up.`, history, signal);
    return;
  }
  if (/\b(sources?|citations?|references?|articles?|studies|study|papers?|journals?|evidence|bibliograph\w*)\b/i.test(userText)) {
    // Asking for a source: suggest good ones right away (that IS the answer; nobody needs a page opened and read).
    yield* stream(
      `${persona}\nIt is ${now()}. The user wants SOURCES for their work. Give 3 to 5 solid, relevant sources, each on its own line: title, who published it, one line on what it covers and why it is credible. ` +
        `Use the web results below for the ones they contain (include those links as plain URLs). You may also name well-known authoritative sources you are sure exist (textbooks, journals, encyclopedias, .gov/.edu/.org pages) WITHOUT inventing URLs for them; for those say "search the title" . Never make up authors, titles or links. Finish with one short line on how to cite (MLA/APA) only if they asked.\n\nWEB RESULTS for “${query}”:\n${found.text.slice(0, 6000)}`,
      history,
      signal,
    );
    return;
  }
  yield* stream(
    `${persona}\nIt is ${now()}. Answer the user's question using ONLY these fresh ${found.source} results for “${query}”. Be concise (1–4 sentences unless they asked for detail). ` +
      `Report live things exactly as shown — if a game/event is still in progress say so (e.g. "Q3 8:17, Warriors lead 64–61"), never call it won/final unless the results say Final. ` +
      `“Last/latest/current” means the most recent one as of today's date above — check the dates in the results and use the newest; if nothing in the results is recent enough, say so plainly instead of giving an older answer. End with "Source: <site names>". If the results don't contain the answer, say so.\n\n--- RESULTS ---\n${found.text}\n--- END ---`,
    history,
    signal,
  );
}
