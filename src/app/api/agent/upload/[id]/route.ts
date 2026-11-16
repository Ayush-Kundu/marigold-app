import { promises as fs } from "fs";
import { localOnly } from "@/lib/server/agent/guard";
import { getUpload } from "@/lib/server/agent/attachments";

/** GET → the uploaded file itself (pictures show as thumbnails in the chat). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const a = await getUpload((await ctx.params).id);
  if (!a) return new Response("not found", { status: 404 });
  const buf = await fs.readFile(a.path);
  // Only pictures render inline; everything else downloads, and nothing can run as a page.
  const inline = a.kind === "image" && /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": inline ? a.mime : "application/octet-stream", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(a.name)}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
}
