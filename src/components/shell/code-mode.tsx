"use client";

import { useState } from "react";
import { Code2, FolderOpen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { nativeApp } from "@/lib/native";
import { Tip } from "@/components/ui/tip";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/**
 * Coding mode switch for the message bar: pick a project folder and Marigold works in it like a coding agent
 * (reads and searches the code, makes exact edits, runs your tests and builds, uses git, opens files in your editor).
 */
export function CodeModeButton() {
  const root = useApp((s) => s.codeRoot);
  const recent = useApp((s) => s.codeRecent);
  const setRoot = useApp((s) => s.setCodeRoot);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const pick = async () => {
    const p = await nativeApp()?.pickFolder?.().catch(() => null);
    if (p) { setRoot(p); setOpen(false); }
  };
  const native = !!nativeApp()?.pickFolder;
  return (
    <div className="relative">
      {root ? (
        <div className="flex h-8 max-w-[170px] items-center gap-1 rounded-lg border border-accent/50 bg-accent/10 pl-2 pr-1 text-[12px] font-medium">
          <Tip label={`Coding in ${root.replace(/^\/Users\/[^/]+/, "~")}`} align="left">
            <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 items-center gap-1.5"><Code2 size={14} className="shrink-0 text-accent" /><span className="truncate">{base(root)}</span></button>
          </Tip>
          <button onClick={() => setRoot(null)} aria-label="Turn off coding mode" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-foreground"><X size={12} /></button>
        </div>
      ) : (
        <Tip label="Coding mode: work in a project folder" align="left">
          <button onClick={() => setOpen((v) => !v)} aria-label="Coding mode" className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-foreground", open && "bg-surface-hover text-foreground")}><Code2 size={16} /></button>
        </Tip>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1.5 w-72 rounded-xl border border-border bg-background p-1.5 shadow-lg">
            <p className="px-2 pb-1 pt-1 text-[11px] leading-snug text-muted">Marigold reads, edits and tests the code in one folder you choose, and asks before anything risky.</p>
            {native ? (
              <button onClick={() => void pick()} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-hover"><FolderOpen size={15} className="text-muted" /> Choose project folder…</button>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { setRoot(typed.trim()); setOpen(false); } }} className="flex gap-1 p-1">
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="~/Developer/my-project" className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent" />
                <button className="h-8 rounded-lg bg-accent px-3 text-[12px] font-medium text-black">Use</button>
              </form>
            )}
            {recent.filter((r) => r !== root).length > 0 && <p className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Recent</p>}
            {recent.filter((r) => r !== root).map((r) => (
              <button key={r} onClick={() => { setRoot(r); setOpen(false); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-hover" title={r}>
                <Code2 size={13} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{base(r)}</span>
              </button>
            ))}
            {root && <button onClick={() => { setRoot(null); setOpen(false); }} className="mt-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-surface-hover"><X size={13} /> Turn off coding mode</button>}
          </div>
        </>
      )}
    </div>
  );
}
