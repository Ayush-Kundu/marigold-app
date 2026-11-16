"use client";

import { useSyncExternalStore } from "react";
import { wavFrom } from "@/lib/dictation";
import { nativeApp } from "@/lib/native";
import { ensureVoice, peekVoiceStatus } from "@/lib/voice-client";

/**
 * Meeting notes. Only ever started by the person on the call (a button, after a reminder to tell the others).
 *   • The sound of the call (what comes out of this Mac) and your microphone are each cut into ~25-second pieces.
 *   • Each piece is written down by Whisper ON THIS MAC and thrown away. No audio is kept or sent anywhere.
 *   • When you stop, the text goes to the AI for a short summary, decisions and action items, saved in ~/.marigold/meetings.
 */

export type MeetingPhase = "off" | "starting" | "recording" | "writing" | "done";
export interface Line { at: number; who: string; text: string }
export interface Notes { summary: string; decisions: string[]; actionItems: { task: string; owner?: string; due?: string }[]; questions: string[] }
interface State { phase: MeetingPhase; title: string; startedAt: number; lines: Line[]; notes: Notes | null; file: string; error: string; warning: string; open: boolean }

let state: State = { phase: "off", title: "", startedAt: 0, lines: [], notes: null, file: "", error: "", warning: "", open: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const useMeeting = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state, () => state);
export const meetingState = () => state;
export const setNotesOpen = (open: boolean) => set({ open });

const PIECE_MS = 25_000;
const PHANTOM = /^(\.+|you|thank you\.?|thanks\.?|thanks for watching\.?|bye\.?|okay\.?|oh\.?|um+\.?|uh+\.?|hmm+\.?|\[.*\]|\(.*\))$/i;

interface Tap { who: string; stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[] }
let taps: Tap[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = 0;

function tap(stream: MediaStream, who: string): Tap {
  const ctx = new AudioContext({ sampleRate: 16000 });
  void ctx.resume().catch(() => {}); // a context started outside a click begins suspended and would hear nothing
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const t: Tap = { who, stream, ctx, node, chunks: [] };
  node.onaudioprocess = (e) => { t.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(node);
  node.connect(ctx.destination); // writes nothing to the output, so the call's sound isn't played twice
  return t;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2));
/** Speakers leak into the microphone: if "You" repeats what "Others" just said, it's the echo, not you. */
function isEcho(text: string, at: number): boolean {
  const mine = words(text);
  if (mine.size < 3) return false;
  return state.lines.some((l) => l.who === "Others" && at - l.at < 60_000 && (() => { const o = words(l.text); let hit = 0; mine.forEach((w) => { if (o.has(w)) hit++; }); return hit / mine.size >= 0.6; })());
}

async function flush(t: Tap) {
  const chunks = t.chunks; t.chunks = [];
  if (!chunks.length) return;
  let sum = 0, n = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i += 8) { sum += c[i] * c[i]; n++; }
  const rms = Math.sqrt(sum / Math.max(1, n));
  if (rms < 0.004) return; // silence: nothing to write down
  const at = Date.now() - state.startedAt - Math.round((chunks.length * 4096 * 1000) / 16000);
  inflight++;
  try {
    const res = await fetch("/api/agent/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wavFrom(chunks, t.ctx.sampleRate) });
    const j = await res.json().catch(() => ({}));
    const text = res.ok && j.text ? String(j.text).trim() : "";
    if (!text || PHANTOM.test(text) || text.split(/\s+/).length < 3) return;
    if (t.who === "You" && isEcho(text, Math.max(0, at))) return;
    set({ lines: [...state.lines, { at: Math.max(0, at), who: t.who, text }].sort((a, b) => a.at - b.at) });
  } catch { /* one piece lost; the next one carries on */ } finally { inflight--; }
}

function release() {
  if (timer) { clearInterval(timer); timer = null; }
  if (capTimer) { clearInterval(capTimer); capTimer = null; }
  if (capFallback) { clearTimeout(capFallback); capFallback = null; }
  capTab = 0;
  for (const t of taps) {
    try { t.node.disconnect(); } catch { /* gone */ }
    t.stream.getTracks().forEach((x) => x.stop());
    void t.ctx.close().catch(() => {});
  }
  taps = [];
}

// ---- live captions (how Gemini takes notes): read the call page's own captions, no audio and no macOS permission needed
let capTab = 0, capTimer: ReturnType<typeof setInterval> | null = null, capFallback: ReturnType<typeof setTimeout> | null = null, capSeen = 0;
const lastBy = new Map<string, { idx: number; text: string }>();
const looksLikeName = (s: string) => s.length <= 40 && !/[.?!,:;]$/.test(s) && s.split(/\s+/).length <= 4 && /^\p{Lu}/u.test(s);
function addCaption(whoRaw: string, text: string) {
  const who = /^you$/i.test(whoRaw) ? "You" : whoRaw;
  const prev = lastBy.get(who);
  // Captions grow as someone talks ("so we" → "so we should" → …): replace that line instead of repeating it.
  if (prev && (text.startsWith(prev.text) || prev.text.startsWith(text) || text.slice(0, 24) === prev.text.slice(0, 24)) && state.lines[prev.idx]?.who === who) {
    if (text.length >= prev.text.length) { const lines = state.lines.slice(); lines[prev.idx] = { ...lines[prev.idx], text }; set({ lines }); lastBy.set(who, { idx: prev.idx, text }); }
    return;
  }
  const lines = [...state.lines, { at: Math.max(0, Date.now() - state.startedAt), who, text }];
  set({ lines });
  lastBy.set(who, { idx: lines.length - 1, text });
}
function ingestCaptions(text: string) {
  const raw = text.split("\n").map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < raw.length;) {
    if (raw[i + 1] !== undefined && looksLikeName(raw[i])) { addCaption(raw[i], raw[i + 1]); i += 2; }
    else { addCaption("Others", raw[i]); i++; }
  }
}
async function readCaptions() {
  const b = nativeApp()?.browser;
  if (!b || !capTab) return;
  const r = await b.captions(capTab).catch(() => null);
  if (r?.text?.trim()) { capSeen = Date.now(); ingestCaptions(r.text); }
}
/** A browser call whose captions we can read. */
export function captionable(url: string): boolean {
  try { const u = new URL(url); const h = u.hostname.replace(/^www\./, ""); return h === "meet.google.com" || (/(^|\.)zoom\.(us|com)$/.test(h) && /^\/wc\//.test(u.pathname)) || h === "teams.microsoft.com" || h === "teams.live.com" || (/(^|\.)webex\.com$/.test(h) && /\/(meet|wbxmjs|join|webappng|meeting)/.test(u.pathname)); } catch { return false; }
}

async function startAudio(warn: string[], micOnly = false): Promise<boolean> {
  const v = peekVoiceStatus().installed ? peekVoiceStatus() : await ensureVoice();
  if (!v.installed) { warn.push(v.error || "Setting up listening on this Mac (one time). Try again when it's done."); return false; }
  let mic: MediaStream | null = null, call: MediaStream | null = null;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
  catch { warn.push("Couldn't use your microphone, so your own words won't be in the notes."); }
  if (!micOnly) try {
    const d = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    d.getVideoTracks().forEach((x) => x.stop());
    if (d.getAudioTracks().length) call = new MediaStream(d.getAudioTracks());
    else warn.push("Couldn't hear the call's sound, so only your microphone is in the notes.");
  } catch { warn.push("Couldn't capture the call's sound (macOS may need Screen Recording turned on for Marigold), so only your microphone is in the notes."); }
  if (!mic && !call) return false;
  taps = [...(call ? [tap(call, "Others")] : []), ...(mic ? [tap(mic, "You")] : [])];
  timer = setInterval(() => { for (const t of taps) void flush(t); }, PIECE_MS);
  return true;
}

/** Start notes. For a call in a browser tab it reads the call's live captions; otherwise (Zoom's app, FaceTime…) it listens. */
export async function startMeeting(title: string, opts: { tabId?: number; url?: string; micOnly?: boolean } = {}) {
  if (state.phase === "starting" || state.phase === "recording" || state.phase === "writing") return;
  set({ phase: "starting", title: title.trim() || "Meeting", startedAt: Date.now(), lines: [], notes: null, file: "", error: "", warning: "", open: false });
  lastBy.clear(); capSeen = 0;
  const b = nativeApp()?.browser;
  if (b && opts.tabId && opts.url && captionable(opts.url)) {
    capTab = opts.tabId;
    const on = await b.captionsOn(opts.tabId).catch(() => false);
    set({ phase: "recording", startedAt: Date.now(), warning: on ? "Taking notes from the call's live captions. Marigold turned them on; they stay on until you turn them off." : "Taking notes from the call's live captions. Turn captions on in the call (the CC button) so there's something to read." });
    capTimer = setInterval(() => void readCaptions(), 2500);
    // No captions after 30 seconds (they're off, or this call doesn't offer them): listen to the call instead.
    capFallback = setTimeout(async () => {
      if (capSeen || state.phase !== "recording") return;
      const warn: string[] = ["No captions appeared, so Marigold is listening to the call instead."];
      const ok = await startAudio(warn);
      set({ warning: ok ? warn.join(" ") : "No captions appeared and the call's sound couldn't be captured. Turn on captions in the call." });
    }, 30_000);
    return;
  }
  const warn: string[] = [];
  const ok = await startAudio(warn, opts.micOnly === true);
  if (!ok) { set({ phase: "off", error: warn.join(" ") || "Couldn't listen to the call." }); return; }
  set({ phase: "recording", warning: warn.join(" "), startedAt: Date.now() });
}

export async function stopMeeting() {
  if (state.phase !== "recording") return;
  set({ phase: "writing" });
  if (capTab) await readCaptions(); // one last look at the captions
  for (const t of taps) await flush(t);
  while (inflight > 0) await new Promise((r) => setTimeout(r, 200));
  release();
  const lines = state.lines;
  if (!lines.length) { set({ phase: "off", error: "Nothing was heard on the call, so there are no notes." }); return; }
  try {
    const r = await fetch("/api/agent/meeting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: state.title, lines }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Couldn't write the notes.");
    set({ phase: "done", notes: j.notes, file: j.file, open: false }); // the assistant takes it from here (see MeetingHost)
  } catch (e) { set({ phase: "done", notes: null, error: e instanceof Error ? e.message : String(e), open: true }); }
}

/** Throw the call away without notes. */
export function cancelMeeting() { release(); set({ phase: "off", lines: [], notes: null, error: "", warning: "", open: false }); }
export const dismissMeeting = () => set({ phase: "off", open: false });

/** Is this tab a video call? (Google Meet, Zoom's web client, Teams, Webex, Whereby, Jitsi, Around… by address, or by title on those sites.) */
export function isMeetingUrl(url: string, title = ""): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (h === "meet.google.com") return u.pathname.length > 1 && !/^\/(landing|about|new)?\/?$/.test(u.pathname) && !/^\/(landing|about)\b/.test(u.pathname);
    if (/(^|\.)zoom\.(us|com)$/.test(h)) return /^\/(wc|j|s|my|join)\b/.test(u.pathname) || /zoom meeting/i.test(title);
    if (h === "teams.microsoft.com" || h === "teams.live.com") return /meet|meetup-join|calling|light-meetings|v2/i.test(u.pathname + u.search + u.hash) || /\| microsoft teams|meeting/i.test(title);
    if (/(^|\.)webex\.com$/.test(h)) return /\/(meet|wbxmjs|join|webappng)/.test(u.pathname);
    if (h === "whereby.com" || h === "meet.jit.si" || h === "around.co" || h === "gather.town" || h === "app.gather.town") return u.pathname.length > 1;
    if (h === "app.slack.com") return /huddle/i.test(u.pathname + u.hash);
    return false;
  } catch { return false; }
}

/** Notes from a recording (voice memo, saved call, lecture; audio or video). Turned into text on this Mac, then the same summary and tasks. */
export async function notesFromFile(file: File, title: string) {
  if (state.phase === "starting" || state.phase === "recording" || state.phase === "writing") return;
  set({ phase: "writing", title: title.trim() || file.name.replace(/\.[a-z0-9]+$/i, "") || "Recording", startedAt: Date.now(), lines: [], notes: null, file: "", error: "", warning: "", open: false });
  try {
    const fd = new FormData(); fd.append("file", file); fd.append("title", state.title);
    const r = await fetch("/api/agent/meeting/file", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Couldn't write notes from that file.");
    set({ phase: "done", notes: j.notes, file: j.file, open: false });
  } catch (e) { set({ phase: "off", error: e instanceof Error ? e.message : String(e), open: false }); }
}
