import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { FAST_TAG } from "@/lib/models";
import { MARIGOLD_DIR } from "./policy";
import { inApp } from "./app-secret";
import { ping, pingPrefs, inQuietHours, alreadyPinged, type PingPrefs } from "./notifications";
import { aboutMe } from "./memory";
import { helperBin } from "./helpers";

/**
 * The watcher: Marigold noticing things on its own (like a good assistant would) and pinging
 * the user — without being asked in the moment.
 *
 *   • Calendar — "Starts in 10 min" (with the room / video link).
 *   • Reminders — due now or overdue.
 *   • Messages — a new text that needs the user (a question, a plan, something urgent); the
 *     small fast model reads new texts and only pings what matters.
 *   • Gmail (when connected) — important new email from real people.
 *   • Battery — low and not charging.
 *   • Morning rundown — today's schedule + reminders in two sentences.
 *
 * Detection is cheap code; only the "is this worth a ping?" judgement and the wording use the
 * SMALL model (qwen3:4b-instruct), and only while no agent task is running. Everything stays on
 * this Mac. Each kind can be switched off; quiet hours hold non-urgent pings.
 */

const exec = promisify(execFile);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const STATE = path.join(MARIGOLD_DIR, "watcher-state.json");
const TICK_MS = 2 * 60_000;

interface State { msgRowId?: number; gmailSeen?: string[]; batteryLow?: boolean; lastTick?: string }
const readState = (): State => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } };
async function writeState(s: State) { await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 }); await fs.writeFile(STATE, JSON.stringify(s), { mode: 0o600 }); }

const g = globalThis as unknown as { __marigoldWatcher?: { timer?: NodeJS.Timeout; busy: boolean } };
const w = (g.__marigoldWatcher ??= { busy: false });

/** Start once per engine (only inside the Mac app, or when explicitly enabled). */
export function startWatcher() {
  if (w.timer || (!inApp() && process.env.MARIGOLD_WATCHER !== "1")) return;
  w.timer = setInterval(() => void tick(), TICK_MS);
  setTimeout(() => void tick(), 45_000);
}

export async function tick(force = false) {
  if (w.busy) return;
  w.busy = true;
  try {
    const s = readState();
    void import("./phone-host").then((m) => { if (m.phoneHostWanted()) void m.ensurePhoneHost(); }).catch(() => {});
    for (const check of [calendar, reminders, battery, briefings, messages, gmail, googleWatch, pulseCheck]) {
      try { await check(s, force); } catch (e) { console.warn("[marigold] watcher:", check.name, String(e).slice(0, 160)); }
    }
    s.lastTick = new Date().toISOString();
    await writeState(s);
  } finally { w.busy = false; }
}

// ---------------------------------------------------------------- helpers

async function eventkit(...args: string[]): Promise<unknown> {
  const { stdout } = await exec(await helperBin("eventkit"), args, { timeout: 150_000 });
  return JSON.parse(stdout || "[]");
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Is an agent task running right now? (then don't load the small model next to it) */
async function agentBusy(): Promise<boolean> {
  const { activeRunCount } = await import("./loop");
  return activeRunCount() > 0;
}

/** The small model, for judgement + wording. Returns "" if it isn't available (memory, not installed). */
async function small(system: string, user: string, json = true): Promise<string> {
  const { cloudAll, cloudJson, cloudText } = await import("./cloud");
  if (await cloudAll()) {
    const out = json ? await cloudJson(system, user, undefined, { tier: "light" }) : await cloudText(system, user, AbortSignal.timeout(30_000), { tier: "light" }).catch(() => "");
    if (out) return out;
  }
  const { fastLaneAvailable } = await import("./loop");
  if (!(await fastLaneAvailable(3))) return "";
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: FAST_TAG, stream: false, think: false, keep_alive: "20m", ...(json ? { format: "json" } : {}),
      options: { temperature: 0.2, num_ctx: 16384, num_predict: 500 },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const j = (await r.json()) as { message?: { content?: string } };
  return j.message?.content?.trim() ?? "";
}

/**
 * Names for phone numbers / emails, read straight from the Contacts database (Full Disk Access) —
 * no need to launch the Contacts app in the background. Cached 10 min.
 */
let abCache: { at: number; map: Map<string, string> } | null = null;
async function contactNames(): Promise<Map<string, string>> {
  if (abCache && Date.now() - abCache.at < 600_000) return abCache.map;
  const map = new Map<string, string>();
  const root = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
  const dbs = (await fs.readdir(root).catch(() => [] as string[])).map((d) => path.join(root, d, "AddressBook-v22.abcddb")).filter((f) => existsSync(f));
  for (const db of dbs) {
    const q = async (sql: string) => { try { const r = await exec("sqlite3", ["-readonly", "-json", db, sql], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }); return r.stdout.trim() ? JSON.parse(r.stdout) : []; } catch { return []; } };
    const rows = [
      ...(await q("SELECT TRIM(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) AS name, COALESCE(r.ZNICKNAME,'') AS nick, p.ZFULLNUMBER AS h FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER;")),
      ...(await q("SELECT TRIM(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) AS name, COALESCE(r.ZNICKNAME,'') AS nick, e.ZADDRESS AS h FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER;")),
    ] as { name: string; nick: string; h: string }[];
    for (const r of rows) {
      const name = r.name || r.nick;
      if (!name || !r.h) continue;
      const key = r.h.includes("@") ? r.h.toLowerCase() : r.h.replace(/\D/g, "").slice(-10);
      if (key) map.set(key, name);
    }
  }
  abCache = { at: Date.now(), map };
  return map;
}
const handleKey = (h: string) => (h.includes("@") ? h.toLowerCase() : h.replace(/\D/g, "").slice(-10));

const VOICE = "Write like a sharp friend texting: short, plain, no greeting, no emoji, no em dashes.";
const SECRET_TEXT = /\b(code|passcode|password|otp|verification|2fa|one[- ]time)\b|\b\d{4,8}\b.*\b(is your|code)\b/i;

// ---------------------------------------------------------------- calendar · reminders · battery

async function calendar() {
  const evs = (await eventkit("events", "0", "15")) as { id: string; title: string; start: string; allDay: boolean; location: string; url: string; notes: string }[] | { error: string };
  if (!Array.isArray(evs)) return;
  for (const e of evs) {
    if (e.allDay) continue;
    const mins = Math.round((Date.parse(e.start) - Date.now()) / 60_000);
    if (mins < 0 || mins > 15) continue;
    const link = e.url || e.notes.match(/https?:\/\/\S*(zoom\.us|meet\.google|teams\.microsoft|webex)\S*/i)?.[0] || "";
    await ping({
      kind: "calendar", key: `cal:${e.id}:${e.start}`, urgent: true,
      title: mins <= 1 ? `Starting now: ${e.title}` : `In ${mins} min: ${e.title}`,
      body: [fmtTime(e.start), e.location, link ? "Has a video link" : ""].filter(Boolean).join(" · "),
      url: link || undefined,
    });
  }
}

async function reminders() {
  const rs = (await eventkit("reminders", "5")) as { id: string; title: string; due: string; list: string }[] | { error: string };
  if (!Array.isArray(rs)) return;
  for (const r of rs) {
    if (!r.due) continue;
    const late = Date.now() - Date.parse(r.due);
    await ping({ kind: "reminders", key: `rem:${r.id}:${r.due}`, title: late > 60_000 ? `Overdue: ${r.title}` : `Due now: ${r.title}`, body: `${r.list} · ${fmtTime(r.due)}` });
  }
}

async function pulseCheck() { await (await import("./pulse")).pulseAlerts(); }

async function battery(s: State) {
  const { stdout } = await exec("pmset", ["-g", "batt"]);
  const pct = Number(stdout.match(/(\d+)%/)?.[1] ?? 100);
  const draining = /discharging/i.test(stdout);
  if (!draining || pct > 25) { s.batteryLow = false; return; }
  if (pct <= 15 && !s.batteryLow) {
    s.batteryLow = true;
    await ping({ kind: "battery", urgent: true, title: `Battery at ${pct}%`, body: "Plug in soon. Marigold's local model drains the battery fast." });
  }
}

// ---------------------------------------------------------------- daily briefings (6am · 2pm · 10pm)

/**
 * Three times a day Marigold reads everything it can see (calendar, reminders, texts, email, device) and, without being
 * asked, tells the user the few things that are actually crucial: what's on, who's waiting on them, what could collide.
 * Missed slots (Mac asleep) are delivered when the Mac wakes, up to 3 hours late.
 */
type Slot = "morning" | "afternoon" | "evening";
const SLOTS: { id: Slot; label: string; goal: string }[] = [
  { id: "morning", label: "Morning briefing", goal: "Plan the day: the first thing on, what needs prep, deadlines today, people waiting on a reply, anything that overlaps." },
  { id: "afternoon", label: "Afternoon check-in", goal: "What's left today and what changed since morning: upcoming events this afternoon/evening, new messages or email that need an answer, things due tonight." },
  { id: "evening", label: "Evening wrap-up", goal: "Close the day: anything unfinished or overdue, what's first tomorrow (time + prep to do tonight), deadlines in the next two days, unanswered people." },
];

async function briefings(_s: State, _force: boolean) {
  const p = pingPrefs();
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = now.toLocaleDateString("en-CA");
  for (const [i, slot] of SLOTS.entries()) {
    const [h, m] = (p.briefTimes?.[i] ?? ["06:00", "14:00", "22:00"][i]).split(":").map(Number);
    const at = h * 60 + m;
    if (mins < at || mins >= at + 180 || alreadyPinged(`brief:${today}:${slot.id}`, 20 * 3600_000)) continue;
    await runBriefing(slot.id, `brief:${today}:${slot.id}`);
  }
}

interface EventRow { id: string; title: string; start: string; end?: string; allDay: boolean; location: string; url?: string; notes?: string; calendar?: string }

/** Everything that might matter, as plain text for the model (and as a fallback summary when no model is available). */
async function gatherFacts(slot: Slot): Promise<{ facts: string; fallback: string[] }> {
  const now = new Date();
  const horizonMin = slot === "evening" ? 36 * 60 : slot === "afternoon" ? 20 * 60 : 24 * 60;
  const parts: string[] = [`NOW: ${now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`];
  const fallback: string[] = [];

  // Calendar (macOS Calendar, which includes any Google/iCloud accounts added there) + Google Calendar API when connected.
  const evs: EventRow[] = [];
  const raw = (await eventkit("events", "0", String(horizonMin)).catch(() => [])) as EventRow[] | { error: string };
  if (Array.isArray(raw)) evs.push(...raw);
  const { connectedAccounts, gapi } = await import("./google");
  const accts = await connectedAccounts().catch(() => []);
  for (const a of accts.slice(0, 3)) {
    const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + horizonMin * 60_000).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "25" });
    const r = (await gapi(a.email, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`).catch(() => ({}))) as { items?: { id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; location?: string; hangoutLink?: string }[] };
    for (const e of r.items ?? []) {
      const start = e.start?.dateTime ?? e.start?.date;
      if (!start) continue;
      if (evs.some((x) => x.title === (e.summary ?? "") && Math.abs(Date.parse(x.start) - Date.parse(start)) < 60_000)) continue; // already seen via macOS Calendar
      evs.push({ id: e.id, title: e.summary ?? "(no title)", start, end: e.end?.dateTime, allDay: !e.start?.dateTime, location: e.location ?? "", url: e.hangoutLink });
    }
  }
  evs.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
  if (evs.length) {
    const day = (iso: string) => new Date(iso).toDateString() === now.toDateString() ? "today" : new Date(iso).toDateString() === new Date(now.getTime() + 86400_000).toDateString() ? "tomorrow" : new Date(iso).toLocaleDateString("en-US", { weekday: "long" });
    const line = (e: EventRow) => `${day(e.start)} ${e.allDay ? "all day" : fmtTime(e.start) + (e.end ? "–" + fmtTime(e.end) : "")} ${e.title}${e.location ? ` @ ${e.location.slice(0, 60)}` : ""}${e.url || /zoom\.us|meet\.google|teams\.microsoft/i.test(e.notes ?? "") ? " [video call]" : ""}`;
    parts.push(`CALENDAR:\n${evs.slice(0, 20).map(line).join("\n")}`);
    fallback.push(...evs.filter((e) => !e.allDay).slice(0, 3).map((e) => `${day(e.start)} ${fmtTime(e.start)}: ${e.title}`));
    // Clashes: two timed events that overlap.
    const timed = evs.filter((e) => !e.allDay && e.end);
    const clashes: string[] = [];
    for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) if (Date.parse(timed[j].start) < Date.parse(timed[i].end!) && Date.parse(timed[i].start) < Date.parse(timed[j].end!) && timed[i].title !== timed[j].title) clashes.push(`“${timed[i].title}” overlaps “${timed[j].title}” (${day(timed[j].start)} ${fmtTime(timed[j].start)})`);
    if (clashes.length) { parts.push(`SCHEDULE CLASHES: ${clashes.slice(0, 3).join("; ")}`); fallback.unshift(`Clash: ${clashes[0]}`); }
  } else parts.push("CALENDAR: nothing in the next day.");

  // Reminders (overdue and due soon).
  const rs = (await eventkit("reminders", String(horizonMin + 12 * 60)).catch(() => [])) as { title: string; due: string; list: string }[] | { error: string };
  if (Array.isArray(rs) && rs.length) {
    const rl = rs.slice(0, 15).map((r) => `${r.due && Date.parse(r.due) < Date.now() ? "OVERDUE " : ""}${r.title}${r.due ? ` (due ${new Date(r.due).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })})` : ""}`);
    parts.push(`REMINDERS:\n${rl.join("\n")}`);
    const over = rs.filter((r) => r.due && Date.parse(r.due) < Date.now()).length;
    if (over) fallback.push(`${over} overdue reminder${over > 1 ? "s" : ""}`);
  }

  // Texts from the last 14 hours.
  try {
    const db = path.join(os.homedir(), "Library/Messages/chat.db");
    const q = (sql: string) => exec("sqlite3", ["-readonly", "-json", db, sql], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => (r.stdout.trim() ? JSON.parse(r.stdout) : []));
    const rows = (await q(`SELECT m.text, hex(m.attributedBody) AS ab, COALESCE(h.id,'') AS sender, COALESCE(c.display_name,'') AS chat
      FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.is_from_me = 0 AND m.item_type = 0 AND m.date > (strftime('%s','now') - 978307200 - 14*3600) * 1000000000 ORDER BY m.ROWID DESC LIMIT 40;`)) as { text: string | null; ab: string; sender: string; chat: string }[];
    const { decodeAttributed } = await import("./tools");
    const names = await contactNames();
    const items = rows.map((r) => ({ who: names.get(handleKey(r.sender)) ?? r.sender, chat: r.chat, text: (r.text || decodeAttributed(r.ab) || "").replace(/\s+/g, " ").trim() })).filter((r) => r.text && !SECRET_TEXT.test(r.text));
    if (items.length) { parts.push(`TEXTS (last 14h, newest first):\n${items.slice(0, 25).map((m) => `${m.who}${m.chat ? ` in “${m.chat}”` : ""}: ${m.text.slice(0, 180)}`).join("\n")}`); fallback.push(`${items.length} new text${items.length > 1 ? "s" : ""}`); }
  } catch { /* no Full Disk Access */ }

  // Unread email (Gmail, when connected).
  for (const a of accts.slice(0, 2)) {
    try {
      const base = "https://gmail.googleapis.com/gmail/v1/users/me";
      const l = (await gapi(a.email, `${base}/messages?maxResults=15&q=${encodeURIComponent("is:unread category:primary newer_than:2d")}`)) as { messages?: { id: string }[] };
      const metas = await Promise.all((l.messages ?? []).slice(0, 12).map(async ({ id }) => {
        const m = (await gapi(a.email, `${base}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
        const hd = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
        return `${hd("from").replace(/<.*>/, "").trim()} — “${hd("subject")}”: ${(m.snippet ?? "").slice(0, 140)}`;
      }));
      if (metas.length) { parts.push(`UNREAD EMAIL (${a.email}):\n${metas.join("\n")}`); fallback.push(`${metas.length} unread email${metas.length > 1 ? "s" : ""}`); }
    } catch { /* not connected / scope missing */ }
  }

  // The Mac itself.
  const dev: string[] = [];
  try { const { stdout } = await exec("pmset", ["-g", "batt"]); const pct = Number(stdout.match(/(\d+)%/)?.[1] ?? 100); if (pct <= 30 && /discharging/i.test(stdout)) dev.push(`battery ${pct}% and not charging`); } catch { /* ignore */ }
  try { const { stdout } = await exec("df", ["-g", "/System/Volumes/Data"]); const free = Number(stdout.trim().split("\n")[1]?.split(/\s+/)[3]); if (free && free < 8) dev.push(`only ${free} GB of disk space left`); } catch { /* ignore */ }
  if (dev.length) { parts.push(`THIS MAC: ${dev.join("; ")}`); fallback.push(dev[0]); }

  const me = aboutMe().slice(0, 25);
  if (me.length) parts.push(`WHAT YOU KNOW ABOUT THE USER (for judging what matters to them):\n${me.join("\n")}`);
  return { facts: parts.join("\n\n"), fallback };
}

/** Build one briefing and send it. `key` dedupes the scheduled ones; manual runs pass a unique key. */
export async function runBriefing(slotId: Slot, key: string) {
  const slot = SLOTS.find((x) => x.id === slotId)!;
  const { facts, fallback } = await gatherFacts(slotId);
  const out = await small(
    `You are the user's chief of staff. You've read everything on their Mac and accounts. ${slot.goal}
Tell them ONLY what is crucial or important: time-sensitive events and the prep they need, deadlines, schedule clashes, people waiting on a reply, important email (school, work, family, appointments, money, deadlines). Ignore newsletters, promos, receipts and automated noise unless they involve money or a deadline. Never invent anything that isn't in the data.
Each bullet is concrete: who/what/when, ≤ 115 characters, starts with the thing itself (not "You have"). 1–5 bullets, most important first. If genuinely nothing needs them, give ONE bullet saying so plainly. ${VOICE}
Reply JSON: {"headline":"<3–7 words that sum up the most important thing>","bullets":["…"]}`,
    facts,
  ).catch(() => "");
  let headline = "", bullets: string[] = [];
  try { const j = JSON.parse(out); headline = String(j.headline ?? ""); bullets = (Array.isArray(j.bullets) ? j.bullets : []).map(String).filter(Boolean).slice(0, 5); } catch { /* fall back below */ }
  if (!bullets.length) bullets = fallback.length ? fallback.slice(0, 5) : ["Nothing needs you right now."];
  await ping({
    kind: "briefing", key, urgent: true,
    title: `${slot.label}${headline ? `: ${headline.replace(/[.]$/, "")}` : ""}`,
    body: bullets.map((b) => `• ${b}`).join("\n"),
  });
}

// ---------------------------------------------------------------- messages

async function messages(s: State) {
  const db = path.join(os.homedir(), "Library/Messages/chat.db");
  const q = (sql: string) => exec("sqlite3", ["-readonly", "-json", db, sql], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => (r.stdout.trim() ? JSON.parse(r.stdout) : []));
  let rows: { id: number; text: string | null; ab: string; sender: string; chat: string; date: number }[];
  try {
    if (s.msgRowId == null) { s.msgRowId = ((await q("SELECT MAX(ROWID) AS m FROM message;")) as { m: number }[])[0]?.m ?? 0; return; } // start from now, never history
    rows = await q(`SELECT m.ROWID AS id, m.text, hex(m.attributedBody) AS ab, COALESCE(h.id,'') AS sender, COALESCE(c.display_name,'') AS chat, m.date
      FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ${Number(s.msgRowId)} AND m.is_from_me = 0 AND m.item_type = 0 ORDER BY m.ROWID LIMIT 40;`);
  } catch { return; } // no Full Disk Access
  if (!rows.length) return;
  s.msgRowId = Math.max(s.msgRowId ?? 0, ...rows.map((r) => r.id));
  if (await agentBusy()) return;
  const { decodeAttributed } = await import("./tools");
  const names = await contactNames();
  const nameOf = (h: string) => names.get(handleKey(h)) ?? h;
  const items = rows.map((r) => ({ id: r.id, who: nameOf(r.sender), chat: r.chat, text: (r.text || decodeAttributed(r.ab) || "").replace(/\s+/g, " ").trim() }))
    .filter((r) => r.text && !SECRET_TEXT.test(r.text)).slice(-20);
  if (!items.length) return;
  const known = new Set(names.values());
  const out = await small(
    `You decide which new text messages deserve a ping from the user's assistant. Ping ONLY when a text needs the user: a direct question to them, a request or plan with a time/place, something urgent, or important news from family/friends. Skip chit-chat, reactions, group banter, promos, delivery/bank alerts and anything already obvious. ${VOICE}
Reply JSON: {"pings":[{"n":<number>,"title":"<who: 3–6 word gist>","body":"<what they need, 1 short sentence>"}]} — empty list if nothing matters.`,
    items.map((m, i) => `[${i + 1}] ${m.who}${known.has(m.who) ? " (contact)" : ""}${m.chat ? ` in “${m.chat}”` : ""}: ${m.text.slice(0, 300)}`).join("\n"),
  ).catch(() => "");
  let picks: { n: number; title: string; body: string }[] = [];
  try { picks = JSON.parse(out).pings ?? []; } catch { /* no model → no message pings */ }
  for (const p of picks.slice(0, 3)) {
    const m = items[p.n - 1];
    if (!m) continue;
    await ping({ kind: "messages", key: `msg:${m.id}`, title: String(p.title || m.who), body: String(p.body || m.text) });
  }
}

// ---------------------------------------------------------------- Gmail (when connected)

/** Classroom, Drive/Docs/Slides/Sheets, Calendar invitations and Tasks (see google-watch.ts). */
async function googleWatch(_s: State, force = false) {
  const { pingGoogle } = await import("./google-watch");
  await pingGoogle({ force });
}

async function gmail(s: State) {
  const { connectedAccounts, gapi } = await import("./google");
  const accts = await connectedAccounts().catch(() => []);
  if (!accts.length) return;
  const me = accts[0].email;
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  const l = (await gapi(me, `${base}/messages?maxResults=10&q=${encodeURIComponent("is:unread category:primary newer_than:1d")}`).catch(() => ({}))) as { messages?: { id: string }[] };
  const seen = new Set(s.gmailSeen ?? []);
  const fresh = (l.messages ?? []).filter((m) => !seen.has(m.id));
  s.gmailSeen = [...(l.messages ?? []).map((m) => m.id), ...(s.gmailSeen ?? [])].slice(0, 300);
  if (!fresh.length || (await agentBusy())) return;
  const metas = await Promise.all(fresh.slice(0, 8).map(async ({ id }) => {
    const m = (await gapi(me, `${base}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
    const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    return { id, from: h("from"), subject: h("subject"), snippet: (m.snippet ?? "").slice(0, 200) };
  }));
  const out = await small(
    `You decide which new emails deserve a ping. Ping ONLY real people or institutions the user deals with (school, teachers, work, family, appointments, deadlines, replies they're waiting on). Skip newsletters, promos, social notifications, receipts, security codes. ${VOICE}
Reply JSON: {"pings":[{"n":<number>,"title":"<sender: gist>","body":"<what it's about / what to do, 1 sentence>"}]}`,
    metas.map((m, i) => `[${i + 1}] From ${m.from} — “${m.subject}”: ${m.snippet}`).join("\n"),
  ).catch(() => "");
  let picks: { n: number; title: string; body: string }[] = [];
  try { picks = JSON.parse(out).pings ?? []; } catch { /* nothing */ }
  for (const p of picks.slice(0, 3)) {
    const m = metas[p.n - 1];
    if (!m) continue;
    await ping({ kind: "email", key: `gmail:${m.id}`, title: String(p.title || m.subject), body: String(p.body || m.snippet), url: `https://mail.google.com/mail/u/0/#inbox/${m.id}` });
  }
}

export { inQuietHours };
export type { PingPrefs };
