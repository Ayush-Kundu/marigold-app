import { localOnly } from "@/lib/server/agent/guard";
import { hasBiometric, registrationOptions, removeBiometrics, rpFrom, verifyRegistration } from "@/lib/server/agent/biometric";

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const url = new URL(req.url);
  if (url.searchParams.get("status")) return Response.json({ enrolled: await hasBiometric() });
  return Response.json(await registrationOptions(rpFrom(req).rpID));
}

export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { rpID, origin } = rpFrom(req);
  try {
    const ok = await verifyRegistration(await req.json(), rpID, origin);
    return Response.json({ ok });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  await removeBiometrics();
  return Response.json({ ok: true });
}
