import { friendlyAiError } from "./cloud";
import { ping } from "./notifications";
import type { AgentStep, ModelId } from "@/lib/types";
import { runAgent, type LoopEvent, type LoopMsg } from "./loop";
import { createScheduled, createMonitor } from "./monitors";

/**
 * Background task manager. Every agent run is a task that lives on the
 * server, independent of the HTTP request that started it — close the tab and
 * it keeps working. Clients subscribe to its event stream (with replay), and
 * macOS notifications fire when a task needs you or finishes while no one is
 * watching.
 */

export type TaskState = "running" | "needs_input" | "done" | "failed" | "stopped";

export type TaskEvent = LoopEvent | { type: "meta"; model: ModelId } | { type: "done" } | { type: "error"; message: string };

export interface ServerTask {
  id: string;
  chatId: string;
  title: string;
  model: ModelId;
  status: TaskState;
  steps: AgentStep[];
  text: string;
  startedAt: string;
  updatedAt: string;
  events: TaskEvent[];
  listeners: Set<(e: TaskEvent) => void>;
  ctrl: AbortController;
  steer: string[];
  /** Paused by the user: the agent holds between steps until resumed. */
  paused?: boolean;
  /** answer / lookup = quick reply (no agent); action = the agent is working. */
  mode: "answer" | "lookup" | "action";
}

const g = globalThis as unknown as { __marigoldTasks?: Map<string, ServerTask> };
const tasks: Map<string, ServerTask> = (g.__marigoldTasks ??= new Map());
let seq = 0;

function notify(title: string, message: string, chatId?: string) {
  void ping({ kind: "task", title, body: message, chatId });
}

function emit(t: ServerTask, e: TaskEvent) {
  t.events.push(e);
  t.updatedAt = new Date().toISOString();
  if (e.type === "step") {
    const i = t.steps.findIndex((s) => s.id === e.step.id);
    if (i < 0) t.steps.push(e.step);
    else t.steps[i] = e.step;
    const awaiting = t.steps.some((s) => s.status === "awaiting");
    t.status = awaiting ? "needs_input" : "running";
    // (the "needs your OK" ping for an approval is sent once, from the run loop below)
  } else if (e.type === "token") {
    t.text += e.value;
  } else if (e.type === "mode") {
    t.mode = e.value;
  }
  t.listeners.forEach((l) => l(e));
}

export function startTask(opts: {
  chatId: string;
  title: string;
  model: ModelId;
  history: LoopMsg[];
  persona?: string;
  auto?: boolean;
  browserCurrent?: boolean;
  browserMode?: boolean;
  pageContext?: string;
  coding?: string;
}): ServerTask {
  const t: ServerTask = {
    id: `task_${Date.now().toString(36)}_${seq++}`,
    chatId: opts.chatId,
    title: opts.title.slice(0, 80),
    model: opts.model,
    status: "running",
    steps: [],
    text: "",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    listeners: new Set(),
    ctrl: new AbortController(),
    steer: [],
    mode: "action",
  };
  tasks.set(t.id, t);
  emit(t, { type: "meta", model: opts.model });

  (async () => {
    try {
      const ctx = {
        steerQueue: t.steer,
        waitIfPaused: async (signal: AbortSignal) => {
          if (!t.paused) return;
          emit(t, { type: "step", step: { id: `pause_${Date.now().toString(36)}`, tool: "pause", title: "Paused — press Resume to continue", status: "done", tier: 0 } });
          while (t.paused && !signal.aborted) await new Promise((r) => setTimeout(r, 300));
        },
        chatId: opts.chatId,
        auto: opts.auto,
        browserCurrent: opts.browserCurrent,
        browserMode: opts.browserMode,
        pageContext: opts.pageContext,
        ...(opts.coding ? { coding: { root: opts.coding }, forceAgent: true } : {}),
        scheduleTask: async (goal: string, atISO: string, repeat: "none" | "daily" | "weekdays" | "weekly" | "monthly") => {
          const m = await createScheduled(opts.chatId, goal, atISO, repeat);
          return m.scheduled!.at;
        },
        startMonitor: (goal: string, every: number, days: number, repeat?: boolean) => {
          void createMonitor(opts.chatId, goal, every, days, repeat);
          return "ok";
        },
      };
      for await (const ev of runAgent(opts.model, opts.history, t.ctrl.signal, opts.persona, ctx)) {
        emit(t, ev);
        // Waiting on the user (approval / Touch ID) → ping, in case they're not looking.
        if (ev.type === "step" && ev.step.status === "awaiting") void ping({ kind: "needs_you", key: `appr:${ev.step.id}`, title: "Marigold needs your OK", body: ev.step.title, chatId: opts.chatId, urgent: true });
      }
      t.status = t.ctrl.signal.aborted ? "stopped" : "done";
      emit(t, { type: "done" });
      // Chat/task finished → ping. The app decides how: macOS notification if you're elsewhere,
      // just the bell if you're in Marigold, nothing visible if you're looking at that chat.
      if (t.status === "done" && opts.chatId !== "unknown" && t.text.trim()) {
        const reply = t.text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
        const asked = t.title.replace(/^\[.*?\]\s*/, "").slice(0, 50);
        if (/\?\s*$/.test(reply) && t.mode === "action") void ping({ kind: "needs_you", title: "Marigold has a question", body: reply.slice(0, 180), chatId: opts.chatId });
        else if (t.mode === "action" && t.steps.length > 0) notify(`Done: ${asked}`, reply.slice(0, 180) || "Finished.", opts.chatId);
        else notify(`Reply: ${asked}`, reply.slice(0, 180), opts.chatId);
      }
      // Only ping if this was a real multi-step job (not a quick chat reply).
    } catch (err) {
      t.status = t.ctrl.signal.aborted ? "stopped" : "failed";
      const message = t.status === "failed" ? await friendlyAiError(err) : err instanceof Error ? err.message : String(err);
      emit(t, { type: "error", message });
      if (t.status === "failed") notify("Couldn't finish", `${t.title.slice(0, 60)}: ${message.slice(0, 120)}`, opts.chatId);
    } finally {
      t.listeners.clear();
    }
  })();

  // Forget finished tasks after a day.
  for (const [id, old] of tasks) {
    if (old.status !== "running" && old.status !== "needs_input" && Date.now() - Date.parse(old.updatedAt) > 86_400_000) tasks.delete(id);
  }
  return t;
}

/** Replay a task's events, then follow it live until done or the client leaves. */
export function subscribe(t: ServerTask, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const line = (e: unknown) => enc.encode(JSON.stringify(e) + "\n");
  let off = () => {};
  return new ReadableStream({
    start(controller) {
      for (const e of t.events) controller.enqueue(line(e));
      const finished = t.status !== "running" && t.status !== "needs_input";
      if (finished) return controller.close();
      const l = (e: TaskEvent) => {
        controller.enqueue(line(e));
        if (e.type === "done" || e.type === "error") {
          off();
          controller.close();
        }
      };
      t.listeners.add(l);
      off = () => t.listeners.delete(l);
      signal.addEventListener("abort", () => {
        off();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel: () => off(),
  });
}

export const getTask = (id: string) => tasks.get(id);

export function listTasks() {
  return [...tasks.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, chatId, title, model, status, steps, startedAt, updatedAt, text, mode, paused }) => ({
      id, chatId, title, model, status, startedAt, updatedAt, mode, paused: !!paused && (status === "running" || status === "needs_input"),
      summary: steps.at(-1)?.title ?? (text ? text.slice(0, 120) : "Thinking…"),
      pending: steps.filter((s: AgentStep) => s.status === "awaiting"),
      stepCount: steps.length,
    }));
}

/** Queue a correction for a running chat task. */
export function steerTask(id: string, text: string) {
  const t = tasks.get(id);
  if (!t || (t.status !== "running" && t.status !== "needs_input")) return false;
  t.steer.push(text.slice(0, 2000));
  return true;
}

/** Pause / resume a running chat task (it holds between steps; nothing is lost). */
export function pauseTask(id: string, paused: boolean) {
  const t = tasks.get(id);
  if (!t || (t.status !== "running" && t.status !== "needs_input")) return false;
  t.paused = paused;
  t.updatedAt = new Date().toISOString();
  return true;
}

export function stopTask(id: string) {
  const t = tasks.get(id);
  if (!t) return false;
  t.ctrl.abort();
  return true;
}

export function stopAllTasks() {
  let n = 0;
  for (const t of tasks.values()) {
    if (t.status === "running" || t.status === "needs_input") {
      t.ctrl.abort();
      n++;
    }
  }
  return n;
}
