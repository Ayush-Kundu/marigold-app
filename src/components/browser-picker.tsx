"use client";

import { useEffect, useState } from "react";
import { BROWSERS } from "@/lib/browsers";
import { cn } from "@/lib/utils";

/** Grid of every supported browser; installed ones first, the Mac default preselected. */
export function BrowserPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [installed, setInstalled] = useState<string[] | null>(null);
  useEffect(() => {
    fetch("/api/agent/prefs").then((r) => r.json()).then((j) => {
      setInstalled(j.installed ?? []);
      if (!value) onChange(j.prefs?.browser ?? j.systemDefault ?? j.installed?.[0] ?? "safari");
    }).catch(() => setInstalled([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = [...BROWSERS].sort((a, b) => Number(installed?.includes(b.id) ?? 0) - Number(installed?.includes(a.id) ?? 0));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {list.map((b) => {
        const has = installed?.includes(b.id);
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => onChange(b.id)}
            className={cn(
              "rounded-xl border p-2.5 text-left transition-colors",
              value === b.id ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent/50",
            )}
          >
            <p className="text-[13px] font-medium">{b.label}</p>
            <p className="mt-0.5 text-[11px] leading-tight text-muted">{installed === null ? "…" : has ? "Installed" : "Not installed"}</p>
          </button>
        );
      })}
    </div>
  );
}

export async function saveBrowser(id: string) {
  await fetch("/api/agent/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ browser: id }) }).catch(() => {});
}
