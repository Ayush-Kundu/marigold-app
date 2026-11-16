import { localOnly } from "@/lib/server/agent/guard";
import { phoneHostStatus, startPhoneHost, stopPhoneHost, ensurePhoneHost, phoneHostWanted } from "@/lib/server/agent/phone-host";

/** GET → state of the iPhone link (and a QR code when it is ready). POST {on: boolean} → turn it on or off. Local only. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  if (phoneHostWanted()) void ensurePhoneHost();
  return Response.json(await phoneHostStatus());
}
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as { on?: boolean };
  if (b.on) await startPhoneHost(); else await stopPhoneHost();
  return Response.json(await phoneHostStatus());
}
