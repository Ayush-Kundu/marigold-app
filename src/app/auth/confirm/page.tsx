"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { MarigoldIcon } from "@/components/marigold-icon";
import { nativeApp } from "@/lib/native";
import { verifyEmailLink } from "@/lib/supabase/auth";

/**
 * Where the sign-in email's button lands (http://localhost:3000/auth/confirm?token_hash=…).
 *  • Marigold Mac app running → hand the one-time token to the app, which signs itself in and
 *    opens the chat on its own (no reload). This tab just says so.
 *  • No app (web use) → sign in right here and go to the chat.
 */
export default function ConfirmPage() {
  const router = useRouter();
  const [state, setState] = useState<"working" | "app" | "error">("working");
  const [error, setError] = useState("");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tokenHash = q.get("token_hash") ?? "";
    const type = q.get("type") ?? "email";
    if (!tokenHash) { router.replace("/" + window.location.hash); return; } // old-style link
    // Don't leave the one-time token sitting in the address bar / history.
    window.history.replaceState(null, "", "/auth/confirm");
    (async () => {
      if (!nativeApp()) {
        const st = await fetch("/api/app/status").then((r) => r.json()).catch(() => null);
        if (st?.app) {
          const ok = await fetch("/api/app/handoff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token_hash: tokenHash, type }),
          }).then((r) => r.ok, () => false);
          if (ok) { setState("app"); return; }
        }
      }
      const { error } = await verifyEmailLink(tokenHash, type);
      if (error) { setError(error); setState("error"); return; }
      router.replace("/");
    })();
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-5 flex justify-center"><MarigoldIcon size={56} /></div>
        {state === "working" && (
          <>
            <Loader2 size={28} className="mx-auto animate-spin text-accent" />
            <p className="mt-3 text-sm text-muted">Signing you in…</p>
          </>
        )}
        {state === "app" && (
          <>
            <CheckCircle2 size={44} className="mx-auto text-accent" />
            <h1 className="mt-3 text-xl font-semibold">You&apos;re signed in</h1>
            <p className="mt-2 text-sm text-muted">Marigold is opening on your Mac. You can close this tab.</p>
          </>
        )}
        {state === "error" && (
          <>
            <AlertCircle size={40} className="mx-auto text-danger" />
            <h1 className="mt-3 text-xl font-semibold">That link didn&apos;t work</h1>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button onClick={() => router.replace("/login")} className="mt-5 text-sm font-medium text-accent hover:underline">Back to sign in</button>
          </>
        )}
      </div>
    </div>
  );
}
