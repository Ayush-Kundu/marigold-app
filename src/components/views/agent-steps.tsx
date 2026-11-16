"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useApp } from "@/lib/store";
import { Check, ChevronRight, Loader2, ShieldAlert, ShieldCheck, Ban, X, CircleDollarSign, Fingerprint } from "lucide-react";
import { answerApproval, approveWithTouchId } from "@/lib/agent";
import type { AgentStep } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- approvals sit at the bottom, next to the message box
let dockMounts = 0;
const dockSubs = new Set<() => void>();
const dockChange = (d: number) => { dockMounts += d; dockSubs.forEach((f) => f()); };
const useDockMounted = () => useSyncExternalStore((f) => { dockSubs.add(f); return () => { dockSubs.delete(f); }; }, () => dockMounts > 0, () => false);
/** The steps of the open chat that are waiting for the user's OK. */
function useAwaiting(): AgentStep[] {
  const chatId = useApp((s) => s.activeChatId);
  const chats = useApp((s) => s.chats);
  return useMemo(() => chats.find((c) => c.id === chatId)?.messages.flatMap((m) => m.steps ?? []).filter((x) => x.status === "awaiting") ?? [], [chats, chatId]);
}

/** Permission cards, pinned just above the message box: no scrolling to find what Marigold is asking. */
export function ApprovalDock() {
  const steps = useAwaiting();
  useEffect(() => { dockChange(1); return () => dockChange(-1); }, []);
  if (!steps.length) return null;
  return (
    <div className="mb-2 max-h-[48vh] space-y-2 overflow-y-auto overscroll-contain" role="region" aria-label="Marigold needs your OK" aria-live="polite">
      {steps.map((x) => <ApprovalCard key={x.id} step={x} />)}
    </div>
  );
}

/** The agent's actions for one turn: a compact timeline. Waiting-for-OK steps show as a one-line pointer to the card at the bottom. */
export function AgentSteps({ steps }: { steps: AgentStep[] }) {
  const dock = useDockMounted();
  const waiting = useAwaiting();
  return (
    <div className="space-y-1">
      {steps.map((s) => (s.status === "awaiting"
        ? (dock && waiting.some((w) => w.id === s.id)
          ? <p key={s.id} className="flex items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[12px] text-muted"><ShieldAlert size={13} className="shrink-0 text-accent" /> <span className="min-w-0 flex-1 truncate">Needs your OK: {s.title}</span><span className="shrink-0 text-[11px]">answer below ↓</span></p>
          : <ApprovalCard key={s.id} step={s} />)
        : <StepRow key={s.id} step={s} />))}
    </div>
  );
}

/** Added lines green, removed lines red (code_edit and git diffs). */
function colorDiff(text: string) {
  return text.split("\n").map((l, i) => {
    const add = /^\s*\d+ \+/.test(l) || /^\+(?!\+\+)/.test(l), del = /^\s*\d+ -/.test(l) || /^-(?!--)/.test(l);
    return <span key={i} className={add ? "block bg-success/10 text-success" : del ? "block bg-danger/10 text-danger" : "block"}>{l || " "}</span>;
  });
}

export function StepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const icon =
    step.status === "running" ? <Loader2 size={12} className="animate-spin text-accent" />
    : step.status === "done" ? <Check size={12} className="text-success" />
    : step.status === "blocked" ? <Ban size={12} className="text-danger" />
    : <X size={12} className="text-muted" />;
  return (
    <div className="text-[12px]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left text-muted hover:text-foreground">
        {icon}
        <span className="flex-1 truncate">{step.title}</span>
        {step.status === "declined" && <span className="text-[11px]">declined</span>}
        {step.status === "blocked" && <span className="text-[11px] text-danger">blocked</span>}
        <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
      </button>
      {open && (step.detail || step.result) && (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface p-2 text-[11px] text-muted [overflow-wrap:anywhere]">
          {step.detail ? `${step.detail}\n\n→ ` : ""}
          {step.tool === "code_edit" || step.tool === "code_git" ? colorDiff(step.result ?? "") : step.result}
        </pre>
      )}
    </div>
  );
}

export function ApprovalCard({ step }: { step: AgentStep }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const money = step.tier === 3;
  const touchId = async () => {
    setBusy(true);
    setErr(null);
    const r = await approveWithTouchId(step.id, `approve: ${step.title.replace(/^💳\s*/, "").slice(0, 90)}`);
    if (!r.ok) {
      setErr(r.error ?? "Couldn't verify.");
      setBusy(false);
    }
  };
  const a = step.approval;
  const act = async (approve: boolean, remember = false) => {
    setBusy(true);
    await answerApproval(step.id, approve, remember).catch(() => setBusy(false));
  };
  const btn = "flex min-w-0 flex-1 basis-[8.5rem] items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-center text-[12px] font-medium leading-tight disabled:opacity-50";
  return (
    <div className={cn("w-full min-w-0 max-w-full overflow-hidden rounded-xl border p-3 text-[12.5px]", money ? "border-danger" : "border-accent")}>
      <div className="flex items-start gap-2 font-medium">
        {money ? <CircleDollarSign size={15} className="mt-0.5 shrink-0 text-danger" /> : <ShieldAlert size={15} className="mt-0.5 shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{step.title}</span>
      </div>
      {step.detail && (
        <pre className="mt-2 max-h-40 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-surface p-2 text-[11px] [overflow-wrap:anywhere]">{step.detail}</pre>
      )}
      {a && <p className="mt-2 text-[11.5px] leading-snug text-muted [overflow-wrap:anywhere]">{a.reason}</p>}
      {err && <p className="mt-1.5 text-[11.5px] text-danger [overflow-wrap:anywhere]">{err}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {money && (
          <button disabled={busy} onClick={touchId} className={cn(btn, "basis-full bg-danger text-white hover:opacity-90")}>
            <Fingerprint size={13} className="shrink-0" /> Approve with Touch ID
          </button>
        )}
        {!money && <button disabled={busy} onClick={() => act(true)} className={cn(btn, a?.rememberable ? "border border-border hover:bg-surface-hover" : "bg-accent text-accent-foreground hover:opacity-90")}>
          Allow once
        </button>}
        {a?.rememberable && (
          <button disabled={busy} onClick={() => act(true, true)} title={a.scope === "terminal" ? "Never ask about terminal commands again" : `Always allow ${a.scope.replace(/^app:/, "")}`} className={cn(btn, "bg-accent text-accent-foreground hover:opacity-90")}>
            <ShieldCheck size={13} className="shrink-0" /> <span className="min-w-0 truncate">{a.scope === "terminal" ? "Always allow terminal commands" : `Always allow ${a.scope.replace(/^app:/, "")}`}</span>
          </button>
        )}
        <button disabled={busy} onClick={() => act(false)} className={cn(btn, "text-muted hover:bg-surface-hover", money && "basis-full")}>
          Decline
        </button>
      </div>
    </div>
  );
}
