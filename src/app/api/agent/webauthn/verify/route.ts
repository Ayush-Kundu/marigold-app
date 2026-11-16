import { localOnly } from "@/lib/server/agent/guard";
import { authenticationOptions, rpFrom, verifyForStep } from "@/lib/server/agent/biometric";
import { answerApproval, isPending } from "@/lib/server/agent/loop";
import { audit } from "@/lib/server/agent/policy";

/** GET ?step=<id> → Touch ID challenge bound to that approval. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const step = new URL(req.url).searchParams.get("step") ?? "";
  // "test-…" = the Safety page's Test button: a real Touch ID check that approves nothing.
  if (!step.startsWith("test-") && !isPending(step)) return Response.json({ error: "No such pending approval" }, { status: 404 });
  const opts = await authenticationOptions(step, rpFrom(req).rpID);
  if (!opts) return Response.json({ error: "not_enrolled" }, { status: 409 });
  return Response.json(opts);
}

/** POST {step, response} → verify Touch ID, then approve that one action. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { step, response } = await req.json().catch(() => ({}));
  const { rpID, origin } = rpFrom(req);
  const ok = typeof step === "string" && (await verifyForStep(step, response, rpID, origin).catch(() => false));
  await audit({ event: "biometric", step, verified: ok });
  if (!ok) return Response.json({ ok: false, error: "Touch ID verification failed" }, { status: 401 });
  if (step.startsWith("test-")) return Response.json({ ok: true, result: "test" });
  const r = answerApproval(step, { approve: true, remember: false }, { biometricVerified: true });
  return Response.json({ ok: r === "ok", result: r });
}
