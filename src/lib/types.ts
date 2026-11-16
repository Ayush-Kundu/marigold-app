/**
 * Domain models for the agent app.
 *
 * These are the contract between the UI and the (currently mocked) data/agent
 * layer. When the real backend + open-source model are wired in, they return
 * these same shapes so the UI doesn't change.
 */

export type ID = string;

/** The two local models Marigold can route between. */
/** Local models. "agent" = gpt-oss:20b (MoE), the default; "llama"/"qwen" are legacy ids that now route to it. */
export type ModelId = "agent" | "llama" | "qwen";

/** How Marigold should speak to the user — set during onboarding. */
export type AgentTone = "concise" | "friendly" | "formal";

export interface User {
  id: ID;
  name: string;
  email: string;
  avatarUrl?: string;
  /** IANA timezone, e.g. "America/New_York" — used for scheduling & times. */
  timezone?: string;
  /** Preferred conversational tone, fed into the agent's system prompt. */
  tone?: AgentTone;
  /** Other emails the user wants Marigold to know (school, work…). `email` stays the primary. */
  extraEmails?: string[];
}

export type MessageRole = "user" | "agent" | "system";

export interface Message {
  id: ID;
  role: MessageRole;
  content: string;
  createdAt: string; // ISO
  /** Optional structured action the agent took or proposes to take. */
  action?: AgentActionSummary;
  /** Which model produced this reply (agent messages only). */
  model?: ModelId;
  /** True while this agent message is still streaming in. */
  streaming?: boolean;
  /** Tool actions the agent took (or is waiting on approval for) this turn. */
  steps?: AgentStep[];
}

/** One tool action inside an agent turn, as decided by the safety policy. */
export interface AgentStep {
  id: ID;
  tool: string;
  /** Human summary of exactly what this does. */
  title: string;
  /** Raw script/command, shown for transparency. */
  detail?: string;
  /** 0 read · 1 reversible · 2 consequential · 3 financial */
  tier: 0 | 1 | 2 | 3;
  status: "running" | "awaiting" | "done" | "declined" | "blocked" | "error";
  result?: string;
  approval?: { scope: string; rememberable: boolean; reason: string };
}

export interface AgentActionSummary {
  label: string; // e.g. "Drafted an email to Alex"
  tool: ToolKind;
  /** If true, the action needs the user's confirmation before executing. */
  needsConfirmation?: boolean;
  status?: "proposed" | "confirmed" | "done" | "declined";
}

export interface Chat {
  id: ID;
  title: string;
  projectId?: ID;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
}

export interface Project {
  id: ID;
  name: string;
  description: string;
  /** Tailwind-ish accent token used for the project glyph. */
  color: string;
  chatIds: ID[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "needs_input"
  | "done"
  | "failed";

export type ToolKind =
  | "email"
  | "calendar"
  | "money"
  | "browser"
  | "docs"
  | "search"
  | "files"
  | "message";

export interface BackgroundTask {
  id: ID;
  title: string;
  kind: ToolKind;
  status: TaskStatus;
  /** 0–100 */
  progress: number;
  summary: string;
  startedAt: string;
  updatedAt: string;
  /** The chat this task was created from — clicking the task opens it. */
  chatId: ID;
  /** If the agent is actively working this task, the live run to watch in View. */
  runId?: ID;
}

// ---------------------------------------------------------------------------
// Live agent run (the "View" tab, Comet-style)
// ---------------------------------------------------------------------------

export type AgentEventType =
  | "thinking"
  | "tool_call"
  | "browse"
  | "write"
  | "awaiting_confirmation"
  | "done"
  | "error";

export interface AgentEvent {
  id: ID;
  type: AgentEventType;
  /** One-line description shown in the activity timeline. */
  title: string;
  detail?: string;
  tool?: ToolKind;
  /** e.g. a URL being browsed, or the app being used. */
  target?: string;
  createdAt: string;
}

export type RunStatus = "running" | "paused" | "awaiting_confirmation" | "done" | "error";

/** What the agent is currently showing on the canvas (browser page, draft, etc). */
export interface CanvasPreview {
  kind: "browser" | "email" | "document" | "spreadsheet" | "none";
  title: string;
  /** Rendered content for the preview (plain text / pseudo-HTML for the mock). */
  body: string;
  url?: string;
}

export interface AgentRun {
  id: ID;
  goal: string;
  status: RunStatus;
  events: AgentEvent[];
  canvas: CanvasPreview;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Capabilities (used by onboarding + "what can you do" surfaces)
// ---------------------------------------------------------------------------

export interface Capability {
  id: ID;
  tool: ToolKind;
  title: string;
  example: string; // a ready-to-run suggested prompt
}
