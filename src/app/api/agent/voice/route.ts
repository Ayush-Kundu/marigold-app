import { localOnly } from "@/lib/server/agent/guard";
import { setupExpressive, setupVoice, voiceStatus } from "@/lib/server/agent/voice";

/** GET → { installed, installing, step, error, running }. POST { action: "setup" } installs the voice models in the background. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json(voiceStatus());
}
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  if (b.action === "setup") { setupVoice(); return Response.json(voiceStatus()); }
  if (b.action === "setup-expressive") { setupExpressive(); return Response.json(voiceStatus()); }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
