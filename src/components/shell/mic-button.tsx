"use client";

import { Loader2, Mic } from "lucide-react";
import { useDictation } from "@/lib/dictation";
import { useVoiceStatus } from "@/lib/voice-client";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";

/** A compact dictation button for the smaller composers (browser, live view). ⌘⇧D works when `shortcut` is set. */
export function MicButton({ onText, size = 28, shortcut }: { onText: (t: string) => void; size?: number; shortcut?: boolean }) {
  const d = useDictation(onText, { shortcut });
  const v = useVoiceStatus();
  const listening = d.phase === "listening";
  const busy = d.phase === "starting" || d.phase === "transcribing";
  const hint = d.error || (v.installing ? `Setting up voice: ${v.step || "starting"}…` : listening ? "Listening… pause or click to finish" : "Dictate");
  const showKeys = !d.error && !v.installing && !listening;
  return (
    <Tip label={hint} keys={showKeys ? ["⌘", "⇧", "D"] : undefined} align="right">
    <button
      type="button"
      onClick={d.toggle}
      disabled={busy}
      aria-label={listening ? "Finish dictating" : "Dictate"}
      aria-pressed={listening}
      style={{ width: size, height: size }}
      className={cn("relative flex shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60", listening ? "bg-danger text-white" : d.error ? "text-danger" : "text-muted hover:bg-surface-hover hover:text-foreground")}
    >
      {listening && <span className="absolute inset-0 animate-ping rounded-full bg-danger/40" />}
      {busy ? <Loader2 size={size * 0.5} className="animate-spin" /> : <Mic size={size * 0.55} className="relative" />}
    </button>
    </Tip>
  );
}
