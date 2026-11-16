"use client";

import { useEffect, useRef, useState } from "react";
import { useApp, projectInstructions, saveProjectInstructions } from "@/lib/store";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ToolGlyph, StatusPill } from "@/components/tool-glyph";
import { ChatsView } from "./chats-view";
import type { Project } from "@/lib/types";
import { MessageSquare, Plus, FolderKanban, ArrowLeft, Trash2 } from "lucide-react";

export function ProjectsView() {
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const projectChatOpen = useApp((s) => s.projectChatOpen);
  const chats = useApp((s) => s.chats);
  const tasks = useApp((s) => s.tasks);
  const openProjectChat = useApp((s) => s.openProjectChat);
  const newProjectChat = useApp((s) => s.newProjectChat);
  const backToProjectHome = useApp((s) => s.backToProjectHome);
  const deleteChat = useApp((s) => s.deleteChat);
  const deleteProject = useApp((s) => s.deleteProject);
  const [confirm, setConfirm] = useState<string | null>(null); // a chat id, or "project"

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted">
        <FolderKanban size={26} className="mb-3" />
        <p className="text-[13px]">Select a project.</p>
      </div>
    );
  }

  // A chat is open within this project — show the conversation with a back control.
  if (projectChatOpen) {
    return (
      <div className="flex min-h-full flex-col">
        <div className="sticky top-0 z-10 border-b border-border bg-background/85 px-3 py-1.5 backdrop-blur">
          <button
            onClick={backToProjectHome}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <ArrowLeft size={14} />
            {project.name}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ChatsView />
        </div>
      </div>
    );
  }

  const projectChats = chats.filter((c) => c.projectId === project.id);
  const projectChatIds = new Set(projectChats.map((c) => c.id));
  const projectTasks = tasks.filter((t) => projectChatIds.has(t.chatId));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><EditableProjectHeader project={project} /></div>
        {confirm === "project" ? (
          <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1 text-[12px]">
            <span>Delete this project and its {projectChats.length} chat{projectChats.length === 1 ? "" : "s"}?</span>
            <button onClick={() => { deleteProject(project.id); setConfirm(null); }} className="rounded-md bg-danger px-2 py-0.5 font-medium text-white">Delete</button>
            <button onClick={() => setConfirm(null)} className="rounded-md px-2 py-0.5 text-muted hover:bg-surface-hover">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirm("project")} title="Delete project" aria-label="Delete project" className="mt-0.5 shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-danger"><Trash2 size={15} /></button>
        )}
      </div>

      <ProjectInstructions key={project.id} id={project.id} />

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Chats in this project
        </h2>
        <Button size="sm" variant="outline" onClick={newProjectChat}>
          <Plus size={14} /> New chat
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {projectChats.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted">
            No chats yet. Start one to kick off work in this project.
          </p>
        )}
        {projectChats.map((c) => (
          <div key={c.id} className="group relative">
            <button
              onClick={() => openProjectChat(c.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 pr-12 text-left transition-colors hover:border-accent"
            >
              <MessageSquare size={15} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{c.title}</p>
                <p className="truncate text-[11px] text-muted">
                  {c.messages.at(-1)?.content ?? "No messages yet"}
                </p>
              </div>
              <span className="shrink-0 text-[11px] text-muted group-hover:invisible">{relativeTime(c.updatedAt)}</span>
            </button>
            {confirm === c.id ? (
              <div className="absolute inset-y-0 right-2 flex items-center gap-1.5 text-[12px]">
                <button onClick={() => { deleteChat(c.id); setConfirm(null); }} className="rounded-md bg-danger px-2 py-1 font-medium text-white">Delete</button>
                <button onClick={() => setConfirm(null)} className="rounded-md bg-surface-hover px-2 py-1 text-muted">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirm(c.id)} title="Delete chat" aria-label="Delete chat" className="absolute inset-y-0 right-2 my-auto h-7 w-7 rounded-md text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"><Trash2 size={14} className="mx-auto" /></button>
            )}
          </div>
        ))}
      </div>

      {/* This project's background tasks only — not the global strip. */}
      {projectTasks.length > 0 && (
        <>
          <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Background tasks
          </h2>
          <div className="mt-3 space-y-2">
            {projectTasks.map((t) => (
              <button
                key={t.id}
                onClick={() => openProjectChat(t.chatId)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-accent"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                  <ToolGlyph tool={t.kind} size={14} className="text-muted" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{t.title}</p>
                  <p className="truncate text-[11px] text-muted">{t.summary}</p>
                </div>
                <StatusPill status={t.status} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Standing instructions Marigold follows in every chat in this project. */
function ProjectInstructions({ id }: { id: string }) {
  const [text, setText] = useState(() => projectInstructions(id));
  return (
    <div className="mt-5 rounded-xl border border-border bg-surface/50 p-3.5">
      <label htmlFor={`instr-${id}`} className="mb-1 block text-[12px] font-semibold">Instructions for this project</label>
      <p className="mb-2 text-[11.5px] text-muted">Marigold follows these in every chat here. Things like tone, language, a budget, or the files and people involved.</p>
      <textarea
        id={`instr-${id}`}
        value={text}
        onChange={(e) => { setText(e.target.value); saveProjectInstructions(id, e.target.value); }}
        rows={3}
        maxLength={4000}
        placeholder="For example: Keep answers short. My budget is $2,000 a month. Always compare at least three options."
        className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-muted/60 focus:border-accent"
      />
    </div>
  );
}

function EditableProjectHeader({ project }: { project: Project }) {
  const updateProject = useApp((s) => s.updateProject);
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // A brand-new (unnamed) project: focus the name field to prompt the user to name it.
  useEffect(() => {
    if (!project.name) nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Autosize the description to its content.
  useEffect(() => {
    const el = descRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [project.description, project.id]);

  return (
    <div>
      <input
        ref={nameRef}
        value={project.name}
        onChange={(e) => updateProject(project.id, { name: e.target.value })}
        onBlur={(e) => updateProject(project.id, { name: e.target.value.trim() })}
        placeholder="Name your project"
        spellCheck={false}
        className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-base font-semibold outline-none placeholder:text-muted/60 focus:bg-surface"
      />
      <textarea
        ref={descRef}
        value={project.description}
        onChange={(e) => updateProject(project.id, { description: e.target.value })}
        placeholder="Add a description…"
        rows={1}
        spellCheck={false}
        className="-mx-1.5 mt-0.5 w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded-md px-1.5 py-0.5 text-[13px] text-muted outline-none placeholder:text-muted/50 focus:bg-surface"
      />
    </div>
  );
}
