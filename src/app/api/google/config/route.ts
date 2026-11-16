import { localOnly } from "@/lib/server/agent/guard";
import { clientIsShipped, connectedAccounts, oauthConfig, saveOauthConfig } from "@/lib/server/agent/google";

/** GET → is the Google app configured, and which accounts are connected. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const cfg = await oauthConfig();
  return Response.json({ configured: !!cfg, shipped: cfg ? await clientIsShipped() : false, accounts: cfg ? await connectedAccounts() : [] });
}

/** POST { clientId, clientSecret } — the developer's one-time Google Cloud OAuth client (Desktop app). */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { clientId, clientSecret } = await req.json().catch(() => ({}));
  if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com") || typeof clientSecret !== "string" || clientSecret.length < 10) {
    return Response.json({ error: "That doesn't look like a Google OAuth client ID / secret." }, { status: 400 });
  }
  await saveOauthConfig(clientId, clientSecret);
  return Response.json({ ok: true });
}
