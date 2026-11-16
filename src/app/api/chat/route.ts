import type { NextRequest } from "next/server";
import type { ChatMsg } from "@/lib/ollama";
import { startTask, subscribe } from "@/lib/server/agent/tasks";
import { localOnly } from "@/lib/server/agent/guard";
import type { ModelId } from "@/lib/types";
import type { ModelChoice } from "@/lib/models";

interface ChatRequest {
  messages: ChatMsg[];
  model?: ModelChoice; // "auto" | "agent" | "llama" | "qwen"
  /** Per-user personalization (name/timezone/tone) appended to the system prompt. */
  persona?: string;
  /** Chat this run belongs to (for the background-tasks strip). */
  chatId?: string;
}

/** The project folder for coding mode: must be a real folder inside the user's home, never a secrets folder. */
async function codingRoot(v: unknown): Promise<string | undefined> {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const { expandPath, sensitivePath } = await import("@/lib/server/agent/policy");
  const { promises: fs } = await import("fs");
  const os = await import("os");
  const p = expandPath(v.trim());
  if (!p.startsWith(os.homedir() + "/") || sensitivePath(p) || p === os.homedir()) return undefined;
  return (await fs.stat(p).then((s) => s.isDirectory(), () => false)) ? p : undefined;
}

export async function POST(req: NextRequest) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Apps the user picked from the app dock arrive as [Notes](app://Notes) links. The agent sees plain names, and for
  // the newest message an explicit instruction to work in exactly those apps.
  const APP_LINK = /\[([^\]]+)\]\(app:\/\/([^)]+)\)/g;
  const decode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  const raw = (body.messages ?? []).filter((m) => m.content?.trim());
  const lastIdx = raw.map((m) => m.role).lastIndexOf("user");
  let picked: string[] = [];
  const messages = raw.map((m, i) => {
    if (m.role !== "user" || !m.content.includes("app://")) return m;
    const here: string[] = [];
    const text = m.content.replace(APP_LINK, (_x, _label, id) => { here.push(decode(id)); return ""; }).replace(/\s{2,}/g, " ").trim();
    if (i === lastIdx) picked = [...new Set(here)];
    return { ...m, content: text || m.content };
  });
  if (messages.length === 0) {
    return Response.json({ error: "No messages" }, { status: 400 });
  }
  if (picked.length) {
    const names = picked.length === 1 ? `the ${picked[0]} app` : `the ${picked.slice(0, -1).join(", ")} and ${picked.at(-1)} apps`;
    const i = messages.findIndex((m, idx) => idx === lastIdx);
    if (i >= 0) messages[i] = { ...messages[i], content: `Use ${names} for this (I picked ${picked.length === 1 ? "it" : "them"} from my app dock, so work in exactly ${picked.length === 1 ? "that app" : "those apps"}, not another app or a website): ${messages[i].content}` };
  }

  // Files attached with the + button arrive as [name](att://id) links. The agent gets what was READ from them
  // (kept apart from the user's own words) and, when a cloud vision model is on, the pictures themselves.
  const ATT_LINK = /\[([^\]]+)\]\(att:\/\/([a-f0-9]{12})\)/g;
  const attIds: string[] = [];
  const shotIds = new Set<string>(); // the assistant's "picture of the page": context only, never part of the request's words
  for (const [i, m] of messages.entries()) {
    if (m.role !== "user" || !m.content.includes("att://")) continue;
    messages[i] = { ...m, content: m.content.replace(ATT_LINK, (_x, label: string, id: string) => {
      if (i === lastIdx) attIds.push(id);
      if (label === "Page screenshot") { if (i === lastIdx) shotIds.add(id); return ""; } // (a marker in front of the request used to hide it from the router: "complete this assignment" stopped being an action)
      return `[attached: ${label}]`;
    }).replace(/\s{2,}/g, " ").trim() };
  }
  if (attIds.length) {
    const { getUpload, describeAttachment, imageDataUrl } = await import("@/lib/server/agent/attachments");
    const atts = (await Promise.all([...new Set(attIds)].slice(0, 8).map((id) => getUpload(id)))).filter((a): a is NonNullable<typeof a> => !!a);
    if (atts.length) {
      const files = atts.filter((a) => !shotIds.has(a.id));
      const described = await Promise.all(files.map((a) => describeAttachment(a)));
      const { cloudForPlans } = await import("@/lib/server/agent/cloud");
      const imgs = (await cloudForPlans().catch(() => false)) ? (await Promise.all(atts.filter((a) => a.kind === "image").slice(0, 4).map((a) => imageDataUrl(a)))).filter((u): u is string => !!u) : [];
      messages[lastIdx] = {
        ...messages[lastIdx],
        attachmentsContext: [
          shotIds.size ? "[A screenshot of the page the user is on, taken as they asked, is attached for reference (layout, charts, images). It does NOT replace working in the page: if the task needs scrolling, clicking through several pages, or opening other pages, do that with web_browser (it opens other pages in a background tab) and use action=screenshot whenever you need to see a page.]" : "",
          files.length ? `[The user attached ${files.length} file${files.length > 1 ? "s" : ""}. What was read from ${files.length > 1 ? "them" : "it"} on this Mac${imgs.length ? " (the picture itself is also in this message)" : ""}:\n${described.join("\n\n")}\nThe files stay at the paths shown if you need to open, move, copy or upload them.]` : "",
        ].filter(Boolean).join("\n"),
        ...(imgs.length ? { cloudImages: imgs } : {}),
      } as (typeof messages)[number];
    }
  }

  const override = body.model;
  // Auto → the agent model (gpt-oss:20b, Mixture-of-Experts).
  const chosen: ModelId = override && override !== "auto" ? override : "agent";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  // The run is a background task: it keeps going if this request closes.
  const task = startTask({
    chatId: typeof body.chatId === "string" ? body.chatId : "unknown",
    title: (lastUser?.content ?? "Task").replace(/^Use (?:the .+? apps?) for this \(I picked[^)]*\): /, ""),
    model: chosen,
    history: messages,
    persona: typeof body.persona === "string" ? body.persona : undefined,
    auto: !override || override === "auto",
    browserCurrent: (body as { browserCurrent?: boolean }).browserCurrent === true,
    browserMode: (body as { browserMode?: boolean }).browserMode === true,
    coding: await codingRoot((body as { coding?: unknown }).coding),
    pageContext: typeof (body as { context?: unknown }).context === "string" ? String((body as { context?: string }).context).slice(0, 9000) : undefined,
  });

  return new Response(subscribe(task, req.signal), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Marigold-Task": task.id,
    },
  });
}
