import { promises as fs, readFileSync } from "fs";
import path from "path";
import { MARIGOLD_DIR } from "./policy";
import type { PingKind } from "./notifications";

/**
 * Notifications from the user's Google account, beyond Gmail: Classroom (announcements, new work, due soon, grades), Drive (files shared
 * with you, edits by others, comments and replies on Docs / Slides / Sheets), Calendar invitations and cancellations, and Google Tasks that
 * are due. Plain code compares what Google says now with what was seen before; no AI is needed, so it works with or without credits.
 *
 * - The first look at each source only remembers what is already there (no flood of old items).
 * - Sources are checked at different paces so Google's quotas are never a worry.
 * - A source whose permission was never granted is skipped, and the user is told once how to add it (reconnect Google).
 * - Nothing is changed in the account: every call is a read.
 */

export interface Found { kind: PingKind; key: string; title: string; body: string; url?: string; urgent?: boolean }
export type Get = (url: string) => Promise<unknown>;
type Src = "classroom" | "shared" | "edits" | "comments" | "invites" | "tasks";

const FILE = path.join(MARIGOLD_DIR, "google-watch.json");
interface PerAccount { started?: Partial<Record<Src, boolean>>; last?: Partial<Record<Src, number>>; since?: Partial<Record<Src, string>>; seen?: Partial<Record<Src, string[]>> }
type Store = Record<string, PerAccount>;
function read(): Store { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; } }
async function write(s: Store) { await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 }); await fs.writeFile(FILE, JSON.stringify(s), { mode: 0o600 }); }

/** How often each source is looked at. */
export const EVERY: Record<Src, number> = { classroom: 8 * 60_000, shared: 4 * 60_000, edits: 5 * 60_000, comments: 5 * 60_000, invites: 4 * 60_000, tasks: 15 * 60_000 };
/** The permission each source needs (the account's granted scopes must contain every one). */
export const NEEDS: Record<Src, string[]> = {
  classroom: ["classroom.courses.readonly", "classroom.announcements.readonly", "classroom.coursework.me.readonly", "classroom.student-submissions.me.readonly"],
  shared: ["drive.readonly"], edits: ["drive.readonly"], comments: ["drive.readonly"], invites: ["calendar.events"], tasks: ["auth/tasks"],
};
const has = (scopes: string, needs: string[]) => needs.every((n) => scopes.includes(n));

const clip = (t: unknown, n: number) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const FILE_KIND = (m: string) => (/document/.test(m) ? "Doc" : /presentation/.test(m) ? "Slides" : /spreadsheet/.test(m) ? "Sheet" : /form/.test(m) ? "Form" : "file");

// ---------------------------------------------------------------- classroom

interface Course { id: string; name?: string }
interface Work { id: string; title?: string; updateTime?: string; creationTime?: string; alternateLink?: string; dueDate?: { year: number; month: number; day: number }; dueTime?: { hours?: number; minutes?: number }; maxPoints?: number }
export const dueMs = (w: Work): number | null => (w.dueDate ? Date.UTC(w.dueDate.year, w.dueDate.month - 1, w.dueDate.day, w.dueTime?.hours ?? 23, w.dueTime?.minutes ?? 59) : null);

export async function classroom(get: Get, seen: Set<string>, first: boolean, now = Date.now()): Promise<Found[]> {
  const out: Found[] = [];
  const add = (f: Found) => { if (seen.has(f.key)) return; seen.add(f.key); if (!first) out.push(f); };
  const courses = ((await get("https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&studentId=me&pageSize=12")) as { courses?: Course[] }).courses ?? [];
  for (const c of courses.slice(0, 8)) {
    const name = clip(c.name, 40);
    const base = `https://classroom.googleapis.com/v1/courses/${c.id}`;
    const [ann, work, subs] = await Promise.all([
      get(`${base}/announcements?pageSize=5&orderBy=updateTime%20desc`).catch(() => ({})) as Promise<{ announcements?: { id: string; text?: string; alternateLink?: string; creationTime?: string }[] }>,
      get(`${base}/courseWork?pageSize=15&orderBy=updateTime%20desc`).catch(() => ({})) as Promise<{ courseWork?: Work[] }>,
      get(`${base}/courseWork/-/studentSubmissions?userId=me&pageSize=30`).catch(() => ({})) as Promise<{ studentSubmissions?: { id: string; courseWorkId: string; state?: string; assignedGrade?: number; draftGrade?: number; alternateLink?: string }[] }>,
    ]);
    for (const a of ann.announcements ?? []) add({ kind: "classroom", key: `classroom:ann:${a.id}`, title: `${name}: new announcement`, body: clip(a.text, 200) || "A new announcement was posted.", url: a.alternateLink });
    const byId = new Map((work.courseWork ?? []).map((w) => [w.id, w]));
    for (const w of work.courseWork ?? []) add({ kind: "classroom", key: `classroom:work:${w.id}`, title: `${name}: new work`, body: `${clip(w.title, 120)}${dueMs(w) ? `, due ${when(dueMs(w)!)}` : ""}`, url: w.alternateLink });
    for (const s of subs.studentSubmissions ?? []) {
      const w = byId.get(s.courseWorkId); if (!w) continue;
      const due = dueMs(w);
      // not handed in, due within a day (or just passed)
      if (due && !/TURNED_IN|RETURNED/.test(s.state ?? "") && due - now < 24 * 3600_000 && due - now > -6 * 3600_000) add({ kind: "classroom", key: `classroom:due:${s.id}:${new Date(due).toISOString().slice(0, 10)}`, title: `${name}: ${due < now ? "just passed" : "due soon"}`, body: `${clip(w.title, 120)}, due ${when(due)}. Not handed in yet.`, url: s.alternateLink ?? w.alternateLink, urgent: due - now < 3 * 3600_000 });
      if (s.state === "RETURNED" && s.assignedGrade !== undefined) add({ kind: "classroom", key: `classroom:grade:${s.id}:${s.assignedGrade}`, title: `${name}: grade posted`, body: `${clip(w.title, 120)}: ${s.assignedGrade}${w.maxPoints ? ` / ${w.maxPoints}` : ""}`, url: s.alternateLink ?? w.alternateLink });
    }
  }
  return out;
}

// ---------------------------------------------------------------- drive (docs, slides, sheets, forms)

interface DFile { id: string; name?: string; mimeType?: string; webViewLink?: string; sharedWithMeTime?: string; modifiedTime?: string; sharingUser?: { displayName?: string }; lastModifyingUser?: { displayName?: string; me?: boolean } }
const DRIVE = "https://www.googleapis.com/drive/v3";
const GOOGLE_FILES = "(mimeType contains 'application/vnd.google-apps.document' or mimeType contains 'application/vnd.google-apps.presentation' or mimeType contains 'application/vnd.google-apps.spreadsheet' or mimeType contains 'application/vnd.google-apps.form')";

export async function sharedWithMe(get: Get, seen: Set<string>, first: boolean): Promise<Found[]> {
  const out: Found[] = [];
  const q = encodeURIComponent("sharedWithMe = true and trashed = false");
  const r = (await get(`${DRIVE}/files?q=${q}&orderBy=sharedWithMeTime%20desc&pageSize=10&fields=files(id,name,mimeType,webViewLink,sharedWithMeTime,sharingUser(displayName))`)) as { files?: DFile[] };
  for (const f of r.files ?? []) {
    const key = `drive:shared:${f.id}`; if (seen.has(key)) continue; seen.add(key); if (first) continue;
    out.push({ kind: "docs", key, title: `${clip(f.sharingUser?.displayName, 40) || "Someone"} shared a ${FILE_KIND(f.mimeType ?? "")} with you`, body: clip(f.name, 120), url: f.webViewLink });
  }
  return out;
}

/** Google files changed by someone else since the last look, at most one ping per file per hour. */
export async function editedByOthers(get: Get, seen: Set<string>, first: boolean, since: string, now = Date.now()): Promise<{ found: Found[]; files: DFile[] }> {
  const q = encodeURIComponent(`${GOOGLE_FILES} and trashed = false and modifiedTime > '${since}'`);
  const r = (await get(`${DRIVE}/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=15&fields=files(id,name,mimeType,webViewLink,modifiedTime,lastModifyingUser(displayName,me))`)) as { files?: DFile[] };
  const found: Found[] = [];
  const hour = Math.floor(now / 3600_000);
  for (const f of r.files ?? []) {
    if (f.lastModifyingUser?.me) continue;
    const key = `drive:edit:${f.id}:${hour}`; if (seen.has(key)) continue; seen.add(key); if (first) continue;
    found.push({ kind: "docs", key, title: `${clip(f.lastModifyingUser?.displayName, 40) || "Someone"} edited a ${FILE_KIND(f.mimeType ?? "")}`, body: clip(f.name, 120), url: f.webViewLink });
  }
  return { found, files: r.files ?? [] };
}

export async function commentsOn(get: Get, files: DFile[], seen: Set<string>, first: boolean): Promise<Found[]> {
  const out: Found[] = [];
  for (const f of files.slice(0, 10)) {
    const r = (await get(`${DRIVE}/files/${f.id}/comments?pageSize=5&includeDeleted=false&fields=comments(id,content,createdTime,author(displayName,me),replies(id,content,author(displayName,me)))`).catch(() => ({}))) as { comments?: { id: string; content?: string; author?: { displayName?: string; me?: boolean }; replies?: { id: string; content?: string; author?: { displayName?: string; me?: boolean } }[] }[] };
    for (const c of r.comments ?? []) {
      for (const x of [{ id: c.id, content: c.content, author: c.author, verb: "commented on" }, ...(c.replies ?? []).map((p) => ({ ...p, verb: "replied on" }))]) {
        if (x.author?.me) continue;
        const key = `drive:comment:${x.id}`; if (seen.has(key)) continue; seen.add(key); if (first) continue;
        out.push({ kind: "docs", key, title: `${clip(x.author?.displayName, 40) || "Someone"} ${x.verb} “${clip(f.name, 40)}”`, body: clip(x.content, 200), url: f.webViewLink });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- calendar invitations

interface CEvent { id: string; status?: string; summary?: string; htmlLink?: string; updated?: string; start?: { dateTime?: string; date?: string }; organizer?: { email?: string; displayName?: string; self?: boolean }; attendees?: { self?: boolean; responseStatus?: string }[] }
export async function invitations(get: Get, seen: Set<string>, first: boolean, since: string): Promise<Found[]> {
  const out: Found[] = [];
  const r = (await get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?updatedMin=${encodeURIComponent(since)}&showDeleted=true&singleEvents=true&maxResults=25`)) as { items?: CEvent[] };
  for (const e of r.items ?? []) {
    if (e.organizer?.self) continue;
    const startMs = Date.parse(e.start?.dateTime ?? e.start?.date ?? "");
    const timeText = Number.isFinite(startMs) ? `, ${when(startMs)}` : "";
    const me = e.attendees?.find((a) => a.self);
    if (e.status === "cancelled") { const key = `cal:cancel:${e.id}`; if (!seen.has(key)) { seen.add(key); if (!first && me) out.push({ kind: "invites", key, title: "Event cancelled", body: clip(e.summary, 120) || "An event on your calendar was cancelled.", url: e.htmlLink }); } continue; }
    if (me?.responseStatus === "needsAction") { const key = `cal:invite:${e.id}`; if (!seen.has(key)) { seen.add(key); if (!first) out.push({ kind: "invites", key, title: `Invitation from ${clip(e.organizer?.displayName ?? e.organizer?.email, 40) || "someone"}`, body: `${clip(e.summary, 100)}${timeText}. You haven't replied.`, url: e.htmlLink }); } }
  }
  return out;
}

// ---------------------------------------------------------------- google tasks

export async function tasksDue(get: Get, seen: Set<string>, now = Date.now()): Promise<Found[]> {
  const out: Found[] = [];
  const end = new Date(now); end.setHours(23, 59, 59, 0);
  const r = (await get(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=false&dueMax=${encodeURIComponent(end.toISOString())}&maxResults=20`)) as { items?: { id: string; title?: string; due?: string }[] };
  const day = new Date(now).toISOString().slice(0, 10);
  for (const t of r.items ?? []) {
    if (!t.due) continue;
    const key = `tasks:due:${t.id}:${day}`; if (seen.has(key)) continue; seen.add(key);
    const late = Date.parse(t.due) < now - 24 * 3600_000;
    out.push({ kind: "tasks", key, title: late ? "Task overdue" : "Task due today", body: clip(t.title, 140) || "A task", url: "https://tasks.google.com/" });
  }
  return out;
}

// ---------------------------------------------------------------- the run

const cap = (a: string[]) => a.slice(-400);

/** Look at every source for every connected account. Returns the notifications to send (the caller pings them). */
export async function checkGoogle(opts: { force?: boolean; accounts?: { email: string; scopes: string }[]; get?: (email: string) => Get; now?: number } = {}): Promise<{ found: Found[]; missing: string[] }> {
  const { connectedAccounts, gapi } = await import("./google");
  const accounts = opts.accounts ?? (await connectedAccounts().catch(() => []));
  const store = read(); const found: Found[] = []; const missing = new Set<string>();
  const now = opts.now ?? Date.now();
  for (const acct of accounts) {
    const raw: Get = opts.get ? opts.get(acct.email) : (url) => gapi(acct.email, url);
    // A reused connection that Google already closed shows up as "fetch failed": try once more on a fresh one.
    const get: Get = async (url) => { try { return await raw(url); } catch (e) { if (!/fetch failed|ECONNRESET|socket/i.test(String(e))) throw e; await new Promise((r) => setTimeout(r, 800)); return raw(url); } };
    const st: PerAccount = (store[acct.email] ??= {});
    st.started ??= {}; st.last ??= {}; st.since ??= {}; st.seen ??= {};
    const run = async (src: Src, fn: (seen: Set<string>, first: boolean) => Promise<Found[]>) => {
      if (!has(acct.scopes, NEEDS[src])) { if (src === "classroom") missing.add("Classroom"); return; }
      if (!opts.force && now - (st.last![src] ?? 0) < EVERY[src]) return;
      const seen = new Set(st.seen![src] ?? []); const first = !st.started![src];
      try { found.push(...(await fn(seen, first))); st.started![src] = true; st.last![src] = now; st.seen![src] = cap([...seen]); }
      catch (e) { console.warn("[marigold] google watch:", src, String(e).slice(0, 140), String((e as { cause?: unknown })?.cause ?? "").slice(0, 120)); }
    };
    await run("classroom", (seen, first) => classroom(get, seen, first, now));
    await run("shared", (seen, first) => sharedWithMe(get, seen, first));
    let edited: DFile[] = [];
    await run("edits", async (seen, first) => {
      const since = st.since!.edits ?? new Date(now - 30 * 60_000).toISOString();
      const r = await editedByOthers(get, seen, first, since, now); edited = r.files; st.since!.edits = new Date(now - 60_000).toISOString(); return r.found;
    });
    await run("comments", async (seen, first) => {
      const files = edited.length ? edited : (((await get(`${DRIVE}/files?q=${encodeURIComponent(`${GOOGLE_FILES} and trashed = false`)}&orderBy=viewedByMeTime%20desc&pageSize=10&fields=files(id,name,webViewLink)`)) as { files?: DFile[] }).files ?? []);
      return commentsOn(get, files, seen, first);
    });
    await run("invites", async (seen, first) => { const since = st.since!.invites ?? new Date(now - 24 * 3600_000).toISOString(); const r = await invitations(get, seen, first, since); st.since!.invites = new Date(now - 60_000).toISOString(); return r; });
    await run("tasks", (seen) => tasksDue(get, seen, now));
  }
  await write(store);
  return { found, missing: [...missing] };
}

/** One-time pings from checkGoogle's result. */
export async function pingGoogle(opts: Parameters<typeof checkGoogle>[0] = {}): Promise<number> {
  const { ping, alreadyPinged } = await import("./notifications");
  const { found, missing } = await checkGoogle(opts);
  let n = 0;
  for (const f of found.slice(0, 12)) if (await ping({ kind: f.kind, key: f.key, title: f.title, body: f.body, url: f.url, urgent: f.urgent })) n++;
  for (const m of missing) { const key = `google-scope:${m}`; if (!alreadyPinged(key, 30 * 86_400_000)) await ping({ kind: "task", key, title: `Marigold can now tell you about ${m}`, body: "Reconnect Google in Settings › Connections to allow it. Until then nothing changes." }); }
  return n;
}
