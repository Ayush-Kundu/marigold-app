import { MODELS } from "./models";
import type { ModelId } from "./types";

/**
 * Server-side Ollama client. Streams chat completions from a local Ollama
 * instance. Swap OLLAMA_URL (or this whole module) for a cloud provider later
 * without touching the API route or UI.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Async generator of content tokens for a chat completion. */
export async function* streamChat(
  model: ModelId,
  messages: ChatMsg[],
  signal?: AbortSignal,
  persona?: string,
): AsyncGenerator<string> {
  const info = MODELS[model];
  const system = persona ? `${info.system}\n\n${persona}` : info.system;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: info.tag,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
      options: { temperature: 0.7 },
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${detail || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        const token: string | undefined = json.message?.content;
        if (token) yield token;
        if (json.done) return;
      } catch {
        /* ignore partial / non-JSON lines */
      }
    }
  }
}

/** Check whether the Ollama server is reachable. */
export async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
