"use client";

import { useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp, useChatRun } from "@/lib/store";
import { setTaskPaused, stopOneTask } from "@/lib/agent";

/**
 * Pause / Resume / Stop for the agent working in a chat. Pausing holds it between steps
 * (it finishes the step it's on, then waits) — Resume carries on from exactly there.
 */
export function RunControls({ chatId, size = "md", stop = true }: { chatId: string | null | undefined; size?: "sm" | "md"; stop?: boolean }) {
  const run = useChatRun(chatId);
  const sync = useApp((s) => s.syncAgentTasks);
  const [busy, setBusy] = useState(false);
  if (!run) return null;
  const paused = !!run.paused;
  const box = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const icon = size === "sm" ? 11 : 14;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); await sync(); setBusy(false); };
  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); void act(() => setTaskPaused(run.id, !paused)); }}
        disabled={busy}
        title={paused ? "Resume" : "Pause (finishes the current step, then waits)"}
        aria-label={paused ? "Resume" : "Pause"}
        className={cn("flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50", box,
          paused ? "bg-accent text-accent-foreground hover:opacity-90" : "text-muted hover:bg-surface-hover hover:text-foreground")}
      >
        {paused ? <Play size={icon} /> : <Pause size={icon} />}
      </button>
      {stop && (
        <button
          onClick={(e) => { e.stopPropagation(); void act(() => stopOneTask(run.id)); }}
          disabled={busy}
          title="Stop"
          aria-label="Stop"
          className={cn("flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-danger disabled:opacity-50", box)}
        >
          <Square size={icon - 2} />
        </button>
      )}
    </>
  );
}
