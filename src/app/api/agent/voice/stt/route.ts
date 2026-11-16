import { localOnly } from "@/lib/server/agent/guard";
import { transcribe } from "@/lib/server/agent/voice";

/** POST audio/wav → { text }. Speech to text with Whisper, on this Mac. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 100 || buf.length > 40 * 1024 * 1024) return Response.json({ error: "no audio" }, { status: 400 });
  try { return Response.json({ text: await transcribe(buf) }); }
  catch (e) {
    const m = String(e instanceof Error ? e.message : e);
    return Response.json({ error: m === "VOICE_NOT_SET_UP" ? "not_set_up" : m }, { status: m === "VOICE_NOT_SET_UP" ? 409 : 500 });
  }
}
