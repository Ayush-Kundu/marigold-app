import { ping } from "./notifications";
import { promises as fs } from "fs";
import path from "path";
import type { AgentStep } from "@/lib/types";
import { runAgent } from "./loop";
import { MARIGOLD_DIR, audit } from "./policy";

/**
 * Background tasks = recurring watchers. The agent creates one (start_monitor)
 * only for jobs that must repeat until a condition is met — "tell me when
 * flights to Tokyo drop under $600". Each check is a fresh, fully
 * safety-gated agent run. Persisted to ~/.marigold/monitors.json so they
 * survive restarts.
 */

/** How a scheduled task repeats after it runs. */
export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

export type MonitorStatus = "running" | "needs_input" | "done" | "failed" | "stopped" | "paused";

export interface Monitor {
  id: string;
  chatId: string;
  goal: string;
  everyMinutes: number;
  until: string;
  status: MonitorStatus;
  checks: number;
  lastCheck?: string;
  lastResult?: string;
  createdAt: string;
  updatedAt: string;
  pending: AgentStep[];
  /** Keep watching after a hit and ping every time something NEW turns up. */
  repeat?: boolean;
  lastPinged?: string;
  /**
   * Scheduled task ("text Mom at 2 pm"): sleeps on ONE timer until `at`, runs the goal once, then (if it repeats)
   * sleeps until the next time. It never polls. Approved by the user when it was scheduled.
   */
  scheduled?: { at: string; repeat: Repeat; runs: number; lastRunAt?: string };
  /** Results waiting to be posted into the chat (the app drains this and shows them as messages). */
  outbox?: { id: string; at: string; text: string; kind: "update" | "done" | "failed" }[];
}

const FILE = path.join(MARIGOLD_DIR, "monitors.json");
type G = { monitors: Map<string, Monitor>; timers: Map<string, NodeJS.Timeout>; ctrls: Map<string, AbortController>; loaded: boolean };
const gg = globalThis as unknown as { __marigoldMon?: G };
const st: G = (gg.__marigoldMon ??= { monitors: new Map(), timers: new Map(), ctrls: new Map(), loaded: false });

/** A short, readable name for a background task ("HN top story watcher"), never its raw instructions. */
function label(goal: string): string {
  const first = goal.replace(/https?:\/\/\S+/g, "").split(/[.!?\n:]/)[0].trim().replace(/^(set up a background task|start a background task|background task|please|can you|check|watch|monitor)[:,]?\s*/i, "");
  const t0 = first.length >= 4 ? first : "Background task";
  const t = t0.charAt(0).toUpperCase() + t0.slice(1);
  return t.length > 48 ? `${t.slice(0, 46).replace(/\s+\S*$/, "")}…` : t;
}

function notify(title: string, message: string, chatId?: string, kind: "monitor" | "needs_you" = "monitor") {
  void ping({ kind, title, body: message, chatId, urgent: kind === "needs_you" });
}

function post(m: Monitor, text: string, kind: "update" | "done" | "failed") {
  (m.outbox ??= []).push({ id: `o_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: new Date().toISOString(), text: text.slice(0, 1200), kind });
  if (m.outbox.length > 20) m.outbox.splice(0, m.outbox.length - 20);
}

/** The app took these results and put them in the chat. */
export async function drainMonitor(id: string) {
  await ensureLoaded();
  const m = st.monitors.get(id);
  if (!m?.outbox?.length) return [];
  const out = m.outbox;
  m.outbox = [];
  await save();
  return out;
}

async function save() {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify([...st.monitors.values()], null, 2), { mode: 0o600 });
}

const CHECK_PROMPT = (m: Monitor) => `You are running a scheduled background check (check #${m.checks + 1}).
GOAL: ${m.goal}
${m.lastResult ? `Last check found: ${m.lastResult}` : ""}
Use your tools to check the current state now — quickly, in as few steps as possible. Then reply with EXACTLY one line:
- "DONE: <what you found>" if the goal's condition is met${m.repeat ? " (something new worth telling the user since the last check)" : " (and any requested action is completed)"}, or
- "NOT YET: <current status>" if not.`;

async function check(id: string) {
  const m = st.monitors.get(id);
  if (!m || m.status === "done" || m.status === "stopped" || m.status === "failed") return;
  if (m.scheduled) return; // scheduled tasks run at their time (runScheduled), never on a polling loop
  if (st.ctrls.has(id)) return; // previous check still running
  if (Date.now() > Date.parse(m.until)) {
    finish(m, "failed", "Gave up — the time limit passed without the condition being met.");
    return;
  }
  const ctrl = new AbortController();
  st.ctrls.set(id, ctrl);
  let text = "";
  try {
    // Background checks run on the SMALL fast model (gpt-oss only steps in if a check gets hard).
    for await (const ev of runAgent("agent", [{ role: "user", content: CHECK_PROMPT(m) }], ctrl.signal, undefined, { auto: true, preferFast: true, forceAgent: true })) {
      if (ev.type === "token") text += ev.value;
      if (ev.type === "step") {
        m.pending = m.pending.filter((p) => p.id !== ev.step.id);
        if (ev.step.status === "awaiting") {
          m.pending.push(ev.step);
          m.status = "needs_input";
          notify("Marigold needs your OK", `${label(m.goal)}: ${ev.step.title}`, m.chatId, "needs_you");
        } else if (m.status === "needs_input" && m.pending.length === 0) m.status = "running";
        m.updatedAt = new Date().toISOString();
      }
    }
    m.checks++;
    m.lastCheck = new Date().toISOString();
    const line = text.trim().split("\n").find((l) => /^(DONE|NOT YET)\s*:/i.test(l.trim())) ?? text.trim();
    m.lastResult = line.replace(/^(DONE|NOT YET)\s*:\s*/i, "").slice(0, 300);
    if (/^DONE\s*:/i.test(line.trim()) && m.repeat) {
      // Keep watching; ping only when what it found changed.
      if (m.lastResult !== m.lastPinged) { m.lastPinged = m.lastResult; notify(`Update: ${label(m.goal)}`, m.lastResult, m.chatId); post(m, m.lastResult, "update"); }
    } else if (/^DONE\s*:/i.test(line.trim())) finish(m, "done", m.lastResult);
    else if (st.monitors.get(m.id)?.status !== ("stopped" as MonitorStatus)) m.status = m.pending.length ? "needs_input" : "running";
  } catch (err) {
    if (!ctrl.signal.aborted) m.lastResult = `Check failed: ${err instanceof Error ? err.message : err}`;
  } finally {
    st.ctrls.delete(id);
    m.updatedAt = new Date().toISOString();
    await save();
  }
}

function finish(m: Monitor, status: MonitorStatus, result: string) {
  m.status = status;
  m.lastResult = result;
  m.pending = [];
  m.updatedAt = new Date().toISOString();
  clearInterval(st.timers.get(m.id));
  st.timers.delete(m.id);
  st.ctrls.get(m.id)?.abort();
  // (a scheduled task already told the user and posted its result when it ran)
  if (status === "done" && !m.scheduled) { notify(`Found it: ${label(m.goal)}`, result, m.chatId); post(m, result, "done"); }
  if (status === "failed" && !m.scheduled) { notify(`Stopped watching: ${label(m.goal)}`, result, m.chatId); post(m, result, "failed"); }
  void audit({ event: "monitor_" + status, goal: m.goal, result });
  void save();
}

function schedule(m: Monitor) {
  clearInterval(st.timers.get(m.id));
  st.timers.set(m.id, setInterval(() => void check(m.id), m.everyMinutes * 60_000));
}

// ---------------------------------------------------------------- scheduled tasks (run at a time, no polling)

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout's ceiling (~24.8 days): longer waits re-arm in chunks
const LATE_GRACE_MS = 6 * 3600_000; // the Mac was off/asleep at the time: still do it if it's within 6 hours

/** The next time after `from` that a repeating task should run (same local clock time), or null for one-offs. */
export function nextRun(from: Date, repeat: Repeat): Date | null {
  if (repeat === "none") return null;
  const d = new Date(from);
  const step = () => d.setDate(d.getDate() + (repeat === "weekly" ? 7 : 1));
  if (repeat === "monthly") d.setMonth(d.getMonth() + 1); else step();
  if (repeat === "weekdays") while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function armScheduled(m: Monitor) {
  clearTimeout(st.timers.get(m.id));
  st.timers.delete(m.id);
  if (!m.scheduled || m.status !== "running") return;
  const wait = Date.parse(m.scheduled.at) - Date.now();
  if (wait <= 0) { void runScheduled(m.id); return; }
  st.timers.set(m.id, setTimeout(() => { if (Date.parse(m.scheduled?.at ?? "0") - Date.now() > 1500) armScheduled(m); else void runScheduled(m.id); }, Math.min(wait, MAX_TIMEOUT)));
}

const SCHEDULED_PROMPT = (m: Monitor, lateMin: number) => `The user scheduled this task for ${new Date(m.scheduled!.at).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })} and approved it then. It is time. Do it now, exactly as described, with as few steps as possible:

${m.goal}
${lateMin > 3 ? `\n(Marigold was ${lateMin} minutes late starting this because the Mac was asleep or off.)` : ""}
Then reply with EXACTLY one line: "DONE: <what you did, e.g. who you messaged and what it said>" or "FAILED: <why it couldn't be done>". Never invent details that weren't in the task.`;

async function runScheduled(id: string) {
  const m = st.monitors.get(id);
  if (!m?.scheduled || m.status !== "running" || st.ctrls.has(id)) return;
  const dueAt = Date.parse(m.scheduled.at);
  const lateMs = Date.now() - dueAt;
  const repeat = m.scheduled.repeat;
  const advance = () => {
    const nxt = nextRun(new Date(Math.max(dueAt, Date.now() - 60_000)), repeat);
    if (!nxt) return false;
    // A repeating task that slept through several runs skips to the next FUTURE time rather than firing a burst.
    while (nxt.getTime() <= Date.now()) { const n2 = nextRun(nxt, repeat); if (!n2) break; nxt.setTime(n2.getTime()); }
    m.scheduled!.at = nxt.toISOString();
    return true;
  };
  if (lateMs > LATE_GRACE_MS) {
    // Way too late to be useful ("pick me up at 2" at 9 pm): say so instead of doing it.
    post(m, `Missed the scheduled time (${new Date(dueAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}): the Mac was off or asleep, so this wasn't done.`, "failed");
    void ping({ kind: "needs_you", title: `Missed: ${label(m.goal)}`, body: "The Mac was off or asleep at the scheduled time, so it wasn't done.", chatId: m.chatId, urgent: true });
    if (advance()) { m.updatedAt = new Date().toISOString(); armScheduled(m); await save(); } else finish(m, "failed", "Missed: the Mac was off at the scheduled time.");
    return;
  }
  const ctrl = new AbortController();
  st.ctrls.set(id, ctrl);
  let text = "";
  try {
    for await (const ev of runAgent("agent", [{ role: "user", content: SCHEDULED_PROMPT(m, Math.round(lateMs / 60_000)) }], ctrl.signal, undefined, { auto: true, forceAgent: true, scheduledApproved: true })) {
      if (ev.type === "token") text += ev.value;
      if (ev.type === "step") {
        m.pending = m.pending.filter((p) => p.id !== ev.step.id);
        if (ev.step.status === "awaiting") {
          m.pending.push(ev.step); m.status = "needs_input";
          notify("Marigold needs your OK", `${label(m.goal)}: ${ev.step.title}`, m.chatId, "needs_you");
        } else if (m.status === "needs_input" && m.pending.length === 0) m.status = "running";
        m.updatedAt = new Date().toISOString();
      }
    }
  } catch (err) {
    if (!ctrl.signal.aborted) text = `FAILED: ${err instanceof Error ? err.message : err}`;
  } finally { st.ctrls.delete(id); }
  if (ctrl.signal.aborted && st.monitors.get(id)?.status === "stopped") return; // cancelled while running
  const line = text.trim().split("\n").reverse().find((l) => /^(DONE|FAILED)\s*:/i.test(l.trim())) ?? text.trim();
  const ok = /^DONE\s*:/i.test(line.trim()) || (!/^FAILED\s*:/i.test(line.trim()) && line.length > 0);
  const result = line.replace(/^(DONE|FAILED)\s*:\s*/i, "").slice(0, 300) || (ok ? "Done." : "It didn't finish.");
  m.scheduled.runs++; m.scheduled.lastRunAt = new Date().toISOString(); m.lastResult = result; m.checks++; m.lastCheck = m.scheduled.lastRunAt;
  m.pending = []; if (m.status === "needs_input") m.status = "running";
  if (ok) { notify(`Done: ${label(m.goal)}`, result, m.chatId); post(m, result, "done"); }
  else { void ping({ kind: "needs_you", title: `Couldn't finish: ${label(m.goal)}`, body: result, chatId: m.chatId, urgent: true }); post(m, result, "failed"); }
  void audit({ event: "scheduled_run", goal: m.goal, ok, result });
  if (advance()) { m.updatedAt = new Date().toISOString(); armScheduled(m); await save(); }
  else finish(m, ok ? "done" : "failed", result);
}

/** Create a task that runs at a specific time (and optionally repeats). The user approved it when it was scheduled. */
export async function createScheduled(chatId: string, goal: string, atISO: string, repeat: Repeat = "none") {
  await ensureLoaded();
  const at = new Date(atISO);
  if (Number.isNaN(at.getTime())) throw new Error("I couldn't understand that time.");
  if (at.getTime() < Date.now() - 60_000) throw new Error("That time has already passed.");
  const now = new Date();
  const m: Monitor = {
    id: `mon_${now.getTime().toString(36)}`, chatId, goal, everyMinutes: 0, until: new Date(at.getTime() + 400 * 86_400_000).toISOString(),
    status: "running", checks: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), pending: [],
    scheduled: { at: at.toISOString(), repeat, runs: 0 },
  };
  st.monitors.set(m.id, m);
  armScheduled(m);
  await save();
  void audit({ event: "scheduled_created", goal, at: m.scheduled!.at, repeat });
  return m;
}

/** "Run now" for a scheduled task (the user wants it done early). */
export async function runScheduledNow(id: string) {
  await ensureLoaded();
  const m = st.monitors.get(id);
  if (!m?.scheduled || m.status !== "running") return false;
  m.scheduled.at = new Date().toISOString();
  void runScheduled(id);
  return true;
}

async function ensureLoaded() {
  if (st.loaded) return;
  st.loaded = true;
  try {
    const list: Monitor[] = JSON.parse(await fs.readFile(FILE, "utf8"));
    for (const m of list) {
      m.pending = []; // approvals from a previous server process can't be answered
      if (m.status === "needs_input") m.status = "running";
      st.monitors.set(m.id, m);
      if (m.status === "running") { if (m.scheduled) armScheduled(m); else schedule(m); }
    }
  } catch { /* none yet */ }
}

export async function createMonitor(chatId: string, goal: string, everyMinutes: number, maxDays: number, repeat = false) {
  await ensureLoaded();
  const now = new Date();
  const m: Monitor = {
    id: `mon_${now.getTime().toString(36)}`,
    chatId,
    goal,
    everyMinutes,
    until: new Date(now.getTime() + maxDays * 86_400_000).toISOString(),
    status: "running",
    checks: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    pending: [],
    repeat,
  };
  st.monitors.set(m.id, m);
  schedule(m);
  await save();
  void audit({ event: "monitor_created", goal, everyMinutes, maxDays });
  setTimeout(() => void check(m.id), 5_000); // first check right away
  return m;
}

export async function listMonitors() {
  await ensureLoaded();
  return [...st.monitors.values()].map((m) => ({ ...m, checking: st.ctrls.has(m.id) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Change what a background watcher is doing; applies from its next check. */
export async function steerMonitor(id: string, text: string) {
  await ensureLoaded();
  const m = st.monitors.get(id);
  if (!m || (m.status !== "running" && m.status !== "needs_input")) return false;
  m.goal += `\nUser update (${new Date().toLocaleString()}): ${text.slice(0, 1000)}`;
  m.updatedAt = new Date().toISOString();
  await save();
  if (!m.scheduled) setTimeout(() => void check(m.id), 1_000); // re-check right away with the new instructions (a scheduled task just runs with the new wording at its time)
  return true;
}

/** Is a check for this monitor running right now? */
export const monitorChecking = (id: string) => st.ctrls.has(id);

/** Pause / resume a background task (paused = no checks until resumed). */
export async function pauseMonitor(id: string, paused: boolean) {
  await ensureLoaded();
  const m = st.monitors.get(id);
  if (!m || (paused ? !["running", "needs_input"].includes(m.status) : m.status !== "paused")) return false;
  m.status = paused ? "paused" : "running";
  m.updatedAt = new Date().toISOString();
  if (paused) { clearInterval(st.timers.get(m.id)); st.timers.delete(m.id); st.ctrls.get(m.id)?.abort(); }
  else if (m.scheduled) armScheduled(m);
  else { schedule(m); setTimeout(() => void check(m.id), 3000); }
  await save();
  return true;
}

export async function stopMonitor(id: string) {
  await ensureLoaded();
  const m = st.monitors.get(id);
  if (!m) return false;
  finish(m, "stopped", "Stopped by you.");
  return true;
}

/** User saw the finished task — remove it from the strip. */
export async function acknowledgeMonitor(id: string) {
  await ensureLoaded();
  const m = st.monitors.get(id);
  if (!m || m.status === "running" || m.status === "needs_input") return false;
  st.monitors.delete(id);
  await save();
  return true;
}

export async function stopAllMonitors() {
  await ensureLoaded();
  let n = 0;
  for (const m of st.monitors.values()) {
    if (m.status === "running" || m.status === "needs_input") {
      finish(m, "stopped", "Stopped by the kill switch.");
      n++;
    }
  }
  return n;
}
