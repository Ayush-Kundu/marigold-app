import { localOnly } from "@/lib/server/agent/guard";
import { answerApproval } from "@/lib/server/agent/loop";

export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { id, approve, remember } = await req.json().catch(() => ({}));
  if (typeof id !== "string") return Response.json({ error: "id required" }, { status: 400 });
  // Money approvals can't come through here — they need /api/agent/webauthn/verify.
  const r = answerApproval(id, { approve: !!approve, remember: !!remember });
  const status = r === "ok" ? 200 : r === "not_found" ? 404 : 403;
  return Response.json({ ok: r === "ok", result: r }, { status });
}
