import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { localOnly } from "@/lib/server/agent/guard";
import { cloudConfig, cloudReachable, hasCloudKey, stepModel } from "@/lib/server/agent/cloud";
import { connectedAccounts } from "@/lib/server/agent/google";
import { voiceInstalled } from "@/lib/server/agent/voice";
import { braveKey } from "@/lib/server/agent/summarize";

/** GET → what's ready on this Mac, for the first-run setup screen. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const cfg = cloudConfig();
  const [hasKey, online] = await Promise.all([hasCloudKey(), cloudReachable()]);
  // A local model: Ollama running with at least one chat model pulled.
  const local = await fetch(`${process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/tags`, { signal: AbortSignal.timeout(1200) })
    .then((r) => r.json() as Promise<{ models?: { name: string }[] }>).then((j) => ({ running: true, models: (j.models ?? []).map((m) => m.name) }), () => ({ running: false, models: [] as string[] }));
  // Full Disk Access (needed to read Messages): can the engine open the Messages database?
  const fullDisk = await fs.open(path.join(os.homedir(), "Library/Messages/chat.db"), "r").then((h) => h.close().then(() => true), () => false);
  const google = (await connectedAccounts().catch(() => [])).length;
  return Response.json({
    cloud: { configured: hasKey && cfg.mode !== "off", hasKey, mode: cfg.mode, online, model: cfg.model, stepModel: stepModel(cfg), baseUrl: cfg.baseUrl },
    local,
    fullDisk,
    google,
    voice: voiceInstalled(),
    searchKey: !!(await braveKey()),
  });
}
