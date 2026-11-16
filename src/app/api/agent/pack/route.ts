import { localOnly } from "@/lib/server/agent/guard";
import { importBundledInvite, importPack, inviteAvailable } from "@/lib/server/agent/pack";

/** GET → { available }: does this copy of Marigold ship with an invite? */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ available: inviteAvailable() });
}

/** POST { pass } → connects the AI from the invite inside the app. (POST { file, pass } still opens a separate setup file.) */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  if (typeof b.pass !== "string" || !b.pass.trim() || b.pass.length > 200) return Response.json({ ok: false, error: "Type the invite code." });
  if (typeof b.file === "string" && b.file.length <= 20000) return Response.json(await importPack(Buffer.from(b.file, "base64"), b.pass));
  return Response.json(await importBundledInvite(b.pass));
}
