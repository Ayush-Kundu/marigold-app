"use client";

import { useApp } from "@/lib/store";
import { ToolGlyph } from "@/components/tool-glyph";
import { cn } from "@/lib/utils";
import type { BackgroundTask, TaskStatus } from "@/lib/types";
import { Minimize2, Maximize2, EyeOff, ListTodo, OctagonX, X, Square, Play } from "lucide-react";
import { stopAllAgents, stopOneTask } from "@/lib/agent";

// Which statuses surface in the strip as a notification.
const NOTABLE: TaskStatus[] = ["running", "needs_input", "done", "failed"];

export function BackgroundStrip() {
  const tasks = useApp((s) => s.tasks);
  const selectChat = useApp((s) => s.selectChat);
  const acknowledge = useApp((s) => s.acknowledgeTask);
  const sync = useApp((s) => s.syncAgentTasks);
  // Stop: halts this one task now and clears it. Delete: removes a finished one.
  const end = async (t: BackgroundTask) => {
    if (t.status === "running" || t.status === "needs_input") { await stopOneTask(t.id); await acknowledge(t.id); await sync(); } else await acknowledge(t.id);
  };
  // Opening a finished (green) or ended task counts as acknowledging it.
  const open = (t: BackgroundTask) => {
    selectChat(t.chatId);
    if (t.status === "done" || t.status === "failed") void acknowledge(t.id);
  };
  const visible = useApp((s) => s.stripVisible);
  const setVisible = useApp((s) => s.setStripVisible);
  const size = useApp((s) => s.stripSize);
  const setSize = useApp((s) => s.setStripSize);

  const shown = tasks.filter((t) => NOTABLE.includes(t.status));
  if (shown.length === 0) return null;

  // Collapsed: a slim bar that can restore the strip.
  if (!visible) {
    return (
      <div className="shrink-0 border-b border-border px-4 py-2">
        <button
          onClick={() => setVisible(true)}
          className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground"
        >
          <ListTodo size={14} />
          Background tasks
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-2 px-1 text-[10px] font-semibold">
            {shown.length}
          </span>
        </button>
      </div>
    );
  }

  const compact = size === "sm";

  return (
    <div className="shrink-0 border-b border-border px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Background tasks
        </span>
        <div className="flex items-center gap-0.5">
          {tasks.some((t) => t.status === "running" || t.status === "needs_input") && (
            <button
              onClick={() => void stopAllAgents()}
              title="Stop every running task"
              className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-danger hover:bg-surface-hover"
            >
              <OctagonX size={12} /> Stop all
            </button>
          )}
          <IconBtn
            label={compact ? "Larger cards" : "Smaller cards"}
            onClick={() => setSize(compact ? "md" : "sm")}
          >
            {compact ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
          </IconBtn>
          <IconBtn label="Hide" onClick={() => setVisible(false)}>
            <EyeOff size={13} />
          </IconBtn>
        </div>
      </div>

      <div className={cn("flex overflow-x-auto pb-0.5", compact ? "gap-2" : "gap-2.5")}>
        {shown.map((t) =>
          compact ? (
            <CompactCard key={t.id} task={t} onClick={() => open(t)} onEnd={() => void end(t)} />
          ) : (
            <Card key={t.id} task={t} onClick={() => open(t)} onEnd={() => void end(t)} />
          ),
        )}
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-foreground"
    >
      {children}
    </button>
  );
}

// Corner notification: marigold (pulsing) = running, green = done, red = needs you.
function notifColor(status: TaskStatus): { dot: string; ring: boolean } {
  switch (status) {
    case "running":
      return { dot: "bg-accent", ring: true };
    case "done":
      return { dot: "bg-success", ring: false };
    case "needs_input":
      return { dot: "bg-danger", ring: false };
    default:
      return { dot: "bg-muted", ring: false };
  }
}

function NotificationDot({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const n = notifColor(status);
  return (
    <span className={cn("relative flex h-2 w-2", className)}>
      {n.ring && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            n.dot,
          )}
        />
      )}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", n.dot)} />
    </span>
  );
}

type CardProps = {
  task: BackgroundTask;
  onClick: () => void;
  onEnd: () => void;
};

/** Stop (while running) or delete (once finished) just this task. */
function EndBtn({ task, onEnd, className }: { task: BackgroundTask; onEnd: () => void; className?: string }) {
  const live = task.status === "running" || task.status === "needs_input";
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onEnd(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onEnd(); } }}
      title={live ? "Stop this task" : "Delete this task"}
      aria-label={live ? "Stop this task" : "Delete this task"}
      className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-60 transition-opacity hover:bg-surface-hover hover:text-danger group-hover:opacity-100", className)}
    >
      {live ? <Square size={10} className="fill-current" /> : <X size={12} />}
    </span>
  );
}

/** Scheduled tasks only: do it now instead of waiting for the time. */
function RunNowBtn({ task }: { task: BackgroundTask }) {
  if (task.kind !== "calendar" || task.status !== "running") return null;
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); void fetch(`/api/agent/tasks/${task.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "runnow" }) }); }}
      title="Run it now instead of waiting"
      aria-label="Run it now"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-60 transition-opacity hover:bg-surface-hover hover:text-accent group-hover:opacity-100"
    >
      <Play size={10} className="fill-current" />
    </span>
  );
}

function Card({ task, onClick, onEnd }: CardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
      title={task.summary}
      className="group relative w-44 shrink-0 cursor-default rounded-lg border border-border bg-surface p-2.5 text-left transition-colors hover:border-accent"
    >
      <div className="flex items-center gap-1.5">
        <NotificationDot status={task.status} />
        <ToolGlyph tool={task.kind} size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
        <RunNowBtn task={task} />
        <EndBtn task={task} onEnd={onEnd} className="-mr-1" />
      </div>
    </div>
  );
}

function CompactCard({ task, onClick, onEnd }: CardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
      title={task.summary}
      className="group flex h-8 shrink-0 cursor-default items-center gap-2 rounded-full border border-border bg-surface pl-2.5 pr-1.5 text-left transition-colors hover:border-accent"
    >
      <NotificationDot status={task.status} />
      <ToolGlyph tool={task.kind} size={13} className="shrink-0 text-muted" />
      <span className="max-w-48 truncate text-xs font-medium">{task.title}</span>
      <RunNowBtn task={task} />
      <EndBtn task={task} onEnd={onEnd} />
    </div>
  );
}
