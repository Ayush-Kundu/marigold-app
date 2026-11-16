import type { AgentTone } from "./types";

/** The tone choices offered during onboarding and in settings. */
export const TONES: { id: AgentTone; label: string; blurb: string }[] = [
  { id: "concise", label: "Concise", blurb: "Short and to the point" },
  { id: "friendly", label: "Friendly", blurb: "Warm and personable" },
  { id: "formal", label: "Formal", blurb: "Professional and precise" },
];

/** Used only if the browser can't enumerate zones (very old engines). */
const FALLBACK_TZ = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

/** Detect the browser's current IANA timezone (falls back to UTC). */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every IANA zone the browser knows, with `ensure` guaranteed present & first. */
export function listTimezones(ensure?: string): string[] {
  let list = FALLBACK_TZ;
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (supported && supported.length) list = supported;
  } catch {
    /* fall back */
  }
  if (ensure && !list.includes(ensure)) list = [ensure, ...list];
  return list;
}
