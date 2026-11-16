"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { nativeApp } from "@/lib/native";
import { useApp } from "@/lib/store";
import { verifyEmailLink } from "@/lib/supabase/auth";

/**
 * Sign-in handoff between the user's browser and the Mac app.
 *  • In a browser tab that just came back from a sign-in link (and the Mac app is running):
 *    pass the new session to the app, then say so.
 *  • In the app: accept handed-off sessions, and open chats the menu-bar panel asks for.
 */
export function AuthBridge() {
  const [handed, setHanded] = useState(false);

  useEffect(() => {
    const native = nativeApp();
    const sb = getSupabase();
    if (native) {
      native.onAuthHandoff(async (t) => {
        if (t.token_hash) await verifyEmailLink(t.token_hash, t.type);
        else await sb?.auth.setSession({ access_token: t.access_token, refresh_token: t.refresh_token });
      });
      native.onOpenChat(async (id) => { await useApp.getState().loadWorkspace(); useApp.getState().selectChat(id); });
      return;
    }
    // Browser tab: only right after returning from a sign-in link (flag set by layout's inline script).
    let flagged = false;
    try { flagged = sessionStorage.getItem("mg_signin_return") === "1"; } catch { /* storage off */ }
    if (!flagged || !sb) return;
    (async () => {
      const st = await fetch("/api/app/status").then((r) => r.json()).catch(() => null);
      if (!st?.app) return; // no Mac app running — this tab IS the app
      for (let i = 0; i < 20; i++) {
        const { data } = await sb.auth.getSession();
        const s = data.session;
        if (s) {
          const ok = await fetch("/api/app/handoff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token }),
          }).then((r) => r.ok, () => false);
          if (ok) { try { sessionStorage.removeItem("mg_signin_return"); } catch {} setHanded(true); }
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }, []);

  if (!handed) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[200] flex justify-center p-3">
      <div className="rounded-xl border border-border bg-background px-4 py-2.5 text-sm shadow-lg">
        ✓ You&apos;re signed in to the <b>Marigold app</b>. You can close this tab.
      </div>
    </div>
  );
}
