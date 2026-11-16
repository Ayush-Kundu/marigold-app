"use client";

import { useEffect, useRef } from "react";
import { useApp } from "@/lib/store";
import { conversationOn } from "@/lib/conversation";
import { ensureVoice, speakable, speakText, stopSpeaking } from "@/lib/voice-client";

/**
 * Reads Marigold's replies aloud when "Speak replies" is on. Only the reply's own summary text is spoken — never
 * the steps the agent took, what it displayed, code, links or lists — and only replies that finish while you're here
 * (opening an old chat stays silent). Sending a new message, switching chats or turning it off stops the voice.
 */
export function VoiceOut() {
  const on = useApp((s) => s.speakReplies);
  const chat = useApp((s) => s.chats.find((c) => c.id === s.activeChatId));
  const sawStreaming = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  const lastChat = useRef<string | undefined>(undefined);
  const lastUser = useRef<string | undefined>(undefined);

  useEffect(() => { if (on) void ensureVoice(); else stopSpeaking(); }, [on]);

  useEffect(() => {
    const msgs = chat?.messages ?? [];
    if (chat?.id !== lastChat.current) {
      lastChat.current = chat?.id;
      stopSpeaking();
      for (const m of msgs) handled.current.add(m.id);
      lastUser.current = msgs.filter((m) => m.role === "user").at(-1)?.id;
      return;
    }
    const u = msgs.filter((m) => m.role === "user").at(-1)?.id;
    if (u !== lastUser.current) { lastUser.current = u; stopSpeaking(); }
    for (const m of msgs) {
      if (m.role === "user") continue;
      if (m.streaming) { sawStreaming.current.add(m.id); continue; }
      if (!sawStreaming.current.has(m.id) || handled.current.has(m.id)) continue;
      handled.current.add(m.id);
      if (!on || conversationOn() || !m.content.trim()) continue;
      const text = speakable(m.content);
      if (text) void speakText(text);
    }
  }, [chat, on]);

  return null;
}
