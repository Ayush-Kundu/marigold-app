import { promises as fs } from "fs";
import path from "path";
import { JOBS } from "@/lib/jobs";
import { catalog, type AppInfo } from "./catalog";
import { MARIGOLD_DIR } from "./policy";

/**
 * Which of THIS Mac's apps belong to which kind of work. Nothing here is a fixed list of apps:
 *   1. the apps named in each job's list (in order), with "@browser" standing for the browser the user uses most;
 *   2. every other app by its own App Store category (CapCut says "Video", so it lands in video editing);
 *   3. apps with no useful category are sorted by the AI once and remembered.
 */

const KIND_JOB: Record<string, string[]> = {
  "Video": ["video"], "Photo": ["photo"], "Graphics & design": ["design", "photo"], "Music & audio": ["audio"], "Developer tools": ["code"],
  "Business": ["business"], "Finance": ["sheets"], "Education": ["teach", "research"], "Social & messaging": ["mail"], "Reference": ["research"],
  "Health & fitness": ["personal"], "Lifestyle": ["personal"], "Travel": ["personal"], "Weather": ["personal"], "News": ["research"],
};
const FILE = path.join(MARIGOLD_DIR, "app-jobs.json");
type Cache = { at: number; byApp: Record<string, string[]> };
let mem: Cache | null = null;
async function loadCache(): Promise<Cache> {
  if (mem) return mem;
  try { mem = JSON.parse(await fs.readFile(FILE, "utf8")) as Cache; } catch { mem = { at: 0, byApp: {} }; }
  return mem;
}

let classifying = false;
/** Ask the AI to place apps the category couldn't (in the background, at most once an hour, never blocking). */
async function classifyUnknown(unknown: string[]) {
  const c = await loadCache();
  const todo = unknown.filter((n) => !(n in c.byApp)).slice(0, 60);
  if (!todo.length || classifying || Date.now() - c.at < 3600_000) return;
  classifying = true;
  try {
    const { cloudJson, hasCloudKey, stepModel } = await import("./cloud");
    if (!(await hasCloudKey())) return;
    const jobs = JOBS.map((j) => `${j.id} = ${j.label}`).join("; ");
    const out = await cloudJson(
      `You sort Mac apps into kinds of work. Kinds: ${jobs}. For each app name below, say which kinds it is used for (0 to 2 ids). Use an empty list when you are not sure or it is not for work (a game, a utility). Return ONLY JSON like {"AppName":["video"],"Other App":[]}.`,
      todo.join("\n"), AbortSignal.timeout(60_000), { model: stepModel(), maxTokens: 1500 });
    const j = JSON.parse(out) as Record<string, unknown>;
    const ids = new Set(JOBS.map((x) => x.id));
    for (const n of todo) c.byApp[n] = (Array.isArray(j[n]) ? (j[n] as unknown[]) : []).map(String).filter((x) => ids.has(x)).slice(0, 2);
    c.at = Date.now();
    await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(FILE, JSON.stringify(c), { mode: 0o600 });
  } catch { /* try again in an hour */ } finally { classifying = false; }
}

export interface JobApps { id: string; label: string; blurb: string; prompts: string[]; installed: string[] }

/** Every job that has at least one app on this Mac, with those apps (the job's own list first, then what the Mac's categories add). */
export async function jobsOnThisMac(): Promise<JobApps[]> {
  // (helpers, handlers and diagnostics are not apps anyone works in)
  const apps = (await catalog()).apps.filter((a) => !a.ios && !/helper|handler|updater|uninstall|installer|speed test|migration|diagnostic|crash|reporter/i.test(a.name));
  const have = new Map(apps.map((a) => [a.name.toLowerCase(), a] as [string, AppInfo]));
  const { mainBrowser } = await import("./prefs");
  const browser = await mainBrowser().then((b) => b.app, () => "");
  const cache = await loadCache();
  const claimed = new Set<string>();
  const out: JobApps[] = [];
  for (const j of JOBS) {
    const names: string[] = [];
    const add = (n: string) => { const a = have.get(n.toLowerCase()); if (a && !names.includes(a.name)) names.push(a.name); };
    for (const n of j.apps) add(n === "@browser" ? browser : n);
    out.push({ id: j.id, label: j.label, blurb: j.blurb, prompts: j.prompts, installed: names });
    names.forEach((n) => claimed.add(n));
  }
  const unknown: string[] = [];
  for (const a of apps) {
    if (claimed.has(a.name) || a.kind === "Games" || a.kind === "Web browser" || a.kind === "Entertainment") continue;
    const ids = KIND_JOB[a.kind] ?? cache.byApp[a.name];
    if (!ids) { if (a.kind === "Other" || a.kind === "Productivity" || a.kind === "Utilities") unknown.push(a.name); continue; }
    for (const id of ids) { const row = out.find((r) => r.id === id); if (row && row.installed.length < 8 && !row.installed.includes(a.name)) row.installed.push(a.name); }
  }
  void classifyUnknown(unknown); // fills in for next time
  return out.filter((r) => r.installed.length > 0);
}
