"use client";

import { useSyncExternalStore } from "react";

/**
 * Voice in the browser side of Marigold: whether the on-device voice models are set up, the spoken-reply
 * queue (Kokoro, open weights), and a filter so only the answer's summary text is ever read aloud —
 * never the steps the agent took, code, links, lists or tables.
 */

// ---------------------------------------------------------------- status + one-time setup

export interface VoiceStatus { installed: boolean; installing: boolean; step: string; error: string; expressive: boolean; expressiveInstalling: boolean; expressiveStep: string }
let status: VoiceStatus = { installed: false, installing: false, step: "", error: "", expressive: false, expressiveInstalling: false, expressiveStep: "" };
const subs = new Set<() => void>();
/** Only tells React when something actually changed (a new-but-equal snapshot would re-render forever). */
const emit = (s: Partial<VoiceStatus>) => {
  const next = { ...status, ...s };
  if (next.installed === status.installed && next.installing === status.installing && next.step === status.step && next.error === status.error && next.expressive === status.expressive && next.expressiveInstalling === status.expressiveInstalling && next.expressiveStep === status.expressiveStep) return;
  status = next;
  subs.forEach((f) => f());
};
let poll: ReturnType<typeof setInterval> | null = null;

let lastRefresh = 0;
async function refresh(): Promise<VoiceStatus> {
  lastRefresh = Date.now();
  const j = await fetch("/api/agent/voice", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  if (j) emit({ installed: !!j.installed, installing: !!j.installing, step: j.step ?? "", error: j.error ?? "", expressive: !!j.expressive, expressiveInstalling: !!j.expressiveInstalling, expressiveStep: j.expressiveStep ?? "" });
  return status;
}

/** Make sure voice is ready: starts the one-time install if needed and keeps `useVoiceStatus` updated until it's done. */
export async function ensureVoice(): Promise<VoiceStatus> {
  let s = await refresh();
  if (s.installed) return s;
  if (!s.installing) {
    const r = await fetch("/api/agent/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setup" }) }).then((x) => x.json()).catch(() => null);
    if (r) emit({ installed: !!r.installed, installing: !!r.installing, step: r.step ?? "", error: r.error ?? "" });
    s = status;
  }
  if (!poll && !s.installed) {
    poll = setInterval(async () => {
      const n = await refresh();
      if (n.installed || (!n.installing && n.error)) { if (poll) clearInterval(poll); poll = null; }
    }, 2000);
  }
  return s;
}
export const peekVoiceStatus = () => status;
// Stable functions (React re-subscribes whenever the subscribe function changes identity).
const subscribeStatus = (f: () => void) => {
  subs.add(f);
  if (Date.now() - lastRefresh > 5000) void refresh();
  return () => { subs.delete(f); };
};
const getStatus = () => status;
export function useVoiceStatus(): VoiceStatus {
  return useSyncExternalStore(subscribeStatus, getStatus, getStatus);
}

// ---------------------------------------------------------------- what gets spoken

/**
 * The part of a reply worth saying out loud: its opening sentences (the summary), without markdown, links,
 * code, tables or the list that follows. Long replies are cut at a sentence end.
 */
export function speakable(md: string): string {
  let t = md.replace(/```[\s\S]*?```/g, "\n").replace(/`[^`]*`/g, " ");
  // The lead-in before a list/table is the summary; the list itself is what's shown on screen.
  const m = t.match(/\n\s*(?:[-•*]\s+|\d+[.)]\s+|\|)/);
  let cutList = false;
  if (m?.index !== undefined) {
    if (t.slice(0, m.index).replace(/\s/g, "").length >= 25) { t = t.slice(0, m.index); cutList = true; }
    else if ((t.match(/\n\s*(?:[-•*]\s+|\d+[.)]\s+|\|)/g) ?? []).length >= 2) return ""; // nothing but a list: that's for the screen
  }
  if (/^\s*(?:[-•*]\s+|\d+[.)]\s+)/.test(t) && (t.match(/^\s*(?:[-•*]\s+|\d+[.)]\s+)/gm) ?? []).length >= 2) return "";
  t = t
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\b(?:read more|more info|see|visit|find it|available|details?)?\s*(?:at|on|here|:)?\s*https?:\/\/\S+/gi, "").replace(/\*\*|__|\*|~~|^#+\s?/gm, "")
    .replace(/^\s*[-•*]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "").replace(/\|[^\n]*\|/g, " ")
    .replace(/\[attached:[^\]]*\]/g, "").replace(/[→←↑↓]/g, " ").replace(/\n{2,}/g, ". ").replace(/\n/g, " ").replace(/([:;,])\s*\./g, ".").replace(/\.{2,}/g, ".").replace(/\s+([.,!?])/g, "$1").replace(/\s+/g, " ").trim();
  if (t.length < 2) return "";
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [t];
  let out = "";
  for (const s of sentences) {
    if (out && /^\s*[a-z]/.test(s) && s.length < 30) continue; // a stub left behind by a removed link
    if (out && (out.length + s.length > 460 || out.split(/[.!?]\s/).length >= 4)) break;
    out += s;
  }
  out = out.trim().replace(/:$/, ".").slice(0, 600);
  return cutList ? `${out} The rest is on your screen.` : out;
}

// ---------------------------------------------------------------- speaking

const KEY_VOICE = "marigold.voiceName", KEY_SPEED = "marigold.voiceSpeed";
export const VOICES: [string, string][] = [
  ["af_heart", "Heart (warm)"], ["af_bella", "Bella"], ["af_nicole", "Nicole (calm)"], ["af_sarah", "Sarah"], ["af_sky", "Sky"],
  ["am_adam", "Adam"], ["am_michael", "Michael"], ["bf_emma", "Emma (British)"], ["bm_george", "George (British)"],
];
export const getVoice = () => { try { return localStorage.getItem(KEY_VOICE) || "af_heart"; } catch { return "af_heart"; } };
export const setVoice = (v: string) => { try { localStorage.setItem(KEY_VOICE, v); } catch { /* private mode */ } };
export const getSpeed = () => { try { return Number(localStorage.getItem(KEY_SPEED)) || 1; } catch { return 1; } };
export const setSpeed = (v: number) => { try { localStorage.setItem(KEY_SPEED, String(v)); } catch { /* private mode */ } };

let speaking = false;
let gen = 0;
let audio: HTMLAudioElement | null = null;
const speakSubs = new Set<() => void>();
const setSpeaking = (v: boolean) => { if (speaking !== v) { speaking = v; speakSubs.forEach((f) => f()); } };
const subscribeSpeaking = (f: () => void) => { speakSubs.add(f); return () => { speakSubs.delete(f); }; };
const getSpeaking = () => speaking;
const getSpeakingServer = () => false;
export const useSpeaking = () => useSyncExternalStore(subscribeSpeaking, getSpeaking, getSpeakingServer);

export function stopSpeaking() {
  gen++;
  if (audio) { audio.pause(); audio.src = ""; audio = null; }
  setSpeaking(false);
}

/** Cut text into short pieces at sentence ends so speech starts after the first piece is ready, not the whole reply. */
function pieces(text: string, max = 170): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text]) {
    if (cur && cur.length + s.length > max) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Start the one-time install of the expressive (laughing) voice in the background. */
export async function ensureExpressive(): Promise<void> {
  if (status.expressive || status.expressiveInstalling) return;
  const r = await fetch("/api/agent/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setup-expressive" }) }).then((x) => x.json()).catch(() => null);
  if (r) emit({ expressive: !!r.expressive, expressiveInstalling: !!r.expressiveInstalling, expressiveStep: r.expressiveStep ?? "" });
  if (!poll) {
    poll = setInterval(async () => {
      const n = await refresh();
      if (n.expressive || !n.expressiveInstalling) { if (poll) clearInterval(poll); poll = null; }
    }, 3000);
  }
}

async function fetchSpeech(text: string, expressive = false): Promise<Blob> {
  const r = await fetch("/api/agent/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice: getVoice(), speed: getSpeed(), expressive }) });
  if (r.status === 409) { void ensureVoice(); throw new Error("not_set_up"); }
  if (!r.ok) throw new Error("tts failed");
  return r.blob();
}

/** Say this text aloud (replaces anything already being said). Resolves when finished or stopped. */
export async function speakText(text: string): Promise<void> {
  stopSpeaking();
  const mine = gen;
  const list = pieces(text);
  if (!list.length) return;
  setSpeaking(true);
  try {
    // Keep the next piece generating while the current one plays.
    const ready: Promise<Blob>[] = [];
    const prime = (i: number) => { if (i < list.length && !ready[i]) { ready[i] = fetchSpeech(list[i]); ready[i].catch(() => {}); } };
    prime(0); prime(1);
    for (let i = 0; i < list.length; i++) {
      const blob = await ready[i];
      if (mine !== gen) return;
      prime(i + 2);
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audio = a;
      await new Promise<void>((res) => { a.onended = () => res(); a.onerror = () => res(); a.play().catch(() => res()); });
      URL.revokeObjectURL(url);
      if (mine !== gen) return;
    }
  } catch { /* voice not ready / network: stay silent */ }
  finally { if (mine === gen) { audio = null; setSpeaking(false); } }
}

/**
 * Speech that starts while the reply is still being written: push sentences as they appear, they play in order
 * (the next one is already being voiced while the current one plays). `end()` says no more are coming; `done`
 * resolves when everything has been said or it was stopped.
 */
export function speechStream(opts: { expressive?: boolean; onPlay?: () => void } = {}) {
  stopSpeaking();
  const mine = gen;
  const jobs: Promise<Blob>[] = [];
  let closed = false, running = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => { finish = r; });
  const pump = async () => {
    if (running) return;
    running = true;
    setSpeaking(true);
    let i = 0;
    while (mine === gen) {
      if (i < jobs.length) {
        try {
          const blob = await jobs[i];
          if (mine !== gen) break;
          const url = URL.createObjectURL(blob);
          const a = new Audio(url);
          audio = a;
          a.onplaying = () => opts.onPlay?.();
          await new Promise<void>((res) => { a.onended = () => res(); a.onerror = () => res(); a.play().catch(() => res()); });
          URL.revokeObjectURL(url);
        } catch { /* a piece failed: skip it */ }
        i++;
      } else if (closed) break;
      else await new Promise((r) => setTimeout(r, 40));
    }
    if (mine === gen) { audio = null; setSpeaking(false); }
    finish();
  };
  return {
    push(text: string) {
      if (mine !== gen || closed) return;
      for (const p of pieces(text, opts.expressive ? 110 : 170)) { const b = fetchSpeech(p, opts.expressive); b.catch(() => {}); jobs.push(b); }
      void pump();
    },
    end() { closed = true; void pump(); },
    done,
    stopped: () => mine !== gen,
  };
}
export const isSpeakingNow = () => speaking;
