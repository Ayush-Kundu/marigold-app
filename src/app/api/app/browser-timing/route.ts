import { localOnly } from "@/lib/server/agent/guard";
import { appBrowserAvailable, mb } from "@/lib/server/agent/app-browser";

/** Dev diagnostics: load a URL in a fresh background tab of the Marigold Browser and report its timing. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  if (!appBrowserAvailable()) return Response.json({ error: "not in the app" }, { status: 409 });
  const url = new URL(req.url).searchParams.get("url") ?? "https://en.wikipedia.org/wiki/Marigold";
  const account = new URL(req.url).searchParams.get("account") ?? undefined;
  const t0 = Date.now();
  await mb("open", { url, newTab: true, ...(account ? { account } : {}) });
  const wall = Date.now() - t0;
  const { value } = (await mb("eval", { ...(account ? { account } : {}), js: `JSON.stringify((() => { const n = performance.getEntriesByType('navigation')[0] || {}; return { ttfb: Math.round(n.responseStart - n.requestStart), dom: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), proto: n.nextHopProtocol, title: document.title, at: location.href, resources: performance.getEntriesByType('resource').length }; })())` })) as { value: string };
  // ?probe=ads → can this page reach a known ad server and a known tracker? (fixed script, no arbitrary eval)
  let ads: unknown;
  if (new URL(req.url).searchParams.get("probe") === "ads") {
    const r = (await mb("eval", { ...(account ? { account } : {}), js: `(async () => { const t = async (u) => { try { await fetch(u, { mode: 'no-cors', cache: 'no-store' }); return 'reached'; } catch { return 'blocked'; } }; return JSON.stringify({ adServer: await t('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'), tracker: await t('https://www.google-analytics.com/analytics.js') }); })()` })) as { value: string };
    ads = JSON.parse(r.value);
  }
  // ?probe=who → which Google account(s) does this page think it's signed in as? (fixed script)
  if (new URL(req.url).searchParams.get("probe") === "who") {
    await new Promise((r) => setTimeout(r, 2500));
    const r = (await mb("eval", { ...(account ? { account } : {}), js: `JSON.stringify([...document.querySelectorAll('a[aria-label^="Google Account"],a[href*="accounts.google.com/SignOutOptions"]')].map((a) => a.getAttribute('aria-label') || a.textContent).slice(0, 3))` })) as { value: string };
    ads = JSON.parse(r.value);
  }
  await new Promise((r) => setTimeout(r, 1500)); // let the page checks run
  const flags = (await mb("info", account ? { account } : {})) as { googleSignIn?: boolean; loginPage?: boolean };
  await mb("close", account ? { account } : {});
  return Response.json({ url, wall, ...JSON.parse(value), googleSignIn: flags.googleSignIn, loginPage: flags.loginPage, ads });
}
