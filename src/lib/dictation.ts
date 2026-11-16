"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nativeApp } from "@/lib/native";
import { ensureVoice, peekVoiceStatus, stopSpeaking } from "@/lib/voice-client";

/**
 * Press-to-dictate: records the microphone (16 kHz mono), stops on a second press / after a pause in
 * speech, sends the audio to Whisper running on this Mac, and hands back the text.
 *   Shortcut: ⌘⇧D — start, press again to finish. Esc cancels. (Only while Marigold is the active app.)
 */
export type DictationPhase = "idle" | "starting" | "listening" | "transcribing";

export function wavFrom(chunks: Float32Array[], rate: number): Blob {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++) { const s = Math.max(-1, Math.min(1, c[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: "audio/wav" });
}

export function useDictation(onText: (text: string) => void, opts: { shortcut?: boolean } = {}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const r = useRef<{ stream?: MediaStream; ctx?: AudioContext; node?: ScriptProcessorNode; chunks: Float32Array[]; heard: boolean; quietSince: number; startedAt: number; lastLevelAt: number; floor: number } | null>(null);
  const phaseRef = useRef<DictationPhase>("idle");
  const cb = useRef(onText);
  useEffect(() => { cb.current = onText; }, [onText]);
  const go = (p: DictationPhase) => { phaseRef.current = p; setPhase(p); };

  const teardown = () => {
    const s = r.current;
    if (!s) return;
    try { s.node?.disconnect(); } catch { /* already gone */ }
    s.stream?.getTracks().forEach((t) => t.stop());
    void s.ctx?.close().catch(() => {});
  };

  const finish = useCallback(async (send: boolean) => {
    if (phaseRef.current !== "listening") return;
    const s = r.current;
    teardown();
    setLevel(0);
    if (!send || !s || !s.heard) { go("idle"); if (send && s && !s.heard) setError("Didn't hear anything. Try again."); return; }
    go("transcribing");
    try {
      const rate = s.ctx?.sampleRate ?? 16000;
      const res = await fetch("/api/agent/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wavFrom(s.chunks, rate) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409) { void ensureVoice(); setError("Voice is still being set up. Try again in a minute."); }
      else if (!res.ok) setError(j.error ?? "Couldn't transcribe that.");
      else if (j.text) cb.current(String(j.text));
      else setError("Didn't catch any words. Try again.");
    } catch { setError("Couldn't reach the voice helper."); }
    go("idle");
  }, []);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError("");
    stopSpeaking(); // the mic must not hear Marigold's own voice
    go("starting");
    const v = peekVoiceStatus().installed ? peekVoiceStatus() : await ensureVoice();
    if (!v.installed) { go("idle"); setError(v.error || "Setting up voice (one time). Try again when it's done."); return; }
    const mic = await nativeApp()?.micAccess?.().catch(() => "unknown");
    if (mic === "denied" || mic === "restricted") { go("idle"); setError("The microphone is blocked. Turn it on for Marigold in System Settings → Privacy & Security → Microphone."); void nativeApp()?.openMicSettings?.(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const s = { stream, ctx, node, chunks: [] as Float32Array[], heard: false, quietSince: 0, startedAt: Date.now(), lastLevelAt: 0, floor: 0 };
      r.current = s;
      node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        s.chunks.push(new Float32Array(d));
        let sum = 0;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / d.length);
        const now = Date.now();
        if (now - s.startedAt < 500) s.floor = Math.max(s.floor, rms); // the room's own noise
        const thr = Math.max(0.012, s.floor * 2.5);
        if (rms > thr) { s.heard = true; s.quietSince = 0; } else if (s.heard && !s.quietSince) s.quietSince = now;
        if (now - s.lastLevelAt > 60) { s.lastLevelAt = now; setLevel(Math.min(1, rms * 9)); }
        if (phaseRef.current !== "listening") return;
        if ((s.heard && s.quietSince && now - s.quietSince > 2400) || now - s.startedAt > 120_000 || (!s.heard && now - s.startedAt > 9000)) void finish(true);
      };
      src.connect(node);
      node.connect(ctx.destination);
      go("listening");
    } catch (e) {
      go("idle");
      const name = (e as { name?: string })?.name;
      setError(name === "NotAllowedError" || name === "SecurityError" ? "The microphone is blocked. Turn it on for Marigold in System Settings → Privacy & Security → Microphone." : name === "NotFoundError" ? "No microphone found." : "Couldn't start the microphone.");
    }
  }, [finish]);

  const toggle = useCallback(() => { if (phaseRef.current === "listening") void finish(true); else if (phaseRef.current === "idle") void start(); }, [finish, start]);
  const cancel = useCallback(() => { void finish(false); }, [finish]);

  useEffect(() => {
    if (!opts.shortcut) return;
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "d") { e.preventDefault(); toggle(); }
      else if (e.key === "Escape" && phaseRef.current === "listening") { e.preventDefault(); cancel(); }
    };
    window.addEventListener("keydown", key);
    const off = nativeApp()?.onDictate?.(() => toggle());
    return () => { window.removeEventListener("keydown", key); off?.(); };
  }, [opts.shortcut, toggle, cancel]);

  useEffect(() => () => { teardown(); }, []);
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(""), 7000); return () => clearTimeout(t); }, [error]);

  return { phase, level, error, toggle, cancel };
}
