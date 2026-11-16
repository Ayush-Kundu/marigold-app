import { localOnly } from "@/lib/server/agent/guard";
import { fromApp } from "@/lib/server/agent/app-secret";
import { answerApproval } from "@/lib/server/agent/loop";
import { audit } from "@/lib/server/agent/policy";

/** The Mac app verified Touch ID natively for this approval (only the app holds the secret). */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  if (!fromApp(req)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "string") return Response.json({ ok: false, error: "id required" }, { status: 400 });
  const r = answerApproval(id, { approve: true, remember: false }, { biometricVerified: true });
  await audit({ event: "biometric", step: id, verified: true, via: "macOS Touch ID" });
  return Response.json({ ok: r === "ok", result: r, error: r === "ok" ? undefined : "That approval isn't waiting anymore." });
}
