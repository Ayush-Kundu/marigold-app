"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { MODEL_LIST, type ModelChoice } from "@/lib/models";
import { ArrowUp, Plus, Mic, ChevronDown, Sparkles, X, Paperclip, FileText, Image as ImageIcon, Monitor, Camera, Volume2, Square, Loader2, AlertCircle } from "lucide-react";
import { Tip } from "@/components/ui/tip";
import { CameraDialog } from "@/components/shell/camera-dialog";
import { CodeModeButton } from "@/components/shell/code-mode";
import { cn } from "@/lib/utils";
import { RunControls } from "@/components/shell/run-controls";
import { ApprovalDock } from "@/components/views/agent-steps";
import { AppChip } from "@/components/shell/app-dock";
import { appLink, attLink } from "@/lib/app-icons";
import { useDictation } from "@/lib/dictation";
import { ensureVoice, stopSpeaking, useSpeaking, useVoiceStatus } from "@/lib/voice-client";

interface Att { key: string; name: string; kind: string; size: number; status: "uploading" | "ready" | "error"; id?: string; preview?: string; error?: string }

const kindFromFile = (f: File) => (/^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(f.name) ? "image" : /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) ? "pdf" : "file");

export function PromptBar() {
  const [text, setText] = useState("");
  const sending = useApp((s) => s.sending);
  const send = useApp((s) => s.sendUserMessage);
  const setComposerActive = useApp((s) => s.setComposerActive);
  const activeChatId = useApp((s) => s.activeChatId);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const chosen = useApp((s) => s.chosenApps);
  const toggleApp = useApp((s) => s.toggleChosenApp);
  const clearApps = useApp((s) => s.clearChosenApps);
  const speakReplies = useApp((s) => s.speakReplies);
  const setSpeakReplies = useApp((s) => s.setSpeakReplies);
  const speaking = useSpeaking();
  const voice = useVoiceStatus();

  // ---- attachments (the + button, drag-and-drop, paste, screenshots)
  const [atts, setAtts] = useState<Att[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState("");
  const uploading = atts.some((a) => a.status === "uploading");
  const ready = atts.filter((a) => a.status === "ready");

  const patch = (key: string, p: Partial<Att>) => setAtts((l) => l.map((a) => (a.key === key ? { ...a, ...p } : a)));
  const addFiles = useCallback((files: File[]) => {
    for (const f of files.slice(0, 10)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const kind = kindFromFile(f);
      const preview = kind === "image" && !/heic|heif|tiff?/i.test(f.name) ? URL.createObjectURL(f) : undefined;
      setAtts((l) => [...l, { key, name: f.name || "pasted file", kind, size: f.size, status: "uploading", preview }]);
      void fetch("/api/agent/upload", { method: "POST", headers: { "x-filename": encodeURIComponent(f.name || "pasted-image.png"), "Content-Type": f.type || "application/octet-stream" }, body: f })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Upload failed"); patch(key, { status: "ready", id: j.id, kind: j.kind, name: j.name }); })
        .catch((e) => patch(key, { status: "error", error: String(e?.message ?? e) }));
    }
    taRef.current?.focus();
  }, []);
  const addScreenshot = async () => {
    setPlusOpen(false);
    const key = `shot-${Date.now()}`;
    setAtts((l) => [...l, { key, name: "Screenshot", kind: "image", size: 0, status: "uploading" }]);
    const r = await fetch("/api/agent/upload?screenshot=1", { method: "POST" }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (r?.ok && j) patch(key, { status: "ready", id: j.id, name: j.name, kind: "image", preview: `/api/agent/upload/${j.id}` });
    else patch(key, { status: "error", error: j?.error ?? "Couldn't take a screenshot (Screen Recording permission?)" });
  };
  const removeAtt = (key: string) => setAtts((l) => { const a = l.find((x) => x.key === key); if (a?.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview); return l.filter((x) => x.key !== key); });

  // Drop files anywhere on the window.
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => !!e.dataTransfer?.types?.includes("Files");
    const enter = (e: DragEvent) => { if (has(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (has(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (has(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth = 0; setDragging(false); addFiles([...(e.dataTransfer?.files ?? [])]); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragleave", leave); window.addEventListener("dragover", over); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave); window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, [addFiles]);

  // ---- dictation (⌘⇧D)
  const dictation = useDictation((t) => setText((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${t}` : `${prev}${t}`)), { shortcut: true });
  const listening = dictation.phase === "listening";

  useEffect(() => {
    const f = () => taRef.current?.focus();
    window.addEventListener("mg-focus-composer", f);
    return () => window.removeEventListener("mg-focus-composer", f);
  }, []);
  const sideView = useApp((s) => s.sideView);
  const codeRoot = useApp((s) => s.codeRoot);
  // Fit the box to its text — again whenever its width changes (a narrow box wraps more).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const fit = () => { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, sideView]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 6000); return () => clearTimeout(t); }, [note]);

  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading && !sending;
  const submit = () => {
    if (!canSend) return;
    if (listening) dictation.cancel();
    const links = [...chosen.map(appLink), ...ready.map((a) => attLink(a.name, a.id!))].join(" ");
    const body = text.trim() || "Take a look at what I attached and tell me what it is.";
    send(links ? `${links} ${body}` : body);
    clearApps();
    for (const a of atts) if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview);
    setAtts([]);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const voiceNote = dictation.error || note || (voice.installing ? `Setting up voice (one time): ${voice.step || "starting"}…` : voice.error ? voice.error : "");

  return (
    <div className="shrink-0 px-4 pb-3 pt-1.5">
      <ApprovalDock />
      <div className={cn("relative mx-auto max-w-3xl rounded-xl border bg-surface shadow-sm focus-within:border-accent", dragging ? "border-accent ring-2 ring-accent/30" : "border-border")}>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-background/85 text-[13px] font-medium text-accent">
            <Paperclip size={15} /> Drop to attach
          </div>
        )}
        {(chosen.length > 0 || atts.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
            {chosen.length > 0 && <span className="text-[11px] text-muted">Use</span>}
            {chosen.map((n) => (
              <span key={n} className="flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 py-0.5 pl-1 pr-1.5 text-[12px]">
                <AppChip name={n} bare />
                <button onClick={() => toggleApp(n)} className="text-muted hover:text-foreground" aria-label={`Remove ${n}`}><X size={11} /></button>
              </span>
            ))}
            {atts.map((a) => (
              <span key={a.key} className={cn("group relative flex items-center gap-1.5 rounded-lg border bg-background py-1 pl-1 pr-1.5 text-[12px]", a.status === "error" ? "border-danger/50" : "border-border")} title={a.error ?? a.name}>
                {a.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.preview} alt="" className="h-8 w-8 rounded-md object-cover" />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-hover text-muted">{a.kind === "image" ? <ImageIcon size={15} /> : <FileText size={15} />}</span>
                )}
                <span className="max-w-[140px] truncate">{a.name}</span>
                {a.status === "uploading" && <Loader2 size={12} className="animate-spin text-muted" />}
                {a.status === "error" && <AlertCircle size={12} className="text-danger" />}
                <button onClick={() => removeAtt(a.key)} className="text-muted hover:text-foreground" aria-label={`Remove ${a.name}`}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        {listening && (
          <div className="mx-2.5 mt-2 flex items-center gap-2.5 rounded-lg bg-accent/10 px-3 py-1.5 text-[12px]">
            <span className="flex h-4 items-end gap-[2px]" aria-hidden>
              {[0.5, 0.9, 0.65, 1, 0.7].map((m, i) => <span key={i} className="w-[3px] rounded-full bg-accent transition-[height] duration-75" style={{ height: `${Math.max(3, Math.round(3 + dictation.level * 13 * m))}px` }} />)}
            </span>
            <span className="font-medium text-accent">Listening</span>
            <span className="text-muted">Pause to finish, or press ⌘⇧D. Esc cancels.</span>
          </div>
        )}
        {dictation.phase === "transcribing" && (
          <div className="mx-2.5 mt-2 flex items-center gap-2 rounded-lg bg-surface-hover px-3 py-1.5 text-[12px] text-muted"><Loader2 size={12} className="animate-spin" /> Writing out what you said…</div>
        )}
        <div className={cn("flex items-end gap-1.5 p-1.5", sideView && "flex-wrap")}>
          <div className="relative">
            <button onClick={() => setPlusOpen((v) => !v)} title="Attach files, photos or a screenshot" aria-label="Attach" className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-foreground", plusOpen && "bg-surface-hover text-foreground")}>
              <Plus size={16} className={cn("transition-transform", plusOpen && "rotate-45")} />
            </button>
            {plusOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPlusOpen(false)} />
                <div className="absolute bottom-full left-0 z-20 mb-1.5 w-60 rounded-xl border border-border bg-background p-1 shadow-lg">
                  <button onClick={() => { setPlusOpen(false); fileRef.current?.click(); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-hover">
                    <Paperclip size={15} className="text-muted" /> <span>Upload files or photos<span className="block text-[11px] text-muted">Pictures, PDFs, documents, text</span></span>
                  </button>
                  <button onClick={() => { setPlusOpen(false); setCameraOpen(true); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-hover">
                    <Camera size={15} className="text-muted" /> <span>Take a photo<span className="block text-[11px] text-muted">Show me what you are looking at</span></span>
                  </button>
                  <button onClick={() => void addScreenshot()} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-hover">
                    <Monitor size={15} className="text-muted" /> <span>Screenshot of my screen<span className="block text-[11px] text-muted">So I can see what you see</span></span>
                  </button>
                </div>
              </>
            )}
            {cameraOpen && <CameraDialog onClose={() => setCameraOpen(false)} onPhoto={(f) => addFiles([f])} />}
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
          </div>
          <CodeModeButton />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setComposerActive(true)}
            onBlur={() => setComposerActive(false)}
            rows={1}
            placeholder={listening ? "Speak now…" : atts.length ? "Add a message, or just send…" : codeRoot ? `Ask Marigold to work on ${codeRoot.split("/").filter(Boolean).pop()}…` : sideView ? "Ask Marigold…" : "Ask your agent to do something…"}
            className={cn("max-h-[200px] min-w-[7rem] flex-1 resize-none bg-transparent py-1.5 text-[13px] outline-none placeholder:text-muted", codeRoot && "pl-2", sideView && "order-first basis-full")}
          />
          <RunControls chatId={activeChatId} />
          <button
            onClick={() => (speaking ? stopSpeaking() : (void (!speakReplies && ensureVoice()), setSpeakReplies(!speakReplies)))}
            title={speaking ? "Stop speaking" : speakReplies ? "Marigold reads its answers aloud (click to turn off)" : "Have Marigold read its answers aloud"}
            aria-label={speakReplies ? "Turn off spoken replies" : "Turn on spoken replies"}
            aria-pressed={speakReplies}
            className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors", speakReplies ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-hover hover:text-foreground")}
          >
            {speaking ? <Square size={13} fill="currentColor" /> : <Volume2 size={16} />}
          </button>
          <Tip label={listening ? "Finish dictating" : "Dictate"} keys={listening ? undefined : ["⌘", "⇧", "D"]} align="right">
          <button
            onClick={dictation.toggle}
            disabled={dictation.phase === "starting" || dictation.phase === "transcribing"}
            aria-label={listening ? "Finish dictating" : "Dictate"}
            aria-pressed={listening}
            className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50", listening ? "bg-danger text-white" : "text-muted hover:bg-surface-hover hover:text-foreground")}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-lg bg-danger/40" />}
            {dictation.phase === "starting" ? <Loader2 size={15} className="animate-spin" /> : <Mic size={16} className="relative" />}
          </button>
          </Tip>
          <button
            onClick={submit}
            disabled={!canSend}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
              canSend ? "bg-accent text-accent-foreground hover:opacity-90" : "bg-surface-2 text-muted",
            )}
          >
            <ArrowUp size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5">
          <ModelPicker />
          <span className={cn("ml-auto truncate text-[11px]", voiceNote ? "text-accent" : "text-muted")}>
            {voiceNote || "Checks with you before sending or spending."}
          </span>
        </div>
      </div>
    </div>
  );
}

function ModelPicker() {
  const [open, setOpen] = useState(false);
  const choice = useApp((s) => s.modelOverride);
  const setChoice = useApp((s) => s.setModelOverride);

  const label =
    choice === "auto" ? "Auto" : MODEL_LIST.find((m) => m.id === choice)?.short ?? "Auto";
  const dot =
    choice === "auto"
      ? "var(--muted)"
      : MODEL_LIST.find((m) => m.id === choice)?.accent ?? "var(--muted)";

  const options: { id: ModelChoice; label: string; desc: string; dot: string }[] = [
    { id: "auto", label: "Auto", desc: "Pick the best model for each prompt", dot: "var(--muted)" },
    ...MODEL_LIST.map((m) => ({ id: m.id, label: m.label, desc: m.description, dot: m.accent })),
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-hover hover:text-foreground"
      >
        <Sparkles size={12} />
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
          {label}
        </span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1.5 w-64 rounded-xl border border-border bg-background p-1 shadow-lg">
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  setChoice(o.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover",
                  choice === o.id && "bg-surface-hover",
                )}
              >
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: o.dot }}
                />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{o.label}</div>
                  <div className="text-[11px] text-muted">{o.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
