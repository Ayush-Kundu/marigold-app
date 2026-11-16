// How the apps in the side-by-side view share the screen.

export interface Rect { x: number; y: number; w: number; h: number }

/** How much room each kind of app wants: documents, maps and editors like space; a calculator or a chat window doesn't. */
const BIG = /^(davinci resolve|adobe premiere pro|logic pro|ableton live|blender|unity|figma|notion|obsidian|microsoft teams|zoom|zoom\.us|pages|numbers|keynote|microsoft (word|excel|powerpoint)|preview|photos|maps|final cut|imovie|xcode|visual studio code|code|cursor|figma|sketch|photoshop|illustrator|terminal|iterm2?|tv|quicktime player|freeform|books|pdf expert|notion|obsidian|slack|discord|zoom\.us|facetime)$/i;
const MEDIUM = /^(mail|calendar|finder|notes|safari|textedit|system settings|app store|news|stocks|home|music|podcasts|contacts|reminders|messages|voice memos)$/i;
const SMALL = /^(calculator|clock|weather|stickies|dictionary|activity monitor|console|keychain access|calendar widget)$/i;
/** The smallest a window of this kind is worth showing (a calculator is useful much smaller than an editor). */
export const minSize = (app: string) => (SMALL.test(app) ? { w: 200, h: 200 } : { w: 300, h: 240 });
export const need = (app: string) => (SMALL.test(app) ? 0.7 : BIG.test(app) ? 2.2 : MEDIUM.test(app) ? 1 : 1);

/** Weighted treemap: split the area between the apps in proportion to how much room each needs. */
export function tile(items: { app: string; weight: number }[], r: Rect): { app: string; rect: Rect }[] {
  if (items.length === 1) return [{ app: items[0].app, rect: r }];
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((n, i) => n + i.weight, 0);
  let acc = 0, k = 0;
  while (k < sorted.length - 1 && acc + sorted[k].weight / 2 < total / 2) { acc += sorted[k].weight; k++; }
  k = Math.max(1, k);
  const a = sorted.slice(0, k), b = sorted.slice(k);
  const share = a.reduce((n, i) => n + i.weight, 0) / total;
  const gap = 8;
  if (r.w >= r.h) { // split side by side
    const wa = Math.round(r.w * share);
    return [...tile(a, { x: r.x, y: r.y, w: wa - gap / 2, h: r.h }), ...tile(b, { x: r.x + wa + gap / 2, y: r.y, w: r.w - wa - gap / 2, h: r.h })];
  }
  const ha = Math.round(r.h * share); // split top and bottom
  return [...tile(a, { x: r.x, y: r.y, w: r.w, h: ha - gap / 2 }), ...tile(b, { x: r.x, y: r.y + ha + gap / 2, w: r.w, h: r.h - ha - gap / 2 })];
}

