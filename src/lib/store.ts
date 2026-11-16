import { isAux } from "./aux";
import { create } from "zustand";
import { streamAgent } from "./agent";
import {
  mockChats,
  mockProjects,
  mockRun,
  mockUser,
} from "./mock-data";
import type {
  AgentEvent,
  AgentStep,
  AgentRun,
  BackgroundTask,
  Chat,
  Message,
  ModelId,
  Project,
  User,
} from "./types";
import type { ModelChoice } from "./models";
import { isSupabaseConfigured } from "./supabase/client";
import {
  deleteAccount as sbDeleteAccount,
  signOut as sbSignOut,
  subscribeAuth,
  updateProfile as sbUpdateProfile,
} from "./supabase/auth";
import {
  deleteChat as deleteChatRow,
  deleteProject as deleteProjectRow,
  insertMessage,
  loadWorkspace as fetchWorkspace,
  touchChat,
  upsertChat,
  upsertProject,
} from "./supabase/db";

export type Tab = "chats" | "projects" | "browser";
/** Send to a specific chat, with page context for the model (not shown in the chat). */
export interface SendOpts { chatId?: string; context?: string; browserCurrent?: boolean }
export type StripSize = "sm" | "md";

const PREF_KEY = "instinct-ui-prefs";

/** Standing instructions the user wrote for a project ("always answer in Spanish", "my budget is $2k"). Kept on this Mac. */
const INSTR_KEY = "marigold.projectInstructions";
const readInstructions = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(INSTR_KEY) ?? "{}"); } catch { return {}; } };
export const projectInstructions = (id?: string | null): string => (id ? readInstructions()[id] ?? "" : "");
export function saveProjectInstructions(id: string, text: string) {
  try {
    const all = readInstructions();
    if (text.trim()) all[id] = text.slice(0, 4000); else delete all[id];
    localStorage.setItem(INSTR_KEY, JSON.stringify(all));
  } catch { /* storage off */ }
}
const MIN_W = 220;
const MAX_W = 420;
const clampW = (w: number) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));

interface AppState {
  user: User;
  chats: Chat[];
  projects: Project[];
  tasks: BackgroundTask[];
  run: AgentRun;

  // Auth / persistence
  userId: string | null;
  /** True when Supabase is configured AND a user is signed in (writes persist). */
  backed: boolean;
  /** False until the initial session check completes (gates the shell). */
  authResolved: boolean;
  /** Guards initAuth against React's double-effect in dev. */
  _authInited: boolean;

  activeTab: Tab;
  activeChatId: string | null;
  activeProjectId: string | null;
  /** When true, the Projects tab shows a chat conversation instead of the project home. */
  projectChatOpen: boolean;
  sidebarOpen: boolean; // mobile drawer
  sending: boolean;
  /** True while the composer is focused — pauses the marigold's idle twirl. */
  composerActive: boolean;
  /** Apps picked from the app dock for the next message (the agent is told to use exactly these). */
  /** The app dock beside the chat is tucked away (remembered). */
  dockHidden: boolean;
  setDockHidden: (v: boolean) => void;
  /** Marigold reads each finished reply aloud (the summary only), with an open-source voice on this Mac. */
  speakReplies: boolean;
  setSpeakReplies: (v: boolean) => void;
  chosenApps: string[];
  setChosenApps: (names: string[]) => void;
  toggleChosenApp: (name: string) => void;
  clearChosenApps: () => void;

  // Layout preferences (persisted)
  sidebarCollapsed: boolean;
  /** Slid away for the Browser tab (comes back when leaving it); not a saved preference. */
  sidebarAutoHidden: boolean;
  setSidebarAutoHidden: (v: boolean) => void;
  /** Until when the sidebar slide runs (ms) — the Browser shows a still picture meanwhile. */
  layoutAnimUntil: number;
  /** Menus open over the browser page (it shows a still picture so they aren't hidden behind it). */
  browserOverlay: number;
  setBrowserOverlay: (delta: number) => void;
  sidebarWidth: number;
  stripVisible: boolean;
  stripSize: StripSize;

  // Which model to use: "auto" routes by prompt, or force llama/qwen.
  modelOverride: ModelChoice;

  initAuth: () => void;
  loadWorkspace: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<{ error?: string }>;
  setProfile: (patch: Partial<Pick<User, "name" | "timezone" | "tone">>) => void;
  saveProfile: (
    patch: Partial<Pick<User, "name" | "timezone" | "tone" | "extraEmails">>,
  ) => Promise<{ error?: string }>;

  setTab: (tab: Tab) => void;
  selectChat: (id: string) => void;
  selectProject: (id: string) => void;
  togglePinChat: (id: string) => void;
  deleteChat: (id: string) => void;
  /** Deletes the project and every chat in it. */
  deleteProject: (id: string) => void;
  newChat: (projectId?: string) => void;
  newProject: () => void;
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "description">>) => void;
  newProjectChat: () => void;
  openProjectChat: (chatId: string) => void;
  backToProjectHome: () => void;
  sendUserMessage: (text: string, opts?: SendOpts) => Promise<void>;
  /** The Browser tab's assistant conversation (a normal chat, also listed under Chats). */
  /** Each browser tab's assistant conversation (normal chats, also listed under Chats). */
  browserChats: Record<number, string>;
  sendBrowserMessage: (text: string, page: { title: string; url: string; text?: string } | null, tabId: number) => Promise<void>;
  setModelOverride: (m: ModelChoice) => void;
  setComposerActive: (active: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  addRunEvent: (event: AgentEvent) => void;

  hydratePrefs: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setStripVisible: (v: boolean) => void;
  setStripSize: (s: StripSize) => void;

  /** Full screen: the current page fills the browser window (sidebar + top bar hidden). */
  fullWindow: boolean;
  /** Side-by-side view: the Marigold window shrinks to a chat strip beside the app the agent is using. */
  sideView: boolean;
  /** Voice conversation is on: replies are written to be spoken. */
  voiceTalk: boolean;
  /** Coding mode: the project folder (null = off). */
  codeRoot: string | null;
  codeRecent: string[];
  setCodeRoot: (p: string | null) => void;
  setVoiceTalk: (v: boolean) => void;
  setSideView: (v: boolean) => void;
  setFullWindow: (v: boolean) => void;
  /** Apps currently shown in the View tab (drives the top bar's "Open app"). */
  /** The agent's live-view panel (slides in from the right while it works in apps). */
  agentPanelOpen: boolean;
  setAgentPanelOpen: (v: boolean) => void;
  viewApps: string[];
  setViewApps: (apps: string[]) => void;
  /** App expanded to fill the whole Marigold page from the View ("Open app"); Esc returns. */


  /** Live background tasks from the local agent server. */
  agentTasks: AgentTaskInfo[];
  syncAgentTasks: () => Promise<void>;
  /** Dismiss a finished (green) background task. */
  acknowledgeTask: (id: string) => Promise<void>;
}

interface MonitorInfo {
  paused?: boolean;
  id: string;
  chatId: string;
  goal: string;
  everyMinutes: number;
  status: AgentTaskInfo["status"];
  checks: number;
  lastResult?: string;
  createdAt: string;
  updatedAt: string;
  pending: AgentStep[];
  checking?: boolean;
  /** Set for "do it at this time" tasks: they sleep until `at` (no polling). */
  scheduled?: { at: string; repeat: string; runs: number };
  outbox?: { id: string; at: string; text: string; kind: "update" | "done" | "failed" }[];
}

export interface AgentTaskInfo {
  id: string;
  chatId: string;
  title: string;
  status: "running" | "needs_input" | "done" | "failed" | "stopped";
  summary: string;
  startedAt: string;
  updatedAt: string;
  pending: AgentStep[];
  stepCount: number;
  /** "chat" = a run answering a chat message; "monitor" = recurring background task. */
  kind?: "chat" | "monitor";
  /** Chat runs: answer/lookup = quick reply (no agent working); action = agent at work. */
  mode?: "answer" | "lookup" | "action";
  /** Monitor only: a check is running this moment. */
  checking?: boolean;
  /** Paused by the user (holds between steps until resumed). */
  paused?: boolean;
}

const TASK_STATUS: Record<AgentTaskInfo["status"], BackgroundTask["status"]> = {
  running: "running",
  needs_input: "needs_input",
  done: "done",
  failed: "failed",
  stopped: "failed",
};

/** DB rows use real UUIDs, so every client-created id is a UUID too. */
const uid = () => crypto.randomUUID();

/** Fire-and-forget a persistence write; a failure logs but never breaks the UI. */
function persist(fn: () => Promise<unknown>) {
  fn().catch((e) => console.warn("[marigold] persistence error:", e));
}

/** Added while the user talks out loud: the reply is read aloud, so it must sound like a person, not a document. */
const VOICE_STYLE = "VOICE CONVERSATION: the user is talking to you out loud and your reply is spoken by a natural voice. Be a warm, quick-witted person in a real conversation, not an assistant reading a document. Keep it to one to three short, natural sentences, and make the FIRST sentence short (a few words) so speech can start right away. React like a human: a little surprise, warmth, empathy or humor when it fits. You may use these sound tags, sparingly and only where a person really would: [laugh] [chuckle] [sigh] [gasp] [clear throat]; and natural spoken touches like 'hmm,' 'oh,' 'well,' 'okay so...'. Use commas and ellipses for beats and pauses. Never use markdown, lists, links, code or emoji. Answer directly. When you do something, say what you did in one sentence. If there is a lot of detail, give the gist and say the rest is on their screen.";

/** A short personalization preamble appended to the model's system prompt. */
function personaFor(user: User): string | undefined {
  const parts: string[] = [];
  if (user.name) {
    const first = user.name.trim().split(/\s+/)[0];
    parts.push(
      `The user's name is ${first}. Don't open replies with it or greet them; use it only occasionally where a person naturally would. Never call them "User".`,
    );
  }
  if (user.timezone) {
    parts.push(`The user's timezone is ${user.timezone}; treat all dates and times as local to it.`);
  }
  if (user.tone === "concise") parts.push("Keep replies brief and to the point.");
  else if (user.tone === "friendly") parts.push("Relaxed and friendly, never gushing.");
  else if (user.tone === "formal") parts.push("Keep a professional, formal tone.");
  return parts.length ? parts.join(" ") : undefined;
}

/** True while an agent is actively working the current run (drives View's visibility). */
export function isRunActive(run: AgentRun): boolean {
  return run.status !== "done" && run.status !== "error";
}

export const useApp = create<AppState>((set, get) => {
  /** The owning user id when writes should persist, else null (mock mode). */
  const owner = () => (get().backed ? get().userId : null);

  /** Switch the store into a signed-in user's workspace. */
  const enter = async (u: User) => {
    set({ user: u, userId: u.id, backed: true });
    await get().loadWorkspace();
  };

  /** Drop back to the signed-out state (clears the user's data from memory). */
  const exit = () => {
    set({
      user: mockUser,
      userId: null,
      backed: false,
      chats: [],
      projects: [],
      tasks: [],
      activeChatId: null,
      activeProjectId: null,
      projectChatOpen: false,
    });
  };

  return {
    user: mockUser,
    chats: mockChats,
    projects: mockProjects,
    tasks: [],
    run: mockRun,

    userId: null,
    backed: false,
    authResolved: false,
    _authInited: false,

    activeTab: "chats",
    activeChatId: mockChats[0]?.id ?? null,
    activeProjectId: mockProjects[0]?.id ?? null,
    projectChatOpen: false,
    sidebarOpen: false,
    sending: false,
    composerActive: false,
    dockHidden: (() => { try { return typeof window !== "undefined" && localStorage.getItem("marigold.dockHidden") === "1"; } catch { return false; } })(),
    setDockHidden: (v) => { try { localStorage.setItem("marigold.dockHidden", v ? "1" : "0"); } catch { /* private mode */ } set({ dockHidden: v, layoutAnimUntil: Date.now() + 340 }); },
    speakReplies: (() => { try { return typeof window !== "undefined" && localStorage.getItem("marigold.speakReplies") === "1"; } catch { return false; } })(),
    setSpeakReplies: (v) => { try { localStorage.setItem("marigold.speakReplies", v ? "1" : "0"); } catch { /* private mode */ } set({ speakReplies: v }); },
    chosenApps: [],
    toggleChosenApp: (name) => set((s) => ({ chosenApps: s.chosenApps.includes(name) ? s.chosenApps.filter((n) => n !== name) : [...s.chosenApps, name] })),
    clearChosenApps: () => set({ chosenApps: [] }),
    setChosenApps: (names) => set({ chosenApps: [...new Set(names)].slice(0, 6) }),

    sidebarCollapsed: false,
    sidebarAutoHidden: false,
    layoutAnimUntil: 0,
    browserOverlay: 0,
    setBrowserOverlay: (delta) => set((s) => ({ browserOverlay: Math.max(0, s.browserOverlay + delta) })),
    setSidebarAutoHidden: (v) => set((s) => (s.sidebarAutoHidden === v ? {} : { sidebarAutoHidden: v, layoutAnimUntil: Date.now() + 340 })),
    sidebarWidth: 260,
    stripVisible: true,
    fullWindow: false,
    sideView: false,
    voiceTalk: false,
    codeRoot: (() => { try { return typeof window !== "undefined" ? localStorage.getItem("marigold.codeRoot") : null; } catch { return null; } })(),
    codeRecent: (() => { try { return typeof window !== "undefined" ? (JSON.parse(localStorage.getItem("marigold.codeRecent") ?? "[]") as string[]) : []; } catch { return []; } })(),
    setCodeRoot: (p) => {
      const recent = p ? [p, ...get().codeRecent.filter((x) => x !== p)].slice(0, 6) : get().codeRecent;
      try { if (p) localStorage.setItem("marigold.codeRoot", p); else localStorage.removeItem("marigold.codeRoot"); localStorage.setItem("marigold.codeRecent", JSON.stringify(recent)); } catch { /* storage off */ }
      set({ codeRoot: p, codeRecent: recent });
    },
    setVoiceTalk: (v) => set({ voiceTalk: v }),
    setSideView: (v) => set({ sideView: v }),
    setFullWindow: (v) => set({ fullWindow: v }),
    agentPanelOpen: false,
    setAgentPanelOpen: (v) => set((s) => (s.agentPanelOpen === v ? {} : { agentPanelOpen: v, layoutAnimUntil: Date.now() + 340 })),
    viewApps: [],
    setViewApps: (apps) => set((s) => (s.viewApps.join("|") === apps.join("|") ? {} : { viewApps: apps })),
    stripSize: "md",

    modelOverride: "auto",

    // --- Auth / persistence -------------------------------------------------

    initAuth: () => {
      if (get()._authInited) return;
      set({ _authInited: true });

      // No backend configured → stay on the in-memory mock store.
      if (!isSupabaseConfigured) {
        set({ authResolved: true });
        return;
      }

      // Let Supabase drive the initial state. onAuthStateChange fires once on
      // setup (INITIAL_SESSION) AFTER it has parsed any session token from the
      // URL — so we mark auth "resolved" from that first event rather than a
      // separate getUser() call, which could race the magic-link redirect and
      // bounce the user to /login before the token is read.
      subscribeAuth((u) => {
        if (u) {
          // Only re-enter if the user actually changed (avoids reloading on
          // token refresh events for the same user).
          if (get().userId !== u.id) void enter(u);
        } else if (get().userId) {
          exit();
        }
        if (!get().authResolved) set({ authResolved: true });
      });
    },

    loadWorkspace: async () => {
      try {
        const ws = await fetchWorkspace();
        void import("./agent").then((m) => m.syncHistory(ws.chats)).catch(() => {});
        set((s) => ({
          projects: ws.projects,
          chats: ws.chats,
          activeChatId: ws.chats[0]?.id ?? null,
          activeProjectId: ws.projects[0]?.id ?? s.activeProjectId,
        }));
      } catch (e) {
        console.warn("[marigold] workspace load failed:", e);
      }
    },

    signOut: async () => {
      try {
        await sbSignOut();
      } finally {
        exit();
      }
    },

    deleteAccount: async () => {
      const res = await sbDeleteAccount();
      if (!res.error) exit();
      return res;
    },

    setProfile: (patch) => set((s) => ({ user: { ...s.user, ...patch } })),

    saveProfile: async (patch) => {
      // Update the in-memory user immediately so the UI (and persona) reflect it.
      set((s) => ({ user: { ...s.user, ...patch } }));
      if (!owner()) return {};
      const res = await sbUpdateProfile(patch);
      if (res.error) console.warn("[marigold] profile save failed:", res.error);
      return res;
    },

    // --- Navigation ---------------------------------------------------------

    setTab: (tab) => set((s) => {
      if (tab === "browser" && isAux()) return {}; // the Browser lives in the main window
      // The Browser and Apps tabs use the whole window: the chat list tucks away while they're open.
      const auto = tab === "browser" ? (s.activeTab === tab ? s.sidebarAutoHidden : true) : false;
      const slides = !s.sidebarCollapsed && auto !== s.sidebarAutoHidden;
      return { activeTab: tab, sidebarAutoHidden: auto, ...(slides ? { layoutAnimUntil: Date.now() + 340 } : {}) };
    }),

    selectChat: (id) =>
      set({ activeChatId: id, activeTab: "chats", projectChatOpen: false, sidebarOpen: false }),

    selectProject: (id) =>
      set({ activeProjectId: id, activeTab: "projects", projectChatOpen: false, sidebarOpen: false }),

    // --- Chats --------------------------------------------------------------

    togglePinChat: (id) => {
      set((s) => ({
        chats: s.chats.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
      }));
      const uidv = owner();
      const chat = get().chats.find((c) => c.id === id);
      if (uidv && chat) {
        persist(() => touchChat(id, { pinned: chat.pinned ?? false, updatedAt: chat.updatedAt }));
      }
    },

    deleteChat: (id) => {
      set((s) => {
        const chats = s.chats.filter((c) => c.id !== id);
        const projects = s.projects.map((p) =>
          p.chatIds.includes(id) ? { ...p, chatIds: p.chatIds.filter((x) => x !== id) } : p,
        );
        const wasActive = s.activeChatId === id;
        return {
          chats,
          projects,
          activeChatId: wasActive ? (chats[0]?.id ?? null) : s.activeChatId,
          // If we were viewing this chat inside a project, return to the project home.
          projectChatOpen: wasActive ? false : s.projectChatOpen,
        };
      });
      if (owner()) persist(() => deleteChatRow(id));
    },

    deleteProject: (id) => {
      set((s) => {
        const chats = s.chats.filter((c) => c.projectId !== id);
        const projects = s.projects.filter((p) => p.id !== id);
        const activeGone = s.activeProjectId === id;
        const chatGone = !chats.some((c) => c.id === s.activeChatId);
        return {
          chats,
          projects,
          activeProjectId: activeGone ? (projects[0]?.id ?? null) : s.activeProjectId,
          activeChatId: chatGone ? (chats[0]?.id ?? null) : s.activeChatId,
          projectChatOpen: activeGone ? false : s.projectChatOpen,
        };
      });
      saveProjectInstructions(id, "");
      if (owner()) persist(() => deleteProjectRow(id));
    },

    newChat: (projectId) => {
      const now = new Date().toISOString();
      const chat: Chat = {
        id: uid(),
        title: "New chat",
        projectId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({
        chats: [chat, ...s.chats],
        activeChatId: chat.id,
        activeTab: "chats",
        projectChatOpen: false,
        sidebarOpen: false,
      }));
      const uidv = owner();
      if (uidv) persist(() => upsertChat(uidv, chat));
    },

    // --- Projects -----------------------------------------------------------

    newProject: () => {
      const palette = ["#6c5ce7", "#16a34a", "#d97706", "#0ea5e9", "#db2777", "#dc2626"];
      const now = new Date().toISOString();
      const project: Project = {
        id: uid(),
        name: "",
        description: "",
        color: palette[get().projects.length % palette.length],
        chatIds: [],
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({
        projects: [project, ...s.projects],
        activeProjectId: project.id,
        activeTab: "projects",
        projectChatOpen: false,
        sidebarOpen: false,
      }));
      const uidv = owner();
      if (uidv) persist(() => upsertProject(uidv, project));
    },

    updateProject: (id, patch) => {
      const now = new Date().toISOString();
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, ...patch, updatedAt: now } : p,
        ),
      }));
      const uidv = owner();
      const project = get().projects.find((p) => p.id === id);
      if (uidv && project) persist(() => upsertProject(uidv, project));
    },

    // Create a chat inside the active project and open it WITHIN the Projects tab.
    newProjectChat: () => {
      const projectId = get().activeProjectId ?? undefined;
      const now = new Date().toISOString();
      const chat: Chat = {
        id: uid(),
        title: "New chat",
        projectId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({
        chats: [chat, ...s.chats],
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, chatIds: [chat.id, ...p.chatIds], updatedAt: now } : p,
        ),
        activeChatId: chat.id,
        activeTab: "projects",
        projectChatOpen: true,
        sidebarOpen: false,
      }));
      const uidv = owner();
      if (uidv) persist(() => upsertChat(uidv, chat));
    },

    openProjectChat: (chatId) =>
      set({ activeChatId: chatId, activeTab: "projects", projectChatOpen: true, sidebarOpen: false }),

    backToProjectHome: () => set({ projectChatOpen: false }),

    // --- Sending ------------------------------------------------------------

    browserChats: {},
    sendBrowserMessage: async (text, page, tabId) => {
      let id = get().browserChats[tabId];
      if (!id || !get().chats.some((c) => c.id === id)) {
        const now = new Date().toISOString();
        const chat: Chat = { id: uid(), title: "Browser", messages: [], createdAt: now, updatedAt: now };
        set((s) => ({ chats: [chat, ...s.chats], browserChats: { ...s.browserChats, [tabId]: chat.id } }));
        const uidv = owner();
        if (uidv) persist(() => upsertChat(uidv, chat));
        id = chat.id;
      }
      const on = page?.url && !/^about:/.test(page.url);
      const context = on
        ? `[Browser: the user is looking at “${page!.title}” — ${page!.url}]${page!.text ? `\n[Text of that page (may be cut):\n${page!.text.slice(0, 7000)}\n]` : ""}`
        : "[Browser: the user is in the Marigold Browser]";
      await get().sendUserMessage(text, { chatId: id, context, browserCurrent: true });
    },

    sendUserMessage: async (text, opts) => {
      const trimmed = text.trim();
      if (!trimmed || get().sending) return;
      let chatId = opts?.chatId ?? get().activeChatId;

      // Start a fresh chat if none is active.
      if (!chatId) {
        get().newChat();
        chatId = get().activeChatId;
      }

      const userMsg: Message = {
        id: uid(),
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      const agentId = uid();
      const agentMsg: Message = {
        id: agentId,
        role: "agent",
        content: "",
        createdAt: new Date().toISOString(),
        streaming: true,
      };

      // Add the user message + an empty agent placeholder to stream into.
      set((s) => ({
        sending: true,
        chats: s.chats.map((c) =>
          c.id === chatId
            ? {
                ...c,
                title: c.messages.length === 0 ? titleFrom(trimmed) : c.title,
                messages: [...c.messages, userMsg, agentMsg],
                updatedAt: new Date().toISOString(),
              }
            : c,
        ),
      }));

      // Persist the chat (in case it's brand new) + the user's message.
      const uidv = owner();
      if (uidv) {
        const chat = get().chats.find((c) => c.id === chatId);
        if (chat) {
          persist(async () => {
            await upsertChat(uidv, chat);
            await insertMessage(uidv, chat.id, userMsg);
          });
        }
      }

      // Build the conversation history for the model (exclude the empty placeholder).
      const chat = get().chats.find((c) => c.id === chatId);
      const history = (chat?.messages ?? [])
        .filter((m) => m.id !== agentId && m.content.trim())
        .map((m) => ({
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          content: m.content,
        }));

      const patch = (fields: Partial<Message>) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === agentId ? { ...m, ...fields } : m,
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : c,
          ),
        }));

      try {
        const note = projectInstructions(get().chats.find((c) => c.id === chatId)?.projectId);
        const persona = [personaFor(get().user), get().voiceTalk ? VOICE_STYLE : "", note ? `PROJECT INSTRUCTIONS (the user wrote these for this project; follow them in every reply here):\n${note}` : ""].filter(Boolean).join("\n") || undefined;
        await streamAgent(history, get().modelOverride, {
          onMeta: (model) => patch({ model }),
          onStep: (step) =>
            set((s) => ({
              chats: s.chats.map((c) =>
                c.id === chatId
                  ? {
                      ...c,
                      messages: c.messages.map((m) => {
                        if (m.id !== agentId) return m;
                        const steps = m.steps ?? [];
                        const i = steps.findIndex((x) => x.id === step.id);
                        return {
                          ...m,
                          steps: i < 0 ? [...steps, step] : steps.map((x, j) => (j === i ? step : x)),
                        };
                      }),
                    }
                  : c,
              ),
            })),
          onToken: (token) =>
            set((s) => ({
              chats: s.chats.map((c) =>
                c.id === chatId
                  ? {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.id === agentId ? { ...m, content: m.content + token } : m,
                      ),
                    }
                  : c,
              ),
            })),
        }, undefined, persona, chatId ?? undefined, opts?.browserCurrent, opts?.context, opts?.browserCurrent ? undefined : get().codeRoot ?? undefined);
        patch({ streaming: false });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        patch({
          streaming: false,
          content: `⚠️ Couldn't get a reply from the model.\n\n${detail}\n\nIf this mentions a connection, make sure Ollama is running (\`ollama serve\`). Otherwise it's likely a server/route error — check the dev server logs.`,
        });
      } finally {
        set({ sending: false });
        // Persist the agent's final message + bump the chat's title/timestamp.
        if (uidv && chatId) {
          const persistId = chatId;
          const finalChat = get().chats.find((c) => c.id === persistId);
          const finalMsg = finalChat?.messages.find((m) => m.id === agentId);
          if (finalChat && finalMsg) {
            const { streaming, ...msg } = finalMsg;
            void streaming;
            persist(async () => {
              await insertMessage(uidv, persistId, msg);
              await touchChat(persistId, {
                title: finalChat.title,
                updatedAt: new Date().toISOString(),
              });
            });
          }
        }
      }
    },

    setModelOverride: (m) => set({ modelOverride: m }),

    setComposerActive: (active) => set({ composerActive: active }),

    setSidebarOpen: (open) => set({ sidebarOpen: open }),

    addRunEvent: (event) =>
      set((s) => ({ run: { ...s.run, events: [...s.run.events, event] } })),

    hydratePrefs: () => {
      try {
        const raw = localStorage.getItem(PREF_KEY);
        if (!raw) return;
        const p = JSON.parse(raw);
        set({
          sidebarCollapsed: !!p.sidebarCollapsed,
          sidebarWidth: clampW(p.sidebarWidth ?? 260),
          stripVisible: p.stripVisible !== false,
          stripSize: p.stripSize === "sm" ? "sm" : "md",
        });
      } catch {
        /* ignore corrupt prefs */
      }
    },

    setSidebarCollapsed: (v) => {
      set((s) => ({ sidebarCollapsed: v, ...(s.sidebarCollapsed !== v ? { layoutAnimUntil: Date.now() + 340 } : {}) }));
      persistPrefs(get);
    },
    setSidebarWidth: (w) => {
      set({ sidebarWidth: clampW(w) });
      persistPrefs(get);
    },
    setStripVisible: (v) => {
      set({ stripVisible: v });
      persistPrefs(get);
    },
    setStripSize: (s) => {
      set({ stripSize: s });
      persistPrefs(get);
    },

    agentTasks: [],
    acknowledgeTask: async (id) => {
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
      await fetch(`/api/agent/tasks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ack" }),
      }).catch(() => {});
    },
    syncAgentTasks: async () => {
      try {
        const res = await fetch("/api/agent/tasks");
        if (!res.ok) return;
        const { tasks, monitors } = (await res.json()) as { tasks: AgentTaskInfo[]; monitors: MonitorInfo[] };
        // Background tasks = recurring watchers only. Chat runs stay in the chat.
        // A paused background task is still "running" (scheduled), just on hold.
        for (const m of monitors) if ((m.status as string) === "paused") { m.status = "running"; m.paused = true; }
        // A background task found something → say so in its chat (not just a notification).
        for (const m of monitors) if (m.outbox?.length && !draining.has(m.id)) {
          draining.add(m.id);
          void fetch(`/api/agent/tasks/${m.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "drain" }) })
            .then((r) => r.json()).then((j: { results?: NonNullable<MonitorInfo["outbox"]> }) => {
              const label = m.goal.split("\n")[0].slice(0, 80);
              for (const o of j.results ?? []) {
                const msg: Message = { id: uid(), role: "agent", createdAt: o.at, content: `**Background task${o.kind === "failed" ? " stopped" : o.kind === "done" ? " finished" : ""}: ${label}**\n\n${o.text}` };
                set((s) => ({ chats: s.chats.map((c) => (c.id === m.chatId ? { ...c, messages: [...c.messages, msg], updatedAt: o.at } : c)) }));
                const uidv = owner();
                if (uidv) persist(async () => { await insertMessage(uidv, m.chatId, msg); await touchChat(m.chatId, { title: get().chats.find((c) => c.id === m.chatId)?.title ?? "", updatedAt: o.at }); });
              }
            }).catch(() => {}).finally(() => draining.delete(m.id));
        }
        const monitorApprovals: AgentTaskInfo[] = monitors.map((m) => ({
          id: m.id, chatId: m.chatId, title: m.goal, status: m.status, summary: m.lastResult ?? "",
          startedAt: m.createdAt, updatedAt: m.updatedAt, pending: m.pending, stepCount: m.checks,
          kind: "monitor", checking: m.checking, paused: m.paused,
        }));
        set({
          agentTasks: [...tasks.map((t) => ({ ...t, kind: "chat" as const })), ...monitorApprovals],
          tasks: monitors.map((m) => ({
            id: m.id,
            title: m.scheduled ? `${whenLabel(m.scheduled.at)} · ${m.goal.split("\n")[0].slice(0, 60)}` : m.goal,
            kind: m.scheduled ? "calendar" : "search",
            status: TASK_STATUS[m.status],
            progress: m.status === "done" ? 100 : 0,
            summary:
              m.status === "needs_input" ? `Needs you: ${m.pending[0]?.title ?? "approval"}`
              : m.scheduled ? (m.status === "running" && m.checking ? "Running now…" : `Runs ${whenLabel(m.scheduled.at)}${m.scheduled.repeat !== "none" ? ` (${m.scheduled.repeat})` : ""}${m.lastResult ? ` · Last: ${m.lastResult}` : ""}`)
              : m.lastResult ? m.lastResult
              : `Checking every ${m.everyMinutes} min…`,
            startedAt: m.createdAt,
            updatedAt: m.updatedAt,
            chatId: m.chatId,
          })),
        });
      } catch {
        /* agent server unreachable — keep current state */
      }
    },
  };
});

const draining = new Set<string>();

/** "Today 2:00 PM", "Tomorrow 8:00 AM", "Fri 7:00 AM". */
function whenLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = d.toDateString() === now.toDateString() ? "Today" : d.toDateString() === new Date(now.getTime() + 86_400_000).toDateString() ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function persistPrefs(get: () => AppState) {
  const { sidebarCollapsed, sidebarWidth, stripVisible, stripSize } = get();
  try {
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ sidebarCollapsed, sidebarWidth, stripVisible, stripSize }),
    );
  } catch {
    /* ignore quota / unavailable storage */
  }
}

export const cleanTitle = (t: string) => t.replace(/\[([^\]]+)\]\((?:app|att):\/\/[^)]*\)\s*/g, "").replace(/^Use (?:the .+? apps?) for this \(I picked[^)]*\):\s*/, "").trim();

function titleFrom(text: string): string {
  const t = cleanTitle(text);
  return t.length <= 40 ? t : t.slice(0, 40).trimEnd() + "…";
}

/** The run working in this chat right now (if any) — drives Pause / Resume / Stop. */
export function useChatRun(chatId: string | null | undefined): AgentTaskInfo | undefined {
  return useApp((s) => (chatId ? s.agentTasks.find((t) => t.chatId === chatId && (t.status === "running" || t.status === "needs_input") && t.kind !== "monitor") : undefined));
}
