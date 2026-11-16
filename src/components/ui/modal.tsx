"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Centered pop-up rendered at <body> level (a portal), so no parent — like the
 * sliding sidebar with its CSS transform — can clip or shift it. It stays until
 * the user closes it (X / Esc); clicking the backdrop does nothing.
 */
export function Modal({ onClose, className, children }: { onClose: () => void; className?: string; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true); // eslint-disable-line react-hooks/set-state-in-effect -- portal needs the DOM
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true">
      <div className={cn("flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl", className)}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
