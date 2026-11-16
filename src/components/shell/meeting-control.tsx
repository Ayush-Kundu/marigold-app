"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, NotebookPen, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { Modal } from "@/components/ui/modal";
import { nativeApp } from "@/lib/native";
import { cancelMeeting, dismissMeeting, isMeetingUrl, meetingState, notesFromFile, setNotesOpen, startMeeting, stopMeeting, useMeeting } from "@/lib/meeting";

/** Anything can ask to start notes: the top bar button, the call reminder in the browser. */
export const askToTakeNotes = (title = "", tab?: { id: number; url: string }) => window.dispatchEvent(new CustomEvent("mg-meeting-start", { detail: { title, tab } }));

/** Give the assistant the notes and let it do what it can: summary first, then every task that is its to do (reminders, calendar, drafts, documents). */
export function handOverToAssistant(title: string, n: { summary: string; decisions: string[]; actionItems: { task: string; owner?: string; due?: string }[]; questions: string[] }, only?: number[], mine = "") {
  const items = n.actionItems.filter((_, i) => !only || only.includes(i));
  const ask = [
    `I just finished a meeting called “${title}” and Marigold took notes. Here they are.`,
    `Summary: ${n.summary}`,
    n.decisions.length ? `Decisions:\n${n.decisions.map((d) => `- ${d}`).join("\n")}` : "",
    items.length ? `Action items:\n${items.map((a, i) => `${i + 1}. ${a.task}${a.owner ? ` (owner: ${a.owner})` : ""}${a.due ? ` — due ${a.due}` : ""}`).join("\n")}` : "",
    n.questions.length ? `Still open:\n${n.questions.map((q) => `- ${q}`).join("\n")}` : "",
    mine.trim() ? `My own instructions for this (they come first, and override anything above): ${mine.trim()}` : "",
    "Please: (1) open with a three-line summary; (2) do ONLY the action items listed above (and anything my instructions add), the ones that are mine and that you can do with my apps right now (reminders, calendar events, notes, documents, to-do lists), using my details; (3) for anything that involves other people, write the draft and ask me before sending; (4) end with a short list of what is left for me. Say plainly what you did and what you could not.",
  ].filter(Boolean).join("\n\n");
  const st = useApp.getState();
  if (st.activeTab === "browser") window.dispatchEvent(new CustomEvent("mg-ask-assistant", { detail: { q: ask } }));
  else { st.setTab("chats"); void st.sendUserMessage(ask); }
}

/** While notes are being taken: what has been heard so far, inside the assistant (and the chat, for apps like Zoom). */
export function MeetingLive() {
  const m = useMeeting();
  const [now, setNow] = useState(0);
  useEffect(() => { if (m.phase !== "recording") return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [m.phase]);
  if (m.phase !== "recording" && m.phase !== "writing") return null;
  const recent = m.lines.slice(-4);
  return (
    <div className="rounded-xl border border-danger/40 bg-danger/[0.06] p-3 text-[12px]">
      <div className="flex items-center gap-2">
        {m.phase === "recording" ? <span className="h-2 w-2 animate-pulse rounded-full bg-danger" /> : <Loader2 size={12} className="animate-spin" />}
        <span className="font-medium">{m.phase === "recording" ? `Taking notes: ${m.title}` : "Writing the notes and working out the tasks…"}</span>
        {m.phase === "recording" && <span className="ml-auto tabular-nums text-muted">{clock(now > m.startedAt ? now - m.startedAt : 0)}</span>}
        {m.phase === "recording" && <button onClick={() => void stopMeeting()} className="flex h-6 items-center gap-1 rounded-full bg-danger px-2 font-medium text-white"><Square size={9} /> Stop</button>}
      </div>
      {m.phase === "recording" && (
        <div className="mt-2 space-y-1 text-[11.5px] leading-snug text-muted">
          {recent.length === 0 ? <p>Listening… the first lines appear in a few seconds.</p> : recent.map((l, i) => <p key={`${l.at}-${i}`} className="line-clamp-2"><b className="text-foreground/80">{l.who}:</b> {l.text}</p>)}
          {m.warning && <p className="pt-1 text-[11px] italic">{m.warning}</p>}
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-muted">When you stop, Marigold writes the notes here and asks what you want done. Nothing happens without your yes.</p>
    </div>
  );
}

/** The top-bar button doesn't know about browser tabs: if the tab showing is a call, notes come from its captions. */
async function askFromBar() {
  const b = nativeApp()?.browser;
  const st = await b?.state().catch(() => null);
  const t = st?.tabs.find((x) => x.id === st.activeId);
  const onBrowser = useApp.getState().activeTab === "browser";
  askToTakeNotes(t && onBrowser && isMeetingUrl(t.url, t.title) ? t.title.replace(/\s*-\s*Google Meet.*$/i, "") : "", t && onBrowser && isMeetingUrl(t.url, t.title) ? { id: t.id, url: t.url } : undefined);
}

/** A Zoom call that is going on now (checked every 15 seconds while Marigold is in view). */
function useCallApps(): string[] {
  const [apps, setApps] = useState<string[]>([]);
  useEffect(() => {
    let dead = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      const j = await fetch("/api/agent/meeting", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { apps?: string[] } | null;
      if (!dead) setApps((cur) => { const n = j?.apps ?? []; return cur.join() === n.join() ? cur : n; });
    };
    void poll();
    const t = setInterval(poll, 15_000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return apps;
}

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The finished notes, for the user to look over: tick the tasks, add their own take, then say yes (or not now). Nothing runs before that. */
export function MeetingReview() {
  const m = useMeeting();
  const [picked, setPicked] = useState<Set<number>>(() => new Set((m.notes?.actionItems ?? []).map((_, i) => i)));
  const [mine, setMine] = useState("");
  const n = m.notes;
  if (!n) return null;
  const toggle = (i: number) => setPicked((s) => { const x = new Set(s); if (x.has(i)) x.delete(i); else x.add(i); return x; });
  const go = () => { handOverToAssistant(m.title, n, [...picked], mine); dismissMeeting(); };
  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-accent/40 bg-accent-soft p-3 text-[12px] [overflow-wrap:anywhere]">
      <div className="flex items-center gap-2"><NotebookPen size={14} className="shrink-0 text-accent" /><p className="min-w-0 flex-1 truncate font-medium">Notes from “{m.title}”</p><button onClick={() => dismissMeeting()} aria-label="Close" className="ml-auto rounded p-0.5 text-muted hover:text-foreground"><X size={13} /></button></div>
      <p className="leading-relaxed">{n.summary}</p>
      {n.decisions.length > 0 && <div><p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Decisions</p><ul className="list-disc space-y-0.5 pl-4">{n.decisions.map((d) => <li key={d}>{d}</li>)}</ul></div>}
      {n.actionItems.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Tasks Marigold could do (nothing happens until you say so)</p>
          <ul className="space-y-1">
            {n.actionItems.map((a, i) => (
              <li key={i}><label className="flex cursor-pointer items-start gap-2 rounded-lg bg-background/60 px-2 py-1.5"><input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} className="mt-0.5" /><span className="min-w-0 flex-1">{a.task}<span className="block text-[11px] text-muted">{[a.owner, a.due && `due ${a.due}`].filter(Boolean).join(" · ")}</span></span></label></li>
            ))}
          </ul>
        </div>
      )}
      <label className="block text-[11px] text-muted">Your own take (optional): what to change, add, or leave alone
        <textarea value={mine} onChange={(e) => setMine(e.target.value)} rows={2} placeholder="e.g. Only set the reminders. Draft the email to Priya but don't send it." className="mt-1 w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={go} disabled={!picked.size && !mine.trim()} className={cn("h-8 rounded-lg bg-accent px-3 text-[12px] font-semibold text-black", !picked.size && !mine.trim() && "opacity-40")}>Yes, do these</button>
        <button onClick={() => dismissMeeting()} className="h-8 rounded-lg border border-border px-3 text-[12px] hover:bg-surface-hover">Not now</button>
        {m.file && <span className="ml-auto hidden truncate text-[10.5px] text-muted min-[360px]:inline" title={m.file}>Saved on this Mac</span>}
      </div>
    </div>
  );
}

/** Under the assistant, only while the tab is a video call: offer notes, show them being taken, or say they're being written. */
export function MeetingCard({ url, title, tabId }: { url: string; title: string; tabId: number }) {
  const m = useMeeting();
  if (m.phase === "recording" || m.phase === "writing" || m.phase === "starting") return <MeetingLive />;
  if (m.phase === "done" && m.notes) return <MeetingReview />;
  if (m.phase === "done" && !m.open && m.error) return <button onClick={() => setNotesOpen(true)} className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-[12px] hover:bg-surface-hover"><NotebookPen size={13} className="text-accent" /> The notes didn&apos;t finish. See what was heard</button>;
  if (m.phase !== "off" || !isMeetingUrl(url, title)) return null;
  return (
    <div className="rounded-xl border border-accent/40 bg-accent-soft p-3 text-[12px]">
      <div className="flex items-start gap-2.5">
        <NotebookPen size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">You&apos;re on a call</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted">Marigold can take notes here, then do the follow-ups it can: reminders, calendar events, drafts.</p>
          <button onClick={() => askToTakeNotes(title.replace(/\s*-\s*Google Meet.*$/i, ""), { id: tabId, url })} className="mt-2 h-7 rounded-lg bg-accent px-3 text-[11.5px] font-semibold text-black">Take notes</button>
        </div>
      </div>
    </div>
  );
}

/** In the chat, only while an app like Zoom is in a call (or notes are being taken). */
export function MeetingChatCard() {
  const m = useMeeting();
  const calls = useCallApps();
  if (m.phase === "recording" || m.phase === "writing" || m.phase === "starting") return <MeetingLive />;
  if (m.phase === "done" && m.notes) return <MeetingReview />;
  if (m.phase !== "off" || !calls.length) return null;
  return (
    <div className="rounded-xl border border-accent/40 bg-accent-soft p-3 text-[12px]">
      <div className="flex items-start gap-2.5">
        <NotebookPen size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{calls[0]} call in progress</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted">Marigold can take notes here, then do the follow-ups it can.</p>
          <button onClick={() => void askFromBar()} className="mt-2 h-7 rounded-lg bg-accent px-3 text-[11.5px] font-semibold text-black">Take notes</button>
        </div>
      </div>
    </div>
  );
}

/** The windows: the "tell the others" reminder before notes start, and the notes (with their tasks) afterwards. Mount once. */
export function MeetingHost() {
  const m = useMeeting();
  const setOverlay = useApp((s) => s.setBrowserOverlay);
  const [consent, setConsent] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [room, setRoom] = useState(false); // microphone only (in the room, a phone on speaker)
  const recFile = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<{ id: number; url: string } | undefined>();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const handed = useRef("");

  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent<{ title?: string; tab?: { id: number; url: string } }>).detail; setTitle(d?.title ?? ""); setTab(d?.tab); setRoom(false); setConsent("ask"); };
    window.addEventListener("mg-meeting-start", f);
    return () => window.removeEventListener("mg-meeting-start", f);
  }, []);
  // The page in the browser tab is drawn above this app's own windows unless it is told to step aside.
  const showing = consent !== null || (m.open && m.phase === "done");
  useEffect(() => { if (!showing) return; setOverlay(1); return () => setOverlay(-1); }, [showing, setOverlay]);
  useEffect(() => { // all tasks start ticked when new notes arrive
    if (m.notes) void Promise.resolve().then(() => setPicked(new Set(m.notes!.actionItems.map((_, i) => i))));
  }, [m.notes]);
  useEffect(() => {
    const msg = [m.error, m.phase === "recording" ? m.warning : ""].filter(Boolean).join(" ");
    if (!msg) return;
    void Promise.resolve().then(() => setToast(msg));
    const t = setTimeout(() => setToast(""), 9000);
    return () => clearTimeout(t);
  }, [m.error, m.warning, m.phase]);
  // Notes are ready: nothing is done with them until the user says so (the review card in the assistant asks).
  useEffect(() => {
    if (m.phase !== "done" || !m.notes || !m.file || handed.current === m.file) return;
    handed.current = m.file;
    void Promise.resolve().then(() => setToast(`Notes saved (${m.file.replace(/^\/Users\/[^/]+/, "~")}). Look over the tasks in the assistant and say what to do.`));
  }, [m.phase, m.notes, m.file]);
  useEffect(() => { const off = () => { if (meetingState().phase === "recording") cancelMeeting(); }; window.addEventListener("beforeunload", off); return () => window.removeEventListener("beforeunload", off); }, []);

  const notesText = () => {
    const n = m.notes; if (!n) return "";
    return [`${m.title}`, "", n.summary, n.decisions.length ? `\nDecisions:\n${n.decisions.map((x) => `- ${x}`).join("\n")}` : "", n.actionItems.length ? `\nAction items:\n${n.actionItems.map((a) => `- ${a.task}${a.owner ? ` (${a.owner})` : ""}${a.due ? ` by ${a.due}` : ""}`).join("\n")}` : ""].join("\n");
  };
  const doTasks = () => { if (m.notes) { dismissMeeting(); handOverToAssistant(m.title, m.notes, [...picked]); } };

  return (
    <>
      {consent !== null && (
        <Modal onClose={() => setConsent(null)} className="max-w-md">
          <div className="space-y-4 p-4 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><NotebookPen size={17} /></span>
              <div>
                <h2 className="text-[16px] font-semibold">Take notes on this call?</h2>
                <p className="mt-1 text-[12.5px] leading-snug text-muted">{tab ? "Marigold will read the call's live captions (turning them on if needed), and give you a summary and a list of tasks when you stop." : "Marigold will listen to the call and your microphone, write down what is said, and give you a summary and a list of tasks when you stop."}</p>
              </div>
            </div>
            <ul className="space-y-1.5 text-[12.5px] leading-snug">
              <li className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-accent" /> {tab ? "It uses the call's own captions: no recording at all." : "The listening and writing happen on this Mac. No recording is kept or uploaded."}</li>
              <li className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-accent" /> Only the written text goes to the AI, to make the summary.</li>
              <li className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-accent" /> <b>Tell the others you are taking notes.</b> Some places require everyone to agree.</li>
            </ul>
            <label className="block text-[12px] text-muted">Name this meeting
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly sync" className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:border-accent" />
            </label>
            {!tab && (
              <div className="grid grid-cols-1 gap-1 rounded-lg bg-surface p-0.5 text-[12px] min-[420px]:grid-cols-2" role="radiogroup" aria-label="What to listen to">
                <button role="radio" aria-checked={!room} onClick={() => setRoom(false)} className={cn("rounded-md px-2 py-1.5", !room ? "bg-background font-medium shadow-sm" : "text-muted")}>A call on this Mac<span className="block text-[10.5px] font-normal text-muted">Zoom, FaceTime, Webex, any app</span></button>
                <button role="radio" aria-checked={room} onClick={() => setRoom(true)} className={cn("rounded-md px-2 py-1.5", room ? "bg-background font-medium shadow-sm" : "text-muted")}>In the room<span className="block text-[10.5px] font-normal text-muted">Microphone only: class, meeting, phone on speaker</span></button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <input ref={recFile} type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.flac,.ogg,.mp4,.mov,.m4v,.webm" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { setConsent(null); void notesFromFile(f, title); } }} />
              <button onClick={() => recFile.current?.click()} className="mr-auto h-9 rounded-lg px-2 text-left text-[12px] text-muted hover:bg-surface-hover hover:text-foreground max-[420px]:basis-full">Use a recording instead…</button>
              <button onClick={() => setConsent(null)} className="h-9 rounded-lg border border-border px-4 text-[13px] hover:bg-surface-hover">Cancel</button>
              <button onClick={() => { setConsent(null); void startMeeting(title, { tabId: tab?.id, url: tab?.url, micOnly: room && !tab }); }} className="h-9 rounded-lg bg-accent px-5 text-[13px] font-semibold text-accent-foreground">Start notes</button>
            </div>
          </div>
        </Modal>
      )}

      {m.open && m.phase === "done" && (
        <Modal onClose={() => setNotesOpen(false)} className="max-w-xl">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 sm:px-5 sm:py-3.5">
            <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold"><NotebookPen size={15} className="shrink-0" /> <span className="min-w-0 truncate">{m.title}</span></h2>
            <button onClick={() => setNotesOpen(false)} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-hover hover:text-foreground"><X size={16} /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 text-[13px] leading-relaxed [overflow-wrap:anywhere] sm:px-5">
            {m.notes ? (
              <>
                <p>{m.notes.summary}</p>
                {m.notes.decisions.length > 0 && <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Decisions</p><ul className="list-disc space-y-1 pl-5">{m.notes.decisions.map((d) => <li key={d}>{d}</li>)}</ul></div>}
                {m.notes.actionItems.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Tasks Marigold can do for you</p>
                    <ul className="space-y-1.5">
                      {m.notes.actionItems.map((a, i) => (
                        <li key={i}>
                          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 hover:bg-surface-hover">
                            <input type="checkbox" checked={picked.has(i)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} className="mt-1" />
                            <span className="min-w-0 flex-1">{a.task}<span className="block text-[11.5px] text-muted">{[a.owner, a.due && `due ${a.due}`].filter(Boolean).join(" · ")}</span></span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {m.notes.questions.length > 0 && <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Still open</p><ul className="list-disc space-y-1 pl-5">{m.notes.questions.map((q) => <li key={q}>{q}</li>)}</ul></div>}
                {m.file && <p className="text-[11.5px] text-muted">Saved on this Mac: {m.file.replace(/^\/Users\/[^/]+/, "~")}</p>}
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-danger">{m.error || "The notes couldn't be written."}</p>
                <p className="text-muted">What was heard is still here. You can copy it.</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-[11.5px]">{m.lines.map((l) => `${l.who}: ${l.text}`).join("\n")}</pre>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-3 sm:px-5">
            <button onClick={() => { void navigator.clipboard.writeText(m.notes ? notesText() : m.lines.map((l) => `${l.who}: ${l.text}`).join("\n")); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12px] hover:bg-surface-hover">{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</button>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => dismissMeeting()} className="h-8 rounded-lg border border-border px-3 text-[12px] hover:bg-surface-hover">Done</button>
              {m.notes && m.notes.actionItems.length > 0 && <button onClick={doTasks} disabled={picked.size === 0} className={cn("h-8 rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-foreground", picked.size === 0 && "opacity-40")}>Do the {picked.size} selected</button>}
            </div>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[150] max-w-md -translate-x-1/2 rounded-xl border border-border bg-background px-4 py-2.5 text-[12.5px] shadow-xl">
          {toast} <button onClick={() => setToast("")} className="ml-2 text-muted hover:text-foreground" aria-label="Dismiss"><X size={12} className="inline" /></button>
        </div>
      )}
    </>
  );
}
