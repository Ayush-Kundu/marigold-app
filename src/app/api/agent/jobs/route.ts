import { localOnly } from "@/lib/server/agent/guard";
import { jobsOnThisMac } from "@/lib/server/agent/jobs-apps";

/** GET → every kind of work that has apps on THIS Mac, with those apps (Workspaces: open a job's apps together). */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ jobs: await jobsOnThisMac() });
}
