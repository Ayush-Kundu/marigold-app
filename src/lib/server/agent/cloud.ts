import { execFile } from "child_process";
import { readFileSync, promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";

/**
 * Cloud "smart mode": a much bigger open-source model (e.g. gpt-oss-120b, Qwen3-235B) hosted
 * by an OpenAI-compatible provider (OpenRouter by default). Used for complex tasks — or
 * everything — WHEN ONLINE; Marigold falls back to the local model when offline or if the
 * cloud call fails. Opt-in: while on, those requests (incl. personal context) go to the provider.
 * The API key lives in the macOS Keychain, never in a file.
 */

const exec = promisify(execFile);
const FILE = path.join(MARIGOLD_DIR, "cloud.json");
const KEYCHAIN = ["-s", "Marigold cloud model", "-a", "marigold"];

/** off · plan = only the planner (≈1 small call per task — fits free tiers) · complex · always */
export type CloudMode = "off" | "plan" | "complex" | "always";
/** model = the strong one (planning, answers, recovery); fastModel = routine tool steps (≈2× quicker per turn). */
export interface CloudConfig { mode: CloudMode; baseUrl: string; model: string; fastModel?: string; lightModel?: string }

/** The model for routine agent steps. Abacus: Claude Sonnet 5.5 (≈1.3 s/turn, picked the right action 5/5 in our check; Haiku 5.5 missed 1/5 and ran most steps badly). */
export function stepModel(c: CloudConfig = cloudConfig()): string {
  return c.fastModel?.trim() || (/abacus\.ai/.test(c.baseUrl) ? "claude-sonnet-5-5" : c.model);
}

/**
 * Three price tiers, so easy work never pays for a big model:
 *   light    — tiny jobs (routing, memory notes, watcher wording, short plain answers): the cheapest model.
 *   standard — routine tool steps and ordinary answers.
 *   heavy    — plans, recovery after a failure, code, long essays, and anything important (money, sending, deleting).
 */
export type Tier = "light" | "standard" | "heavy";
export function lightModel(c: CloudConfig = cloudConfig()): string {
  return c.lightModel?.trim() || (/abacus\.ai/.test(c.baseUrl) ? "claude-haiku-5-5" : c.fastModel?.trim() || c.model);
}
export function modelFor(tier: Tier, c: CloudConfig = cloudConfig()): string {
  return tier === "light" ? lightModel(c) : tier === "standard" ? stepModel(c) : c.model;
}
const HARD_ASK = /\b(essay|analy[sz]e|analysis|research|in[- ]depth|step[- ]by[- ]step|write (a|an|me a) (long|detailed|full)|code|function|script|debug|refactor|algorithm|proof|derive|prove|strategy|business plan|legal|contract|medical|diagnos|tax|invest|compare .{10,}|pros and cons|critique|rewrite my|proofread my)\b/i;
/** How big a model does this plain question need? Short and ordinary → light; heavy words or long → heavy. */
export function answerTier(text: string): Tier {
  const t = text.trim();
  if (t.length > 700 || HARD_ASK.test(t)) return "heavy";
  if (t.length < 140 && t.split(/\s+/).length < 24) return "light";
  return "standard";
}
/** Work where a mistake costs something: money, sending to people, deleting, grades, accounts, documents that get submitted. */
export const IMPORTANT_JOB = /\b(buy|purchase|order|pay|checkout|transfer|wire|invoice|book|reserve|subscribe|cancel|refund|submit|apply|register|send (an? )?(e-?mail|message|text|invite)|e-?mail|reply to|forward|delete|remove|trash|wipe|erase|unsubscribe|post|publish|tweet|share|grades?|password|bank|tax|legal|contract|resume|cover letter|application)\b/i;

export const PRESETS: Record<string, { baseUrl: string; model: string; label: string }> = {
  abacus: { label: "Abacus.AI RouteLLM (best model for each request)", baseUrl: "https://routellm.abacus.ai/v1", model: "route-llm" },
  openrouter: { label: "OpenRouter (many models, one key)", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-120b" },
  together: { label: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "openai/gpt-oss-120b" },
  fireworks: { label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/gpt-oss-120b" },
  "openrouter-glm": { label: "OpenRouter · GLM-5.2 (paid — for later)", baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.2" },
  "openrouter-kimi": { label: "OpenRouter · Kimi K3 (paid — for later)", baseUrl: "https://openrouter.ai/api/v1", model: "moonshotai/kimi-k3" },
  zai: { label: "Z.ai direct · GLM-5.2 (paid — for later)", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-5.2" },
  moonshot: { label: "Moonshot direct · Kimi K3 (paid — for later)", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k3" },
  groq: { label: "Groq · free tier (use Plans only)", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
};

export function cloudConfig(): CloudConfig {
  try { return { mode: "off", ...PRESETS.openrouter, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { return { mode: "off", ...PRESETS.openrouter }; }
}
export async function saveCloudConfig(c: Partial<CloudConfig>, apiKey?: string) {
  const next = { ...cloudConfig(), ...c };
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify({ mode: next.mode, baseUrl: next.baseUrl, model: next.model, ...(next.fastModel ? { fastModel: next.fastModel } : {}), ...(next.lightModel ? { lightModel: next.lightModel } : {}) }, null, 2), { mode: 0o600 });
  if (apiKey) await exec("security", ["add-generic-password", ...KEYCHAIN, "-w", apiKey.trim(), "-U"]);
  keyCache = undefined;
}

let keyCache: string | null | undefined;
async function apiKey(): Promise<string | null> {
  if (keyCache !== undefined) return keyCache;
  keyCache = await exec("security", ["find-generic-password", ...KEYCHAIN, "-w"]).then((r) => r.stdout.trim() || null, () => null);
  return keyCache;
}
export const hasCloudKey = async () => !!(await apiKey());

let online: { at: number; ok: boolean } | null = null;
/** Reachable right now? (cached 60 s; any HTTP answer counts) */
export async function cloudReachable(): Promise<boolean> {
  if (online && Date.now() - online.at < 60_000) return online.ok;
  const ok = await fetch(`${cloudConfig().baseUrl}/models`, { method: "GET", signal: AbortSignal.timeout(7000) }).then(() => true, () => false);
  online = { at: Date.now(), ok };
  return ok;
}
export const markCloudDown = () => { online = { at: Date.now(), ok: false }; };

/** "Always" mode: EVERY AI call (routing, answers, agent, background, memory, summaries) goes to the cloud first. */
export async function cloudAll(): Promise<boolean> {
  return cloudConfig().mode === "always" && (await hasCloudKey());
}

/** Should the PLANNER use the big model? (any mode except off) */
export async function cloudForPlans(): Promise<boolean> {
  return cloudConfig().mode !== "off" && (await hasCloudKey()) && (await cloudReachable());
}

/** Should THIS request use the cloud model? */
export async function shouldUseCloud(complex: boolean): Promise<boolean> {
  const c = cloudConfig();
  if (c.mode === "off" || c.mode === "plan" || (c.mode === "complex" && !complex)) return false;
  if (c.mode === "always") return await hasCloudKey();
  return (await hasCloudKey()) && (await cloudReachable());
}

// ---------------------------------------------------------------- OpenAI-compatible streaming

interface LoopMsg { role: string; content: string; cloudImages?: string[]; tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[]; tool_name?: string; tool_call_id?: string; thinking?: string }

/** A user message's content: plain text, or text + pictures (for vision models) when the user attached images. */
function contentFor(m: { role: string; content: string; cloudImages?: string[] }) {
  if (m.role !== "user" || !m.cloudImages?.length) return m.content;
  return [{ type: "text", text: m.content }, ...m.cloudImages.map((url) => ({ type: "image_url", image_url: { url } }))];
}

/** Our messages → OpenAI chat format (tool calls need ids + JSON-string arguments). */
function toOpenAI(messages: LoopMsg[]) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return { role: "assistant", content: m.content || null, tool_calls: m.tool_calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })) };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id ?? "call_0", content: m.content };
    return { role: m.role, content: contentFor(m) };
  });
}

/**
 * Stream one model turn from the cloud. Yields text tokens as they arrive; returns the
 * finished assistant message (content + tool calls) in OUR format.
 */
export async function* cloudTurn(messages: LoopMsg[], tools: unknown[], signal: AbortSignal, model?: string): AsyncGenerator<string, LoopMsg> {
  const c = cloudConfig();
  const key = await apiKey();
  if (!key) throw new Error("No cloud API key");
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://marigold.app", "X-Title": "Marigold" },
    body: JSON.stringify({ model: model ?? c.model, messages: toOpenAI(messages), tools, tool_choice: "auto", stream: true, temperature: 0.2, max_tokens: 8192 }),
  });
  if (!res.ok || !res.body) throw new Error(`Cloud model ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);

  const out: LoopMsg = { role: "assistant", content: "", tool_calls: [] };
  const pending: { id?: string; name: string; args: string }[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }[] } }[] };
      try { j = JSON.parse(data); } catch { continue; }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.content) { out.content += d.content; if (!pending.length) yield d.content; }
      for (const [k, tc] of (d.tool_calls ?? []).entries()) {
        // Providers differ: OpenAI streams `arguments` as text pieces; some (e.g. Ollama) send a whole object.
        const p = (pending[tc.index ?? k] ??= { name: "", args: "" });
        if (tc.id) p.id = tc.id;
        if (tc.function?.name && !p.name.endsWith(tc.function.name)) p.name += tc.function.name;
        const fa = tc.function?.arguments;
        if (fa && typeof fa === "object") p.args = JSON.stringify(fa);
        else if (typeof fa === "string") p.args += fa;
      }
    }
  }
  out.tool_calls = pending.filter(Boolean).map((p) => {
    let args: Record<string, unknown> = {};
    try { args = p.args ? JSON.parse(p.args) : {}; } catch { args = {}; }
    // Normalise provider quirks: "functions.calendar" / "calendar.run" → "calendar";
    // {action, parameters:{…}} → {action, …}.
    const name = p.name.replace(/^functions\./, "").replace(/\.(run|call|invoke|execute)$/, "");
    if (args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)) {
      const { parameters, ...rest } = args as { parameters: Record<string, unknown> };
      args = { ...rest, ...parameters };
    }
    return { id: p.id, function: { name, arguments: args } };
  });
  return out;
}

/** One-shot (non-streaming) text completion — used by the planner. */
export async function cloudText(system: string, user: string, signal?: AbortSignal, opts: { model?: string; maxTokens?: number; tier?: Tier } = {}): Promise<string> {
  const c = cloudConfig();
  const key = await apiKey();
  if (!key) return "";
  const r = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://marigold.app", "X-Title": "Marigold" },
    body: JSON.stringify({ model: opts.model ?? (opts.tier ? modelFor(opts.tier, c) : c.model), messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.3, max_tokens: opts.maxTokens ?? 1500 }),
  });
  const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Which provider a pasted key belongs to, by its prefix (so an Abacus key is never sent to OpenRouter by mistake). */
export function presetForKey(key: string): string | null {
  const k = key.trim();
  if (/^s2_/.test(k)) return "abacus";
  if (/^sk-or-/.test(k)) return "openrouter";
  if (/^gsk_/.test(k)) return "groq";
  return null;
}

/** Settings "Test": a tiny request so the user knows the key + model work. On failure it says what the provider answered. */
export async function testCloud(): Promise<{ ok: boolean; reply?: string; error?: string; ms?: number }> {
  const t = Date.now();
  const c = cloudConfig();
  const key = await apiKey();
  const host = (() => { try { return new URL(c.baseUrl).host; } catch { return c.baseUrl; } })();
  if (!key) return { ok: false, error: "No key is saved." };
  try {
    const r = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://marigold.app", "X-Title": "Marigold" },
      body: JSON.stringify({ model: c.model, max_tokens: 20, temperature: 0, messages: [{ role: "user", content: "Reply with exactly: Marigold cloud OK" }] }),
    });
    const raw = await r.text();
    let j: { choices?: { message?: { content?: string } }[]; error?: unknown } = {};
    try { j = JSON.parse(raw); } catch { /* not JSON */ }
    const reply = j.choices?.[0]?.message?.content?.trim();
    if (r.ok && reply) return { ok: true, reply, ms: Date.now() - t };
    const detail = (typeof j.error === "string" ? j.error : (j.error as { message?: string } | undefined)?.message) ?? raw.slice(0, 160);
    return { ok: false, error: `${host} answered ${r.status}: ${String(detail).replace(/\s+/g, " ").slice(0, 160)}${r.status === 401 || r.status === 403 ? " (this looks like the wrong provider or a wrong key)" : ""}` };
  } catch (e) {
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.message ?? "no answer";
    return { ok: false, error: `Couldn't reach ${host} (${code}). Check the internet connection or a network filter.` };
  }
}

/** Stream plain text from the cloud model (no tools) — quick answers, lookups, summaries. */
export async function* cloudStream(system: string, messages: { role: string; content: string; cloudImages?: string[] }[], signal?: AbortSignal, maxTokens = 1200, model?: string): AsyncGenerator<string> {
  const c = cloudConfig();
  const key = await apiKey();
  if (!key) throw new Error("No cloud API key");
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://marigold.app", "X-Title": "Marigold" },
    body: JSON.stringify({ model: model ?? c.model, messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: contentFor(m) }))], stream: true, temperature: 0.3, max_tokens: maxTokens }),
  });
  if (!res.ok || !res.body) { markCloudDown(); throw new Error(`Cloud model ${res.status}`); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") continue;
      try { const t = JSON.parse(data).choices?.[0]?.delta?.content; if (t) yield t; } catch { /* partial */ }
    }
  }
}

/** One-shot JSON from the cloud (routing, memory, watcher judgement). "" on failure. */
export async function cloudJson(system: string, user: string, signal?: AbortSignal, opts?: { model?: string; maxTokens?: number; tier?: Tier }): Promise<string> {
  try { return await cloudText(`${system}\nReply with ONLY the JSON, no other text.`, user, signal ?? AbortSignal.timeout(30_000), opts); }
  catch { markCloudDown(); return ""; }
}

/** Why the AI can't be used right now, in plain words ("" if nothing obvious is wrong). */
export async function cloudProblem(): Promise<string> {
  const c = cloudConfig();
  if (c.mode === "off") return "No AI is set up on this Mac yet. Open Setup, choose \"Got a setup file from someone?\" (or paste an API key), and Marigold will connect.";
  if (!(await hasCloudKey())) return "No AI key is saved on this Mac. Open Setup, choose \"Got a setup file from someone?\" and pick the file you were sent (or paste an API key).";
  const host = (() => { try { return new URL(c.baseUrl).host; } catch { return c.baseUrl; } })();
  try { await fetch(`${c.baseUrl}/models`, { signal: AbortSignal.timeout(8000) }); }
  catch (e) {
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.message ?? "no answer";
    return `This Mac can't reach the AI service (${host}: ${code}). Check the internet connection; a school or work network, a VPN or a firewall may be blocking it.`;
  }
  const key = await apiKey();
  const r = await fetch(`${c.baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: stepModel(c), max_tokens: 4, messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) return `The AI service (${host}) didn't answer. Try again in a moment.`;
  if (r.status === 401 || r.status === 403) return "The AI service rejected the saved key. It may have been replaced or turned off. Ask whoever sent you Marigold for a fresh setup file.";
  if (r.status === 402 || r.status === 429) return "The AI service says the key is out of credit or rate-limited. Try again later, or ask whoever sent you Marigold.";
  return r.ok ? "" : `The AI service answered with an error (${r.status}). Try again in a moment.`;
}
/** Turn a low-level network error ("fetch failed") into something a person can act on. */
export async function friendlyAiError(err: unknown): Promise<string> {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket hang up|other side closed/i.test(msg)) return msg;
  const why = await cloudProblem().catch(() => "");
  return why || "Marigold's AI isn't connected. Open Setup to connect it (the setup file you were sent, or an API key).";
}
