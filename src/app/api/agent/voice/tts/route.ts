import { localOnly } from "@/lib/server/agent/guard";
import { speak } from "@/lib/server/agent/voice";

/** POST { text, voice?, speed? } → audio/wav. Marigold's spoken voice (Kokoro, open weights), on this Mac. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 1500) : "";
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  try {
    const wav = await speak(text, typeof b.voice === "string" ? b.voice : "af_heart", Number(b.speed) || 1, b.expressive === true);
    return new Response(new Uint8Array(wav), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } catch (e) {
    const m = String(e instanceof Error ? e.message : e);
    return Response.json({ error: m === "VOICE_NOT_SET_UP" ? "not_set_up" : m }, { status: m === "VOICE_NOT_SET_UP" ? 409 : 500 });
  }
}
