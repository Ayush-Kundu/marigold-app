import { localOnly } from "@/lib/server/agent/guard";
import { listTasks } from "@/lib/server/agent/tasks";
import { listMonitors } from "@/lib/server/agent/monitors";

/** `tasks` = live chat runs (for approvals); `monitors` = real background tasks. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ tasks: listTasks(), monitors: await listMonitors() });
}
