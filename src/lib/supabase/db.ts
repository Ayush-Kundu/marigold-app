import { getSupabase } from "./client";
import type {
  BackgroundTask,
  Chat,
  Message,
  ModelId,
  Project,
  TaskStatus,
  ToolKind,
} from "../types";

/**
 * Supabase data-access layer.
 *
 * Pure functions that read/write the user's workspace. Every row is scoped to
 * the signed-in user by row-level security, so queries never need an explicit
 * user filter on reads — but writes still set user_id because RLS checks it.
 *
 * Mapping convention: DB columns are snake_case; domain types are camelCase.
 */

// --- Row shapes (what Supabase returns) ------------------------------------

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  color: string;
  created_at: string;
  updated_at: string;
}

interface ChatRow {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  chat_id: string;
  user_id: string;
  role: Message["role"];
  content: string;
  model: ModelId | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  title: string;
  kind: string;
  status: string;
  progress: number;
  summary: string;
  created_at: string;
  updated_at: string;
}

// --- Mapping ---------------------------------------------------------------

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    ...(r.model ? { model: r.model } : {}),
  };
}

function toTask(r: TaskRow): BackgroundTask {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as ToolKind,
    status: r.status as TaskStatus,
    progress: r.progress,
    summary: r.summary,
    startedAt: r.created_at,
    updatedAt: r.updated_at,
    chatId: r.chat_id ?? "",
  };
}

// --- Read ------------------------------------------------------------------

export interface Workspace {
  projects: Project[];
  chats: Chat[];
  tasks: BackgroundTask[];
}

/**
 * Load everything the signed-in user owns in a few round-trips, then assemble
 * the nested domain shapes the UI expects (chats carry their messages;
 * projects carry their chat ids).
 */
export async function loadWorkspace(): Promise<Workspace> {
  const sb = getSupabase();
  if (!sb) return { projects: [], chats: [], tasks: [] };

  const [projectsRes, chatsRes, messagesRes, tasksRes] = await Promise.all([
    sb.from("projects").select("*").order("updated_at", { ascending: false }),
    sb.from("chats").select("*").order("updated_at", { ascending: false }),
    sb.from("messages").select("*").order("created_at", { ascending: true }),
    sb.from("background_tasks").select("*").order("updated_at", { ascending: false }),
  ]);

  const firstError =
    projectsRes.error || chatsRes.error || messagesRes.error || tasksRes.error;
  if (firstError) throw firstError;

  const projectRows = (projectsRes.data ?? []) as ProjectRow[];
  const chatRows = (chatsRes.data ?? []) as ChatRow[];
  const messageRows = (messagesRes.data ?? []) as MessageRow[];
  const taskRows = (tasksRes.data ?? []) as TaskRow[];

  // Group messages by chat (preserving the created_at ordering from the query).
  const messagesByChat = new Map<string, Message[]>();
  for (const row of messageRows) {
    const list = messagesByChat.get(row.chat_id) ?? [];
    list.push(toMessage(row));
    messagesByChat.set(row.chat_id, list);
  }

  const chats: Chat[] = chatRows.map((r) => ({
    id: r.id,
    title: r.title,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    messages: messagesByChat.get(r.id) ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pinned: r.pinned,
  }));

  // Group chat ids by project (chats are already newest-first).
  const chatIdsByProject = new Map<string, string[]>();
  for (const r of chatRows) {
    if (!r.project_id) continue;
    const list = chatIdsByProject.get(r.project_id) ?? [];
    list.push(r.id);
    chatIdsByProject.set(r.project_id, list);
  }

  const projects: Project[] = projectRows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    chatIds: chatIdsByProject.get(r.id) ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return { projects, chats, tasks: taskRows.map(toTask) };
}

// --- Write -----------------------------------------------------------------
//
// All writes take the owning userId explicitly (RLS requires user_id to match
// auth.uid()). They throw on error; callers persist fire-and-forget and log.

export async function upsertChat(
  userId: string,
  chat: Pick<Chat, "id" | "title" | "pinned" | "projectId" | "createdAt" | "updatedAt">,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("chats").upsert({
    id: chat.id,
    user_id: userId,
    project_id: chat.projectId ?? null,
    title: chat.title,
    pinned: chat.pinned ?? false,
    created_at: chat.createdAt,
    updated_at: chat.updatedAt,
  });
  if (error) throw error;
}

export async function touchChat(
  id: string,
  patch: { title?: string; pinned?: boolean; updatedAt: string },
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const row: Record<string, unknown> = { updated_at: patch.updatedAt };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.pinned !== undefined) row.pinned = patch.pinned;
  const { error } = await sb.from("chats").update(row).eq("id", id);
  if (error) throw error;
}

export async function deleteChat(id: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("chats").delete().eq("id", id);
  if (error) throw error;
}

export async function insertMessage(
  userId: string,
  chatId: string,
  msg: Message,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("messages").insert({
    id: msg.id,
    chat_id: chatId,
    user_id: userId,
    role: msg.role,
    content: msg.content,
    // Older schemas only allow llama/qwen here; the model badge is gone anyway.
    model: msg.model === "llama" || msg.model === "qwen" ? msg.model : null,
    created_at: msg.createdAt,
  });
  if (error) throw error;
}

export async function deleteProject(id: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const chats = await sb.from("chats").delete().eq("project_id", id); // the foreign key would only unlink them
  if (chats.error) throw chats.error;
  const { error } = await sb.from("projects").delete().eq("id", id);
  if (error) throw error;
}

export async function upsertProject(
  userId: string,
  project: Pick<Project, "id" | "name" | "description" | "color" | "createdAt" | "updatedAt">,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("projects").upsert({
    id: project.id,
    user_id: userId,
    name: project.name,
    description: project.description,
    color: project.color,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  });
  if (error) throw error;
}
