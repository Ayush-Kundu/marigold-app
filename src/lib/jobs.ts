/**
 * Job toolsets: for each kind of work a person does on a Mac, the apps they use for it and how Marigold should work in them.
 * Shared by the server (it adds the playbook to the agent's instructions when you pick those apps or ask for that kind of work)
 * and by the screen (Workspaces: open a job's apps together, laid out beside the chat).
 */
export interface Job {
  id: string;
  label: string;
  blurb: string;
  /** Apps for this job in order of preference; any that are installed count. "@browser" is the browser the user uses most. */
  apps: string[];
  /** Words in a request that suggest this job. */
  words: RegExp;
  /** How to work: tools to prefer, what to check, how to finish. Short and specific. */
  playbook: string;
  /** Ready-made things to ask. */
  prompts: string[];
}

const J = (j: Job): Job => j;

export const JOBS: Job[] = [
  J({ id: "code", label: "Software development", blurb: "Write, run and fix code", apps: ["Visual Studio Code", "Cursor", "Xcode", "Zed", "Terminal", "iTerm", "Warp", "GitHub Desktop", "Docker"], words: /\b(code|coding|bug|function|repo|commit|build|compile|deploy|refactor|unit test|pull request|stack trace|npm|python|swift|javascript|typescript)\b/i,
    playbook: "Coding: use coding mode when a project folder is chosen (code_read/code_search/code_edit/code_run, tests before and after). Otherwise run_shell for commands and the editor tool to open files at a line. Read before editing, make small edits, run the tests or the build, and report what failed. Never push, force-push or delete without asking. Ask before installing packages.",
    prompts: ["Find why the tests are failing and fix it", "Add a feature to this project and write tests for it", "Explain what this codebase does"] }),
  J({ id: "write", label: "Writing & documents", blurb: "Draft, edit and format documents", apps: ["Pages", "Microsoft Word", "TextEdit", "Notion", "Obsidian", "Bear", "Ulysses", "iA Writer"], words: /\b(essay|report|draft|document|letter|memo|proposal|article|blog post|rewrite|proofread|outline|resume|cover letter)\b/i,
    playbook: "Writing: produce complete, specific, well-organised work with real details, not filler. For a document the user keeps, create it (Pages/Word/Google Docs/Notion) with headings and real formatting, then give the link or path. Match the length and tone asked for. Proofread before finishing. Never invent quotes, statistics or sources.",
    prompts: ["Write a five page report on this topic", "Proofread this document and fix the mistakes", "Turn these notes into a polished memo"] }),
  J({ id: "notes", label: "Note-taking & meetings", blurb: "Capture, organise and act on notes", apps: ["Notes", "Obsidian", "Notion", "Bear", "Craft", "Evernote", "OneNote", "Zoom", "zoom.us"], words: /\b(notes|meeting|minutes|action items|agenda|summari[sz]e (the )?(call|meeting)|follow[- ]ups?)\b/i,
    playbook: "Notes and meetings: the Meeting notes button takes notes on a call and turns them into tasks. For existing notes, search and read them first, then summarise or reorganise without deleting anything (deleted notes go to Recently Deleted). Turn decisions into reminders, calendar events or emails, asking before anything is sent to others.",
    prompts: ["Summarise my notes from this week", "Turn these notes into an action list and set reminders", "Make a study guide from my notes"] }),
  J({ id: "sheets", label: "Spreadsheets & finance", blurb: "Analyse numbers and build models", apps: ["Numbers", "Microsoft Excel", "Google Sheets", "QuickBooks", "Quicken"], words: /\b(spreadsheet|excel|numbers app|formula|pivot|budget|forecast|revenue|expenses|invoice|cash flow|chart)\b/i,
    playbook: "Spreadsheets: check the data first (headers, blanks, units), keep the original sheet and work on a copy for big changes, use real formulas rather than pasted values, label columns, and say what each number means. Money actions (payments, transfers) are never done without the user's Touch ID.",
    prompts: ["Build a monthly budget from these transactions", "Clean up this sheet and add a summary chart", "What does this spreadsheet tell me?"] }),
  J({ id: "slides", label: "Presentations", blurb: "Beautiful slide decks", apps: ["Keynote", "Microsoft PowerPoint", "Google Slides", "Canva"], words: /\b(slides?|presentation|deck|keynote|powerpoint|pitch)\b/i,
    playbook: "Presentations: write one idea per slide with a short title and 3 or fewer lines, add a relevant picture where it helps, use a consistent theme, put detail in speaker notes, and end with a clear takeaway. Check every slide before saying it is done and give the link or file.",
    prompts: ["Create a ten slide presentation about this topic", "Turn this document into a pitch deck", "Add speaker notes to every slide"] }),
  J({ id: "video", label: "Video editing", blurb: "Cut, arrange and export video", apps: ["Final Cut Pro", "iMovie", "DaVinci Resolve", "Adobe Premiere Pro", "CapCut", "Descript"], words: /\b(video edit|edit (the |a )?video|timeline|clip|b-roll|footage|export (the )?video|trim|subtitles?|captions?)\b/i,
    playbook: "Video editing: for files, use video_edit (ffmpeg + Whisper): probe, look at frames, transcribe, then PROPOSE the cuts in words and times, wait for the user's changes, render a preview, then the final. Every result is a new file; never touch the original. Editing apps (Final Cut, DaVinci, Premiere, CapCut) can only be driven through menus and shortcuts (app_ui), one edit at a time, checking the screen after each.",
    prompts: ["Trim the dead air from the start of this clip", "Export this project for YouTube", "Add captions to this video"] }),
  J({ id: "photo", label: "Photo editing", blurb: "Retouch and organise pictures", apps: ["Photos", "Pixelmator Pro", "Adobe Photoshop", "Affinity Photo", "Adobe Lightroom", "Preview"], words: /\b(photo edit|retouch|crop|resize image|remove (the )?background|color grade|lightroom|photoshop|batch (resize|export))\b/i,
    playbook: "Photo editing: work on a copy, never the original. Photos has scripting for albums and exports; Preview handles quick crops and resizing; the other apps work through menus and shortcuts (app_ui). Describe what changed, and keep the original beside the result.",
    prompts: ["Resize these photos for a website", "Remove the background from this picture", "Make an album of this weekend's photos"] }),
  J({ id: "design", label: "Design", blurb: "Interfaces, graphics and brand", apps: ["Figma", "Sketch", "Adobe Illustrator", "Affinity Designer", "Canva", "Pixelmator Pro"], words: /\b(design|mockup|wireframe|logo|brand|icon set|ui kit|prototype)\b/i,
    playbook: "Design: ask for or find the brief first (audience, size, brand colours), then work in the app through its menus and shortcuts. Keep layers named, keep an untouched original, and export in the formats asked for. Take a screenshot to check the result before saying it is done.",
    prompts: ["Export all the icons in this file as PNG", "Create a social post from this brand kit", "Review this design for consistency"] }),
  J({ id: "audio", label: "Music & audio production", blurb: "Record, mix and master", apps: ["Logic Pro", "GarageBand", "Ableton Live", "Audacity", "Pro Tools", "FL Studio"], words: /\b(mix|master|record(ing)?|track|beat|podcast edit|stems?|midi|sample)\b/i,
    playbook: "Audio: these apps are driven through menus and shortcuts (app_ui). Never record over or delete takes; bounce or export copies. Open the project, check levels and the arrangement on screen before each change.",
    prompts: ["Export this song as MP3 and WAV", "Clean up the background noise in this recording", "Set up a new podcast project"] }),
  J({ id: "mail", label: "Email & messaging", blurb: "Read, draft and reply", apps: ["Mail", "Microsoft Outlook", "Messages", "Slack", "Discord", "Microsoft Teams", "Spark"], words: /\b(email|inbox|reply|unsubscribe|draft a (message|reply)|text (him|her|them)|slack message)\b/i,
    playbook: "Email and messages: read first, draft second, send only after the user approves. Recipients come from the user's words or Contacts, never guessed. Keep replies short and in the user's voice. Summarise long threads before drafting.",
    prompts: ["Summarise my unread email and flag what needs me", "Draft a polite reply to this", "Find the email about my flight"] }),
  J({ id: "calendar", label: "Calendar & tasks", blurb: "Plan the day and keep on top of tasks", apps: ["Calendar", "Reminders", "Fantastical", "Things", "Todoist", "OmniFocus"], words: /\b(calendar|schedule|appointment|remind me|to-?do|task list|deadline|plan my (day|week))\b/i,
    playbook: "Calendar and tasks: check the calendar for conflicts before adding anything, include time zone and location, put deadlines in as reminders with times, and say exactly what was created. Ask before inviting other people.",
    prompts: ["Plan my week around my deadlines", "Find a free hour tomorrow and book focus time", "Turn this list into reminders"] }),
  J({ id: "pm", label: "Project management", blurb: "Tickets, boards and roadmaps", apps: ["Linear", "Jira", "Asana", "Trello", "Notion", "ClickUp", "Things"], words: /\b(ticket|sprint|backlog|roadmap|kanban|jira|linear|asana|trello|issue tracker)\b/i,
    playbook: "Project management: use the connected tools first (GitHub, Linear, Notion, Todoist in Settings → Connections) before the website. Read the current state, propose the change, then make it. Say which tickets or cards changed. Ask before closing, deleting or notifying people.",
    prompts: ["What is assigned to me and what is due soon?", "Turn these notes into tickets", "Write this week's status update"] }),
  J({ id: "research", label: "Research & study", blurb: "Find, read and cite sources", apps: ["@browser", "Preview", "Books", "Zotero", "Notes", "Pages"], words: /\b(research|sources?|literature|cite|citation|bibliography|study guide|flashcards?|thesis)\b/i,
    playbook: "Research: search first, read at least three sources, cross-check numbers and dates, and quote nothing you have not seen. Say which claims are well supported and which are uncertain. Give links. For video links use the video tool (transcript only; you cannot see the picture).",
    prompts: ["Find three good sources on this topic", "Summarise this paper in plain English", "Make flashcards from these notes"] }),
  J({ id: "data", label: "Data analysis", blurb: "Explore data and build charts", apps: ["Visual Studio Code", "Terminal", "Numbers", "Microsoft Excel", "RStudio", "Jupyter"], words: /\b(dataset|csv|pandas|regression|dashboard|data analysis|plot|statistics|sql query)\b/i,
    playbook: "Data: look at the data's shape first (columns, missing values, units), do the analysis in a script (run_shell or coding mode) so it can be re-run, save charts as files, and state the finding in one sentence before the detail. Never overwrite the original data file.",
    prompts: ["Analyse this CSV and tell me what stands out", "Plot sales by month and save it", "Clean this dataset and explain what you changed"] }),
  J({ id: "3d", label: "3D, CAD & animation", blurb: "Model, render and animate", apps: ["Blender", "Fusion 360", "AutoCAD", "SketchUp", "Cinema 4D", "Maya"], words: /\b(3d model|render|cad|blender|animation rig|mesh|sketchup)\b/i,
    playbook: "3D: these apps are driven through menus and shortcuts (app_ui) and Blender also through its Python console. Save a new version before big changes, never overwrite the only copy, and check the viewport on screen after each step.",
    prompts: ["Export this model as STL", "Render this scene at 1080p", "Set up a basic turntable animation"] }),
  J({ id: "teach", label: "Teaching & school", blurb: "Lessons, grading and coursework", apps: ["Keynote", "Pages", "Zoom", "zoom.us", "Notes", "Numbers"], words: /\b(lesson plan|grading|rubric|homework|assignment|worksheet|syllabus|quiz|study schedule)\b/i,
    playbook: "School work: help the user learn, not just finish. Explain the reasoning, give examples, and never invent sources or observations (for example about a video you have not seen). Build lesson plans, rubrics and study schedules as real documents.",
    prompts: ["Make a study schedule for finals", "Write a rubric for this assignment", "Quiz me on this chapter"] }),
  J({ id: "business", label: "Business & sales", blurb: "Proposals, outreach and CRM", apps: ["Microsoft Excel", "Numbers", "Pages", "Mail", "Calendar", "Keynote", "HubSpot", "Salesforce"], words: /\b(client|customer|lead|crm|outreach|quote|contract|proposal|pipeline)\b/i,
    playbook: "Business: be accurate with names, figures and dates; keep drafts for approval and never send to a client without the user's OK. Money actions always need the user's Touch ID.",
    prompts: ["Draft a follow-up email to this client", "Build a simple proposal for this project", "Summarise this contract's key terms"] }),
  J({ id: "social", label: "Social media & content", blurb: "Plan, write and schedule posts", apps: ["Canva", "Photos", "Notes", "@browser", "Pages"], words: /\b(social media|instagram|tiktok|linkedin post|tweet|caption idea|content calendar|newsletter)\b/i,
    playbook: "Content: match each platform's length and tone, give two or three options, and keep facts and claims checkable. Posting is the user's action: draft and prepare, never publish without approval.",
    prompts: ["Write five post ideas for next week", "Turn this article into a LinkedIn post", "Plan a month of content"] }),
  J({ id: "it", label: "IT & system admin", blurb: "Keep the Mac healthy", apps: ["Terminal", "Activity Monitor", "System Settings", "Console", "Disk Utility"], words: /\b(slow mac|disk space|storage|network problem|wifi|permissions issue|uninstall|startup items|update macos)\b/i,
    playbook: "IT: diagnose with read-only commands first and say what you found. Ask before changing settings, deleting files or stopping processes. Explain what each fix does and how to undo it.",
    prompts: ["Why is my Mac slow?", "Free up disk space safely", "Check what starts when I log in"] }),
  J({ id: "gamedev", label: "Game development", blurb: "Build and test games", apps: ["Unity", "Unreal Engine", "Xcode", "Visual Studio Code", "Blender"], words: /\b(unity|unreal|game dev|sprite|level design|game loop)\b/i,
    playbook: "Game dev: use coding mode for scripts and run_shell for builds; the engines themselves are driven through menus (app_ui). Commit or back up before big changes, and run the game or tests to verify.",
    prompts: ["Fix this gameplay bug", "Add a scoring system", "Explain this script"] }),
  J({ id: "personal", label: "Everyday life", blurb: "Plans, trips, shopping and home", apps: ["Maps", "Reminders", "Notes", "Music", "Home", "Calendar"], words: /\b(trip|itinerary|recipe|grocery|directions|restaurant|gift idea|workout plan)\b/i,
    playbook: "Everyday: give a clear recommendation, not a list of ten options. Check the calendar before planning, and ask before booking or buying anything. Money actions always need Touch ID.",
    prompts: ["Plan a weekend trip", "What's for dinner with what I have?", "Set up my morning routine"] }),
];

/** Jobs these apps belong to, best match first. */
const BROWSERS = /^(safari|google chrome|arc|firefox|brave browser|microsoft edge|opera|vivaldi|orion|duckduckgo|comet|chromium)$/i;
export function jobsForApps(apps: string[]): Job[] {
  const names = apps.map((a) => a.toLowerCase());
  if (apps.some((a) => BROWSERS.test(a))) names.push("@browser"); // whichever browser the user uses stands in for "@browser"
  return JOBS.map((j) => ({ j, n: j.apps.filter((a) => names.includes(a.toLowerCase())).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.j);
}

/** The playbook lines to give the agent for this request: from the apps the user picked, and from what they asked for. */
export function jobHint(apps: string[], text: string): string {
  const byApp = jobsForApps(apps).slice(0, 2);
  const byText = JOBS.filter((j) => j.words.test(text) && !byApp.includes(j)).slice(0, 1);
  const picked = [...byApp, ...byText];
  return picked.length ? `\n[How to work here: ${picked.map((j) => `(${j.label}) ${j.playbook}`).join(" ")}]` : "";
}
