"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { nativeApp } from "@/lib/native";
import { ApprovalCard, StepRow } from "@/components/views/agent-steps";
import { MarigoldIcon } from "@/components/marigold-icon";
import { ArrowUp, Maximize2, X, Loader2 } from "lucide-react";

/**
 * The menu-bar quick panel (opened from Marigold's menu-bar icon or ⌥⇧Space):
 * ask anything, watch the reply stream, approve what's waiting, see what's running.
 * Every question becomes a normal chat, so it's also in the full app.
 */
export default function QuickPanel() {
  const initAuth = useApp((s) => s.initAuth);
  const hydratePrefs = useApp((s) => s.hydratePrefs);
  const authResolved = useApp((s) => s.authResolved);
  const backed = useApp((s) => s.backed);
  const user = useApp((s) => s.user);
  const syncAgentTasks = useApp((s) => s.syncAgentTasks);
  const agentTasks = useApp((s) => s.agentTasks);
  const sending = useApp((s) => s.sending);
  const [chatId, setChatId] = useState<string | null>(null);
  const chat = useApp((s) => s.chats.find((c) => c.id === chatId));
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Let the panel's frosted (vibrancy) window show through.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    hydratePrefs();
    initAuth();
    void syncAgentTasks();
    const t = setInterval(() => void syncAgentTasks(), 2500);
    nativeApp()?.onQuickShown(() => setTimeout(() => input.current?.focus(), 30));
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") void nativeApp()?.hideQuick(); };
    window.addEventListener("keydown", k);
    return () => { clearInterval(t); window.removeEventListener("keydown", k); };
  }, [hydratePrefs, initAuth, syncAgentTasks]);

  const ask = async () => {
    const q = text.trim();
    if (!q || sending) return;
    setText("");
    const s = useApp.getState();
    s.newChat();
    const id = useApp.getState().activeChatId;
    setChatId(id);
    await s.sendUserMessage(q);
  };

  const reply = [...(chat?.messages ?? [])].reverse().find((m) => m.role !== "user");
  const asked = [...(chat?.messages ?? [])].reverse().find((m) => m.role === "user");
  const waiting = agentTasks.flatMap((t) => t.pending.map((p) => ({ ...p, chatId: t.chatId })));
  const working = agentTasks.filter((t) => t.kind === "chat" && t.status === "running" && t.mode === "action" && t.chatId !== chatId);

  return (
    <div className="flex h-dvh flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/85 text-foreground backdrop-blur-xl">
      {/* Title bar (drag to move) */}
      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <MarigoldIcon size={18} />
        <span className="text-[13px] font-semibold">Marigold</span>
        <div className="ml-auto flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button onClick={() => void nativeApp()?.openMain(chatId ?? undefined)} title="Open in Marigold" className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
            <Maximize2 size={14} />
          </button>
          <button onClick={() => void nativeApp()?.hideQuick()} title="Close (Esc)" className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
            <X size={14} />
          </button>
        </div>
      </div>

      {!authResolved ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted"><Loader2 size={16} className="animate-spin" /></div>
      ) : !backed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm">
          <p>Sign in to Marigold first.</p>
          <button onClick={() => void nativeApp()?.openMain()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground">Open Marigold</button>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 pb-3">
            {waiting.length > 0 && (
              <section className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Waiting for you</p>
                {waiting.map((p) => <ApprovalCard key={p.id} step={p} />)}
              </section>
            )}

            {chat && asked ? (
              <section className="space-y-2">
                <p className="rounded-xl bg-surface px-3 py-2 text-[13px]">{asked.content}</p>
                {(reply?.steps ?? []).filter((s) => s.status !== "awaiting").map((s) => <StepRow key={s.id} step={s} />)}
                {reply?.content ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{reply.content}</p>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> Thinking…</p>
                )}
              </section>
            ) : waiting.length === 0 && (
              <div className="pt-6 text-center text-[13px] text-muted">
                <p>What do you need?</p>
                <p className="mt-1 text-[11px]">Ask a question, or tell me to do something on your Mac.</p>
              </div>
            )}

            {working.length > 0 && (
              <section className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Working now</p>
                {working.map((t) => (
                  <button key={t.id} onClick={() => void nativeApp()?.openMain(t.chatId)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-surface-hover">
                    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                    <span className="truncate">{t.title}</span>
                  </button>
                ))}
              </section>
            )}
          </div>

          <div className="border-t border-border/60 p-2.5">
            <div className="flex items-end gap-2 rounded-xl border border-border bg-surface/70 p-1.5 focus-within:border-accent">
              <textarea
                ref={input}
                autoFocus
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }}
                placeholder="Ask Marigold…"
                className="max-h-28 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-muted"
              />
              <button onClick={() => void ask()} disabled={!text.trim() || sending} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground disabled:opacity-40">
                <ArrowUp size={16} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
