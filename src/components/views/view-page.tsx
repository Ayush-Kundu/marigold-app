"use client";

import { useApp } from "@/lib/store";

/**
 * What the agent is doing in the active chat (shared by the nav, the chat and the Apps tab).
 * The side-by-side view lives in components/shell/side-view.tsx.
 */
const WORKED_KEY = "marigold.agentChats";
function workedChats(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(WORKED_KEY) ?? "[]")); } catch { return new Set(); }
}
function rememberWorked(id: string) {
  try {
    const set = workedChats();
    if (set.has(id)) return;
    set.add(id);
    localStorage.setItem(WORKED_KEY, JSON.stringify([...set].slice(-500)));
  } catch { /* storage unavailable — history check still works */ }
}

/** What the agent is doing in the active chat (a live run, a background check, or earlier work worth keeping on screen). */
export function useChatAgentState() {
  const chatId = useApp((s) => s.activeChatId);
  const agentTasks = useApp((s) => s.agentTasks);
  const chat = useApp((s) => s.chats.find((c) => c.id === s.activeChatId));
  const live = (t: { status: string }) => t.status === "running" || t.status === "needs_input";
  // Quick answers/lookups aren't the agent working.
  const chatRun = agentTasks.find((t) => t.kind === "chat" && t.chatId === chatId && live(t) && t.mode !== "answer" && t.mode !== "lookup");
  const monitor = agentTasks.find((t) => t.kind === "monitor" && t.chatId === chatId && live(t));
  const target = chatRun ?? monitor;
  const working = !!chatRun || !!monitor?.checking;
  const msgs = chat?.messages ?? [];
  const hadWork = msgs.some((m) => m.role !== "user" && (m.steps?.length ?? 0) > 0) || (!!chatId && workedChats().has(chatId));
  if (target && chatId) rememberWorked(chatId);
  const lastAgent = [...msgs].reverse().find((m) => m.role !== "user");
  return { chatId, chatRun, monitor, target, working, hasWork: !!target || hadWork, lastAgent };
}
