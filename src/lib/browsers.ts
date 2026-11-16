/** Browsers Marigold can drive. `kind` decides how: full AppleScript (tabs, page text) or basic (open URLs, window titles). */
export type BrowserKind = "safari" | "chromium" | "basic";
export interface BrowserInfo { id: string; app: string; label: string; kind: BrowserKind }

export const BROWSERS: BrowserInfo[] = [
  { id: "safari", app: "Safari", label: "Safari", kind: "safari" },
  { id: "chrome", app: "Google Chrome", label: "Google Chrome", kind: "chromium" },
  { id: "arc", app: "Arc", label: "Arc", kind: "chromium" },
  { id: "edge", app: "Microsoft Edge", label: "Microsoft Edge", kind: "chromium" },
  { id: "brave", app: "Brave Browser", label: "Brave", kind: "chromium" },
  { id: "firefox", app: "Firefox", label: "Firefox", kind: "basic" },
  { id: "opera", app: "Opera", label: "Opera", kind: "basic" },
  { id: "opera-gx", app: "Opera GX", label: "Opera GX", kind: "basic" },
  { id: "vivaldi", app: "Vivaldi", label: "Vivaldi", kind: "chromium" },
  { id: "chromium", app: "Chromium", label: "Chromium", kind: "chromium" },
  { id: "orion", app: "Orion", label: "Orion", kind: "safari" },
  { id: "duckduckgo", app: "DuckDuckGo", label: "DuckDuckGo", kind: "basic" },
  { id: "zen", app: "Zen", label: "Zen", kind: "basic" },
  { id: "tor", app: "Tor Browser", label: "Tor Browser", kind: "basic" },
];

export const browserById = (id?: string) => BROWSERS.find((b) => b.id === id);
export const browserByName = (name?: string) => {
  const n = (name ?? "").toLowerCase().trim();
  if (!n) return undefined;
  return BROWSERS.find((b) => b.id === n || b.app.toLowerCase() === n || b.label.toLowerCase() === n)
    ?? BROWSERS.find((b) => b.app.toLowerCase().includes(n) || n.includes(b.id));
};
