"use client";

import { useEffect } from "react";
import { AudioLines, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { nativeApp } from "@/lib/native";
import { stopConversation, toggleConversation, useConversation, type ConvPhase } from "@/lib/conversation";
import { Tip } from "@/components/ui/tip";

const LABEL: Record<ConvPhase, string> = { off: "", starting: "Starting…", waiting: "Say “Hey Marigold”", listening: "Listening", hearing: "Hearing you…", transcribing: "Got it…", thinking: "Thinking…", speaking: "Speaking" };

/** ⌘⇧V toggles the voice conversation from anywhere (also while a web page has focus). Mount once. */
export function ConversationHost() {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "v") { e.preventDefault(); toggleConversation(); }
    };
    window.addEventListener("keydown", key);
    const off = nativeApp()?.onConverse?.(toggleConversation);
    window.addEventListener("beforeunload", stopConversation);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("beforeunload", stopConversation); off?.(); };
  }, []);
  return null;
}

/** Start / end the conversation; while it's on, shows what Marigold is doing (listening, thinking, speaking) and what it heard. */
export function ConversationControl({ compact = false }: { compact?: boolean }) {
  const c = useConversation();
  if (c.phase === "off") {
    return (
      <Tip label={c.error || "Listen for “Hey Marigold”"} keys={c.error ? undefined : ["⌘", "⇧", "V"]} align="right">
        <button onClick={toggleConversation} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Listen for Hey Marigold">
          <AudioLines size={14} />
          {!compact && <span className="hidden sm:inline">Talk</span>}
        </button>
      </Tip>
    );
  }
  const live = c.phase === "hearing" || c.phase === "speaking";
  return (
    <div className="flex h-8 max-w-[300px] items-center gap-2 rounded-full border border-accent/50 bg-accent/10 pl-2.5 pr-1">
      <span className="flex h-4 shrink-0 items-end gap-[2px]" aria-hidden>
        {c.phase === "starting" || c.phase === "transcribing" ? <Loader2 size={13} className="animate-spin text-accent" /> : [0.55, 1, 0.7, 0.9, 0.6].map((m, i) => (
          <span key={i} className={cn("w-[3px] rounded-full bg-accent transition-[height] duration-100", c.phase === "speaking" && "animate-pulse", c.phase === "waiting" && "opacity-40")} style={{ height: `${Math.max(3, Math.round(3 + (c.phase === "hearing" ? c.level : c.phase === "speaking" ? 0.6 : 0.12) * 13 * m))}px`, animationDelay: `${i * 90}ms` }} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] leading-tight">
        <span className={cn("font-medium", live && "text-foreground")}>{LABEL[c.phase]}</span>
        {!compact && c.heard && c.phase !== "listening" && <span className="text-muted"> · “{c.heard}”</span>}
      </span>
      <Tip label={c.phase === "waiting" ? "Stop listening" : "End conversation"} keys={["⌘", "⇧", "V"]} align="right">
        <button onClick={stopConversation} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground" aria-label="End conversation"><X size={13} /></button>
      </Tip>
    </div>
  );
}
