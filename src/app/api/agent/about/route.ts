import { localOnly } from "@/lib/server/agent/guard";
import { aboutMe, saveAboutMe } from "@/lib/server/agent/memory";

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ facts: aboutMe() });
}

/** POST { facts: string[] } — the user's "About you" list from Settings. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { facts } = await req.json().catch(() => ({}));
  if (!Array.isArray(facts)) return Response.json({ error: "facts required" }, { status: 400 });
  await saveAboutMe(facts.map(String), undefined, { keepReplaced: false }); // the user edited the list by hand
  return Response.json({ ok: true, facts: aboutMe() });
}
