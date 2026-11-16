/** The Mac app bridge (electron/preload.cjs). Undefined in a normal browser tab. */
export interface MarigoldApp {
  /** ⌘⇧D pressed while a web page (not the Marigold window) had focus. */
  /** Asks macOS for microphone access (first time) and returns granted / denied / restricted. */
  micAccess?: () => Promise<string>;
  openMicSettings?: () => Promise<void>;
  /** "Deep dive" clicked on Marigold's search page: open a chat about this topic. */
  /** A question from Marigold's results page ("Go deeper", follow-ups): ask it in the open tab's assistant. */
  onAskTab?: (cb: (q: string, deep: boolean) => void) => () => void;
  onDeepDive?: (cb: (q: string) => void) => () => void;
  /** Coding mode: choose a project folder (macOS folder picker). */
  pickFolder?: () => Promise<string | null>;
  /** Tells the menu bar what the voice conversation is doing. */
  convState?: (phase: string) => void;
  onConverse?: (cb: () => void) => () => void;
  onDictate?: (cb: () => void) => () => void;
  isApp: true;
  info: () => Promise<{ version: string; ownsServer: boolean; hotkey: string }>;
  touchID: (stepId: string, reason: string) => Promise<{ ok: boolean; error?: string }>;
  testTouchID: () => Promise<{ ok: boolean; error?: string }>;
  openMain: (chatId?: string) => Promise<void>;
  hideQuick: () => Promise<void>;
  onAuthHandoff: (cb: (t: { access_token: string; refresh_token: string; token_hash?: string; type?: string }) => void) => void;
  onOpenChat: (cb: (chatId: string) => void) => void;
  onQuickShown: (cb: () => void) => void;
  showPermissions?: () => Promise<void>;
  permissions?: () => Promise<{ accessibility: boolean; screen: boolean; microphone: string; camera?: string }>;
  requestPermission?: (kind: "accessibility" | "screen" | "microphone" | "camera" | "fulldisk" | "notifications") => Promise<{ accessibility: boolean; screen: boolean; microphone: string }>;
  notifyStatus?: () => Promise<"allowed" | "denied" | "not-asked" | "missing" | "unknown">;
  openNotifySettings?: () => Promise<void>;
  onPing?: (cb: (p: { id: string; kind: string; title: string; body: string; chatId?: string; url?: string; priority?: "critical" | "normal" | "low" }) => void) => () => void;
  onOpenTab?: (cb: (tab: string) => void) => void;
  /** Side-by-side view: shrink this window to a strip on the left; resolves with the area (screen points) for the app. */
  viewEnter?: () => Promise<{ x: number; y: number; w: number; h: number } | null>;
  viewExit?: () => Promise<void>;
  onOpenPings?: (cb: () => void) => void;
  browser?: BrowserBridge;
}

export interface BrowserTab { pinned?: boolean; id: number; title: string; url: string; favicon: string; loading: boolean; canBack: boolean; canForward: boolean; agent: boolean; newTab: boolean; loginPage?: boolean; blocked?: string[]; permAsk?: { site: string; permission: string; media?: string[] } | null; googleSignIn?: boolean; audible?: boolean; muted?: boolean; authAsk?: { id: string; host: string; realm: string; proxy: boolean } | null }
export interface ImportSource { id: string; label: string; profiles: { dir: string; name: string; email: string }[] }
export interface ImportResult { ok: boolean; error?: string; from?: string; bookmarks?: number; history?: number; signins?: number; signinsError?: string; extensions?: string[]; extensionsHeld?: string[]; extensionsError?: string }
export interface BrowserExtension { id: string; name: string; version: string; ok: boolean; error?: string; popup: string; icon: string; held?: boolean; incompatible?: boolean; safeMode?: boolean; errors?: number }
export interface Bookmark { url: string; title: string; folder: string }
export interface BrowserProfile { key: string; email: string }
export interface BrowserDownload { id: number; name: string; path: string; url: string; state: "progressing" | "completed" | "cancelled" | "interrupted"; received: number; total: number; at: number }
export interface HistoryItem { url: string; title: string; last: number; visits: number }
export interface BrowserState { tabs: BrowserTab[]; activeId: number; agentId: number; lastDownload: string; profile: string; profiles: BrowserProfile[]; downloads: BrowserDownload[]; engine: string; engines: { id: string; name: string }[] }
export interface BrowserBridge {
  state: () => Promise<BrowserState>;
  /** Show a tab ("active" = the user's, "agent" = the agent's) over this area of the window; null hides. */
  host: (h: { which: "active" | "agent"; bounds: { x: number; y: number; width: number; height: number } } | null) => Promise<void>;
  /** Snapshot of the visible tab (data URL), then hide it — shown while the layout animates. */
  freeze: () => Promise<string>;
  preconnect?: (url: string) => Promise<void>;
  snapshot?: () => Promise<string>;
  newTab: (url?: string) => Promise<BrowserState>;
  close: (id: number) => Promise<BrowserState>;
  activate: (id: number) => Promise<BrowserState>;
  /** Drag-to-reorder: put tab `id` at position `to` in the strip. */
  moveTab: (id: number, to: number) => Promise<BrowserState>;
  reopenTab: () => Promise<boolean>;
  /** Tells the app whether the Browser tab is on screen (so browser shortcuts work). */
  shown: (v: boolean) => Promise<void>;
  /** Right-click menu for a tab (native). */
  tabMenu: (id: number) => Promise<void>;
  pin: (id: number) => Promise<BrowserState>;
  historyList: (q?: string) => Promise<HistoryItem[]>;
  historyDelete: (arg: { url?: string; since?: number } | undefined) => Promise<boolean>;
  clearData: (o: { history?: boolean; cookies?: boolean; cache?: boolean; sinceMs?: number }) => Promise<boolean>;
  download: (id: number, action: "open" | "reveal" | "cancel" | "remove" | "clear") => Promise<boolean>;
  zoom: (o?: { id?: number; delta?: number; reset?: boolean }) => Promise<number>;
  devtools: () => Promise<void>;
  print: () => Promise<void>;
  pageLinks: (id?: number) => Promise<{ text: string; href: string }[]>;
  onPanel: (cb: (p: "history" | "downloads" | "clear" | "bookmarks-bar" | "tab-search") => void) => () => void;
  onBookmarksChanged: (cb: () => void) => () => void;
  navigate: (id: number | undefined, input: string) => Promise<BrowserState>;
  nav: (id: number | undefined, what: "back" | "forward" | "reload" | "stop") => Promise<void>;
  pageText: (id?: number) => Promise<{ title: string; url: string; text: string } | null>;
  pageShot: (id?: number) => Promise<string>;
  captions: (id?: number) => Promise<{ found: boolean; text: string } | null>;
  captionsOn: (id?: number) => Promise<boolean>;
  setEngine: (id: string) => Promise<string>;
  revealDownload: () => Promise<void>;
  suggest: (q: string) => Promise<{ url: string; title: string; kind: "bookmark" | "history" }[]>;
  homeData: () => Promise<{ topSites: { url: string; title: string }[]; bookmarks: { url: string; title: string; folder: string }[]; imported: string[]; signins: string[]; last: { id: string; profile: string } | null }>;
  reloadAll: () => Promise<void>;
  /** Switch browser profile ("" = primary email): its own logins and tabs. */
  setProfile: (key: string) => Promise<BrowserState>;
  extensions: () => Promise<BrowserExtension[]>;
  /** Built-in ad & tracker blocking: read (no arg) or set. */
  adblock: (on?: boolean) => Promise<{ on: boolean; ready: boolean }>;
  openExtension: (id: string) => Promise<boolean>;
  removeExtension: (id: string) => Promise<boolean>;
  /** Turn on an extension that was held back (installed by an organization). */
  enableExtension: (id: string) => Promise<boolean>;
  bookmarks: () => Promise<Bookmark[]>;
  /** Star / unstar a page (returns true if it's now bookmarked). */
  toggleBookmark: (url: string, title: string) => Promise<boolean>;
  answerPermission: (id: number, allow: boolean) => Promise<void>;
  resetPermissions: () => Promise<boolean>;
  openExternal: (url: string, email?: string) => Promise<boolean>;
  importSources: () => Promise<ImportSource[]>;
  importFrom: (opts: { id: string; profile: string; what: { bookmarks: boolean; history: boolean; cookies: boolean; extensions?: boolean } }) => Promise<ImportResult>;
  onState: (cb: (s: BrowserState) => void) => () => void;
  onFocusOmnibox: (cb: () => void) => () => void;
  answerAuth: (id: string, user?: string, pass?: string, cancel?: boolean) => Promise<boolean>;
  mute: (id: number) => Promise<boolean>;
  find: (text: string, forward?: boolean, next?: boolean) => Promise<boolean>;
  findStop: () => Promise<boolean>;
  onFindOpen: (cb: () => void) => () => void;
  onFindResult: (cb: (r: { active: number; total: number }) => void) => () => void;
}

export const nativeApp = (): MarigoldApp | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { marigoldApp?: MarigoldApp }).marigoldApp;
