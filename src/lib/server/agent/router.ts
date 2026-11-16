import { Agent as UndiciAgent, fetch as ufetch } from "undici";

/**
 * Answer vs. action. Before the agent starts, decide what the user actually wants:
 *   answer — knowledge/maths/writing help ("what is 1+1") → the model answers directly. No tools.
 *   lookup — fresh facts from the internet ("the Warriors score") → a quick background web
 *            lookup, then the model answers from it. No tools, no browser window, no View.
 *   action — the user wants something DONE on their Mac/accounts, or about THEIR data
 *            ("text mom", "what's on my calendar", "suggest a trade for my fantasy team") → the agent.
 * Obvious cases are decided instantly by pattern; the rest by a tiny model call (~1–2 s).
 */

// ---------------------------------------------------------------- simple vs complex (instant, no AI)

const SIMPLE_START = /^(please\s+|can you\s+|could you\s+|hey marigold,?\s+)?(set (a |an )?(timer|alarm)|start (a )?timer|play|pause|resume|skip|next song|previous song|stop (the )?music|open|launch|quit|close|turn (on|off|up|down)|mute|unmute|(set|change) (the )?volume|volume|text|message|msg|call|facetime|remind me|add (a )?reminder|create (a )?(note|reminder)|make (a )?(note|reminder)|write (a )?note|lock|take a screenshot|screenshot|empty (the )?trash|(what('?s| is)|show me|check) (on )?my (calendar|schedule|reminders|battery)|what time is it in)\b/i;
const COMPLEX = /\b(and then|then|after that|also|website|web ?site|browser|online|\bsite\b|form|buy|order|purchase|book|checkout|sign ?(in|up)|log ?in|fantasy|trade|compare|research|summari[sz]e|email|e-mail|draft|meeting|invite|every|until|monitor|organi[sz]e|all (of )?my|each|both|for each|if )\b/i;
const SECOND_ACTION = /\b(and|,)\s+(then\s+)?(send|text|set|open|create|add|play|call|email|book|buy|delete|move|write|schedule)\b/i;

/** One clear single-app step ("set a timer", "text mom hi", "play Study")? → fast model. */
/** One-look questions about the user's own stuff — one tool call, no plan needed. */
const QUICK_LOOKUP = /^(do i have|have i got|what('?s| is| are)|what do i have|any|show me|list|when('?s| is))\b.{0,60}\b(reminders?|calendar|events?|meetings?|schedule|notes?|alarms?|timers?|battery|brightness|volume)\b/i;

export function isSimple(text: string): boolean {
  const t = text.trim();
  if (QUICK_LOOKUP.test(t) && t.length < 120) return true;
  if (!t || t.length > 160 || t.split(/[.!?]\s+/).filter(Boolean).length > 1) return false;
  return SIMPLE_START.test(t) && !COMPLEX.test(t) && !SECOND_ACTION.test(t);
}

export type Intent = { kind: "answer" } | { kind: "lookup"; query: string } | { kind: "action" };

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const ollama = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });

const ACTION_START = /^(please\s+|can you\s+|could you\s+|pls\s+|hey marigold,?\s+)?(send|text|message|msg|email|e-mail|reply|forward|call|facetime|ring|open|launch|close|quit|create|make|add|new|set|schedule|book|reserve|remind|play|pause|resume|skip|stop|delete|remove|trash|move|rename|copy|duplicate|zip|unzip|download|upload|buy|order|purchase|pay|post|tweet|share|turn|switch|enable|disable|mute|unmute|install|uninstall|update|run|start|go to|navigate|visit|log ?in|sign ?(in|up)|fill|submit|apply|cancel|accept|decline|invite|draft|write (a|an|me a|the)? ?(note|email|message|text|reminder|doc)|save|export|print|organize|clean|clear|sort|archive|mark|star|pin|join|leave|subscribe|unsubscribe|record|take|capture|screenshot|lock|restart|shut ?down|sleep|empty|check (my|on my|the status of my)|show me my|find (my|me my)|read (my|me my)|summari[sz]e (my|the (email|message|thread|chat))|look (at|through) my|suggest (a |some )?trades?|manage|edit|change|fix|update my|connect|pair|backup|sync)\b/i;
/** "At 2 pm text Mom…", "tomorrow at 8 email my teacher", "every weekday at 7 send me…": a timed request is always an action (schedule_task). */
const TIMED_ACTION = /\b(at \d{1,2}(:\d\d)?\s?(am|pm)?|tomorrow|tonight|this (morning|afternoon|evening)|every (day|weekday|week|morning|night|evening|mon|tue|wed|thu|fri|sat|sun)\w*|in \d+ ?(min|minutes|hour|hours|hrs))\b/i;
const TIMED_VERB = /\b(send|text|message|msg|email|call|remind|play|post|turn|open|set|create|add|schedule|tell|ask|reply|forward|pick|order|book)\b/i;
// "me" alone is NOT personal ("give me the NFL playoff picture", "tell me about Rome").
const PERSONAL = /\b(my|mine|our|i have|i've got)\b/i;
/** Reads like a request for information (not for something to be done). Used as the safe fallback when the router model is unsure or down. */
const INFO_START = /^(please\s+|can you\s+|could you\s+|hey marigold,?\s+)?(give me|tell me|show me|explain|describe|define|what('?s| is| are| was| were| does| do)|who('?s| is| are| was| won| wins)|when (is|are|was|did|does|do)|where (is|are|was|can i find)|why|how (do|does|did|many|much|long|far|old|big|tall|fast|is|are|can|to)|which|list (the|some)|compare|summari[sz]e|recommend|suggest|predict|project(ed)?|forecast|rank|top \d+|best|latest|current|news|score|standings|odds|weather)\b/i;
const PURE_MATH = /^[\s\d+\-*/^().,%x×÷=?]+$|^(what('?s| is)|calculate|compute)\s+[\d\s+\-*/^().,%x×÷]+\??$/i;
const FOLLOW_UP = /^(yes|yeah|yep|ok(ay)?|sure|do it|go ahead|send it|try again|continue|retry|again|go|confirm|that one|the (first|second|other) one|no,? (use|send|do))\b/i;

/** Things only a browser/agent can do: act on THIS page/site, sign in, fill/click/submit, touch the user's accounts, buy/book/send/post. */
const DOES_SOMETHING = /\b(click|press the|fill( it)? (out|in)|sign ?in|log ?in|submit|download|upload|open (a |the |that )?(tab|page|site|link|website|url)|go to|navigate|browse to|visit|add (it )?to (my |the )?(cart|calendar|list)|check ?out|book|buy|order|purchase|pay|schedule|send|post|reply|forward|unsubscribe|rsvp|apply (to|for)|register|sign up)\b/i;
/** Wanting a source, reference, idea, outline, explanation… — an LLM (or one quick web lookup) answers these; no browsing. */
/** Reads/changes the user's OWN stuff ("my project" alone is not this). */
const USER_DATA = /\b(my|our) (e-?mails?|inbox|calendar|schedule|reminders?|notes?|messages?|texts?|files?|folders?|downloads?|documents?|docs?|drive|photos?|contacts?|accounts?|orders?|cart|bank|battery|mac|computer|screen|tabs?|history|bookmarks?|grades?|classes|assignments?)\b(?!\s+(project|projects|class|essay|paper|report|homework|presentation|course|teacher|exam|test|quiz|assignment|lesson|unit|thesis|topic|subject))/i;
const KNOWLEDGE_ASK = /\b(sources?|citations?|cite|references?|bibliograph\w*|studies|study|papers?|journals?|articles? (on|about|for)|evidence|statistics|stats|quote|quotes|examples?|ideas?|brainstorm|outline|thesis|topic|summary of|summari[sz]e (the )?(book|article|topic|chapter)|explain|explanation|difference between|pros and cons|compare|recommend|suggest|how (do|does|did|to)|why|define|meaning of|essay|paragraph|rewrite|rephrase|proofread|translate|tips|advice|briefing|overview|deep dive|in-depth)\b/i;

const ROUTER_PROMPT = `You route requests for Marigold, an assistant that can (1) answer from its own knowledge, (2) look up fresh facts on the public internet, or (3) take ACTIONS on the user's Mac and accounts (apps, files, messages, email, calendar, browser tasks, their logged-in sites like fantasy sports, anything personal).
THE TEST: could a knowledgeable person answer this just by TALKING (from knowledge, or after one quick web search)? Then it is answer or lookup. Only choose action if the user needs something DONE for them in a browser, app or account (click, fill, sign in, send, buy, book, schedule, read THEIR data, work on the page they're on). "Find me a source/article/study for my project", "recommend a book", "give me ideas", "explain X", "what's a good way to cite…", "write/rewrite/proofread this" are NEVER action: the answer is the work, there is nothing to click. Do not open pages just to read them when a search result or your own knowledge answers it.
IMPORTANT: asking for information is NOT a task. "give me the projected NFL playoffs", "who's the best QB", "explain inflation", "top 10 pizza places in Chicago", "tell me about the Roman empire" are answer/lookup, never action. Choose action ONLY when the user wants something done to their Mac/accounts/apps or needs THEIR data. When unsure between lookup and action for a general-world question, choose lookup.
Reply with ONLY one line of JSON: {"intent":"answer"} or {"intent":"lookup","query":"<good web search query>"} or {"intent":"action"}.
- action: the user wants something DONE (send, open, create, schedule, buy, change, check/read THEIR data or accounts), or the request depends on their personal data/accounts, or continues an action from earlier in the chat.
- lookup: a question about the outside world whose answer can change or is too specific to know (live scores, today's news, prices, current events, opening hours, recent releases, "who won…").
- answer: general knowledge, maths, definitions, explanations, advice, writing/brainstorming help that needs nothing outside the conversation.`;

let routerModel = "gpt-oss:20b";
/** The router's tiny classification call uses the fast model when it's installed (keeps gpt-oss idle for simple stuff). */
export function setRouterModel(tag: string) { routerModel = tag; }
export const routerTag = () => routerModel;
/** "My favorite food is sushi", "I go to Monte Vista" — telling Marigold something, not asking for anything. */
export function isSelfStatement(text: string): boolean {
  const t = text.trim();
  if (!t || /\?/.test(t) || ACTION_START.test(t)) return false;
  if (/\b(can you|could you|please|help me|remind|tell me|show me|let me know)\b/i.test(t)) return false;
  return /\b(my [\w' ]{2,30} (is|are|was)|i (go to|attend|work|live|am|'m|have|like|love|hate|prefer|play|take|use)|i'm (a|an|in|allergic)|call me)\b/i.test(t);
}

export async function routeIntent(history: { role: string; content: string }[], signal?: AbortSignal): Promise<Intent> {
  const raw = [...history].reverse().find((m) => m.role === "user")?.content.trim() ?? "";
  const last = raw.replace(/\[attached:[^\]]*\]\s*/g, "").trim() || raw; // an attachment marker in front of the words must not hide what was asked
  if (!last) return { kind: "action" };
  if (ACTION_START.test(last)) return { kind: "action" };
  // Arranging the desktop (windows) is done with the desktop tool.
  if (/\b(tidy|arrange|organi[sz]e|clean ?up|line up|tile|lay ?out|snap)\b.{0,40}\b(my )?(desktop|windows?|apps|screen|workspace)\b|\b(desktop|windows?)\b.{0,30}\b(neat|tidy|messy|organi[sz]ed)\b/i.test(last)) return { kind: "action" };
  // Questions about the user's own spending (from the statements they added in Money) are answered by the finance tool.
  if (/\b(how much (did|have|do) i (spend|spent|pay|paid)|(my|our) (spending|expenses|subscriptions|budget|transactions|bank|credit card|card|money)|am i (over|under) budget|what (do|am) i (pay|paying) for|where (does|did) my money)\b/i.test(last)) return { kind: "action" };
  // The connected websites (GitHub, Notion, Linear, Todoist) have their own tools: those requests go to the agent, not a web lookup.
  if (/\b(github|notion|linear|todoist)\b/i.test(last) && /\b(my|list|show|find|search|open|create|add|file|read|check|issues?|prs?|pull requests?|tasks?|pages?|tickets?|repos?)\b/i.test(last)) return { kind: "action" };
  // Editing a video or audio file on this Mac (Video Studio).
  if (/\b(trim|cut|edit|speed up|slow down|caption|subtitle|remove (the )?(silence|pauses)|merge|combine|crop|reframe|vertical|compress|export|extract (the )?audio|transcribe)\b/i.test(last) && /\b(video|clip|footage|recording|podcast|mp4|mov|mkv|m4a|mp3|wav)\b/i.test(last)) return { kind: "action" };
  if (TIMED_ACTION.test(last) && TIMED_VERB.test(last)) return { kind: "action" };
  if (FOLLOW_UP.test(last) && history.length > 1) return { kind: "action" };
  if (PURE_MATH.test(last)) return { kind: "answer" };
  // "…using the Keynote app", "what can Rectangle do": about an installed app on THIS Mac → the agent (it can look the app up and drive it).
  if (/\b(the\s+)?[\w .+-]{2,30}\s+(app|application)\b|\bwhat (can|does)\b[^?]{0,40}\b(do|support|script)\b|\b(using|with|in|through)\s+(the\s+)?[A-Z][\w+-]+/.test(last)) {
    const { appsMentioned } = await import("./catalog");
    if ((await appsMentioned(last).catch(() => [])).length) return { kind: "action" };
  }
  // Questions about the page the user is on ("summarize this page", "what does this say about X") → answered from the page text, no browsing.
  if (/\b(this|the current|that) (page|site|website|article|tab|post|document|paper|video|recipe|product)\b/i.test(last) && !DOES_SOMETHING.test(last) && !USER_DATA.test(last)) return { kind: "answer" };
  // Asking for a source / idea / explanation with nothing to DO → never an agent run. Sources and "find me…" get one quick web lookup (real links).
  if (KNOWLEDGE_ASK.test(last) && !DOES_SOMETHING.test(last) && !USER_DATA.test(last) && !FOLLOW_UP.test(last)) {
    if (/\b(sources?|citations?|references?|articles?|studies|study|papers?|journals?|statistics|stats|evidence|news|latest|current|today|lately|recent(ly)?)\b/i.test(last) && !/\b(rewrite|rephrase|proofread|translate|this (essay|paragraph|text))\b/i.test(last)) {
      return { kind: "lookup", query: last.replace(/^(please\s+|can you\s+|could you\s+)?(find|get|give|show|send|help)\s+(me\s+)?(with\s+)?/i, "").replace(/\?+$/, "").trim() || last };
    }
    return { kind: "answer" };
  }
  // Questions about what's on THIS Mac ("what models do I have in ollama", "is Zoom installed",
  // "what version of node am I on") need a tool, not the model's memory.
  if (/\b(do i have|have i got|i have installed|are installed|is .{2,40} installed|installed on|am i (running|on|using)|on (my|this) (mac|computer|laptop|machine))\b/i.test(last)) return { kind: "action" };
  if (PERSONAL.test(last)) {
    const { appsMentioned, catalog } = await import("./catalog");
    const cli = (await catalog().catch(() => ({ cli: [] as string[] }))).cli;
    const low = ` ${last.toLowerCase().replace(/[^a-z0-9.\s-]/g, " ")} `;
    if (cli.some((c) => low.includes(` ${c} `)) || (await appsMentioned(last).catch(() => [])).length) return { kind: "action" };
  }

  try {
    const recent = history.slice(-5).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 400)}`).join("\n");
    // Cloud "always" mode: route with the strong model (small call); local otherwise or if it fails.
    const { cloudAll, cloudJson } = await import("./cloud");
    const viaCloud = (await cloudAll()) ? await cloudJson(ROUTER_PROMPT, `Conversation:\n${recent}\n\nRoute the LAST user message.`, signal, { tier: "light", maxTokens: 120 }) : "";
    const res = viaCloud ? null : await ufetch(`${OLLAMA_URL}/api/chat`, {
      dispatcher: ollama,
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: routerModel,
        stream: false,
        think: routerModel.startsWith("qwen3") ? false : "low",
        keep_alive: "60m",
        format: "json",
        options: { temperature: 0, num_ctx: 16384, num_predict: 300 },
        messages: [{ role: "system", content: ROUTER_PROMPT }, { role: "user", content: `Conversation:\n${recent}\n\nRoute the LAST user message.` }],
      }),
    });
    const j = (res ? await res.json() : { message: { content: viaCloud } }) as { message?: { content?: string } };
    const parsed = JSON.parse(j.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { intent?: string; query?: string };
    if (parsed.intent === "answer") return PERSONAL.test(last) && /\b(my|our|do i|i have|am i)\b/i.test(last) ? { kind: "action" } : { kind: "answer" };
    // Questions about THEIR Mac/data ("what macOS am I running", "do I have…") need the agent, not the web.
    if (parsed.intent === "lookup" && /\b(my|mine|am i|do i|have i|did i|i'm|i am|on this mac|this computer)\b/i.test(last)) return { kind: "action" };
    if (parsed.intent === "lookup") {
      // The router model's memory is old: drop years it added that the user didn't type ("2023 NBA champion").
      const typed = new Set(last.match(/\b(19|20)\d\d\b/g) ?? []);
      const q = (parsed.query?.trim() || last).replace(/\b(19|20)\d\d\b/g, (y) => (typed.has(y) ? y : "")).replace(/\s+/g, " ").trim();
      return { kind: "lookup", query: q || last };
    }
    // The model said "action", but nothing in the message asks for anything to be DONE and it isn't about the user's own stuff → it's a question.
    if (parsed.intent === "action" && !ACTION_START.test(last) && !DOES_SOMETHING.test(last) && !TIMED_ACTION.test(last) && !USER_DATA.test(last) && !(history.length > 1 && FOLLOW_UP.test(last)) && INFO_START.test(last)) return { kind: "lookup", query: last };
    // Unknown/garbled verdict: a plain information request is still not a task.
    return INFO_START.test(last) && !PERSONAL.test(last) ? { kind: "lookup", query: last } : { kind: "action" };
  } catch {
    // Router model down/slow: information requests still go the light way; everything else gets the agent.
    return INFO_START.test(last) && !PERSONAL.test(last) ? { kind: "lookup", query: last } : { kind: "action" };
  }
}


// ---------------------------------------------------------------- planner (complex tasks)

/**
 * For anything beyond one simple step: think first. A short, concrete plan — which app,
 * which command, what info is needed and WHERE it comes from, how to check it worked —
 * so the user doesn't have to spell out the reasoning ("open marks, pick my school…").
 */
export async function makePlan(task: string, tools: string, facts: string, signal?: AbortSignal, cloud = false): Promise<string> {
  try {
    if (cloud) {
      const { cloudText } = await import("./cloud");
      const p = await cloudText(planPrompt(tools, facts), task, signal).catch(() => "");
      if (p) return p.slice(0, 1500);
    }
    const res = await ufetch(`${OLLAMA_URL}/api/chat`, {
      dispatcher: ollama,
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-oss:20b", stream: false, think: "medium", keep_alive: "60m",
        options: { temperature: 0.3, num_ctx: 16384, num_predict: 1200 },
        messages: [
          { role: "system", content: planPrompt(tools, facts) },
          { role: "user", content: task },
        ],
      }),
    });
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? "").trim().slice(0, 1500);
  } catch { return ""; }
}


// ---------------------------------------------------------------- skills (obvious commands → the right tool, no AI choice)

export interface Skill { tool: string; args: Record<string, unknown> }

/** Common commands the small/local model kept fumbling — recognised by pattern, executed directly. */
export function matchSkill(text: string): Skill | null {
  const t = text.trim().replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;
  // "add Fix You by Coldplay to my Study playlist" / "…to the playlist Guitar" / "add this song to Guitar"
  if ((m = t.match(/^(?:please\s+)?add\s+(.+?)\s+to\s+(?:my\s+|the\s+|a\s+(?:new\s+)?)?(?:playlist\s+(?:called\s+|named\s+)?)?["“]?(.+?)["”]?(?:\s+playlist)?$/i))) {
    const song = /^(this|this song|the current song|what'?s playing|the song)$/i.test(m[1]) ? "current" : m[1];
    if (!/\b(calendar|reminder|note|list|cart|contacts?)\b/i.test(m[2])) return { tool: "music", args: { action: "add_to_playlist", query: song, playlist: m[2] } };
  }
  if ((m = t.match(/^(?:please\s+)?play\s+(?:my\s+)?(.+?)\s+playlist$/i))) return { tool: "music", args: { action: "play_playlist", query: m[1] } };
  if ((m = t.match(/^(?:please\s+)?(pause|stop)(?: the)? music$/i))) return { tool: "music", args: { action: "pause" } };
  // "Which version of node do I have?" → just ask the tool (read-only, instant).
  if ((m = t.match(/^(?:which|what)(?:'s| is)? (?:the )?version of ([a-z][\w.+-]{0,30})(?: do i have| is installed| am i (?:on|running))?\??$/i)))
    return { tool: "run_shell", args: { command: `${m[1].toLowerCase()} --version` } };
  // Screen brightness — exact numbers or relative steps, no model arithmetic.
  if ((m = t.match(/^(?:please\s+)?(?:set|change|put|turn)\s+(?:my\s+|the\s+)?(?:screen\s+|display\s+)?brightness\s+(?:to|at)\s+(\d{1,3})\s*(?:%|percent)?$/i)))
    return { tool: "system", args: { action: "set_brightness", level: Math.min(100, Number(m[1])) } };
  if (/^(?:please\s+)?(?:(?:make|turn)\s+(?:my\s+|the\s+)?(?:screen|display)\s+(?:a\s+(?:bit|little)\s+|slightly\s+)?(?:dimmer|darker|down)|dim\s+(?:my\s+|the\s+)?(?:screen|display)|(?:turn|lower)\s+(?:down\s+)?(?:my\s+|the\s+)?brightness(?:\s+down)?|brightness\s+down)$/i.test(t))
    return { tool: "system", args: { action: "brightness_down" } };
  if (/^(?:please\s+)?(?:(?:make|turn)\s+(?:my\s+|the\s+)?(?:screen|display)\s+(?:a\s+(?:bit|little)\s+|slightly\s+)?(?:brighter|up)|(?:turn|raise)\s+(?:up\s+)?(?:my\s+|the\s+)?brightness(?:\s+up)?|brightness\s+up)$/i.test(t))
    return { tool: "system", args: { action: "brightness_up" } };
  if ((m = t.match(/^(?:please\s+)?set\s+(?:my\s+|the\s+)?volume\s+to\s+(\d{1,3})\s*(?:%|percent)?$/i)))
    return { tool: "system", args: { action: "set_volume", level: Math.min(100, Number(m[1])) } };
  if (/^(?:please\s+)?(mute|unmute)(?:\s+(?:my\s+|the\s+)?(?:mac|sound|volume|audio))?$/i.test(t))
    return { tool: "system", args: { action: t.toLowerCase().replace(/^please\s+/, "").startsWith("un") ? "unmute" : "mute" } };
  if ((m = t.match(/^(?:please\s+)?(?:set|start) (?:a )?timer for (\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?)(?: (?:called|named|for) (.+))?$/i))) {
    const n = Number(m[1]);
    const mins = /^s/i.test(m[2]) ? n / 60 : /^h/i.test(m[2]) ? n * 60 : n;
    return { tool: "clock", args: { action: "set_timer", minutes: mins, ...(m[3] ? { label: m[3] } : {}) } };
  }
  return null;
}

function planPrompt(tools: string, facts: string): string {
  return `You plan tasks for Marigold, an agent that operates the user's Mac through tools. It works in installed apps (incl. iPhone/iPad apps on the Mac) via app_ui, built-in tools, files and terminal, and on WEBSITES via web_browser (the Marigold Browser, built in, with the user's logins) ONLY to do things there; to look up or read information it uses web_search and web_fetch.
TOOLS: ${tools}
${facts || "No saved facts about the user yet."}
ALWAYS prefer a dedicated tool action when one exists (e.g. music add_to_playlist, reminders add, calendar create_event) — use app_ui (clicking an app's buttons) only when no dedicated tool can do it.
Pick the app from APPS INSTALLED ON THIS MAC: if an installed app is made for the job (grades → an Education app like marks; notes → Notes; video call → zoom.us/FaceTime), USE IT — don't plan a website or a web search for something an installed app does.
ORDER OF PREFERENCE: (1) a dedicated tool (notes create, reminders add, music, calendar, messages, mail, clock, system for brightness/volume/wifi/dark mode, files, run_shell for command-line work) — if one covers the job the plan is just that call, no app_ui; (2) app_ui in the installed app; (3) the website with web_browser (open_url → elements → click/type …) ONLY when the job is acting on a site (their own account, a form, a purchase); to find or read information plan web_search then web_fetch, never web_browser.
Only when using app_ui: step 1 is ALWAYS open it and look at its screen (app_ui open → elements / screen_text) — plan the rest from what's actually there, never from guesses.
Sign-ins: NEVER ask for, store or type passwords. Look at the app's sign-in screen: use "Sign in with Google"/school/SSO options when offered, choose the user's school/account from ABOUT THE USER or their emails, fill in non-secret fields you know (username/email), then hand over: tell the user to type their password in the app themselves. Only ask the user for non-secret info you truly can't find (e.g. which school) — and remember it.
Write a SHORT numbered plan (max 7 steps). For each step: the tool + exact action (e.g. "app_ui open marks", "app_ui find_command 'rectangle'", "app_ui elements → click 'Sign in'"). Say what info each step needs and where it comes from (ABOUT THE USER facts, memory recall, person_info, the app's own screen) — only "ask the user" if nothing else can have it, and never for things you can look up. Passwords: the user types them. End with how to verify it worked. No preamble.`;
}
