import type { ToolDef } from "./tools";
import type { Classified } from "./policy";
import { looksFinancial } from "./policy";
import { connectedAccounts, gapi } from "./google";
import { accountNamedBy, primaryAccount } from "./accounts";
import { appBrowserAvailable, mb } from "./app-browser";

/**
 * Gmail / Google Calendar / Drive through Google's APIs (one-time consent in Settings →
 * Connect Google). Fast and reliable — no browser, no bot detection. Sending asks first.
 */

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
const num = (a: Args, k: string, d: number) => (Number.isFinite(Number(a[k])) && a[k] !== undefined && a[k] !== "" ? Number(a[k]) : d);
const clip = (t: string, n = 6000) => (t.length > n ? `${t.slice(0, n)}\n…` : t);

/** Which connected Google account: the one named, else the primary, else the only one. */
async function who(a: Args): Promise<string> {
  const list = await connectedAccounts();
  if (!list.length) throw new Error("NOT_CONNECTED");
  const want = str(a, "account").toLowerCase();
  const hit = (want ? list.find((x) => x.email === want || x.email.includes(want)) : undefined)
    ?? list.find((x) => x.email === primaryAccount()?.address)
    ?? list[0];
  return hit.email;
}

const notConnected = (e: unknown) => {
  const m = String(e instanceof Error ? e.message : e);
  if (/NOT_CONFIGURED/.test(m)) return "FAILED: Google isn't set up in Marigold yet (Settings → Google → add the app's client ID once). Use the Mail app or web_browser meanwhile.";
  if (/NOT_CONNECTED/.test(m)) return `FAILED: no Google account connected${m.includes("@") ? ` for ${m.split(" ")[1]}` : ""}. Tell the user: Settings → Google → Connect Google (one time). Meanwhile use the Mail app or web_browser.`;
  return `FAILED: ${m}`;
};

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
function rfc822(to: string, subject: string, body: string, cc = "") {
  return b64url([`To: ${to}`, cc ? `Cc: ${cc}` : "", `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", body].filter((l, i) => l || i > 3).join("\r\n"));
}
const header = (m: { payload?: { headers?: { name: string; value: string }[] } }, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
function textOf(p: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string {
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of (p.parts ?? []) as typeof p[]) { const t = textOf(c); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ");
  return "";
}

// ---------------------------------------------------------------- Gmail

export const gmailTool: ToolDef = {
  name: "gmail",
  description: "The user's Gmail via Google's API (fast, no browser). search (Gmail query syntax, e.g. 'from:sinisia newer_than:30d'), read (id), draft, send (to, subject, body). Use the primary account unless the user names another (account).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "read", "draft", "send"] },
      query: { type: "string" }, id: { type: "string" },
      to: { type: "string" }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
      account: { type: "string", description: "only if the user names a different email" },
      limit: { type: "number" },
    },
    required: ["action"],
  },
  taints: true,
  classify: (a): Classified => {
    const act = str(a, "action");
    if (act === "send") {
      const sum = `Send email to ${str(a, "to")} — “${str(a, "subject").slice(0, 60)}”`;
      return looksFinancial(str(a, "subject"), str(a, "body")) ? { tier: 3, scope: "finance:email", outward: true, summary: sum } : { tier: 2, scope: "send:email", outward: true, summary: sum };
    }
    if (act === "draft") return { tier: 1, summary: `Draft email to ${str(a, "to")}` };
    return { tier: 0, summary: act === "read" ? "Read an email" : `Search email: ${str(a, "query")}` };
  },
  async exec(a) {
    try {
      const me = await who(a);
      const base = `https://gmail.googleapis.com/gmail/v1/users/me`;
      switch (str(a, "action")) {
        case "search": {
          const l = (await gapi(me, `${base}/messages?maxResults=${Math.min(20, num(a, "limit", 8))}&q=${encodeURIComponent(str(a, "query"))}`)) as { messages?: { id: string }[] };
          if (!l.messages?.length) return `No emails match “${str(a, "query")}” (${me}).`;
          const rows = await Promise.all(l.messages.map(async ({ id }) => {
            const m = (await gapi(me, `${base}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
            return `• [${id}] ${header(m, "date")} — ${header(m, "from")} — “${header(m, "subject")}”: ${(m.snippet ?? "").slice(0, 140)}`;
          }));
          return clip(`${me} — ${rows.length} email(s):\n${rows.join("\n")}`);
        }
        case "read": {
          const m = (await gapi(me, `${base}/messages/${encodeURIComponent(str(a, "id"))}?format=full`)) as { payload?: { headers?: { name: string; value: string }[] } & Parameters<typeof textOf>[0] };
          return clip(`From: ${header(m, "from")}\nTo: ${header(m, "to")}\nDate: ${header(m, "date")}\nSubject: ${header(m, "subject")}\n\n${textOf(m.payload ?? {}).replace(/\n{3,}/g, "\n\n")}`);
        }
        case "draft": case "send": {
          const raw = rfc822(str(a, "to"), str(a, "subject"), str(a, "body"), str(a, "cc"));
          if (str(a, "action") === "draft") {
            await gapi(me, `${base}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw } }) });
            return `Draft saved in ${me}'s Gmail (to ${str(a, "to")}, “${str(a, "subject")}”).`;
          }
          await gapi(me, `${base}/messages/send`, { method: "POST", body: JSON.stringify({ raw }) });
          return `Sent from ${me} to ${str(a, "to")}: “${str(a, "subject")}”.`;
        }
      }
      return "Unknown action.";
    } catch (e) { return notConnected(e); }
  },
};

// ---------------------------------------------------------------- Google Calendar

export const gcalTool: ToolDef = {
  name: "google_calendar",
  description: "The user's Google Calendar via API: list (days ahead), create (title, start, end ISO, invitees emails, location, notes — invitees get an invite). Use when they use Google Calendar; Apple Calendar has its own tool.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "create"] },
      days: { type: "number" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      invitees: { type: "string" }, location: { type: "string" }, notes: { type: "string" }, account: { type: "string" },
    },
    required: ["action"],
  },
  classify: (a): Classified => {
    if (str(a, "action") !== "create") return { tier: 0, summary: "Look at Google Calendar" };
    return str(a, "invitees")
      ? { tier: 2, scope: "calendar:invite", outward: true, summary: `Google Calendar: create “${str(a, "title")}” and invite ${str(a, "invitees")}` }
      : { tier: 1, summary: `Google Calendar: create “${str(a, "title")}”` };
  },
  async exec(a) {
    try {
      const me = await who(a);
      const cal = `https://www.googleapis.com/calendar/v3/calendars/primary/events`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (str(a, "action") === "list") {
        const now = new Date(), until = new Date(Date.now() + num(a, "days", 7) * 86_400_000);
        const j = (await gapi(me, `${cal}?singleEvents=true&orderBy=startTime&maxResults=30&timeMin=${now.toISOString()}&timeMax=${until.toISOString()}`)) as { items?: { summary?: string; start?: { dateTime?: string; date?: string }; location?: string }[] };
        const rows = (j.items ?? []).map((e) => `• ${new Date(e.start?.dateTime ?? e.start?.date ?? "").toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} — ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`);
        return rows.length ? `${me} — next ${num(a, "days", 7)} days:\n${rows.join("\n")}` : `Nothing on ${me}'s Google Calendar in the next ${num(a, "days", 7)} days.`;
      }
      const start = new Date(str(a, "start"));
      const end = str(a, "end") ? new Date(str(a, "end")) : new Date(start.getTime() + 3_600_000);
      const attendees = str(a, "invitees").split(/[,;\s]+/).filter((e) => e.includes("@")).map((email) => ({ email }));
      const ev = (await gapi(me, `${cal}?sendUpdates=${attendees.length ? "all" : "none"}`, { method: "POST", body: JSON.stringify({
        summary: str(a, "title"), location: str(a, "location") || undefined, description: str(a, "notes") || undefined,
        start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz }, attendees,
      }) })) as { htmlLink?: string };
      return `Created “${str(a, "title")}” on ${start.toLocaleString()} in ${me}'s Google Calendar${attendees.length ? `, invited ${attendees.map((x) => x.email).join(", ")}` : ""}. ${ev.htmlLink ?? ""}`;
    } catch (e) { return notConnected(e); }
  },
};

// ---------------------------------------------------------------- Google Drive

export const gdriveTool: ToolDef = {
  name: "google_drive",
  description: "The user's Google Drive via API: search (name/text), read (id → text of a Google Doc/Sheet/text file).",
  parameters: {
    type: "object",
    properties: { action: { type: "string", enum: ["search", "read"] }, query: { type: "string" }, id: { type: "string" }, account: { type: "string" } },
    required: ["action"],
  },
  taints: true,
  classify: (a): Classified => ({ tier: 0, summary: str(a, "action") === "read" ? "Read a Drive file" : `Search Drive: ${str(a, "query")}` }),
  async exec(a) {
    try {
      const me = await who(a);
      if (str(a, "action") === "search") {
        const q = `fullText contains '${str(a, "query").replace(/'/g, "\\'")}' and trashed = false`;
        const j = (await gapi(me, `https://www.googleapis.com/drive/v3/files?pageSize=15&fields=files(id,name,mimeType,modifiedTime)&q=${encodeURIComponent(q)}`)) as { files?: { id: string; name: string; mimeType: string; modifiedTime: string }[] };
        return j.files?.length ? `${me} — Drive:\n${j.files.map((f) => `• [${f.id}] ${f.name} (${f.mimeType.split(".").pop()}, ${f.modifiedTime.slice(0, 10)})`).join("\n")}` : `No Drive files match “${str(a, "query")}”.`;
      }
      const id = encodeURIComponent(str(a, "id"));
      const meta = (await gapi(me, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`)) as { name: string; mimeType: string };
      const exportAs = meta.mimeType.includes("spreadsheet") ? "text/csv" : "text/plain";
      const url = meta.mimeType.startsWith("application/vnd.google-apps")
        ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`
        : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
      const tok = await (async () => { try { return await gapi(me, url); } catch (e) { return String(e); } })();
      return clip(`${meta.name}\n\n${typeof tok === "string" ? tok : JSON.stringify(tok)}`);
    } catch (e) { return notConnected(e); }
  },
};

// ---------------------------------------------------------------- Docs · Sheets · Slides · Tasks · Contacts

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const MIME = { doc: "application/vnd.google-apps.document", sheet: "application/vnd.google-apps.spreadsheet", slides: "application/vnd.google-apps.presentation" };

/** A file id from `id`, a docs.google.com link, or the newest file whose name matches `query`. */
async function fileId(me: string, a: Args, kind: keyof typeof MIME): Promise<{ id: string; name: string } | string> {
  const raw = str(a, "id") || str(a, "url");
  const m = raw.match(/\/d\/([\w-]{20,})/) ?? raw.match(/^([\w-]{20,})$/);
  if (m) return { id: m[1], name: "" };
  const q = str(a, "query") || str(a, "title");
  if (!q) return "FAILED: give id, a link, or query (part of the file's name).";
  const j = (await gapi(me, `${DRIVE}?pageSize=5&orderBy=modifiedTime desc&fields=files(id,name)&q=${encodeURIComponent(`mimeType='${MIME[kind]}' and name contains '${q.replace(/'/g, "\\'")}' and trashed=false`)}`)) as { files?: { id: string; name: string }[] };
  return j.files?.[0] ?? `FAILED: no ${kind === "doc" ? "Google Doc" : kind === "sheet" ? "Google Sheet" : "Google Slides deck"} named like “${q}”.`;
}
const rowsOf = (a: Args): string[][] => {
  const r = a.rows;
  if (Array.isArray(r)) return r.map((x) => (Array.isArray(x) ? x.map(String) : String(x).split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim())));
  const t = str(a, "text");
  return t ? t.split("\n").map((l) => l.split(/\t|,/).map((c) => c.trim())) : [];
};

/** Reload any open browser tab showing this file, so the page matches what the API just wrote. */
async function refreshOpenTabs(id: string) {
  try { if (appBrowserAvailable()) await mb("reload_matching", { contains: id }); } catch { /* browser not running */ }
}

/**
 * Markdown-ish text → plain text + the Docs requests that format it (headings, bullets, numbered
 * lists, **bold**). `at` = where it goes; leadNewline = start a new paragraph after existing text.
 */
function mdToDocs(md: string, at: number, leadNewline = false): { requests: unknown[] } {
  const lines = md.replace(/\r/g, "").split("\n");
  let text = leadNewline ? "\n" : "";
  const paras: { start: number; end: number; kind: string }[] = [];
  const bolds: [number, number][] = [];
  lines.forEach((raw, li) => {
    let kind = "p", line = raw, m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) { kind = `h${m[1].length}`; line = m[2]; }
    else if ((m = raw.match(/^\s*[-*•]\s+(.*)$/))) { kind = "ul"; line = m[1]; }
    else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) { kind = "ol"; line = m[1]; }
    if (li > 0) text += "\n";
    const start = at + text.length;
    let plain = "";
    for (const part of line.split(/(\*\*[^*]+\*\*)/g)) {
      const b = part.match(/^\*\*([^*]+)\*\*$/);
      if (b) { bolds.push([start + plain.length, start + plain.length + b[1].length]); plain += b[1]; } else plain += part;
    }
    text += plain;
    paras.push({ start, end: start + plain.length + 1, kind });
  });
  const reqs: unknown[] = [{ insertText: { location: { index: at }, text } }];
  const r = (startIndex: number, endIndex: number) => ({ startIndex, endIndex });
  reqs.push({ updateParagraphStyle: { range: r(at, at + text.length + 1), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
  for (const p of paras) if (/^h[123]$/.test(p.kind)) reqs.push({ updateParagraphStyle: { range: r(p.start, p.end), paragraphStyle: { namedStyleType: `HEADING_${p.kind[1]}` }, fields: "namedStyleType" } });
  // Consecutive list lines become one list.
  for (let i = 0; i < paras.length; ) {
    const k = paras[i].kind;
    if (k !== "ul" && k !== "ol") { i++; continue; }
    let j = i;
    while (j + 1 < paras.length && paras[j + 1].kind === k) j++;
    reqs.push({ createParagraphBullets: { range: r(paras[i].start, paras[j].end), bulletPreset: k === "ul" ? "BULLET_DISC_CIRCLE_SQUARE" : "NUMBERED_DECIMAL_NESTED" } });
    i = j + 1;
  }
  for (const [x, y] of bolds) reqs.push({ updateTextStyle: { range: r(x, y), textStyle: { bold: true }, fields: "bold" } });
  return { requests: reqs };
}

/** Where new text can go: the index just before the document's final newline. */
async function docEnd(me: string, id: string): Promise<number> {
  const d = (await gapi(me, `https://docs.googleapis.com/v1/documents/${id}?fields=body(content(endIndex))`)) as { body?: { content?: { endIndex?: number }[] } };
  return (d.body?.content?.at(-1)?.endIndex ?? 2) - 1;
}

/** Documents Marigold itself created this session (id and lower-cased title): editing those again is its own work, not overwriting yours. */
const madeDocs = new Set<string>();
const isMine = (a: Args) => [str(a, "id"), str(a, "url"), str(a, "query"), str(a, "title")].filter(Boolean).some((v) => [...madeDocs].some((m) => v.toLowerCase().includes(m)));

export const gdocsTool: ToolDef = {
  name: "google_docs",
  description: "Google Docs via API — INSTANT, no typing in the browser. For a NEW document always use create(title, text) with the FULL content in one call (never create empty then fill). create(title, text) · read · append(text) · write(text) replaces the whole document · replace(find, text) · all take id / link (url) / query=name. `text` is Markdown: # / ## / ### headings, - bullets, 1. numbered lists, **bold** — so ONE call can write an entire formatted document (essay, report, notes, lesson plan). If the doc is open in the browser, use this with its url instead of typing in the page.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "read", "append", "write", "replace"] }, title: { type: "string" }, text: { type: "string", description: "Markdown content" }, find: { type: "string", description: "replace: the text to find" }, id: { type: "string" }, url: { type: "string" }, query: { type: "string" }, account: { type: "string" } }, required: ["action"] },
  taints: true,
  classify: (a): Classified => {
    const act = str(a, "action");
    if (act === "read") return { tier: 0, summary: `Read Google Doc ${str(a, "query") || str(a, "id")}` };
    // Replacing a whole existing document can lose work → ask (once per doc).
    if ((act === "write" || act === "replace") && isMine(a)) return { tier: 1, summary: `Google Docs: finish the document I made` };
    if (act === "write" || act === "replace") return { tier: 2, scope: `docs:overwrite:${str(a, "id") || str(a, "url") || str(a, "query")}`, summary: `Google Docs: ${act === "write" ? "replace the contents of" : "edit"} “${str(a, "query") || str(a, "title") || "this doc"}”` };
    return { tier: 1, summary: `Google Docs: ${act} “${str(a, "title") || str(a, "query") || "doc"}”` };
  },
  async exec(a) {
    try {
      const me = await who(a);
      const act = str(a, "action");
      const md = String(a.text ?? "");
      const batch = (id: string, requests: unknown[]) => gapi(me, `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
      if (act === "create") {
        const d = (await gapi(me, "https://docs.googleapis.com/v1/documents", { method: "POST", body: JSON.stringify({ title: str(a, "title") || "Untitled document" }) })) as { documentId: string };
        madeDocs.add(d.documentId.toLowerCase()); madeDocs.add((str(a, "title") || "untitled document").toLowerCase());
        if (md.trim()) await batch(d.documentId, mdToDocs(md, 1).requests);
        return `Created Google Doc “${str(a, "title") || "Untitled document"}”${md.trim() ? ` (${md.split(/\s+/).length} words)` : ""}: https://docs.google.com/document/d/${d.documentId}/edit`;
      }
      const f = await fileId(me, a, "doc");
      if (typeof f === "string") return f;
      const link = `https://docs.google.com/document/d/${f.id}/edit`;
      if (act === "append") {
        if (!md.trim()) return "FAILED: give text to add.";
        await batch(f.id, mdToDocs(md, await docEnd(me, f.id), true).requests);
        void refreshOpenTabs(f.id);
        return `Added to ${f.name || "the doc"}: ${link}`;
      }
      if (act === "write") {
        const end = await docEnd(me, f.id);
        await batch(f.id, [...(end > 1 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end } } }] : []), ...mdToDocs(md, 1).requests]);
        void refreshOpenTabs(f.id);
        return `Rewrote ${f.name || "the doc"}: ${link}`;
      }
      if (act === "replace") {
        const find = str(a, "find");
        if (!find) return "FAILED: give find (the text to replace).";
        const r = (await batch(f.id, [{ replaceAllText: { containsText: { text: find, matchCase: false }, replaceText: md } }])) as { replies?: { replaceAllText?: { occurrencesChanged?: number } }[] };
        void refreshOpenTabs(f.id);
        const n = r.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return n ? `Replaced ${n} place${n > 1 ? "s" : ""} in ${f.name || "the doc"}: ${link}` : `FAILED: “${find}” isn't in the document.`;
      }
      const text = await gapi(me, `${DRIVE}/${f.id}/export?mimeType=text%2Fplain`);
      return clip(`${f.name}\n${link}\n\n${String(text)}`);
    } catch (e) { return notConnected(e); }
  },
};

export const gsheetsTool: ToolDef = {
  name: "google_sheets",
  description: "Google Sheets via API: create(title, rows) · read(id / link / query=name, range e.g. 'Sheet1!A1:F50') · append(id or query, rows) adds rows at the bottom · write(id, range, rows) overwrites cells. rows = [[\"Name\",\"Score\"],[\"Ana\",\"92\"]] (or text with one row per line, commas between cells).",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "read", "append", "write"] }, title: { type: "string" }, id: { type: "string" }, url: { type: "string" }, query: { type: "string" }, range: { type: "string" }, rows: { type: "array", items: { type: "array", items: { type: "string" } } }, text: { type: "string" }, account: { type: "string" } }, required: ["action"] },
  taints: true,
  classify: (a): Classified => {
    const act = str(a, "action");
    if (act === "read") return { tier: 0, summary: `Read Google Sheet ${str(a, "query") || str(a, "id")}` };
    // Overwriting existing cells can lose data → ask (once per sheet).
    if (act === "write") return { tier: 2, scope: `sheets:write:${str(a, "id") || str(a, "query")}`, summary: `Google Sheets: overwrite ${str(a, "range") || "cells"} in “${str(a, "query") || str(a, "id")}”` };
    return { tier: 1, summary: `Google Sheets: ${act} ${str(a, "title") || str(a, "query") || ""}`.trim() };
  },
  async exec(a) {
    try {
      const me = await who(a);
      const act = str(a, "action");
      const base = "https://sheets.googleapis.com/v4/spreadsheets";
      if (act === "create") {
        const s = (await gapi(me, base, { method: "POST", body: JSON.stringify({ properties: { title: str(a, "title") || "Untitled spreadsheet" } }) })) as { spreadsheetId: string };
        const rows = rowsOf(a);
        if (rows.length) {
          await gapi(me, `${base}/${s.spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`, { method: "PUT", body: JSON.stringify({ values: rows }) });
          // Header row: bold + frozen, columns sized to fit.
          await gapi(me, `${base}/${s.spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [
            { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
            { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
            { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: Math.max(1, ...rows.map((r) => r.length)) } } },
          ] }) }).catch(() => {});
        }
        return `Created Google Sheet “${str(a, "title") || "Untitled spreadsheet"}”${rows.length ? ` with ${rows.length} rows` : ""}: https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`;
      }
      const f = await fileId(me, a, "sheet");
      if (typeof f === "string") return f;
      const range = str(a, "range") || "A1:Z200";
      if (act === "read") {
        const v = (await gapi(me, `${base}/${f.id}/values/${encodeURIComponent(range)}`)) as { values?: string[][]; range?: string };
        return clip(`${f.name} (${v.range ?? range}) — https://docs.google.com/spreadsheets/d/${f.id}/edit\n${(v.values ?? []).map((r) => r.join("\t")).join("\n") || "(empty)"}`);
      }
      const rows = rowsOf(a);
      if (!rows.length) return "FAILED: give rows to add.";
      if (act === "append") {
        await gapi(me, `${base}/${f.id}/values/${encodeURIComponent(str(a, "range") || "A1")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values: rows }) });
        void refreshOpenTabs(f.id);
        return `Added ${rows.length} row(s) to ${f.name || "the sheet"}: https://docs.google.com/spreadsheets/d/${f.id}/edit`;
      }
      await gapi(me, `${base}/${f.id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: JSON.stringify({ values: rows }) });
      void refreshOpenTabs(f.id);
      return `Wrote ${rows.length} row(s) to ${range} in ${f.name || "the sheet"}.`;
    } catch (e) { return notConnected(e); }
  },
};

const THEMES: Record<string, { background: string; title: string; body: string; accent: string; font: string }> = {
  modern: { background: "#FFFFFF", title: "#1F2937", body: "#374151", accent: "#E8A317", font: "Montserrat" },
  dark: { background: "#111827", title: "#F9FAFB", body: "#D1D5DB", accent: "#F2B035", font: "Roboto" },
  marigold: { background: "#FFF8E7", title: "#7A4B00", body: "#4A3A1A", accent: "#E8A317", font: "Merriweather" },
  ocean: { background: "#F0F9FF", title: "#0C4A6E", body: "#1E3A5F", accent: "#0EA5E9", font: "Open Sans" },
  forest: { background: "#F1F8F2", title: "#14532D", body: "#1F3D2B", accent: "#22A06B", font: "Lora" },
  sunset: { background: "#FFF1EC", title: "#9A3412", body: "#4A2A20", accent: "#F97316", font: "Poppins" },
  minimal: { background: "#FAFAFA", title: "#111111", body: "#444444", accent: "#111111", font: "Arial" },
  bold: { background: "#0B1F3A", title: "#FFFFFF", body: "#DCE6F5", accent: "#FF5A5F", font: "Oswald" },
};
/** The deck's look: a preset name, custom colors, or (for a new deck with none given) a clean default. null = leave the deck as it is. */
function deckTheme(t: unknown, isNew: boolean) {
  const hex = (v: unknown, d: string) => (typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? `#${v.trim().replace("#", "")}` : d);
  if (typeof t === "string" && t.trim()) return THEMES[t.trim().toLowerCase()] ?? THEMES.modern;
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>, base = THEMES.modern;
    return { background: hex(o.background, base.background), title: hex(o.title_color, base.title), body: hex(o.body_color, base.body), accent: hex(o.accent, base.accent), font: typeof o.font === "string" && o.font.trim() ? o.font.trim() : base.font };
  }
  return isNew ? THEMES.modern : null;
}

export const gslidesTool: ToolDef = {
  name: "google_slides",
  description: "Google Slides via API — INSTANT, builds an ENTIRE presentation in one call. create(title, slides) · add(id/url/query, slides) · read · batch(id/url/query, requests = raw Slides API requests for any edit: restyle, move/resize, images, shapes). slides = [{title, bullets:[\"point\", …] (or body text), subtitle (makes a title/section slide), notes (speaker notes), image (URL) or image_query (picture to find and place beside the text)}], theme (preset name like modern/dark/marigold/ocean/forest/sunset/minimal/bold, or {background, title_color, body_color, accent, font}). ALWAYS pick a theme that fits the topic and add pictures (image_query) on most slides when the user wants a good-looking deck. Write real content (5–12 slides for a normal deck, each with 3–5 concise bullets). Returns the link.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "add", "read", "batch"] }, requests: { type: "array", items: { type: "object" }, description: "batch only: raw Google Slides API batchUpdate requests (createImage, createShape, updateTextStyle, updatePageProperties, replaceAllText, deleteObject, createSlide…) for anything the other fields can't express" }, title: { type: "string" }, id: { type: "string" }, url: { type: "string" }, query: { type: "string" }, slides: { type: "array", items: { type: "object", properties: { title: { type: "string" }, subtitle: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, body: { type: "string" }, notes: { type: "string" }, image: { type: "string", description: "public https URL of a picture for this slide" }, image_query: { type: "string", description: "or describe the picture; a free one is found and placed" } } } }, theme: { description: "look of the whole deck: a preset name (modern, dark, marigold, ocean, forest, sunset, minimal, bold) or {background, title_color, body_color, accent, font} with #hex colors", anyOf: [{ type: "string" }, { type: "object" }] }, account: { type: "string" } }, required: ["action"] },
  taints: true,
  classify: (a): Classified => str(a, "action") === "read" ? { tier: 0, summary: `Read slides ${str(a, "query") || str(a, "id")}` } : { tier: 1, summary: `Google Slides: ${str(a, "action")} “${str(a, "title") || str(a, "query") || "deck"}”` },
  async exec(a) {
    try {
      const me = await who(a);
      const act = str(a, "action");
      const base = "https://slides.googleapis.com/v1/presentations";
      let id = "", name = str(a, "title"), firstSlide = "";
      if (act === "create") {
        const p = (await gapi(me, base, { method: "POST", body: JSON.stringify({ title: name || "Untitled presentation" }) })) as { presentationId: string; slides?: { objectId: string }[] };
        id = p.presentationId; firstSlide = p.slides?.[0]?.objectId ?? "";
      } else {
        const f = await fileId(me, a, "slides");
        if (typeof f === "string") return f;
        id = f.id; name = f.name;
      }
      if (act === "batch") {
        const reqs = Array.isArray(a.requests) ? (a.requests as unknown[]).slice(0, 200) : [];
        if (!reqs.length) return "FAILED: batch needs requests (Google Slides API batchUpdate requests).";
        const r = (await gapi(me, `${base}/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: reqs }) })) as { replies?: unknown[] };
        void refreshOpenTabs(id);
        return `Applied ${reqs.length} change(s) to “${name || "the deck"}”: https://docs.google.com/presentation/d/${id}/edit`;
      }
      if (act === "read") {
        const p = (await gapi(me, `${base}/${id}`)) as { title?: string; slides?: { pageElements?: { shape?: { text?: { textElements?: { textRun?: { content?: string } }[] } } }[] }[] };
        const out = (p.slides ?? []).map((s, i) => `Slide ${i + 1}: ${(s.pageElements ?? []).map((e) => (e.shape?.text?.textElements ?? []).map((t) => t.textRun?.content ?? "").join("")).join(" | ").replace(/\s+/g, " ").trim()}`);
        return clip(`${p.title ?? name}\nhttps://docs.google.com/presentation/d/${id}/edit\n${out.join("\n")}`);
      }
      const slides = (Array.isArray(a.slides) ? a.slides : []) as { title?: string; subtitle?: string; bullets?: string[]; body?: string; notes?: string; image?: string; image_query?: string }[];
      if (slides.length) {
        const stamp = Date.now().toString(36);
        const reqs: unknown[] = [];
        const ids: string[] = [];
        const th = deckTheme(a.theme, act === "create");
        const rgb = (hex: string) => { const n = parseInt(hex.replace("#", ""), 16); return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 }; };
        const color = (hex: string) => ({ opaqueColor: { rgbColor: rgb(hex) } });
        const style = (objectId: string, o: { color: string; font: string; bold?: boolean; size?: number }) => ({ updateTextStyle: { objectId, textRange: { type: "ALL" }, style: { foregroundColor: color(o.color), fontFamily: o.font, ...(o.bold ? { bold: true } : {}), ...(o.size ? { fontSize: { magnitude: o.size, unit: "PT" } } : {}) }, fields: `foregroundColor,fontFamily${o.bold ? ",bold" : ""}${o.size ? ",fontSize" : ""}` } });
        // Pictures: a given URL, or find a free one for the description (in parallel).
        const { slideImage } = await import("./web-search");
        const pics = await Promise.all(slides.map(async (s) => (typeof s.image === "string" && /^https:\/\//.test(s.image) ? s.image : s.image_query ? await slideImage(String(s.image_query)).catch(() => null) : null)));
        slides.forEach((s, i) => {
          const sid = `mg_${stamp}_${i}`;
          ids.push(sid);
          const titleSlide = !!s.subtitle && !s.bullets?.length && !s.body;
          const pic = pics[i];
          const body = titleSlide ? String(s.subtitle) : s.bullets?.length ? s.bullets.map(String).join("\n") : String(s.body ?? "");
          const withPic = !!pic && !titleSlide;
          if (withPic) {
            // Text on the left, picture on the right (a text box we place ourselves, so the layout is exact).
            reqs.push({ createSlide: { objectId: sid, slideLayoutReference: { predefinedLayout: "TITLE_ONLY" }, placeholderIdMappings: [{ layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: `${sid}_t` }] } });
            if (body) {
              reqs.push({ createShape: { objectId: `${sid}_b`, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: sid, size: { width: { magnitude: 4900000, unit: "EMU" }, height: { magnitude: 3300000, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 457200, translateY: 1500000, unit: "EMU" } } } });
              reqs.push({ insertText: { objectId: `${sid}_b`, text: body } });
              if (s.bullets?.length) reqs.push({ createParagraphBullets: { objectId: `${sid}_b`, textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
            }
            reqs.push({ createImage: { objectId: `${sid}_i`, url: pic, elementProperties: { pageObjectId: sid, size: { width: { magnitude: 3300000, unit: "EMU" }, height: { magnitude: 3300000, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 5400000, translateY: 1450000, unit: "EMU" } } } });
          } else {
            reqs.push({ createSlide: { objectId: sid, slideLayoutReference: { predefinedLayout: titleSlide ? "TITLE" : "TITLE_AND_BODY" }, placeholderIdMappings: [
              { layoutPlaceholder: { type: titleSlide ? "CENTERED_TITLE" : "TITLE", index: 0 }, objectId: `${sid}_t` },
              { layoutPlaceholder: { type: titleSlide ? "SUBTITLE" : "BODY", index: 0 }, objectId: `${sid}_b` }] } });
            if (body) {
              reqs.push({ insertText: { objectId: `${sid}_b`, text: body } });
              if (!titleSlide && s.bullets?.length) reqs.push({ createParagraphBullets: { objectId: `${sid}_b`, textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
            }
            // A title slide with a picture: put it under the text as a wide banner.
            if (pic && titleSlide) reqs.push({ createImage: { objectId: `${sid}_i`, url: pic, elementProperties: { pageObjectId: sid, size: { width: { magnitude: 2600000, unit: "EMU" }, height: { magnitude: 1500000, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 3272000, translateY: 3500000, unit: "EMU" } } } });
          }
          if (s.title) reqs.push({ insertText: { objectId: `${sid}_t`, text: String(s.title) } });
          if (th) {
            reqs.push({ updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb(th.background) } } } }, fields: "pageBackgroundFill.solidFill.color" } });
            if (s.title) reqs.push(style(`${sid}_t`, { color: th.title, font: th.font, bold: true }));
            if (body) reqs.push(style(`${sid}_b`, { color: th.body, font: th.font, size: withPic ? 18 : undefined }));
            // A thin accent bar across the top.
            reqs.push({ createShape: { objectId: `${sid}_a`, shapeType: "RECTANGLE", elementProperties: { pageObjectId: sid, size: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 110000, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU" } } } });
            reqs.push({ updateShapeProperties: { objectId: `${sid}_a`, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb(th.accent) } } }, outline: { propertyState: "NOT_RENDERED" } }, fields: "shapeBackgroundFill.solidFill.color,outline.propertyState" } });
          }
        });
        // A new deck starts with one empty title slide — drop it (ours come after).
        if (act === "create" && firstSlide) reqs.push({ deleteObject: { objectId: firstSlide } });
        await gapi(me, `${base}/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: reqs }) });
        // Speaker notes live on each slide's notes page.
        if (slides.some((s) => s.notes)) {
          const p = (await gapi(me, `${base}/${id}?fields=slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))`)) as { slides?: { objectId: string; slideProperties?: { notesPage?: { notesProperties?: { speakerNotesObjectId?: string } } } }[] };
          const notes: unknown[] = [];
          slides.forEach((s, i) => {
            const target = p.slides?.find((x) => x.objectId === ids[i])?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
            if (s.notes && target) notes.push({ insertText: { objectId: target, text: String(s.notes) } });
          });
          if (notes.length) await gapi(me, `${base}/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: notes }) });
        }
        void refreshOpenTabs(id);
      }
      return `${act === "create" ? "Created" : "Updated"} “${name || "Untitled presentation"}”${slides.length ? ` (${slides.length} slide${slides.length > 1 ? "s" : ""} added)` : ""}: https://docs.google.com/presentation/d/${id}/edit`;
    } catch (e) { return notConnected(e); }
  },
};

export const gtasksTool: ToolDef = {
  name: "google_tasks",
  description: "Google Tasks via API: list (open tasks) · add(title, notes, due ISO date) · complete(id).",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "add", "complete"] }, title: { type: "string" }, notes: { type: "string" }, due: { type: "string" }, id: { type: "string" }, account: { type: "string" } }, required: ["action"] },
  classify: (a): Classified => str(a, "action") === "list" ? { tier: 0, summary: "Look at Google Tasks" } : { tier: 1, summary: `Google Tasks: ${str(a, "action")} ${str(a, "title") || str(a, "id")}` },
  async exec(a) {
    try {
      const me = await who(a);
      const base = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
      const act = str(a, "action");
      if (act === "list") {
        const j = (await gapi(me, `${base}?showCompleted=false&maxResults=50`)) as { items?: { id: string; title: string; due?: string; notes?: string }[] };
        return j.items?.length ? j.items.map((t) => `• [${t.id}] ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ""}${t.notes ? ` — ${t.notes.slice(0, 80)}` : ""}`).join("\n") : "No open Google Tasks.";
      }
      if (act === "add") {
        const due = str(a, "due") ? new Date(str(a, "due")) : null;
        await gapi(me, base, { method: "POST", body: JSON.stringify({ title: str(a, "title"), notes: str(a, "notes") || undefined, due: due && !isNaN(+due) ? due.toISOString() : undefined }) });
        return `Added “${str(a, "title")}” to Google Tasks.`;
      }
      await gapi(me, `${base}/${encodeURIComponent(str(a, "id"))}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) });
      return "Marked done.";
    } catch (e) { return notConnected(e); }
  },
};

export const gcontactsTool: ToolDef = {
  name: "google_contacts",
  description: "Search the user's Google Contacts (name → emails, phones).",
  parameters: { type: "object", properties: { query: { type: "string" }, account: { type: "string" } }, required: ["query"] },
  taints: true,
  classify: (a): Classified => ({ tier: 0, summary: `Look up “${str(a, "query")}” in Google Contacts` }),
  async exec(a) {
    try {
      const me = await who(a);
      const url = `https://people.googleapis.com/v1/people:searchContacts?readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=10&query=${encodeURIComponent(str(a, "query"))}`;
      await gapi(me, url.replace(/query=[^&]*/, "query=")).catch(() => {}); // Google asks for a warm-up call first
      const j = (await gapi(me, url)) as { results?: { person?: { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[]; phoneNumbers?: { value?: string }[]; organizations?: { name?: string }[] } }[] };
      const rows = (j.results ?? []).map(({ person: p }) => `• ${p?.names?.[0]?.displayName ?? "?"}${p?.organizations?.[0]?.name ? ` (${p.organizations[0].name})` : ""} — ${[...(p?.emailAddresses ?? []).map((e) => e.value), ...(p?.phoneNumbers ?? []).map((n) => n.value)].filter(Boolean).join(", ")}`);
      return rows.length ? rows.join("\n") : `No Google contact matches “${str(a, "query")}”.`;
    } catch (e) { return notConnected(e); }
  },
};

/**
 * A file made through the API belongs to ONE Google account. A bare docs.google.com link opens as
 * whichever account the browser happens to have first — if that's a different one (school vs
 * personal), Google says "You need access". Tagging every link with ?authuser=<owner> makes Google
 * open it as the right account (or ask that account to sign in).
 */
function tagOwner(text: string, owner: string): string {
  return text.replace(/https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)\/edit(?!\?)/g, (_m, kind, id) => `https://docs.google.com/${kind}/d/${id}/edit?authuser=${encodeURIComponent(owner)}`);
}
/** The Google account of the Browser profile the user is working in (null if not in the browser / unknown). */
async function browsingAs(): Promise<string | null> {
  try {
    if (!appBrowserAvailable()) return null;
    const st = (await mb("tabs")) as { profile?: string; profiles?: { key: string; email: string }[] };
    return st.profiles?.find((p) => p.key === (st.profile ?? ""))?.email?.toLowerCase() || null;
  } catch { return null; }
}

for (const t of [gmailTool, gcalTool, gdriveTool, gdocsTool, gsheetsTool, gslidesTool, gtasksTool, gcontactsTool]) {
  const run = t.exec;
  t.exec = async (a0, signal, ctx) => {
    let a = a0;
    let fellBack = "";
    // The user NAMED an account in their message: that account wins over the model's guess and over the profile
    // they're browsing as, and if it isn't connected we stop instead of quietly using a different one.
    const named = ctx?.userText ? accountNamedBy(ctx.userText) : {};
    if (named.account) {
      const have = await connectedAccounts().catch(() => []);
      if (!have.some((x) => x.email === named.account!.address.toLowerCase())) {
        return `FAILED: you asked for ${named.account.address}, but that account isn't connected to Marigold yet, so nothing was done (I won't use a different account). Tell the user: Settings → Google → Connect Google, sign in as ${named.account.address}, then ask again.`;
      }
      a = { ...a, account: named.account.address.toLowerCase() };
    }
    // Working in the Browser tab: files, mail and events belong to the account you're browsing as,
    // not silently to the primary one. Naming an account always wins.
    if (!named.account && !str(a, "account") && (ctx?.browserCurrent || ctx?.browserMode)) {
      const me = await browsingAs();
      const have = await connectedAccounts().catch(() => []);
      if (me && have.length > 1 || (me && have.length === 1 && have[0].email !== me)) {
        if (!have.some((x) => x.email === me)) { fellBack = me; } // not connected: use the connected account, and say so
        else        a = { ...a, account: me };
      }
    }
    let out = await run.call(t, a, signal, ctx);
    if (fellBack && typeof out === "string" && !out.startsWith("FAILED")) out += `\n(Note for the user: you're browsing as ${fellBack}, which isn't connected to Marigold, so this was done in ${await who(a).catch(() => "your connected account")} instead. Open the link in Chrome as that account. To work in ${fellBack}, connect it with Connect Google once it's allowed.)`;
    if (typeof out !== "string" || !/docs\.google\.com/.test(out)) return out;
    const owner = await who(a).catch(() => "");
    return owner ? `${tagOwner(out, owner)}${/Created|Updated|Added/.test(out) ? `\n(The file belongs to ${owner}. Give the user the link exactly as written; don't reopen it under a different account.)` : ""}` : out;
  };
}
