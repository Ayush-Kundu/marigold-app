/**
 * The agent can control this Mac, so its API must only accept requests from
 * the Marigold UI on this machine — not other devices on the LAN, and not
 * other websites open in the browser (CSRF).
 */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function localOnly(req: Request): Response | null {
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  const originOk = !origin || LOCAL.test(new URL(origin).host);
  if (!LOCAL.test(host) || !originOk || (fetchSite && fetchSite !== "same-origin")) {
    return Response.json({ error: "Agent API is local-only" }, { status: 403 });
  }
  return null;
}
