"use client";

import { useApp } from "@/lib/store";
import { Maximize, Minimize } from "lucide-react";

const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground";

/**
 * Navbar button next to the theme toggle: Full screen. The current page fills the Marigold window
 * (not macOS full screen, which would put Marigold on its own desktop where apps can't be controlled).
 * Esc leaves it (handled in the app shell); there is no floating "exit" button over the page.
 */
export function ScreenControls() {
  const full = useApp((s) => s.fullWindow);
  const setFull = useApp((s) => s.setFullWindow);
  return (
    <button onClick={() => setFull(!full)} className={btn} title={full ? "Exit full screen (Esc)" : "Full screen"}>
      {full ? <Minimize size={14} /> : <Maximize size={14} />} {full ? "Exit full screen" : "Full screen"}
    </button>
  );
}
