import { localOnly } from "@/lib/server/agent/guard";
import { addHistory, backfillFromHistory, type PastMsg } from "@/lib/server/agent/memory";
import { routerTag } from "@/lib/server/agent/router";

/** Background reading uses the small fast model when it's installed (thinking off, quick). */
async function learner(): Promise<string> {
  const tags = await fetch(`${process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/tags`).then((r) => r.json(), () => ({ models: [] })) as { models?: { name: string }[] };
  return tags.models?.find((m) => m.name.startsWith("qwen3:4b-instruct"))?.name ?? routerTag();
}

/**
 * POST { items: [{id, chatId, title, at, text}] } — the user's OWN messages from their chats,
 * kept on this Mac (~/.marigold/history.json) so Marigold can remember across conversations.
 * New ones are read once in the background for lasting facts.
 */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 3000).filter((i: Partial<PastMsg>) =>
    typeof i?.id === "string" && typeof i?.chatId === "string" && typeof i?.text === "string" && typeof i?.at === "string") as PastMsg[];
  const added = await addHistory(items);
  if (added) void learner().then((m) => backfillFromHistory(m)).catch(() => {});
  return Response.json({ ok: true, added });
}
