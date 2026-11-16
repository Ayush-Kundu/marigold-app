import { localOnly } from "@/lib/server/agent/guard";
import { disconnect } from "@/lib/server/agent/google";

/** POST { email } → revoke Marigold's access to that Google account and forget it. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { email } = await req.json().catch(() => ({}));
  if (typeof email !== "string") return Response.json({ error: "email required" }, { status: 400 });
  await disconnect(email);
  return Response.json({ ok: true });
}
