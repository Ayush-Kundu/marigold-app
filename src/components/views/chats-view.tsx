"use client";

import { useEffect, useRef } from "react";

import { useApp } from "@/lib/store";
import { starterPrompts } from "@/lib/mock-data";
import { ToolGlyph } from "@/components/tool-glyph";
import type { Message } from "@/lib/types";
import { MarigoldIcon } from "@/components/marigold-icon";
import { Check, X, ShieldCheck } from "lucide-react";
import { AgentSteps } from "./agent-steps";
import { AppChip } from "@/components/shell/app-dock";
import { APP_LINK_RE, ATT_LINK_RE } from "@/lib/app-icons";
import { Paperclip, Radar } from "lucide-react";
import { useOpenView } from "@/components/shell/side-view";
import { useChatAgentState } from "@/components/views/view-page";

export function ChatsView() {
  const chat = useApp((s) => s.chats.find((c) => c.id === s.activeChatId));

  // Follow new messages / streaming / tool steps — unless the user scrolled up to read.
  const endRef = useRef<HTMLDivElement>(null);
  const last = chat?.messages.at(-1);
  const growth = `${chat?.id}:${chat?.messages.length}:${last?.content.length}:${last?.steps?.map((x) => x.status).join()}`;
  const prevChat = useRef<string | undefined>(undefined);
  useEffect(() => {
    const end = endRef.current;
    const scroller = end?.closest("main");
    if (!end || !scroller) return;
    const switched = prevChat.current !== chat?.id;
    prevChat.current = chat?.id;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (switched || nearBottom || last?.role === "user") {
      end.scrollIntoView({ block: "end", behavior: switched ? "auto" : "smooth" });
    }
  }, [growth, chat?.id, last?.role]);

  if (!chat || chat.messages.length === 0) return <EmptyState />;

  const lastId = chat?.messages.at(-1)?.id;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5">
      <div className="space-y-6">
        {chat.messages.map((m) => (
          <MessageBubble key={m.id} message={m} isLast={m.id === lastId} />
        ))}
        <OrphanApprovals chatId={chat.id} known={chat.messages.flatMap((m) => m.steps ?? []).map((x) => x.id)} />
        <WatchLive />
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** While Marigold works in your apps: one tap to watch it (and step in) in the side-by-side view. */
function WatchLive() {
  const { working, chatRun } = useChatAgentState();
  const sideView = useApp((s) => s.sideView);
  const { can, open } = useOpenView();
  if (!working || sideView || !can || chatRun?.mode !== "action") return null;
  return (
    <button onClick={() => void open()} className="ml-7 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-left text-[12.5px] hover:bg-accent/15">
      <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-accent" /></span>
      <span className="font-medium">Marigold is working in your apps</span>
      <span className="flex items-center gap-1 text-muted"><Radar size={12} /> Open view</span>
    </button>
  );
}

/** Approvals from background tasks this tab isn't streaming (e.g. after a reload). */
function OrphanApprovals({ chatId, known }: { chatId: string; known: string[] }) {
  const tasks = useApp((s) => s.agentTasks);
  const pending = tasks
    .filter((t) => t.chatId === chatId)
    .flatMap((t) => t.pending)
    .filter((p) => !known.includes(p.id));
  if (pending.length === 0) return null;
  return (
    <div className="pl-7">
      <p className="mb-1 text-[11px] text-muted">A background task needs you:</p>
      <AgentSteps steps={pending} />
    </div>
  );
}

/** A user message with its picked-app links shown as app chips and its attached files as thumbnails / file chips. */
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
function userParts(content: string) {
  const out: React.ReactNode[] = [];
  const re = new RegExp(`${APP_LINK_RE.source}|${ATT_LINK_RE.source}`, "g");
  let last = 0, k = 0;
  for (const m of content.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(content.slice(last, i));
    if (m[1] !== undefined) out.push(<AppChip key={k++} name={m[1]} />);
    else if (IMG_EXT.test(m[3])) out.push(
      // eslint-disable-next-line @next/next/no-img-element
      <img key={k++} src={`/api/agent/upload/${m[4]}`} alt={m[3]} className="my-1 mr-1 inline-block max-h-40 max-w-[220px] rounded-lg border border-border object-cover align-middle" />,
    );
    else out.push(<span key={k++} className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-px align-middle text-[12px]"><Paperclip size={11} className="text-muted" />{m[3]}</span>);
    last = i + m[0].length;
  }
  if (last < content.length) out.push(content.slice(last).replace(/^ /, last ? " " : ""));
  return out;
}

export function MessageBubble({ message, isLast }: { message: Message; isLast: boolean }) {
  const isUser = message.role === "user";
  const composerActive = useApp((s) => s.composerActive);
  const waiting = message.streaming && message.content.length === 0;

  // User turns: a compact, neutral bubble, right-aligned (ChatGPT style).
  if (isUser) {
    return (
      <div className="flex animate-fade-in justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl bg-surface px-3.5 py-1.5 text-[12.5px] leading-relaxed">
          {userParts(message.content)}
        </div>
      </div>
    );
  }

  // Marigold avatar: breathe while answering, twirl when dormant, still while the user types.
  const iconState = message.streaming
    ? "stream"
    : isLast && !composerActive
      ? "idle"
      : "static";

  // Assistant turns: plain text, no box, full width.
  return (
    <div className="flex animate-fade-in gap-2.5">
      <div className="mt-0.5 shrink-0">
        <MarigoldIcon size={20} state={iconState} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {message.steps && message.steps.length > 0 && <AgentSteps steps={message.steps} />}
        {waiting && message.steps?.length ? null : waiting ? (
          <div className="flex items-center gap-1 pt-1">
            <Dot /> <Dot delay="0.15s" /> <Dot delay="0.3s" />
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-foreground">
            {message.content.replace(/\s?\[(laugh|chuckle|sigh|gasp|cough|groan|sniff|shush|clear throat)\]/gi, "").split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => (/^\*\*[^*\n]+\*\*$/.test(part) ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : part))}
            {message.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
          </div>
        )}
        {message.action && <ActionChip action={message.action} />}
      </div>
    </div>
  );
}

function ActionChip({ action }: { action: NonNullable<Message["action"]> }) {
  const needs = action.needsConfirmation && action.status === "proposed";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-[13px]">
      <ToolGlyph tool={action.tool} size={14} className="text-muted" />
      <span className="flex-1">{action.label}</span>
      {needs ? (
        <div className="flex items-center gap-1">
          <button className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground hover:opacity-90">
            <Check size={12} /> Approve
          </button>
          <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-hover">
            <X size={13} />
          </button>
        </div>
      ) : (
        <span className="text-[11px] text-muted">
          {action.status === "done" ? "Done" : action.status}
        </span>
      )}
    </div>
  );
}

function Dot({ delay = "0s" }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted"
      style={{ animationDelay: delay }}
    />
  );
}

function EmptyState() {
  const send = useApp((s) => s.sendUserMessage);
  const name = useApp((s) => s.user.name);
  const composerActive = useApp((s) => s.composerActive);
  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center px-4 text-center">
      <div className="mb-3.5">
        <MarigoldIcon size={44} state={composerActive ? "static" : "idle"} />
      </div>
      <h1 className="text-lg font-semibold">Good to see you, {name}.</h1>
      <p className="mt-1.5 text-[13px] text-muted">
        What should I take off your plate? I&apos;ll show my work as I go.
      </p>
      <div className="mt-5 grid w-full gap-2 sm:grid-cols-2">
        {starterPrompts.map((p) => (
          <button
            key={p}
            onClick={() => send(p)}
            className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-left text-[13px] transition-colors hover:border-accent"
          >
            {p}
          </button>
        ))}
      </div>
      <p className="mt-5 flex items-center gap-1.5 text-[11px] text-muted">
        <ShieldCheck size={12} /> Approve an app once and I remember. Money always asks.
      </p>
    </div>
  );
}
