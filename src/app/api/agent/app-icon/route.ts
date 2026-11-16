import { execFile } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { localOnly } from "@/lib/server/agent/guard";
import { catalog } from "@/lib/server/agent/catalog";
import { MARIGOLD_DIR } from "@/lib/server/agent/policy";
import { helperBin } from "@/lib/server/agent/helpers";

const exec = promisify(execFile);
const CACHE = path.join(MARIGOLD_DIR, "icons");

async function ensureBin() { return helperBin("appicon"); }

// A few at a time: each icon is a short native process.
let active = 0;
const waiters: (() => void)[] = [];
const slot = async () => { if (active >= 6) await new Promise<void>((r) => waiters.push(r)); active++; };
const free = () => { active--; waiters.shift()?.(); };

/** GET ?path=/Applications/Notes.app → that app's real icon as a PNG (cached on disk). Only apps in the catalog. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const p = new URL(req.url).searchParams.get("path") ?? "";
  const { apps } = await catalog();
  if (!p.endsWith(".app") || !apps.some((a) => a.path === p)) return new Response("not an installed app", { status: 404 });
  const file = path.join(CACHE, `${createHash("sha1").update(p).digest("hex").slice(0, 16)}.png`);
  try {
    let png = await fs.readFile(file).catch(() => null);
    if (!png) {
      await fs.mkdir(CACHE, { recursive: true, mode: 0o700 });
      const bin = await ensureBin();
      await slot();
      try { await exec(bin, [p, file, "128"], { timeout: 15_000 }); } finally { free(); }
      png = await fs.readFile(file);
    }
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });
  } catch {
    return new Response("no icon", { status: 404 });
  }
}
