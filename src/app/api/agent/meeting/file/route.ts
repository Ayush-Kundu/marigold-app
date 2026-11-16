import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { localOnly } from "@/lib/server/agent/guard";
import { summarizeMeeting, type Line } from "@/lib/server/agent/meeting";
import { transcript } from "@/lib/server/agent/video-edit";
import { transcribeSegments } from "@/lib/server/agent/voice";

/**
 * Notes from a recording (a voice memo, a saved call, a lecture; audio or video) → the same summary, decisions and tasks as a live
 * call. The file is turned into text on this Mac and deleted straight away; only the text goes to the AI.
 * POST multipart: file, title. Up to 45 minutes.
 */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  if (!(f instanceof File) || !f.size) return Response.json({ error: "No file." }, { status: 400 });
  if (f.size > 600 * 1024 * 1024) return Response.json({ error: "That file is too large (600 MB at most)." }, { status: 413 });
  const title = String(form?.get("title") ?? "").trim().slice(0, 120) || f.name.replace(/\.[a-z0-9]+$/i, "") || "Recording";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marigold-rec-"));
  const file = path.join(dir, `in${path.extname(f.name).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".m4a"}`);
  try {
    await fs.writeFile(file, Buffer.from(await f.arrayBuffer()), { mode: 0o600 });
    const segs = await transcript(file, { sensitive: () => undefined, transcribe: transcribeSegments, queueImages: () => {} });
    if (!segs.length) return Response.json({ error: "No speech was found in that file." }, { status: 422 });
    const lines: Line[] = segs.map((s) => ({ at: Math.round(s.start * 1000), who: "Others", text: s.text.slice(0, 1200) }));
    return Response.json({ ...(await summarizeMeeting(title, lines)), title });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
