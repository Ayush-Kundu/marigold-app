"use client";

import { cn } from "@/lib/utils";

/**
 * An instant hover hint (the browser's own title tooltip waits about a second and is easy to miss).
 * `keys` shows a shortcut as little keycaps, e.g. ["⌘", "⇧", "D"].
 */
export function Tip({ label, keys, align = "center", children, className }: { label: string; keys?: string[]; align?: "center" | "right" | "left"; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute bottom-full z-50 mb-2 flex w-max max-w-[220px] items-center gap-1.5 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-[11.5px] font-medium text-background opacity-0 shadow-lg transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
          align === "center" ? "left-1/2 -translate-x-1/2" : align === "right" ? "right-0" : "left-0",
        )}
      >
        {label}
        {keys?.length ? <span className="flex items-center gap-0.5">{keys.map((k) => <kbd key={k} className="rounded bg-background/20 px-1 py-px font-sans text-[11px] leading-none">{k}</kbd>)}</span> : null}
      </span>
    </span>
  );
}
