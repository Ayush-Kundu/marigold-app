"use client";

import { useSyncExternalStore } from "react";

/**
 * Every app on this Mac with its real icon, for the app dock beside the chat and the app chips in messages.
 * The list comes from the agent's own catalog (so the dock and the agent agree on what's installed); icons
 * are rendered by macOS itself (NSWorkspace) on demand. An app without one gets a letter tile.
 */
export interface MacApp { name: string; kind: string; path: string; ios: boolean }
interface Snap { apps: MacApp[]; ready: boolean }

let snap: Snap = { apps: [], ready: false };
const subs = new Set<() => void>();
const emit = (next: Partial<Snap>) => { snap = { ...snap, ...next }; subs.forEach((f) => f()); };
let started = false;

/** Load the app list once (icons are plain images the browser fetches as each one scrolls into view). */
export function loadApps(force = false) {
  if (started && !force) return;
  started = true;
  void (async () => {
    const j = await fetch("/api/agent/apps", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    emit({ apps: j?.apps ?? [], ready: true });
  })();
}

/** The real macOS icon of an app, served by the local engine. */
export const iconUrl = (path: string) => `/api/agent/app-icon?path=${encodeURIComponent(path)}`;

const subscribeApps = (f: () => void) => { subs.add(f); loadApps(); return () => { subs.delete(f); }; };
const getApps = () => snap;
export function useMacApps(): Snap {
  return useSyncExternalStore(subscribeApps, getApps, getApps);
}

const USE_KEY = "marigold.appUse";
export function appUseCounts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(USE_KEY) ?? "{}"); } catch { return {}; }
}
export function bumpAppUse(name: string) {
  try { const c = appUseCounts(); c[name] = (c[name] ?? 0) + 1; localStorage.setItem(USE_KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

/** Letter tile colour (stable per name) for apps without an icon. */
export const tileHue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Markdown-style link a message carries for an app the user picked: [Notes](app://Notes). */
export const appLink = (name: string) => `[${name}](app://${encodeURIComponent(name)})`;
export const APP_LINK_RE = /\[([^\]]+)\]\(app:\/\/([^)]+)\)/g;

/** A file attached in the composer travels in the message as [name](att://id). */
export const attLink = (name: string, id: string) => `[${name.replace(/[\[\]]/g, "")}](att://${id})`;
export const ATT_LINK_RE = /\[([^\]]+)\]\(att:\/\/([a-f0-9]{12})\)/g;
