import { localOnly } from "@/lib/server/agent/guard";
import { stopAll } from "@/lib/server/agent/loop";
import { stopAllTasks } from "@/lib/server/agent/tasks";
import { stopAllMonitors } from "@/lib/server/agent/monitors";
import { audit } from "@/lib/server/agent/policy";

/** Kill switch — stops every running task and declines pending approvals. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const stopped = stopAllTasks() + (await stopAllMonitors());
  stopAll();
  await audit({ event: "kill_switch", stopped });
  return Response.json({ stopped });
}
