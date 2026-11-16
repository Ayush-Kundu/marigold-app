import { localOnly } from "@/lib/server/agent/guard";
import { installedBrowsers, prefs, setPrefs, systemDefaultBrowser } from "@/lib/server/agent/prefs";
import { accountFor, accounts, inboxUrl, providerLabel, saveAccounts, signInUrl } from "@/lib/server/agent/accounts";
import { browserById } from "@/lib/browsers";

const view = () => accounts().map((a) => ({ ...a, label: providerLabel(a.provider, a.address), inbox: inboxUrl(a) ?? null }));

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({
    prefs: prefs(),
    installed: installedBrowsers().map((b) => b.id),
    systemDefault: (await systemDefaultBrowser())?.id ?? null,
    emails: view(),
  });
}

/**
 * POST { browser: "chrome" }                              → main browser
 * POST { emails: { primary: "a@x.com", extras: [...] } }  → the user's email accounts
 * POST { action: "signin", email }                        → open that provider's sign-in page
 *                                                            (email pre-filled) in the Marigold Browser
 */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const body = await req.json().catch(() => ({}));

  if (body.action === "signin") {
    const acc = accountFor(String(body.email ?? ""));
    if (!acc) return Response.json({ error: "unknown email" }, { status: 404 });
    const { page, setPage, selectAccount } = await import("@/lib/server/agent/browser");
    selectAccount(acc.address); // sign in inside THAT account's own Marigold Browser profile
    const p = await page();
    await p.goto(signInUrl(acc), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await setPage(p);
    return Response.json({ ok: true, url: p.url() });
  }

  if (body.emails) {
    const extras = Array.isArray(body.emails.extras) ? body.emails.extras.map(String).slice(0, 10) : [];
    const list = await saveAccounts(typeof body.emails.primary === "string" ? body.emails.primary : undefined, extras);
    return Response.json({ ok: true, emails: list.map((a) => ({ ...a, label: providerLabel(a.provider, a.address), inbox: inboxUrl(a) ?? null })) });
  }

  const { browser } = body;
  if (browser !== undefined && !browserById(browser)) return Response.json({ error: "unknown browser" }, { status: 400 });
  await setPrefs({ browser });
  return Response.json({ ok: true, prefs: prefs() });
}
