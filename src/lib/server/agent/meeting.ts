import { promises as fs } from "fs";
import path from "path";
import { MARIGOLD_DIR } from "./policy";

/**
 * Meeting notes: the transcript Marigold wrote down on this Mac (the audio is never kept) → a short summary, decisions and
 * action items, saved as a text file in ~/.marigold/meetings. Only the text goes to the AI.
 */

export interface Line { at: number; who: string; text: string }
export interface MeetingNotes {
  summary: string;
  decisions: string[];
  actionItems: { task: string; owner?: string; due?: string }[];
  questions: string[];
}

const stamp = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function transcriptText(lines: Line[]): string {
  return lines.map((l) => `[${stamp(l.at)}] ${l.who}: ${l.text}`).join("\n");
}

const SYSTEM = `You write meeting notes from a call transcript that Marigold's speech recognition wrote down. The speakers are "You" (the person who asked for the notes) and either their names (from live captions) or "Others" (everyone else, not told apart). The recognition makes mistakes; use context.
Return ONLY JSON:
{"summary":"3-5 sentences: what the meeting was about and what came out of it",
 "decisions":["each decision that was actually made"],
 "actionItems":[{"task":"a concrete thing someone has to do, written as an instruction","owner":"You, or a name only if it was said, otherwise omit","due":"the deadline in the words it was said, only if one was said, otherwise omit"}],
 "questions":["things left open or unanswered"]}
Use ONLY what was said. Never invent tasks, names or dates. If little was said, say so in the summary and return empty lists. No markdown.`;

export async function summarizeMeeting(title: string, lines: Line[]): Promise<{ notes: MeetingNotes; file: string }> {
  const { cloudJson, hasCloudKey, stepModel } = await import("./cloud");
  if (!(await hasCloudKey())) throw new Error("The AI isn't connected, so I can't write the notes. Open Setup to connect it.");
  let text = transcriptText(lines);
  if (text.length > 60_000) text = `${text.slice(0, 30_000)}\n[the middle of a very long call is left out here]\n${text.slice(-28_000)}`;
  const out = await cloudJson(SYSTEM, `Meeting: ${title}\n\nTranscript:\n${text}`, AbortSignal.timeout(90_000), { model: stepModel(), maxTokens: 1800 });
  let j: Partial<MeetingNotes> = {};
  try { j = JSON.parse(out); } catch { /* handled below */ }
  if (!j.summary) throw new Error("The AI didn't return notes. Try again.");
  const str = (x: unknown) => String(x ?? "").trim();
  const notes: MeetingNotes = {
    summary: str(j.summary),
    decisions: (j.decisions ?? []).map(str).filter(Boolean).slice(0, 20),
    actionItems: (j.actionItems ?? []).filter((a) => a?.task).slice(0, 30).map((a) => ({ task: str(a.task), ...(a.owner ? { owner: str(a.owner) } : {}), ...(a.due ? { due: str(a.due) } : {}) })),
    questions: (j.questions ?? []).map(str).filter(Boolean).slice(0, 12),
  };
  return { notes, file: await save(title, notes, lines) };
}

async function save(title: string, n: MeetingNotes, lines: Line[]): Promise<string> {
  const dir = path.join(MARIGOLD_DIR, "meetings");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const d = new Date();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "meeting";
  const file = path.join(dir, `${d.toISOString().slice(0, 10)}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}-${slug}.md`);
  const body = [
    `# ${title}`, `${d.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}`, "",
    "## Summary", n.summary, "",
    n.decisions.length ? `## Decisions\n${n.decisions.map((x) => `- ${x}`).join("\n")}\n` : "",
    n.actionItems.length ? `## Action items\n${n.actionItems.map((a) => `- [ ] ${a.task}${a.owner ? ` (${a.owner})` : ""}${a.due ? ` — ${a.due}` : ""}`).join("\n")}\n` : "",
    n.questions.length ? `## Still open\n${n.questions.map((x) => `- ${x}`).join("\n")}\n` : "",
    "## Transcript", transcriptText(lines), "",
  ].filter((x) => x !== "").join("\n");
  await fs.writeFile(file, body, { mode: 0o600 });
  return file;
}
