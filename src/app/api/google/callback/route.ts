import { execFile } from "child_process";
import { finishConsent } from "@/lib/server/agent/google";

/**
 * Google sends the user's browser back here after consent. It's a cross-site navigation,
 * so the usual same-origin guard doesn't apply — but it only accepts a one-time `state`
 * Marigold created (PKCE), and only on this Mac's localhost address.
 */
const page = (title: string, msg: string) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#fafafa"><div style="text-align:center;max-width:420px"><div style="font-size:42px">${title.startsWith("Connected") ? "🌼" : "⚠️"}</div><h2>${title}</h2><p style="color:#555">${msg}</p></div>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } },
);

export async function GET(req: Request) {
  const host = req.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return new Response("forbidden", { status: 403 });
  const u = new URL(req.url);
  if (u.searchParams.get("error")) return page("Not connected", "Google didn't finish connecting. If you cancelled, just try again from Marigold. If Google said the app is blocked or you're not an approved tester, Marigold's Google access is still in limited preview for new accounts.");
  try {
    const email = await finishConsent(u.searchParams.get("code") ?? "", u.searchParams.get("state") ?? "");
    // Bring Marigold back to the front so the user lands where they were (inside the app only).
    if (process.env.MARIGOLD_APP_SECRET) execFile("open", ["-a", "Marigold"], () => {});
    return page("Connected to Marigold", `${email} is connected. Marigold can now use Gmail, Calendar, Drive, Docs, Sheets and Slides for you. You can close this tab and go back to Marigold.<script>setTimeout(()=>window.close(),1500)</script>`);
  } catch (e) {
    return page("Not connected", String(e instanceof Error ? e.message : e));
  }
}
