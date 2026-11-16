import { execFile } from "child_process";
import { readFileSync, promises as fs } from "fs";
import path from "path";
import { MARIGOLD_DIR } from "./policy";
import { inApp } from "./app-secret";

/**
 * Pings: everything Marigold tells the user without being asked in the moment — a task
 * finished, a background task found something, or the watcher noticed something (a meeting
 * soon, an urgent text, an important email, low battery, the morning rundown).
 *
 *  • Kept in ~/.marigold/pings.json (the bell in the app shows them).
 *  • Delivered as native notifications by the Mac app (it collects new ones every few
 *    seconds); outside the app, as a plain macOS notification.
 *  • Each kind can be turned off; quiet hours hold non-urgent pings.
 */

export type PingKind = "task" | "monitor" | "calendar" | "messages" | "email" | "reminders" | "battery" | "morning" | "needs_you" | "briefing" | "pulse" | "classroom" | "docs" | "invites" | "tasks";
/**
 * How loudly a ping speaks. critical = act now (sound, banner, on-screen card even while Marigold is open);
 * normal = worth a quiet banner when you're away; low = just the bell unless you're away, and capped.
 */
export type PingPriority = "critical" | "normal" | "low";
export interface Ping { id: string; kind: PingKind; title: string; body: string; at: string; chatId?: string; url?: string; key?: string; read?: boolean; urgent?: boolean; priority?: PingPriority }
export const priorityOf = (kind: PingKind): PingPriority => (["needs_you", "calendar", "battery", "briefing"].includes(kind) ? "critical" : ["messages", "email", "reminders", "monitor", "morning", "pulse", "classroom", "docs", "invites", "tasks"].includes(kind) ? "normal" : "low");

const FILE = path.join(MARIGOLD_DIR, "pings.json");
const PREFS = path.join(MARIGOLD_DIR, "ping-prefs.json");

export interface PingPrefs { kinds: Record<PingKind, boolean>; quiet: { from: string; to: string } | null; morningAt: string; /** When the three daily briefings go out (morning, afternoon, evening). */ briefTimes: [string, string, string] }
export const DEFAULT_PREFS: PingPrefs = {
  kinds: { task: true, monitor: true, calendar: true, messages: true, email: true, reminders: true, battery: true, morning: true, needs_you: true, briefing: true, pulse: true, classroom: true, docs: true, invites: true, tasks: true },
  quiet: { from: "22:30", to: "07:00" },
  morningAt: "07:30",
  briefTimes: ["06:00", "14:00", "22:00"],
};

export function pingPrefs(): PingPrefs {
  try { const j = JSON.parse(readFileSync(PREFS, "utf8")); return { ...DEFAULT_PREFS, ...j, kinds: { ...DEFAULT_PREFS.kinds, ...(j.kinds ?? {}) } }; } catch { return DEFAULT_PREFS; }
}
export async function savePingPrefs(p: Partial<PingPrefs>) {
  const next = { ...pingPrefs(), ...p, kinds: { ...pingPrefs().kinds, ...(p.kinds ?? {}) } };
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(PREFS, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

const g = globalThis as unknown as { __marigoldPings?: { list: Ping[]; loaded: boolean; seq: number } };
const st = (g.__marigoldPings ??= { list: [], loaded: false, seq: 0 });

function load() {
  if (st.loaded) return;
  st.loaded = true;
  try { st.list = JSON.parse(readFileSync(FILE, "utf8")); } catch { st.list = []; }
}
async function save() {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(st.list.slice(-300), null, 1), { mode: 0o600 });
}

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
export function inQuietHours(now = new Date(), p = pingPrefs()): boolean {
  if (!p.quiet) return false;
  const t = now.getHours() * 60 + now.getMinutes(), a = minutes(p.quiet.from), b = minutes(p.quiet.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** Was something with this key already pinged (within `withinMs`)? */
export function alreadyPinged(key: string, withinMs = 7 * 86_400_000): boolean {
  load();
  return st.list.some((p) => p.key === key && Date.now() - Date.parse(p.at) < withinMs);
}

/** Tell the user something. Returns the ping, or null if that kind is off / it's a duplicate / quiet hours. */
export async function ping(p: Omit<Ping, "id" | "at">): Promise<Ping | null> {
  load();
  const prefs = pingPrefs();
  if (!prefs.kinds[p.kind]) return null;
  if (p.key && alreadyPinged(p.key)) return null;
  if (!p.urgent && p.kind !== "task" && p.kind !== "needs_you" && inQuietHours(new Date(), prefs)) return null;
  const full: Ping = { ...p, priority: p.priority ?? priorityOf(p.kind), id: `p_${Date.now().toString(36)}_${st.seq++}`, at: new Date().toISOString(), title: p.title.slice(0, 80), body: p.body.slice(0, p.kind === "briefing" ? 700 : 400) };
  st.list.push(full);
  await save();
  // Inside the Mac app, the app shows it (clickable, opens the chat). Otherwise a plain macOS notification.
  if (!inApp()) {
    const esc = (t: string) => t.replace(/["\\]/g, "\\$&").slice(0, 200);
    execFile("osascript", ["-e", `display notification "${esc(full.body)}" with title "${esc(full.title)}" sound name "Glass"`], () => {});
  }
  return full;
}

export function listPings(after?: string): Ping[] {
  load();
  if (!after) return [...st.list].reverse().slice(0, 100);
  const i = st.list.findIndex((p) => p.id === after);
  return i < 0 ? st.list.slice(-5) : st.list.slice(i + 1);
}
export async function markRead(ids: string[] | "all") {
  load();
  for (const p of st.list) if (ids === "all" || ids.includes(p.id)) p.read = true;
  await save();
}
export async function clearPings() { load(); st.list = []; await save(); }
