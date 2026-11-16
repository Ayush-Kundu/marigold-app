import { promises as fs } from "fs";
import path from "path";
import { localOnly } from "@/lib/server/agent/guard";
import { MARIGOLD_DIR } from "@/lib/server/agent/policy";

/** Most recent audit log entries (newest first). */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const raw = await fs.readFile(path.join(MARIGOLD_DIR, "audit.jsonl"), "utf8").catch(() => "");
  const entries = raw.trim().split("\n").filter(Boolean).slice(-100).reverse().map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return Response.json({ entries });
}
