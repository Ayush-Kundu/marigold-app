import { promises as fs } from "fs";
import path from "path";
import { localOnly } from "@/lib/server/agent/guard";
import { MARIGOLD_DIR } from "@/lib/server/agent/policy";
import { catalog } from "@/lib/server/agent/catalog";

/** The user's own workspaces: a name and up to four apps that open together beside the chat. Stored in ~/.marigold/workspaces.json. */
const FILE = path.join(MARIGOLD_DIR, "workspaces.json");
export interface Workspace { id: string; name: string; apps: string[] }

async function load(): Promise<Workspace[]> {
  try { const j = JSON.parse(await fs.readFile(FILE, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ workspaces: await load() });
}

/** POST { workspaces: [{id?, name, apps[]}] } replaces the whole list (apps must be installed on this Mac). */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = (await req.json().catch(() => ({}))) as { workspaces?: { id?: string; name?: string; apps?: unknown }[] };
  if (!Array.isArray(b.workspaces)) return Response.json({ error: "bad request" }, { status: 400 });
  const have = new Map((await catalog()).apps.map((a) => [a.name.toLowerCase(), a.name]));
  const out: Workspace[] = [];
  for (const w of b.workspaces.slice(0, 30)) {
    const name = String(w.name ?? "").trim().slice(0, 40);
    const apps = [...new Set((Array.isArray(w.apps) ? w.apps : []).map((x) => have.get(String(x).toLowerCase())).filter((x): x is string => !!x && x !== "Marigold"))].slice(0, 4);
    if (!name || !apps.length) continue;
    out.push({ id: String(w.id || Math.random().toString(36).slice(2, 10)).slice(0, 20), name, apps });
  }
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  return Response.json({ workspaces: out });
}
