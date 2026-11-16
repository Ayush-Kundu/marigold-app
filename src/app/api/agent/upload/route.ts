import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { localOnly } from "@/lib/server/agent/guard";
import { MAX_UPLOAD, saveUpload } from "@/lib/server/agent/attachments";

const exec = promisify(execFile);

/**
 * POST (raw file body, `x-filename` header, optional content-type) → { id, name, kind, size }.
 * POST ?screenshot=1 → a fresh screenshot of the main display, saved as an attachment.
 */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  try {
    if (new URL(req.url).searchParams.get("screenshot")) {
      const tmp = path.join(os.tmpdir(), `marigold-shot-${Date.now()}.png`);
      await exec("screencapture", ["-x", "-t", "png", tmp], { timeout: 10_000 });
      const buf = await fs.readFile(tmp).finally(() => fs.unlink(tmp).catch(() => {}));
      const a = await saveUpload(`Screenshot ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/[:,]/g, ".")}.png`, "image/png", buf);
      return Response.json({ id: a.id, name: a.name, kind: a.kind, size: a.size });
    }
    const raw = req.headers.get("x-filename") ?? "file";
    const name = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return Response.json({ error: "That file is empty." }, { status: 400 });
    if (buf.length > MAX_UPLOAD) return Response.json({ error: "That file is over 50 MB." }, { status: 413 });
    const a = await saveUpload(name, req.headers.get("content-type") ?? "", buf);
    return Response.json({ id: a.id, name: a.name, kind: a.kind, size: a.size });
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
