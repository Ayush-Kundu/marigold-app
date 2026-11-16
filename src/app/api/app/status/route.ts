import { localOnly } from "@/lib/server/agent/guard";
import { inApp } from "@/lib/server/agent/app-secret";

/** Is a Marigold engine running here, and is it the Mac app's? */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ marigold: true, app: inApp() });
}
