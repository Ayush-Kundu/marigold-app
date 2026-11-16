import { localOnly } from "@/lib/server/agent/guard";
import { loadGrants, revokeGrant } from "@/lib/server/agent/policy";

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ grants: await loadGrants() });
}

/** Revoke one scope ({scope}) or all ({}). */
export async function DELETE(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { scope } = await req.json().catch(() => ({}));
  await revokeGrant(typeof scope === "string" ? scope : undefined);
  return Response.json({ grants: await loadGrants() });
}
