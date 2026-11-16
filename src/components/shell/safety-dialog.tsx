"use client";

import { BrowserPicker, saveBrowser } from "@/components/browser-picker";

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, OctagonX, ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { enrollTouchId, stopAllAgents, testTouchId } from "@/lib/agent";
import { cn } from "@/lib/utils";
import { nativeApp } from "@/lib/native";

interface Grant { scope: string; grantedAt: string }
interface AuditEntry { at: string; tool?: string; event?: string; status?: string; tier?: number; scope?: string; via?: string }

const scopeLabel = (s: string) =>
  s.startsWith("app:") ? `Control ${s.slice(4)}`
  : s.startsWith("shortcut:") ? `Run Shortcut “${s.slice(9)}”`
  : s.startsWith("browser-js:") ? `Run scripts in ${s.slice(11)}`
  : s === "shell" ? "Run Terminal commands"
  : s;

/** Safety & permissions: remembered approvals, Touch ID, kill switch, activity log. */
export function SafetyDialog({ onClose }: { onClose: () => void }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [browser, setBrowser] = useState("");
  const [touchMsg, setTouchMsg] = useState<string | null>(null);
  const test = async () => {
    setTouchMsg("Touch the sensor…");
    const r = await testTouchId();
    setTouchMsg(r.ok ? "✓ Touch ID works. Money actions will ask for it." : `Touch ID failed: ${r.error ?? "cancelled"}`);
  };

  const refresh = useCallback(async () => {
    const [g, a, b] = await Promise.all([
      fetch("/api/agent/grants").then((r) => r.json()).catch(() => ({ grants: [] })),
      fetch("/api/agent/audit").then((r) => r.json()).catch(() => ({ entries: [] })),
      fetch("/api/agent/webauthn/register?status=1").then((r) => r.json()).catch(() => ({ enrolled: false })),
    ]);
    setGrants(g.grants ?? []);
    setAudit(a.entries ?? []);
    setEnrolled(!!b.enrolled);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const revoke = async (scope?: string) => {
    const r = await fetch("/api/agent/grants", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scope ? { scope } : {}),
    }).then((x) => x.json());
    setGrants(r.grants ?? []);
  };

  const enroll = async () => {
    setMsg(null);
    const r = await enrollTouchId();
    setTouchMsg(r.ok ? "Touch ID is set up for money approvals." : `Couldn't set up Touch ID: ${r.error ?? "cancelled"}`);
    void refresh();
  };

  const stop = async () => {
    await stopAllAgents();
    setMsg("Stopped every running task.");
    void refresh();
  };

  return (
    <Modal onClose={onClose} className="max-w-5xl">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck size={18} className="text-accent" /> Safety &amp; permissions</h2>
        <button onClick={onClose} aria-label="Close" className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-surface-hover hover:text-foreground">
          <X size={16} /> Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-5 p-6 text-[13px] md:grid-cols-2">
          <div className="space-y-6">
            <Card title="Emergency stop" desc="Stops every running task and declines anything waiting for approval.">
              <Button variant="danger" size="sm" onClick={stop} className="w-full justify-center gap-1.5">
                <OctagonX size={14} /> Stop all tasks now
              </Button>
              {msg && <p className="mt-2 text-[12px] text-muted">{msg}</p>}
            </Card>

            <Card title="Touch ID for money" desc="Apple Pay, checkouts, purchases, card fields, transfers and banking apps always need your fingerprint — every single time. It can never be set to “always allow”.">
              <div className="flex flex-wrap items-center gap-2">
                {enrolled || nativeApp() ? (
                  <>
                    <span className="flex items-center gap-1.5 text-[12px] text-success"><Fingerprint size={14} /> {nativeApp() ? "Built into the Marigold app" : "Set up on this Mac"}</span>
                    <Button variant="outline" size="sm" onClick={test} className="gap-1.5"><Fingerprint size={14} /> Test Touch ID</Button>
                  </>
                ) : (
                  <Button variant="primary" size="sm" onClick={enroll} className="gap-1.5"><Fingerprint size={14} /> Set up Touch ID</Button>
                )}
              </div>
              {touchMsg && <p className="mt-2 text-[12px] text-muted">{touchMsg}</p>}
            </Card>

            <Card title="Main browser" desc="Marigold browses and acts on websites here unless you name another browser.">
              <BrowserPicker value={browser} onChange={(id) => { setBrowser(id); void saveBrowser(id); }} />
            </Card>
          </div>

          <div className="space-y-6">
            <Card
              title="Always allowed"
              desc="Marigold won't ask again for these. Money is never on this list."
              action={grants.length > 0 ? <button onClick={() => revoke()} className="text-[12px] text-danger hover:underline">Revoke all</button> : undefined}
            >
              <ul className="divide-y divide-border rounded-lg border border-border">
                {grants.length === 0 && <li className="px-3 py-2 text-[12px] text-muted">Nothing yet. You&apos;ll be asked the first time.</li>}
                {grants.map((g) => (
                  <li key={g.scope} className="flex items-center gap-2 px-3 py-2">
                    <span className="flex-1">{scopeLabel(g.scope)}</span>
                    <button onClick={() => revoke(g.scope)} aria-label={`Revoke ${g.scope}`} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-danger"><Trash2 size={13} /></button>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Activity log" desc="Everything Marigold did, newest first.">
              <ul className="max-h-72 space-y-1 overflow-y-auto text-[12px]">
                {audit.length === 0 && <li className="text-muted">No actions yet.</li>}
                {audit.map((e, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted">{new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    <span className="flex-1 truncate">{e.tool ?? e.event}{e.scope ? ` · ${e.scope}` : ""}</span>
                    <span className={cn("shrink-0", e.status === "blocked" || e.status === "declined" ? "text-danger" : "text-muted")}>
                      {e.status ?? (e.event === "biometric" ? "touch id" : "")}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Card({ title, desc, action, children }: { title: string; desc: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      <p className="mb-3 mt-1 text-[12px] text-muted">{desc}</p>
      {children}
    </section>
  );
}
