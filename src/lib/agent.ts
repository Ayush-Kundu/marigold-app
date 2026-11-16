import { nativeApp } from "./native";
/**
 * Agent interface. The UI talks to the agent ONLY through this module.
 *
 * `streamAgent` calls the real local models (via /api/chat → Ollama). The
 * `streamRun`/`steerRun` helpers below still drive the (currently dormant)
 * View tab with a simulated event stream and will be wired to real runs later.
 */

import type { AgentEvent, AgentEventType, AgentStep, ModelId } from "./types";
import type { ModelChoice } from "./models";

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;

export interface StreamHandlers {
  onMeta?: (model: ModelId) => void;
  onToken?: (token: string) => void;
  /** A tool step was added or updated (including approval requests). */
  onStep?: (step: AgentStep) => void;
}

/** Answer an approval card. `remember` = "Always allow" for that scope. */
export async function answerApproval(id: string, approve: boolean, remember = false) {
  await fetch("/api/agent/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, approve, remember }),
  });
}

/** Touch ID approval for money actions (WebAuthn, platform authenticator). */
export async function approveWithTouchId(stepId: string, reason = "approve this payment"): Promise<{ ok: boolean; error?: string }> {
  // Inside the Mac app: the real macOS Touch ID prompt.
  const native = nativeApp();
  if (native) return native.touchID(stepId, reason);
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const optsRes = await fetch(`/api/agent/webauthn/verify?step=${encodeURIComponent(stepId)}`);
  const opts = await optsRes.json();
  if (!optsRes.ok) {
    return { ok: false, error: opts.error === "not_enrolled" ? "Set up Touch ID in Settings → Safety first." : opts.error };
  }
  try {
    const response = await startAuthentication({ optionsJSON: opts });
    const r = await fetch("/api/agent/webauthn/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: stepId, response }),
    });
    const j = await r.json();
    return { ok: !!j.ok, error: j.error };
  } catch {
    return { ok: false, error: "Touch ID was cancelled." };
  }
}

/** Enroll this Mac's Touch ID for money approvals. */
export async function enrollTouchId(): Promise<{ ok: boolean; error?: string }> {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const opts = await (await fetch("/api/agent/webauthn/register")).json();
  try {
    const response = await startRegistration({ optionsJSON: opts });
    const r = await fetch("/api/agent/webauthn/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
    return r.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cancelled" };
  }
}

/** Kill switch — stops every running agent task. */
export async function stopAllAgents() {
  await fetch("/api/agent/stop", { method: "POST" });
}

/**
 * Stream a real reply from the routed local model.
 * Returns the model that answered and the full text.
 */
export async function streamAgent(
  messages: { role: "user" | "assistant"; content: string }[],
  model: ModelChoice,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  persona?: string,
  chatId?: string,
  browserCurrent?: boolean,
  context?: string,
  coding?: string,
): Promise<{ model: ModelId; text: string }> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, model, persona, chatId, browserCurrent, context, coding }),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) detail = `${res.status} — ${j.error}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Chat request failed (${detail})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let chosen: ModelId = "llama";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = JSON.parse(trimmed);
      if (msg.type === "meta") {
        chosen = msg.model;
        handlers.onMeta?.(chosen);
      } else if (msg.type === "token") {
        text += msg.value;
        handlers.onToken?.(msg.value);
      } else if (msg.type === "step") {
        handlers.onStep?.(msg.step);
      } else if (msg.type === "error") {
        throw new Error(msg.message);
      }
    }
  }

  return { model: chosen, text };
}

/**
 * Subscribe to a live run's event stream (the View tab).
 * Returns an unsubscribe function. Replace the interval with a websocket/SSE
 * connection to the real backend later.
 */
export function streamRun(
  _runId: string,
  onEvent: (event: AgentEvent) => void,
): () => void {
  let i = 0;
  const script: Array<Pick<AgentEvent, "type" | "title" | "detail" | "tool" | "target">> = [
    { type: "thinking", title: "Checking broker replies", detail: "Two of three have responded." },
    { type: "browse", title: "Opened Sunday 1:00 slot for 88 Pacific St", tool: "browser", target: "streeteasy.com" },
    { type: "tool_call", title: "Added tentative holds to your calendar", tool: "calendar" },
    { type: "write", title: "Updating the confirmation email", tool: "email" },
  ];

  const timer = setInterval(() => {
    if (i >= script.length) {
      clearInterval(timer);
      return;
    }
    const step = script[i++];
    onEvent({ ...step, id: uid("e"), createdAt: new Date().toISOString() });
  }, 3500);

  return () => clearInterval(timer);
}

/** Inject a steering instruction mid-run (from the View sidebar). */
export async function steerRun(_runId: string, instruction: string): Promise<AgentEvent> {
  await delay(500);
  return {
    id: uid("e"),
    type: "thinking",
    title: "Adjusting plan per your note",
    detail: instruction,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const eventColors: Record<AgentEventType, string> = {
  thinking: "var(--muted)",
  tool_call: "var(--accent)",
  browse: "var(--accent)",
  write: "var(--warning)",
  awaiting_confirmation: "var(--warning)",
  done: "var(--success)",
  error: "var(--danger)",
};

export function eventColor(type: AgentEventType): string {
  return eventColors[type];
}

/** Send a mid-task correction to a running chat task or background task. */
export async function steerTask(taskId: string, text: string): Promise<boolean> {
  const res = await fetch(`/api/agent/tasks/${taskId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "steer", text }),
  }).catch(() => null);
  return !!res?.ok && !!(await res.json().catch(() => ({}))).ok;
}

// ---------------------------------------------------------------- Google (one-click connect)

export interface GoogleStatus { configured: boolean; shipped: boolean; accounts: { email: string; scopes?: string }[] }
export const googleStatus = (): Promise<GoogleStatus | null> => fetch("/api/google/config").then((r) => r.json()).catch(() => null);

/**
 * Connect a Google account: opens Google's own approval page in the user's real browser (the one
 * place Google allows it), then waits until the connection shows up. No passwords pass through Marigold.
 */
export async function connectGoogle(email: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch("/api/google/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }).catch(() => null);
  const j = await r?.json().catch(() => ({}));
  if (!r?.ok) return { ok: false, error: j?.error ?? "Couldn't start the connection." };
  for (let i = 0; i < 100; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    const s = await googleStatus();
    if (s?.accounts?.some((a) => a.email === email.toLowerCase())) return { ok: true };
  }
  return { ok: false, error: "Timed out waiting for Google's approval page." };
}

/** Pause / resume a running chat task or background task (it holds between steps). */
export async function setTaskPaused(taskId: string, paused: boolean): Promise<boolean> {
  const res = await fetch(`/api/agent/tasks/${taskId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: paused ? "pause" : "resume" }),
  }).catch(() => null);
  return !!res?.ok && !!(await res.json().catch(() => ({}))).ok;
}

/** Stop one task (not everything). */
export async function stopOneTask(taskId: string): Promise<boolean> {
  const res = await fetch(`/api/agent/tasks/${taskId}`, { method: "DELETE" }).catch(() => null);
  return !!res?.ok;
}

/** Safety page: run a real Touch ID check that approves nothing. */
export const testTouchId = () => nativeApp()?.testTouchID() ?? approveWithTouchId(`test-${Date.now().toString(36)}`);

// ---------------------------------------------------------------- email accounts

export interface EmailAccountInfo { address: string; primary: boolean; provider: string; label: string; inbox: string | null }

/** Tell the local agent which emails are the user's (primary = login email). */
export async function syncEmails(primary: string | undefined, extras: string[]): Promise<EmailAccountInfo[]> {
  const r = await fetch("/api/agent/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emails: { primary, extras } }),
  }).catch(() => null);
  return ((await r?.json().catch(() => null))?.emails ?? []) as EmailAccountInfo[];
}

/** Give the local agent the user's own past messages (for cross-chat memory). Cheap when nothing's new. */
export async function syncHistory(chats: { id: string; title: string; messages: { id: string; role: string; content: string; createdAt: string }[] }[]) {
  const items = chats.flatMap((c) => c.messages.filter((m) => m.role === "user" && m.content.trim()).map((m) => ({ id: m.id, chatId: c.id, title: c.title, at: m.createdAt, text: m.content })));
  if (!items.length) return;
  await fetch("/api/agent/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items.slice(-3000) }) }).catch(() => {});
}

export async function getEmails(): Promise<EmailAccountInfo[]> {
  const r = await fetch("/api/agent/prefs").catch(() => null);
  return ((await r?.json().catch(() => null))?.emails ?? []) as EmailAccountInfo[];
}

/** Open that email's sign-in page (email pre-filled) in the Marigold Browser. */
export async function signInEmail(email: string): Promise<boolean> {
  const r = await fetch("/api/agent/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "signin", email }),
  }).catch(() => null);
  return !!r?.ok;
}
