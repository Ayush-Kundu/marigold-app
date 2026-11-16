import { execFile } from "child_process";
import { localOnly } from "@/lib/server/agent/guard";
import { consentUrl } from "@/lib/server/agent/google";

/** POST { email? } → open Google's consent screen in the user's own default browser. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { email } = await req.json().catch(() => ({}));
  try {
    const url = await consentUrl(typeof email === "string" ? email : undefined);
    execFile("open", [url]); // their real browser — Google trusts it, no automation involved
    return Response.json({ ok: true });
  } catch (e) {
    const m = String(e instanceof Error ? e.message : e);
    return Response.json({ error: m === "NOT_CONFIGURED" ? "Add the Google app's client ID first." : m }, { status: 400 });
  }
}
