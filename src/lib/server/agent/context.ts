import { execFile } from "child_process";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { ToolDef } from "./tools";
import { rankContacts } from "./tools";

/**
 * Cross-app context ("the ecosystem"): everything Marigold already knows about a
 * person, gathered from Contacts, Mail, Calendar history, Messages and Notes in one
 * call — so "set up a meeting with my tutor Sinisia at 5" can use her email, her
 * usual Zoom link and how long your sessions usually run, without asking the user.
 *
 * Read-only. Every source has its own time limit; a missing or slow source is
 * reported ("Mail: no account set up") instead of failing the whole lookup.
 */

const execAsync = promisify(execFile);
const asq = (t: string) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

async function osa(script: string, timeout = 30_000): Promise<string> {
  const { stdout } = await execAsync("osascript", ["-e", `with timeout of ${Math.ceil(timeout / 1000)} seconds\n${script}\nend timeout`], {
    timeout: timeout + 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const LINK = /https?:\/\/(?:[\w-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|whereby\.com|calendly\.com)\/[^\s<>")\]]+/gi;
const ROLE = /\b(tutor|teacher|coach|professor|prof\.|dr\.|doctor|counselor|instructor|mentor|manager|advisor|therapist|dentist|trainer|lawyer|realtor|recruiter)\b/i;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const SEP = "␞"; // record separator unlikely to appear in user data

async function fromContacts(name: string) {
  const { ranked } = await rankContacts(name);
  const top = ranked.slice(0, 3);
  if (!top.length) return { lines: ["Contacts: no match."], emails: [], phones: [], names: [] as string[] };
  const details = await Promise.all(top.map(async (p) => {
    const extra = await osa(`tell application "Contacts"
  set p to first person whose name is "${asq(p.name)}"
  set o to ""
  try
    if organization of p is not missing value then set o to o & "org: " & organization of p & "; "
  end try
  try
    if job title of p is not missing value then set o to o & "job: " & job title of p & "; "
  end try
  try
    if note of p is not missing value then set o to o & "note: " & note of p
  end try
  return o
end tell`, 10_000).catch(() => "");
    return `${p.name} — ${p.handles.join(", ")}${extra ? ` (${extra.slice(0, 200)})` : ""}`;
  }));
  const handles = top.flatMap((p) => p.handles);
  return {
    lines: [`Contacts (${top.length > 1 ? "several matches" : "1 match"}):`, ...details.map((d) => `  • ${d}`)],
    emails: handles.filter((h) => h.includes("@")),
    phones: handles.filter((h) => !h.includes("@")),
    names: top.map((p) => p.name),
  };
}

async function fromMail(terms: string[]) {
  const accounts = await osa('tell application "Mail" to return count of accounts', 10_000).catch(() => "0");
  if (accounts.trim() === "0") return { lines: ["Mail: no account set up in the Mail app, so emails can't be searched yet."], text: "" };
  const cond = terms.map((t) => `sender contains "${asq(t)}" or subject contains "${asq(t)}"`).join(" or ");
  const raw = await osa(`tell application "Mail"
  set out to ""
  set n to 0
  repeat with acc in accounts
    repeat with mb in mailboxes of acc
      set mbName to name of mb
      if mbName is "INBOX" or mbName contains "Sent" or mbName contains "All Mail" then
        try
          set ms to (messages of mb whose (${cond}))
          repeat with m in ms
            if n ≥ 8 then exit repeat
            set c to ""
            try
              set c to content of m
              if (length of c) > 1500 then set c to text 1 thru 1500 of c
            end try
            set out to out & (sender of m) & "${SEP}" & (subject of m) & "${SEP}" & ((date received of m) as text) & "${SEP}" & c & "${SEP}${SEP}"
            set n to n + 1
          end repeat
        end try
      end if
      if n ≥ 8 then exit repeat
    end repeat
  end repeat
  return out
end tell`, 45_000).catch((e) => `ERR ${String(e).slice(0, 120)}`);
  if (raw.startsWith("ERR")) return { lines: [`Mail: search failed or timed out (${raw.slice(4)}).`], text: "" };
  const msgs = raw.split(`${SEP}${SEP}`).filter((x) => x.trim()).map((r) => {
    const [from, subject, date, body = ""] = r.split(SEP);
    return { from, subject, date, body };
  });
  if (!msgs.length) return { lines: ["Mail: no emails mention them."], text: "" };
  return {
    lines: [`Mail (${msgs.length} email${msgs.length > 1 ? "s" : ""}):`, ...msgs.map((m) => `  • ${m.date} — from ${m.from} — “${m.subject}”: ${m.body.replace(/\s+/g, " ").slice(0, 220)}`)],
    text: msgs.map((m) => `${m.from}\n${m.body}`).join("\n"),
  };
}

async function fromCalendar(terms: string[]) {
  const cond = terms.map((t) => `summary contains "${asq(t)}" or description contains "${asq(t)}" or location contains "${asq(t)}"`).join(" or ");
  const raw = await osa(`tell application "Calendar"
  set d1 to (current date) - (365 * days)
  set d2 to (current date) + (60 * days)
  set out to ""
  repeat with c in calendars
    try
      repeat with e in (every event of c whose start date ≥ d1 and start date ≤ d2 and (${cond}))
        set loc to ""
        try
          if location of e is not missing value then set loc to location of e
        end try
        set u to ""
        try
          if url of e is not missing value then set u to url of e
        end try
        set ds to ""
        try
          if description of e is not missing value then set ds to description of e
          if (length of ds) > 300 then set ds to text 1 thru 300 of ds
        end try
        set att to ""
        try
          repeat with a in attendees of e
            set att to att & (email of a) & " "
          end repeat
        end try
        set out to out & (summary of e) & "${SEP}" & ((start date of e) as «class isot» as string) & "${SEP}" & ((end date of e) as «class isot» as string) & "${SEP}" & loc & "${SEP}" & u & "${SEP}" & ds & "${SEP}" & att & "${SEP}${SEP}"
      end repeat
    end try
  end repeat
  return out
end tell`, 45_000).catch((e) => `ERR ${String(e).slice(0, 120)}`);
  if (raw.startsWith("ERR")) return { lines: [`Calendar: search failed or timed out.`], text: "", events: [] as { title: string; start: Date; mins: number; loc: string; url: string }[] };
  const events = raw.split(`${SEP}${SEP}`).filter((x) => x.trim()).map((r) => {
    const [title, s, e, loc, url, desc, att] = r.split(SEP);
    const start = new Date(s), end = new Date(e);
    return { title, start, mins: Math.round((end.getTime() - start.getTime()) / 60_000), loc, url, desc, att };
  }).filter((e) => !Number.isNaN(e.start.getTime())).sort((a, b) => b.start.getTime() - a.start.getTime());
  if (!events.length) return { lines: ["Calendar: no past or upcoming events with them."], text: "", events: [] };
  const fmt = (d: Date) => d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return {
    lines: [`Calendar (${events.length} event${events.length > 1 ? "s" : ""}):`, ...events.slice(0, 6).map((e) => `  • ${fmt(e.start)} (${e.mins} min) — “${e.title}”${e.loc ? ` @ ${e.loc}` : ""}${e.url ? ` ${e.url}` : ""}${e.att ? ` invitees: ${e.att.trim()}` : ""}`)],
    text: events.map((e) => `${e.loc} ${e.url} ${e.desc} ${e.att}`).join("\n"),
    events,
  };
}

async function fromMessages(phones: string[], emails: string[]) {
  const keys = [...phones.map((p) => p.replace(/\D/g, "").slice(-10)).filter((k) => k.length >= 7), ...emails.map((e) => e.toLowerCase())];
  if (!keys.length) return { lines: [] as string[] };
  const where = keys.map((k) => `h.id like '%${k.replace(/'/g, "")}%'`).join(" or ");
  const db = path.join(os.homedir(), "Library/Messages/chat.db");
  try {
    const { stdout } = await execAsync("sqlite3", ["-readonly", "-json", db,
      `select m.is_from_me as me, m.text as text, datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as at
       from message m join handle h on h.ROWID = m.handle_id where (${where}) and m.text is not null order by m.date desc limit 6`], { timeout: 10_000 });
    const rows = JSON.parse(stdout || "[]") as { me: number; text: string; at: string }[];
    if (!rows.length) return { lines: ["Messages: no texts with them."] };
    return { lines: ["Messages (latest):", ...rows.map((r) => `  • ${r.at} ${r.me ? "you" : "them"}: ${r.text.replace(/\s+/g, " ").slice(0, 140)}`)] };
  } catch {
    return { lines: ["Messages: history not readable yet (needs Full Disk Access for the app running Marigold)."] };
  }
}

async function fromNotes(terms: string[]) {
  const cond = terms.map((t) => `name contains "${asq(t)}"`).join(" or ");
  const raw = await osa(`tell application "Notes"
  set out to ""
  repeat with n in (notes whose ${cond})
    set b to plaintext of n
    if (length of b) > 300 then set b to text 1 thru 300 of b
    set out to out & (name of n) & "${SEP}" & b & "${SEP}${SEP}"
  end repeat
  return out
end tell`, 20_000).catch(() => "");
  const notes = raw.split(`${SEP}${SEP}`).filter((x) => x.trim()).slice(0, 3).map((r) => r.split(SEP));
  if (!notes.length) return { lines: [] as string[], text: "" };
  return { lines: ["Notes:", ...notes.map(([t, b]) => `  • “${t}”: ${(b ?? "").replace(/\s+/g, " ").slice(0, 160)}`)], text: notes.map(([, b]) => b).join("\n") };
}

export const personInfoTool: ToolDef = {
  name: "person_info",
  description:
    "Everything already known about a person, gathered from Contacts, Mail, Calendar history, Messages and Notes in one go: their emails/phones, role (e.g. tutor), usual meeting link, location and meeting length. Call this FIRST whenever a task involves a person (scheduling, inviting, emailing, calling someone by name or role like 'my tutor Sinisia'), then use what it finds instead of asking the user.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "the person's name as the user said it, e.g. Sinisia" },
      role: { type: "string", description: "how the user described them, e.g. tutor (optional)" },
    },
    required: ["name"],
  },
  classify: (a) => ({ tier: 0, summary: `Look up everything about ${String(a.name ?? "")}${a.role ? ` (${a.role})` : ""}` }),
  taints: true, // email/notes text is outside content
  async exec(a) {
    const name = String(a.name ?? "").trim();
    const role = String(a.role ?? "").trim();
    if (!name) return "FAILED: give the person's name.";
    const first = name.split(/\s+/)[0];

    const contacts = await fromContacts(name).catch(() => ({ lines: ["Contacts: lookup failed."], emails: [], phones: [], names: [] as string[] }));
    const terms = uniq([name, first.length >= 3 ? first : name, ...contacts.names, ...contacts.emails]).slice(0, 5);
    const [mail, cal, msgs, notes] = await Promise.all([
      fromMail(terms),
      fromCalendar(terms),
      fromMessages(contacts.phones, contacts.emails),
      fromNotes(terms),
    ]);

    // Best guesses, pulled out so the model can use them directly.
    const corpus = `${mail.text}\n${cal.text}\n${notes.text}`;
    const emails = uniq([...contacts.emails, ...(corpus.match(EMAIL) ?? [])]).filter((e) => !/noreply|no-reply|notifications?@|calendar-notification/i.test(e)).slice(0, 4);
    // Strip links first so a Zoom meeting number isn't mistaken for a phone number.
    const phones = uniq([...contacts.phones, ...(corpus.replace(/https?:\/\/\S+/g, " ").match(PHONE) ?? [])]).slice(0, 3);
    const links = uniq(corpus.match(LINK) ?? []).slice(0, 3);
    const roleSeen = role || corpus.match(ROLE)?.[0] || "";
    const durations = cal.events.map((e) => e.mins).filter((m) => m > 0 && m <= 480);
    const usualMins = durations.length ? durations.sort((x, y) => x - y)[Math.floor(durations.length / 2)] : 0;
    const locs = cal.events.map((e) => e.loc).filter(Boolean);
    const usualLoc = locs.length ? Object.entries(locs.reduce<Record<string, number>>((m, l) => ((m[l] = (m[l] ?? 0) + 1), m), {})).sort((x, y) => y[1] - x[1])[0][0] : "";
    const lastTitle = cal.events[0]?.title ?? "";

    const best = [
      emails.length ? `email: ${emails.join(", ")}` : "email: unknown",
      phones.length ? `phone: ${phones.join(", ")}` : "",
      roleSeen ? `role: ${roleSeen}` : "",
      links.length ? `usual meeting link: ${links[0]}` : "",
      usualLoc ? `usual location: ${usualLoc}` : "",
      usualMins ? `usual length: ${usualMins} min` : "",
      lastTitle ? `past events were titled like “${lastTitle}”` : "",
    ].filter(Boolean);

    return [
      `PERSON: ${name}${role ? ` (${role})` : ""}`,
      `BEST GUESS → ${best.join(" · ")}`,
      "",
      ...contacts.lines, ...mail.lines, ...cal.lines, ...msgs.lines, ...notes.lines,
      "",
      emails.length || phones.length || cal.events.length
        ? "Use these details directly. Only ask the user for something that's still unknown and actually needed."
        : `Nothing found about ${name} in Contacts, Mail, Calendar, Messages or Notes. Ask the user for what you need (e.g. their email).`,
    ].join("\n").slice(0, 6000);
  },
};
