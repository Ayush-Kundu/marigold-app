"use client";

import { useSyncExternalStore } from "react";
import { useApp } from "@/lib/store";
import { nativeApp } from "@/lib/native";
import { stopAllAgents } from "@/lib/agent";
import { wavFrom } from "@/lib/dictation";
import { ensureExpressive, ensureVoice, isSpeakingNow, peekVoiceStatus, speechStream, stopSpeaking } from "@/lib/voice-client";

/**
 * Voice conversation: turn it on once, then just talk. No buttons per turn.
 *   listen (always, while on) → you pause (~0.7 s) → Whisper on this Mac writes it down → Marigold works on it,
 *   sentences are spoken AS they are written → it listens again. Talk over it and it stops and listens (barge-in).
 * Everything stays on this Mac (Whisper and Kokoro run locally). Actions use the normal safety checks: anything that
 * needs approval waits on screen (Touch ID for money), it is never approved by voice.
 */
export type ConvPhase = "off" | "starting" | "waiting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";
interface ConvState { phase: ConvPhase; level: number; heard: string; error: string }

let state: ConvState = { phase: "off", level: 0, heard: "", error: "" };
const subs = new Set<() => void>();
const set = (p: Partial<ConvState>) => {
  const next = { ...state, ...p };
  if (next.phase === state.phase && next.level === state.level && next.heard === state.heard && next.error === state.error) return;
  const phaseChanged = next.phase !== state.phase;
  state = next;
  if (phaseChanged) nativeApp()?.convState?.(next.phase);
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const getState = () => state;
export const useConversation = () => useSyncExternalStore(subscribe, getState, getState);
export const conversationOn = () => state.phase !== "off";

const dbg = (m: string) => console.info(`[conv] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME = 1024;               // 64 ms at 16 kHz
const PREROLL_FRAMES = 7;         // keep ~450 ms before speech is noticed so the first word isn't clipped
const END_SILENCE_MS = 700;       // a pause this long ends your turn
const IDLE_END_MS = 150_000;      // nobody said anything for 2.5 minutes: stop listening

let rt: { stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode } | null = null;
let preroll: Float32Array[] = [];
let utter: Float32Array[] = [];
let inSpeech = false, voicedRun = 0, voicedMs = 0, lastVoice = 0, floor = 0, lastLevelAt = 0, lastActivity = 0, utterStart = 0;
let busyListening = false;        // transcribing: don't start another utterance on top
let turn = 0;                     // bumps whenever a reply should stop being followed
let unsubStore: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------- what gets said

const clean = (t: string) => t
  .replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "")
  .replace(/\*\*|__|\*|~~|^#+\s?/gm, "").replace(/\[attached:[^\]]*\]/g, "").replace(/\[\d+\]/g, "").replace(/\s*\(([^)]{1,60})\)/g, ", $1,").replace(/,\s*,/g, ",").replace(/,\s*([.!?])/g, "$1")
  .replace(/[→←↑↓]/g, " ").replace(/\s*\n+\s*/g, " ").replace(/\s+([.,!?])/g, "$1").replace(/\s+/g, " ").trim();
const STRUCTURE = /(^|\n)\s*([-•*]\s+|\d+[.)]\s+|\||```)/;

/** The next speakable part of a reply that is still being written: whole sentences only (everything when it's final). */
function nextPart(content: string, from: number, final: boolean): { text: string; next: number; stop: boolean } {
  const rest = content.slice(from);
  const cut = rest.match(STRUCTURE);
  const head = cut?.index !== undefined ? rest.slice(0, cut.index) : rest;
  let end = head.length;
  if (!final && !cut) {
    let last = -1;
    for (const m of head.matchAll(/[.!?](?=\s)|\n\n/g)) last = (m.index ?? 0) + 1;
    // Nothing said yet: don't wait for a whole sentence, start with the first clause so the voice begins sooner.
    if (last < 0 && from === 0) { for (const m of head.matchAll(/[,;:—–](?=\s)/g)) if ((m.index ?? 0) >= 24) { last = (m.index ?? 0) + 1; break; } }
    end = last;
  }
  if (end <= 0) return { text: "", next: from, stop: !!cut && head.trim().length === 0 };
  return { text: clean(head.slice(0, end)), next: from + end, stop: !!cut };
}

// ---------------------------------------------------------------- following a reply

function follow(chatId: string, userMsgId: string) {
  const mine = ++turn;
  unsubStore?.(); unsubStore = null;
  let spokenTo = 0, spoke = 0, closed = false, filler = false, announced = false, firstTok = false;
  const t0 = Date.now();
  let out: ReturnType<typeof speechStream> | null = null;
  const say = (text: string) => { if (!text) return; out ??= speechStream({ expressive: peekVoiceStatus().expressive, onPlay: () => { dbg("audio playing"); if (mine === turn && state.phase !== "off") set({ phase: "speaking" }); } }); dbg(`say: ${text.slice(0, 60)}`); out.push(text); spoke += text.length; };

  const tick = () => {
    if (mine !== turn || closed) return;
    const chat = useApp.getState().chats.find((c) => c.id === chatId);
    const msgs = chat?.messages ?? [];
    const at = msgs.findIndex((m) => m.id === userMsgId);
    const reply = at >= 0 ? msgs.slice(at + 1).find((m) => m.role !== "user") : undefined;
    if (!reply) return;
    if (reply.content && !firstTok) { firstTok = true; dbg("first words of the reply"); }
    if (reply.steps?.some((s) => s.status === "awaiting") && !announced) { announced = true; say("I need your okay on the screen."); }
    const final = !reply.streaming;
    if (spoke < 520) {
      const p = nextPart(reply.content, spokenTo, final);
      if (p.next > spokenTo) spokenTo = p.next;
      if (p.text) say(p.text);
      if (p.stop && spoke > 0) { spokenTo = reply.content.length; say("The rest is on your screen."); spoke = 999; }
    } else if (!final) spokenTo = reply.content.length;
    // Only when it is actually DOING something (a tool is running) and nothing has been said yet: a short "on it", never for a plain answer.
    if (!filler && !reply.content && reply.streaming && reply.steps?.some((s) => s.status === "running") && Date.now() - t0 > 1200) { filler = true; say("On it."); }
    if (final) {
      closed = true;
      unsubStore?.(); unsubStore = null;
      if (spoke === 0) say(reply.steps?.length ? "Done. The details are on your screen." : reply.content.trim() ? "I've put that on your screen." : "Sorry, I couldn't do that.");
      out?.end();
      void (out?.done ?? Promise.resolve()).then(() => { if (mine === turn && state.phase !== "off") { lastActivity = Date.now(); set({ phase: restPhase() }); } });
    }
  };
  unsubStore = useApp.subscribe(tick);
  tick();
  // The filler timer and the final check also run on a clock (the store may be quiet while tools work).
  const clock = setInterval(() => { if (mine !== turn || closed) { clearInterval(clock); return; } tick(); }, 400);
}

// ---------------------------------------------------------------- sending what was said

async function sendFromBrowser(text: string): Promise<{ chatId: string; userMsgId: string } | null> {
  const st = useApp.getState();
  const b = nativeApp()?.browser;
  const bs = await b?.state().catch(() => null);
  const tab = bs?.tabs.find((t) => t.id === bs.activeId);
  if (!b || !tab) return null;
  const onPage = !tab.newTab && /^https?:/.test(tab.url);
  const pt = onPage ? await Promise.race([b.pageText(tab.id).catch(() => null), sleep(2500).then(() => null)]) : null;
  void st.sendBrowserMessage(text, onPage ? { title: tab.title, url: tab.url, text: pt?.text } : null, tab.id);
  const chatId = useApp.getState().browserChats[tab.id];
  return chatId ? { chatId, userMsgId: lastUserId(chatId) } : null;
}
const lastUserId = (chatId: string) => useApp.getState().chats.find((c) => c.id === chatId)?.messages.filter((m) => m.role === "user").at(-1)?.id ?? "";

async function submit(text: string) {
  // One request at a time: if the last one is still running, this one waits its turn.
  for (let i = 0; i < 80 && useApp.getState().sending; i++) await sleep(250);
  if (state.phase === "off") return;
  set({ phase: "thinking" });
  const st = useApp.getState();
  let target: { chatId: string; userMsgId: string } | null = null;
  if (st.activeTab === "browser") target = await sendFromBrowser(text);
  if (!target) {
    void st.sendUserMessage(text);
    const chatId = useApp.getState().activeChatId;
    if (chatId) target = { chatId, userMsgId: lastUserId(chatId) };
  }
  if (target?.userMsgId) follow(target.chatId, target.userMsgId); else set({ phase: restPhase() });
}

// Whisper makes up words from silence or noise; these never mean the user said something.
const PHANTOM = /^(\.+|you|thank you\.?|thanks\.?|thanks for watching\.?|bye\.?|okay\.?|oh\.?|um+\.?|uh+\.?|hmm+\.?|\[.*\]|\(.*\))$/i;
const STOP_WORDS = /^(stop|stop listening|that'?s all|that is all|goodbye|bye bye|end (the )?conversation|we'?re done)[.!]?$/i;
const SHUSH = /^(never ?mind|cancel|be quiet|quiet|shush|stop talking|enough)[.!]?$/i;

// ---------------------------------------------------------------- the wake word
// Listening starts in "waiting": everything heard is checked on this Mac for "Hey Marigold" and then thrown away. Only after
// the wake phrase does a conversation begin; it ends back in "waiting" (idle for 2.5 minutes, or "goodbye"). The Talk button turns it all off.
let awake = false;
const restPhase = (): ConvPhase => (awake ? "listening" : "waiting");
const WAKE = /\b(?:hey|hay|hi|ok|okay)[\s,.!-]*(?:marigold|merry\s?gold|mary\s?gold|marry\s?gold|merri\s?gold|marygold)s?\b[\s,.!?:;-]*/i;
function wakeMatch(text: string): { rest: string } | null {
  const t = text.replace(/[“”"]/g, "");
  const m = WAKE.exec(t);
  if (!m || m.index > 15) return null; // "hey marigold" opens the sentence; the same words in the middle of someone else's chatter don't count
  return { rest: t.slice(m.index + m[0].length).trim() };
}
/** A soft two-note sound so you know it heard you (up) or went back to sleep (down). */
function chime(kind: "up" | "down") {
  try {
    const c = rt?.ctx; if (!c) return;
    const t = c.currentTime;
    (kind === "up" ? [660, 880] : [660, 440]).forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), at = t + i * 0.11;
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + 0.18);
    });
    muteUntil = Date.now() + 500; // the mic ignores the chime itself
  } catch { /* no audio */ }
}
function wake() {
  awake = true; lastActivity = Date.now();
  useApp.getState().setVoiceTalk(true);
  chime("up");
  set({ phase: "listening", heard: "", error: "" });
}
function goToSleep() {
  turn++; stopSpeaking();
  awake = false;
  useApp.getState().setVoiceTalk(false);
  chime("down");
  set({ phase: "waiting", heard: "", level: 0 });
}

async function handleUtterance(chunks: Float32Array[]) {
  busyListening = true;
  dbg("utterance ended, transcribing");
  if (awake) set({ phase: "transcribing" });
  let text = "";
  try {
    const res = await fetch("/api/agent/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wavFrom(chunks, rt?.ctx.sampleRate ?? 16000) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 409) { void ensureVoice(); set({ error: "Voice is still being set up." }); }
    else if (res.ok && j.text) text = String(j.text).trim();
  } catch { set({ error: "Couldn't reach the voice helper." }); }
  busyListening = false;
  if (state.phase === "off") return;
  if (!awake) { // waiting for "Hey Marigold": anything else is dropped unheard
    const m = text && !PHANTOM.test(text) ? wakeMatch(text) : null;
    if (!m) { set({ phase: "waiting" }); return; }
    dbg("wake word heard");
    wake();
    if (m.rest.split(/\s+/).filter(Boolean).length >= 2 && !PHANTOM.test(m.rest)) { set({ heard: m.rest }); await submit(m.rest); } // "Hey Marigold, what's the weather" in one go
    return;
  }
  if (!text || PHANTOM.test(text) || text.split(/\s+/).length < 1) { set({ phase: restPhase() }); return; }
  lastActivity = Date.now();
  dbg(`heard: ${text}`);
  set({ heard: text, error: "" });
  if (STOP_WORDS.test(text)) { if (/^stop listening[.!]?$/i.test(text)) stopConversation(); else goToSleep(); return; } // "stop listening" turns it off; "goodbye" goes back to waiting
  if (SHUSH.test(text)) { turn++; stopSpeaking(); set({ phase: "listening" }); return; }
  if (text.split(/\s+/).length >= 4 && Math.random() < 0.6) backchannel();
  await submit(text);
}

// ---------------------------------------------------------------- listening

function onFrame(d: Float32Array) {
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
  const rms = Math.sqrt(sum / d.length);
  const now = Date.now();
  if (now - lastLevelAt > 60) { lastLevelAt = now; set({ level: Math.min(1, rms * 9) }); }
  const speaking = isSpeakingNow();
  if (!inSpeech) floor = floor === 0 ? rms : floor * 0.97 + Math.min(rms, Math.max(floor * 3, 0.004)) * 0.03; // the room's own noise level
  const thr = Math.max(0.014, floor * 3);
  const barge = Math.max(0.035, floor * 6); // while Marigold talks the bar is higher (its own voice can leak back in)
  const copy = new Float32Array(d);

  if (!inSpeech) {
    preroll.push(copy);
    if (preroll.length > PREROLL_FRAMES) preroll.shift();
    if (busyListening || state.phase === "starting" || now < muteUntil) return;
    voicedRun = rms > (speaking ? barge : thr) ? voicedRun + 1 : 0;
    if (voicedRun >= (speaking ? 5 : 3)) {
      // Talking over a spoken reply: it stops. (While tools are still working, the new request just waits its turn.)
      if (speaking) { turn++; stopSpeaking(); if (useApp.getState().sending) void stopAllAgents(); }
      inSpeech = true; voicedMs = 0; utter = [...preroll]; preroll = []; lastVoice = now; utterStart = now; lastActivity = now;
      if (awake) set({ phase: "hearing" });
    }
    return;
  }
  utter.push(copy);
  if (rms > thr) { lastVoice = now; voicedMs += (FRAME / 16000) * 1000; }
  if (now - lastVoice > END_SILENCE_MS || now - utterStart > 30_000) {
    inSpeech = false; voicedRun = 0;
    const chunks = utter; utter = [];
    if (voicedMs < 350) { set({ phase: awake ? (useApp.getState().sending ? "thinking" : "listening") : "waiting" }); return; } // a cough or a click
    if (!awake && (chunks.length * FRAME) / 16000 > 6.5) { set({ phase: "waiting" }); return; } // too long to be a wake phrase: not even transcribed
    void handleUtterance(chunks);
  }
}

// Short human acknowledgements ("Mm-hm.", "Okay.") voiced ahead of time, so one can play the instant you finish talking
// while the real answer is still being worked out. That is what a person does, and it hides some of the wait.
let backchannels: Blob[] = [];
let muteUntil = 0; // the mic ignores itself while one plays
async function loadBackchannels() {
  if (backchannels.length) return;
  const exp = peekVoiceStatus().expressive;
  const clips = await Promise.all(["Mm-hm.", "Okay.", "Right.", "Hmm."].map((t) => fetch("/api/agent/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, expressive: exp, speed: 1.05 }) }).then((r) => (r.ok ? r.blob() : null)).catch(() => null)));
  backchannels = clips.filter((b): b is Blob => !!b);
}
function backchannel() {
  if (!backchannels.length || isSpeakingNow()) return;
  const url = URL.createObjectURL(backchannels[Math.floor(Math.random() * backchannels.length)]);
  const a = new Audio(url);
  muteUntil = Date.now() + 1800;
  a.onended = () => { muteUntil = Date.now() + 350; URL.revokeObjectURL(url); };
  a.play().catch(() => {});
}

/** Load the listening and speaking models now (while you are still getting started), so the first answer isn't slow. */
async function warmUp() {
  const quiet = wavFrom([new Float32Array(3200)], 16000);
  void fetch("/api/agent/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: quiet }).catch(() => {});
  void loadBackchannels(); // also loads the speaking voice
}

export async function startConversation() {
  if (state.phase !== "off") return;
  set({ phase: "starting", error: "", heard: "", level: 0 });
  const v = peekVoiceStatus().installed ? peekVoiceStatus() : await ensureVoice();
  if (!v.installed) { set({ phase: "off", error: v.error || "Setting up voice (one time). Try again when it's done." }); return; }
  const mic = await nativeApp()?.micAccess?.().catch(() => "unknown");
  if (mic === "denied" || mic === "restricted") { set({ phase: "off", error: "The microphone is blocked. Turn it on for Marigold in System Settings → Privacy & Security → Microphone." }); void nativeApp()?.openMicSettings?.(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(FRAME, 1, 1);
    node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0));
    src.connect(node);
    node.connect(ctx.destination); // (outputs silence; keeps the processor running)
    rt = { stream, ctx, node };
    preroll = []; utter = []; inSpeech = false; voicedRun = 0; floor = 0; busyListening = false; lastActivity = Date.now();
    stopSpeaking();
    awake = false;
    void ensureExpressive(); // the laughing voice installs itself once, in the background; the plain voice covers until then
    void warmUp();
    set({ phase: "waiting" });
    timer = setInterval(() => {
      if (awake && state.phase === "listening" && Date.now() - lastActivity > IDLE_END_MS) goToSleep(); // quiet for a while: back to waiting for "Hey Marigold"
    }, 5000);
  } catch (e) {
    const name = (e as { name?: string })?.name;
    set({ phase: "off", error: name === "NotAllowedError" || name === "SecurityError" ? "The microphone is blocked. Turn it on for Marigold in System Settings → Privacy & Security → Microphone." : name === "NotFoundError" ? "No microphone found." : "Couldn't start the microphone." });
  }
}

export function stopConversation() {
  turn++;
  unsubStore?.(); unsubStore = null;
  if (timer) { clearInterval(timer); timer = null; }
  try { rt?.node.disconnect(); } catch { /* already gone */ }
  rt?.stream.getTracks().forEach((t) => t.stop());
  void rt?.ctx.close().catch(() => {});
  rt = null; inSpeech = false; utter = []; preroll = []; awake = false;
  stopSpeaking();
  useApp.getState().setVoiceTalk(false);
  set({ phase: "off", level: 0 });
}

export const toggleConversation = () => { if (state.phase === "off") void startConversation(); else stopConversation(); };
