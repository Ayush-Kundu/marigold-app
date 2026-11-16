import type {
  AgentRun,
  BackgroundTask,
  Capability,
  Chat,
  Project,
  User,
} from "./types";

/** Minutes/hours ago as an ISO string. */
const ago = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

export const mockUser: User = {
  id: "u_1",
  name: "Ayush",
  email: "anirbankundu@gmail.com",
};

export const capabilities: Capability[] = [
  {
    id: "cap_email",
    tool: "email",
    title: "Write & send emails",
    example: "Draft a polite follow-up to Alex about the Q3 invoice.",
  },
  {
    id: "cap_calendar",
    tool: "calendar",
    title: "Manage your calendar",
    example: "Find 30 minutes with Sam next week and send an invite.",
  },
  {
    id: "cap_money",
    tool: "money",
    title: "Keep an eye on money",
    example: "Summarize my spending this month and flag anything unusual.",
  },
  {
    id: "cap_browser",
    tool: "browser",
    title: "Browse & research the web",
    example: "Compare the top 3 standing desks under $500 and recommend one.",
  },
  {
    id: "cap_docs",
    tool: "docs",
    title: "Draft documents",
    example: "Turn these notes into a one-page project brief.",
  },
  {
    id: "cap_search",
    tool: "search",
    title: "Dig through your inbox & files",
    example: "Find the lease PDF I was sent back in the spring.",
  },
];

export const mockProjects: Project[] = [
  {
    id: "p_apartment",
    name: "Apartment hunt",
    description: "Find and apply for a 1-bed in Brooklyn under $3k.",
    color: "#6c5ce7",
    chatIds: ["c_lease", "c_tour"],
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(90),
  },
  {
    id: "p_finances",
    name: "Personal finances",
    description: "Budget, bills, and subscriptions on autopilot.",
    color: "#16a34a",
    chatIds: ["c_budget"],
    createdAt: ago(60 * 24 * 10),
    updatedAt: ago(200),
  },
  {
    id: "p_launch",
    name: "Product launch",
    description: "Coordinate the v1 launch — emails, press, scheduling.",
    color: "#d97706",
    chatIds: [],
    createdAt: ago(60 * 24 * 1),
    updatedAt: ago(30),
  },
];

export const mockChats: Chat[] = [
  {
    id: "c_budget",
    title: "This month's spending",
    projectId: "p_finances",
    createdAt: ago(240),
    updatedAt: ago(90),
    pinned: true,
    messages: [
      {
        id: "m1",
        role: "user",
        content: "How much did I spend on food this month vs last month?",
        createdAt: ago(240),
      },
      {
        id: "m2",
        role: "agent",
        content:
          "You spent $612 on food this month, up 18% from $519 last month. The jump is mostly from 9 delivery orders ($214). Want me to set a weekly delivery cap and nudge you when you're close?",
        createdAt: ago(239),
        action: {
          label: "Reviewed 42 transactions",
          tool: "money",
          status: "done",
        },
      },
    ],
  },
  {
    id: "c_lease",
    title: "Lease review — 215 Dean St",
    projectId: "p_apartment",
    createdAt: ago(180),
    updatedAt: ago(120),
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Can you read this lease and flag anything unusual?",
        createdAt: ago(180),
      },
      {
        id: "m2",
        role: "agent",
        content:
          "Two things stand out: (1) a $75/month 'amenity fee' on top of rent, and (2) a 60-day move-out notice instead of the usual 30. Everything else is standard. Want me to draft an email asking the broker about the amenity fee?",
        createdAt: ago(179),
        action: {
          label: "Draft email to broker",
          tool: "email",
          needsConfirmation: true,
          status: "proposed",
        },
      },
    ],
  },
  {
    id: "c_tour",
    title: "Schedule apartment tours",
    projectId: "p_apartment",
    createdAt: ago(60),
    updatedAt: ago(45),
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Book tours for the 3 places I starred this weekend.",
        createdAt: ago(60),
      },
    ],
  },
  {
    id: "c_general",
    title: "Trip to Lisbon ideas",
    createdAt: ago(60 * 20),
    updatedAt: ago(60 * 19),
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Give me a loose 4-day Lisbon itinerary for late spring.",
        createdAt: ago(60 * 20),
      },
      {
        id: "m2",
        role: "agent",
        content:
          "Here's a relaxed 4-day plan centered on Alfama, Belém, and a day trip to Sintra. I kept mornings light and left evenings open for dinner wandering.",
        createdAt: ago(60 * 19),
      },
    ],
  },
];

export const mockTasks: BackgroundTask[] = [
  {
    id: "t_tours",
    title: "Booking apartment tours",
    kind: "calendar",
    status: "running",
    progress: 60,
    summary: "Emailed 2 of 3 brokers, waiting on replies.",
    startedAt: ago(42),
    updatedAt: ago(4),
    chatId: "c_tour",
    runId: "run_tours",
  },
  {
    id: "t_invoice",
    title: "Chasing the Q3 invoice",
    kind: "email",
    status: "needs_input",
    progress: 30,
    summary: "Drafted a follow-up — needs your OK to send.",
    startedAt: ago(90),
    updatedAt: ago(12),
    chatId: "c_lease",
  },
  {
    id: "t_subs",
    title: "Auditing subscriptions",
    kind: "money",
    status: "done",
    progress: 100,
    summary: "Found 3 unused subscriptions ($47/mo).",
    startedAt: ago(300),
    updatedAt: ago(220),
    chatId: "c_budget",
  },
];

/** A sample live run for the View tab. */
export const mockRun: AgentRun = {
  id: "run_tours",
  goal: "Book tours for the 3 starred apartments this weekend",
  status: "running",
  startedAt: ago(42),
  canvas: {
    kind: "browser",
    title: "StreetEasy — 215 Dean St",
    url: "https://streeteasy.com/building/215-dean-st",
    body:
      "215 Dean Street · 1 bed / 1 bath · $2,850/mo\n\nContact: Brooklyn Lofts Realty\nTour availability: Sat 11:00, Sat 2:30, Sun 1:00\n\n[ Request a tour ]  [ Save ]",
  },
  events: [
    {
      id: "e1",
      type: "thinking",
      title: "Planning the 3 tour requests",
      detail:
        "I'll request Saturday slots for all three so they're back-to-back, then confirm by email.",
      createdAt: ago(42),
    },
    {
      id: "e2",
      type: "browse",
      title: "Opened StreetEasy listing for 215 Dean St",
      tool: "browser",
      target: "streeteasy.com/building/215-dean-st",
      createdAt: ago(40),
    },
    {
      id: "e3",
      type: "tool_call",
      title: "Submitted tour request for Sat 11:00",
      tool: "calendar",
      createdAt: ago(36),
    },
    {
      id: "e4",
      type: "write",
      title: "Drafting confirmation email to broker",
      tool: "email",
      detail: "Introducing you and confirming the Saturday 11:00 slot.",
      createdAt: ago(5),
    },
    {
      id: "e5",
      type: "awaiting_confirmation",
      title: "Ready to send confirmation — approve?",
      tool: "email",
      createdAt: ago(1),
    },
  ],
};

/** Starter prompts shown on an empty chat. */
export const starterPrompts: string[] = [
  "Summarize my unread emails from today",
  "What's on my calendar tomorrow?",
  "Find unused subscriptions and cancel them",
  "Draft a thank-you note to my interviewer",
];
