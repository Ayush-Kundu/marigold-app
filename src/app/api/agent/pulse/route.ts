import { localOnly } from "@/lib/server/agent/guard";
import { pulse, saveConfig } from "@/lib/server/agent/pulse";

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json(await pulse());
}

/** POST { symbols?, crypto?, leagues?, teams?, city? } → saves the watchlist, returns fresh data. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  await saveConfig(await req.json().catch(() => ({})));
  return Response.json(await pulse());
}
