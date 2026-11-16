import { localOnly } from "@/lib/server/agent/guard";
import { summarizeMeeting, type Line } from "@/lib/server/agent/meeting";

/** POST { title, lines: [{at, who, text}] } → { notes, file }: the summary, decisions and action items, saved on this Mac. */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 120) : "Meeting";
  const lines: Line[] = (Array.isArray(b.lines) ? b.lines : [])
    .filter((l: { at?: unknown; who?: unknown; text?: unknown }) => typeof l?.text === "string" && typeof l?.who === "string")
    .slice(0, 4000)
    .map((l: { at?: unknown; who: string; text: string }) => ({ at: Math.max(0, Number(l.at) || 0), who: l.who.slice(0, 40), text: l.text.slice(0, 1200) }));
  if (!lines.length) return Response.json({ error: "Nothing was heard, so there's nothing to write up." }, { status: 400 });
  try { return Response.json(await summarizeMeeting(title, lines)); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 }); }
}

/** GET → { apps: ["Zoom"] }: call apps that are in a call right now. Zoom starts its CptHost helper only during a meeting. (FaceTime's helper runs all the time, so it can't tell a call from none.) */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { execFile } = await import("child_process");
  const out = await new Promise<string>((res) => execFile("ps", ["-axo", "comm="], { maxBuffer: 4 << 20 }, (_e, so) => res(String(so ?? ""))));
  const apps: string[] = [];
  if (/CptHost/.test(out)) apps.push("Zoom");
  // Webex and Teams don't have a helper that only runs during a call: look for a call window instead (title says meeting / call).
  const apps2: [string, string, RegExp][] = [["Webex", "Webex", /meeting|webex/i], ["Microsoft Teams", "Microsoft Teams", /\| microsoft teams|meeting|call/i]];
  for (const [label, proc, re] of apps2) {
    if (!new RegExp(`${proc.split(" ").pop()}`, "i").test(out)) continue; // not even running
    try {
      const { windowsOf } = await import("@/lib/server/agent/windows");
      const w = await windowsOf([proc]);
      if (w.some((x) => re.test(x.name) && !/^\s*$/.test(x.name) && (label === "Webex" ? /meeting|in a meeting|\bwebex meeting/i.test(x.name) && !/^webex$/i.test(x.name.trim()) : /meeting|call/i.test(x.name)))) apps.push(label);
    } catch { /* can't tell */ }
  }
  // FaceTime's helper runs all the time, so look for a call window instead: the home window is called "FaceTime", a call window carries the person's name.
  if (/FaceTime/.test(out)) {
    try {
      const { windowsOf } = await import("@/lib/server/agent/windows");
      const w = await windowsOf(["FaceTime"]);
      if (w.some((x) => x.name.trim() && !/^(facetime|new facetime|)$/i.test(x.name.trim()) && x.w >= 240 && x.h >= 160)) apps.push("FaceTime");
    } catch { /* can't tell */ }
  }
  return Response.json({ apps });
}
