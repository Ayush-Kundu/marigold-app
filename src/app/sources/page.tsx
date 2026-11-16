import type { Metadata } from "next";
import licenses from "@/data/licenses.json";

export const metadata: Metadata = { title: "Sources and licenses - Marigold" };

type Source = { name: string; what: string; terms: string; url: string };

const SOURCES: Source[] = [
  { name: "Wikipedia, Wikivoyage, Wikidata and Wikimedia Commons", what: "Articles, travel guides, facts and pictures", terms: "Text is CC BY-SA 4.0 (Wikidata is CC0). Each picture carries its own license, shown with its credit.", url: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use" },
  { name: "Stack Exchange", what: "Answers on Stack Overflow and its sister sites", terms: "CC BY-SA. Every result links to the original question and its authors.", url: "https://stackoverflow.com/legal/terms-of-service/public" },
  { name: "MedlinePlus (U.S. National Library of Medicine)", what: "Health topic summaries", terms: "Public information from the NIH. Not medical advice.", url: "https://medlineplus.gov/about/using/usingcontent/" },
  { name: "MDN Web Docs", what: "Web development documentation", terms: "CC BY-SA 2.5 and MIT for code samples.", url: "https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Attrib_copyright_license" },
  { name: "OpenAlex", what: "Research papers", terms: "CC0 (public domain).", url: "https://openalex.org/" },
  { name: "Open Library and the Internet Archive", what: "Books", terms: "Open data, linked back to Open Library.", url: "https://openlibrary.org/developers/api" },
  { name: "Openverse", what: "Openly licensed pictures", terms: "Each picture keeps its Creative Commons license and credit.", url: "https://openverse.org/" },
  { name: "Marginalia Search", what: "The independent small web", terms: "Public search API, used lightly.", url: "https://search.marginalia.nu/" },
  { name: "Hacker News (Algolia)", what: "Tech stories and discussion", terms: "Public API. Links go to the original stories.", url: "https://hn.algolia.com/api" },
  { name: "GitHub", what: "Open-source projects", terms: "Public API. Links go to each repository.", url: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service" },
  { name: "BBC News, NPR and The Guardian", what: "Headlines and photos", terms: "From each publisher's own RSS feed. Marigold shows the headline and links to the publisher. Stories belong to them.", url: "https://www.bbc.co.uk/news/10628494" },
  { name: "ESPN", what: "Scores and game schedules", terms: "Public scoreboard data, shown as links to ESPN. Not a licensed feed.", url: "https://www.espn.com/" },
  { name: "Yahoo Finance", what: "Stock and index prices", terms: "Public quote data, possibly delayed. Not a licensed feed and not investment advice.", url: "https://finance.yahoo.com/" },
  { name: "CoinGecko", what: "Crypto prices", terms: "Free public API. Prices by CoinGecko.", url: "https://www.coingecko.com/en/api" },
  { name: "Open-Meteo", what: "Weather", terms: "Weather data by Open-Meteo.com, CC BY 4.0, free for non-commercial use.", url: "https://open-meteo.com/" },
  { name: "Tavily Search", what: "Web results with page text and pictures", terms: "Used through Tavily's free keyless mode, or your own free key for higher limits. Under Tavily's terms. Brave Search can be used instead with your own key.", url: "https://docs.tavily.com/documentation/keyless" },
];

export default function SourcesPage() {
  const list = licenses as { name: string; version: string; license: string; url: string }[];
  const counts = new Map<string, number>();
  for (const l of list) counts.set(l.license, (counts.get(l.license) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Sources and licenses</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          Marigold doesn&apos;t make up the web. This page lists where its search results, answers, Pulse bar and pictures come from, and the open-source
          software it is built with. Pictures and articles belong to their sources, and results link back to them.
        </p>

        <h2 className="mt-9 text-[13px] font-semibold uppercase tracking-wide text-muted">Where information comes from</h2>
        <ul className="mt-3 divide-y divide-border rounded-2xl border border-border">
          {SOURCES.map((s) => (
            <li key={s.name} className="px-4 py-3.5">
              <a href={s.url} target="_blank" rel="noreferrer" className="text-[14.5px] font-medium hover:text-[var(--accent)] hover:underline">{s.name}</a>
              <span className="ml-2 text-[12.5px] text-muted">{s.what}</span>
              <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/70">{s.terms}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          Your searches are not sent to an advertising network, and Marigold doesn&apos;t track what you search. Questions you ask the assistant go to the AI
          provider you chose, and searches go to the sources above.
        </p>

        <h2 className="mt-10 text-[13px] font-semibold uppercase tracking-wide text-muted">Open-source software</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Marigold ships {list.length} open-source packages, including Electron, Chromium, Next.js, React and Tailwind CSS. Most licenses: {top.map(([k, v]) => `${k} (${v})`).join(", ")}.
          Each package keeps its own license, linked below.
        </p>
        <details className="mt-3 rounded-2xl border border-border">
          <summary className="cursor-pointer px-4 py-3 text-[13.5px] font-medium">Show all {list.length} packages</summary>
          <div className="max-h-[60vh] overflow-y-auto border-t border-border">
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 bg-background text-muted"><tr><th className="px-4 py-2 font-medium">Package</th><th className="px-2 py-2 font-medium">Version</th><th className="px-4 py-2 font-medium">License</th></tr></thead>
              <tbody>
                {list.map((l) => (
                  <tr key={`${l.name}@${l.version}`} className="border-t border-border/60">
                    <td className="px-4 py-1.5">{l.url ? <a href={l.url} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)] hover:underline">{l.name}</a> : l.name}</td>
                    <td className="px-2 py-1.5 text-muted">{l.version}</td>
                    <td className="px-4 py-1.5 text-muted">{l.license}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <p className="mt-4 text-[12px] leading-relaxed text-muted">
          Chromium is licensed under a BSD-style license and includes components under other open-source licenses. Widevine is provided by Google under its own license.
          Marigold is not affiliated with or endorsed by any of the services named here.
        </p>
      </div>
    </main>
  );
}
