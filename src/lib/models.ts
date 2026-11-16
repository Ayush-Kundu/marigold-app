import type { ModelId } from "./types";

export interface ModelInfo {
  id: ModelId;
  label: string;
  short: string;
  /** The Ollama tag to run. */
  tag: string;
  description: string;
  /** Badge color. */
  accent: string;
  /** System prompt that gives the model its Marigold persona / specialty. */
  system: string;
  /** Tried in order if `tag` isn't installed. */
  fallbacks?: string[];
}

/** Per-model Ollama settings (each family wants different sampling). */
export interface RuntimeOptions { options: Record<string, number>; think?: "low" | "medium" | "high" | false }
/** Auto mode's fast lane: a small model for simple one-step actions (thinking off). */
export const FAST_TAG = "qwen3:4b-instruct";

export function runtimeFor(tag: string, deep = false): RuntimeOptions {
  if (tag.startsWith("qwen3")) {
    // Non-thinking mode = no hidden reasoning before each step (Qwen's recommended sampling).
    return { think: false, options: { temperature: 0.7, top_p: 0.8, num_ctx: 16384, num_predict: 1024 } };
  }
  if (tag.startsWith("gpt-oss")) {
    // After something fails, think harder ("medium"): slower per step, but recovers instead of thrashing.
    if (deep) return { think: "medium", options: { temperature: 0.6, top_p: 1, num_ctx: 16384, num_predict: 4096 } };
    // MoE: 21B total, ~3.6B active per token. "low" reasoning keeps tool steps fast;
    // no repeat_penalty — it corrupts gpt-oss's tool-call format.
    return { think: "low", options: { temperature: 0.6, top_p: 1, num_ctx: 16384, num_predict: 2048 } };
  }
  return { options: { temperature: 0.3, num_ctx: 16384, num_predict: 1200, repeat_penalty: 1.1 } };
}

// The first line is also the whole persona for quick answers, so the voice rules live on it.
const MARIGOLD_PERSONA = `You are Marigold, the user's assistant on their Mac. Write like a sharp, friendly person texting: plain words, short sentences, the answer in the first sentence. No greetings or sign-offs, don't start with the user's name, no filler ("Certainly", "Great question", "I hope this helps", "Let me know if…"), no emoji, no headings or bullet lists for short answers, bold only for the one key fact, and use commas or periods rather than em dashes. If you're not sure, say so plainly. Never claim something happened that didn't.
Real-world actions (sending, spending, changing things) go through Marigold's safety checks, which ask the user when needed.`;

const CODER_PERSONA = `You are Marigold's coding and files specialist, powered by Qwen 2.5 Coder.
You help with programming, scripts, debugging, refactoring, and local file manipulation.
Prefer correct, idiomatic, runnable code. Use fenced code blocks with a language tag.
Be concise in prose and let the code do the talking. When an action would modify files
or run commands on the user's machine, state exactly what it will do and ask first.`;

export const MODELS: Record<ModelId, ModelInfo> = {
  agent: {
    id: "agent",
    label: "GPT-OSS 20B (MoE)",
    short: "GPT-OSS",
    tag: "gpt-oss:20b",
    description: "Agent — controls your apps, multi-step tasks (default)",
    accent: "#c2410c",
    system: MARIGOLD_PERSONA,
  },
  llama: {
    id: "llama",
    label: "Llama 3.1 8B",
    short: "Llama",
    tag: "llama3.1:8b",
    description: "General assistant — email, writing, web & everyday tasks",
    accent: "#e8a317",
    system: MARIGOLD_PERSONA,
  },
  qwen: {
    id: "qwen",
    label: "Qwen 2.5 Coder 7B",
    short: "Qwen Coder",
    tag: "qwen2.5-coder:7b",
    description: "Code & files — programming, scripts, file manipulation",
    accent: "#16a34a",
    system: CODER_PERSONA,
  },
};

export type ModelChoice = "auto" | ModelId;

/** Only the agent model is installed now; old ids ("llama"/"qwen") route to it. */
export const MODEL_LIST = [MODELS.agent];
