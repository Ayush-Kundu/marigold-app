"use client";

import { useEffect, useRef, useState } from "react";
import { useApp, isRunActive } from "@/lib/store";
import { streamRun, steerRun, eventColor } from "@/lib/agent";
import { ToolGlyph } from "@/components/tool-glyph";
import { relativeTime, cn } from "@/lib/utils";
import type { AgentEvent, CanvasPreview } from "@/lib/types";
import {
  Pause,
  Hand,
  ArrowUp,
  Lock,
  Globe,
  Check,
  Pencil,
  Radar,
} from "lucide-react";

export function LiveView() {
  const run = useApp((s) => s.run);
  const addRunEvent = useApp((s) => s.addRunEvent);
  const active = isRunActive(run);

  // Subscribe to the live event stream (mock today, websocket later).
  useEffect(() => {
    if (!active) return;
    const unsub = streamRun(run.id, addRunEvent);
    return unsub;
  }, [run.id, addRunEvent, active]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted">
        <Radar size={28} className="mb-3 opacity-60" />
        <p className="text-sm">Nothing running right now.</p>
        <p className="mt-1 text-xs">
          When the agent starts a task, it&apos;ll appear here so you can watch and steer.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Canvas */}
      <div className="flex min-h-0 flex-1 flex-col p-5">
        <div className="mb-3 flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-accent opacity-75" />
            <span className="h-2 w-2 rounded-full bg-accent" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{run.goal}</p>
            <p className="text-xs text-muted">Agent is working · live</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Control icon={Pause} label="Pause" />
            <Control icon={Hand} label="Take over" />
          </div>
        </div>
        <Canvas canvas={run.canvas} />
      </div>

      {/* Steering panel */}
      <SteeringPanel runId={run.id} events={run.events} />
    </div>
  );
}

function Control({ icon: Icon, label }: { icon: typeof Pause; label: string }) {
  return (
    <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground">
      <Icon size={14} /> {label}
    </button>
  );
}

function Canvas({ canvas }: { canvas: CanvasPreview }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
      {/* Faux browser/app chrome */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-danger/70" />
          <span className="h-3 w-3 rounded-full bg-warning/70" />
          <span className="h-3 w-3 rounded-full bg-success/70" />
        </div>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-background px-2.5 py-1 text-xs text-muted">
          {canvas.kind === "browser" ? <Lock size={11} /> : <Globe size={11} />}
          <span className="truncate">{canvas.url ?? canvas.title}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-xl">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ToolGlyph
              tool={canvas.kind === "email" ? "email" : "browser"}
              size={16}
              className="text-accent"
            />
            {canvas.title}
          </div>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/90">
            {canvas.body}
          </pre>
        </div>
      </div>
    </div>
  );
}

function SteeringPanel({ runId, events }: { runId: string; events: AgentEvent[] }) {
  const [note, setNote] = useState("");
  const [steering, setSteering] = useState(false);
  const addRunEvent = useApp((s) => s.addRunEvent);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const submit = async () => {
    if (!note.trim() || steering) return;
    const text = note.trim();
    setNote("");
    setSteering(true);
    const ev = await steerRun(runId, text);
    addRunEvent(ev);
    setSteering(false);
  };

  return (
    <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border lg:w-[360px] lg:border-l lg:border-t-0">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        <p className="text-xs text-muted">Watch, steer, or edit directly.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ol className="relative space-y-4 border-l border-border pl-5">
          {events.map((e) => (
            <TimelineItem key={e.id} event={e} />
          ))}
        </ol>
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-1.5 focus-within:border-accent">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Redirect the agent mid-task…"
            className="max-h-24 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
          />
          <button
            onClick={submit}
            disabled={!note.trim() || steering}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              note.trim() && !steering
                ? "bg-accent text-accent-foreground hover:opacity-90"
                : "bg-surface-2 text-muted",
            )}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function TimelineItem({ event }: { event: AgentEvent }) {
  const color = eventColor(event.type);
  const awaiting = event.type === "awaiting_confirmation";
  return (
    <li className="relative animate-fade-in">
      <span
        className="absolute -left-[26px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background"
        style={{ background: color }}
      />
      <div className="flex items-start gap-2">
        {event.tool && <ToolGlyph tool={event.tool} size={14} className="mt-0.5 text-muted" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{event.title}</p>
          {event.detail && <p className="mt-0.5 text-xs text-muted">{event.detail}</p>}
          {event.target && (
            <p className="mt-0.5 truncate text-xs text-accent">{event.target}</p>
          )}
          <p className="mt-0.5 text-[11px] text-muted">{relativeTime(event.createdAt)}</p>

          {awaiting && (
            <div className="mt-2 flex items-center gap-2">
              <button className="flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:opacity-90">
                <Check size={13} /> Approve &amp; send
              </button>
              <button className="flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium text-muted hover:bg-surface-hover">
                <Pencil size={12} /> Edit
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
