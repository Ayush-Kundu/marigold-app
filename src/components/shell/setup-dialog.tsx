"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDashed, ExternalLink, Loader2, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { nativeApp } from "@/lib/native";
import { TESTER_BUILD } from "@/lib/channel";
import { ensureVoice, useVoiceStatus } from "@/lib/voice-client";
import { cn } from "@/lib/utils";

interface Status {
  cloud: { configured: boolean; hasKey: boolean; mode: string; online: boolean; model: string };
  local: { running: boolean; models: string[] };
  fullDisk: boolean; google: number; voice: boolean;
}
interface Perms { accessibility: boolean; screen: boolean; microphone: string; camera?: string }
interface Presets { [id: string]: { label: string; baseUrl: string; model: string } }

const STORAGE = "marigold.setupSeen";
/** Everything Marigold needs to be useful, checked live. `required` ones block real use. */
export function useSetupState() {
  const [status, setStatus] = useState<Status | null>(null);
  const [perms, setPerms] = useState<Perms | null>(null);
  const refresh = useCallback(async () => {
    const [s, p] = await Promise.all([
      fetch("/api/agent/setup-status", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      nativeApp()?.permissions?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    if (s) setStatus(s);
    if (p) setPerms(p);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch; state is set after the awaits
  useEffect(() => { void refresh(); }, [refresh]);
  const hasAI = !!status && ((status.cloud.configured && status.cloud.online) || (status.local.running && status.local.models.length > 0));
  const needsAttention = !!status && (!hasAI || (!!perms && (!perms.accessibility || !perms.screen)));
  return { status, perms, refresh, hasAI, needsAttention };
}

/** Opens by itself the first time Marigold runs (if something important is missing). */
export function SetupGate() {
  const { needsAttention, status } = useSetupState();
  const [open, setOpen] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    const f = () => setOpen(true);
    window.addEventListener("mg-open-setup", f);
    return () => window.removeEventListener("mg-open-setup", f);
  }, []);
  useEffect(() => {
    if (!status || decided.current) return;
    decided.current = true;
    let seen = false;
    try { seen = localStorage.getItem(STORAGE) === "1"; } catch { /* private mode */ }
      if (!seen && needsAttention) setOpen(true);
  }, [status, needsAttention]);
  if (!open) return null;
  return <SetupDialog onClose={() => { try { localStorage.setItem(STORAGE, "1"); } catch { /* ignore */ } setOpen(false); }} />;
}

/** Optional paid-for-by-the-user web search key (Brave Search API) for full web, news, video and shopping results. Marigold works without it. */
function SearchKeyRow() {
  const [has, setHas] = useState<boolean | null>(null);
  const [key, setKey] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { void fetch("/api/agent/search-key").then((r) => r.json()).then((j) => setHas(!!j.hasKey)).catch(() => setHas(false)); }, []);
  const save = async (remove = false) => {
    setBusy(true); setErr("");
    const r = await fetch("/api/agent/search-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: remove ? "" : key }) }).then((x) => x.json()).catch(() => ({ error: "Couldn't reach Marigold." }));
    setBusy(false);
    if (r.error) setErr(r.error); else { setHas(!!r.hasKey); setKey(""); }
  };
  return (
    <Row ok={!!has} title="Web search key" hint={has ? "Marigold's results page uses your search key for full web, news and video results." : "Recommended for real web results. Without a key Marigold only searches Wikipedia, Q&A sites, papers, books and a few big sites. A free Tavily key (about 1,000 credits a month, no card, per their docs) or a Brave Search key (about $5 of credit a month, needs a card) adds a full web index."}>
      {has ? (
        <button onClick={() => void save(true)} disabled={busy} className="h-7 rounded-lg border border-border px-3 text-[11.5px] hover:bg-surface-hover">Remove</button>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5"><input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Tavily or Brave API key" className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-[12px] outline-none focus:border-accent" /></div>
          <div className="flex items-center gap-2">
            <button onClick={() => void save()} disabled={busy || !key.trim()} className="h-7 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-black disabled:opacity-40">{busy ? "Checking…" : "Save"}</button>
            <a href="https://app.tavily.com/" target="_blank" rel="noreferrer" className="text-[11.5px] text-muted underline hover:text-foreground">Get a free Tavily key</a><a href="https://brave.com/search/api/" target="_blank" rel="noreferrer" className="text-[11.5px] text-muted underline hover:text-foreground">or Brave</a>
          </div>
          {err && <p className="text-[11.5px] text-danger">{err}</p>}
        </div>
      )}
    </Row>
  );
}

function Row({ ok, title, hint, required, children }: { ok: boolean; title: string; hint?: React.ReactNode; required?: boolean; children?: React.ReactNode }) {
  return (
    <div className={cn("flex gap-3 rounded-xl border p-3", ok ? "border-border bg-surface/50" : required ? "border-accent/40 bg-accent/[0.05]" : "border-border bg-surface")}>
      <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full", ok ? "bg-success/20 text-success" : "bg-surface-hover text-muted")}>{ok ? <Check size={12} /> : <CircleDashed size={12} />}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}{required && !ok && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent">needed</span>}</p>
        {hint && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{hint}</p>}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}

export function SetupDialog({ onClose }: { onClose: () => void }) {
  const { status, perms, refresh, hasAI } = useSetupState();
  const voice = useVoiceStatus();
  const app = nativeApp();

  // Permissions change outside the app: keep checking while this is open.
  useEffect(() => { const t = setInterval(() => void refresh(), 2500); return () => clearInterval(t); }, [refresh]);

  // ---- AI backend
  const [presets, setPresets] = useState<Presets>({});
  const [preset, setPreset] = useState("openrouter");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => { void fetch("/api/agent/cloud").then((r) => r.json()).then((j) => setPresets(j.presets ?? {})).catch(() => {}); }, []);
  const saveKey = async () => {
    setBusy(true); setMsg("");
    await fetch("/api/agent/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset, mode: "always", apiKey: key }) });
    const t = await fetch("/api/agent/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test" }) }).then((r) => r.json()).catch(() => null);
    if (t?.ok) { setMsg("Connected."); setKey(""); } else setMsg(t?.error ? `That didn't work: ${String(t.error).slice(0, 140)}` : "Couldn't reach that provider. Check the key and your connection.");
    setBusy(false);
    void refresh();
  };
  const [invite, setInvite] = useState<boolean | null>(null);
  const tester = TESTER_BUILD;
  const [code, setCode] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  useEffect(() => { void fetch("/api/agent/pack").then((r) => r.json()).then((j) => setInvite(!!j.available)).catch(() => setInvite(false)); }, []);
  const joinWithCode = async () => {
    setBusy(true); setMsg("");
    const r = await fetch("/api/agent/pack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass: code }) }).then((x) => x.json()).catch(() => null);
    if (!r?.ok) { setMsg(r?.error ?? "That didn't work. Check the code and try again."); setBusy(false); return; }
    const t = await fetch("/api/agent/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test" }) }).then((x) => x.json()).catch(() => null);
    setMsg(t?.ok ? "Connected." : `Saved, but the AI didn't answer: ${String(t?.error ?? "check your connection").slice(0, 140)}`); setCode("");
    setBusy(false);
    void refresh();
  };
  const ask = async (k: "accessibility" | "screen" | "microphone" | "camera" | "fulldisk" | "notifications") => { await app?.requestPermission?.(k); void refresh(); };
  const [notif, setNotif] = useState<string | null>(null);
  useEffect(() => { void app?.notifyStatus?.().then(setNotif).catch(() => {}); }, [app]);

  const allowBtn = (label: string, k: Parameters<typeof ask>[0]) => (
    <button onClick={() => void ask(k)} className="h-7 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-accent-foreground">{label}</button>
  );
  const done = hasAI && (!perms || (perms.accessibility && perms.screen));

  return (
    <Modal onClose={onClose} className="max-w-xl">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[16px] font-semibold">Let&apos;s get Marigold ready</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">Two quick things: connect the AI, and let Marigold see and click in your apps. That&apos;s it.</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-hover hover:text-foreground"><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
        {!status ? <p className="py-6 text-center text-[13px] text-muted"><Loader2 size={16} className="mr-2 inline animate-spin" />Checking your Mac…</p> : (
          <>
            <Row ok={hasAI} required title="Connect your AI"
              hint={hasAI ? "Connected. You are good to go." : !tester ? "Sign in to Marigold and its AI connects by itself." : invite ? "Type the invite code you were sent." : "Paste an API key from an AI provider."}>
              {!hasAI && tester && (
                <div className="space-y-2">
                  {invite && (
                    <div className="flex gap-2">
                      <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && code.trim() && void joinWithCode()} placeholder="Invite code" autoComplete="off" autoFocus className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-accent" />
                      <button onClick={() => void joinWithCode()} disabled={!code.trim() || busy} className="h-9 rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-foreground disabled:opacity-40">{busy ? "Connecting…" : "Connect"}</button>
                    </div>
                  )}
                  {(!invite || ownKey) && (
                    <div className="space-y-2">
                      <select value={preset} onChange={(e) => setPreset(e.target.value)} className="h-8 w-full rounded-lg border border-border bg-background px-2 text-[12px]">
                        {Object.entries(presets).filter(([id]) => !/paid/.test(presets[id].label)).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
                      </select>
                      <div className="flex gap-2">
                        <input value={key} onChange={(e) => { setKey(e.target.value); const v = e.target.value.trim(); const g = /^s2_/.test(v) ? "abacus" : /^sk-or-/.test(v) ? "openrouter" : /^gsk_/.test(v) ? "groq" : null; if (g) setPreset(g); }} type="password" placeholder="Paste your API key" autoComplete="off" className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-[12px] outline-none focus:border-accent" />
                        <button onClick={() => void saveKey()} disabled={!key.trim() || busy} className="h-8 rounded-lg bg-accent px-3 text-[12px] font-medium text-accent-foreground disabled:opacity-40">{busy ? "Testing…" : "Save & test"}</button>
                      </div>
                    </div>
                  )}
                  {invite && !ownKey && <button onClick={() => setOwnKey(true)} className="text-[11.5px] text-muted underline hover:text-foreground">I have my own AI key instead</button>}
                  {msg && <p className={cn("text-[11.5px]", msg === "Connected." ? "text-success" : "text-danger")}>{msg}</p>}
                </div>
              )}
            </Row>

            {perms ? (
              <>
                <Row ok={perms.accessibility} required title="Accessibility" hint="Lets Marigold see and click in your apps." >{!perms.accessibility && allowBtn("Allow", "accessibility")}</Row>
                <Row ok={perms.screen} required title="Screen Recording" hint="Lets Marigold see an app's window (the live view) and read what's on screen.">{!perms.screen && allowBtn("Allow", "screen")}</Row>
              </>
            ) : (
              <Row ok={false} title="macOS permissions" hint="Open Marigold from your Applications folder (not a browser) to grant Accessibility and Screen Recording." />
            )}

            <details className="group rounded-xl border border-border">
              <summary className="cursor-pointer select-none px-3.5 py-2.5 text-[12.5px] font-medium text-muted hover:text-foreground">More options (all optional)</summary>
              <div className="space-y-2.5 border-t border-border p-3">
                {perms && (
                  <>
                <Row ok={status.fullDisk} title="Full Disk Access" hint="Optional. Only needed for reading your texts, so it can tell you when one needs an answer.">{!status.fullDisk && allowBtn("Open Settings", "fulldisk")}</Row>
                <Row ok={notif === "allowed"} title="Notifications" hint="Optional. For your daily briefings and when a task needs you.">{notif !== "allowed" && allowBtn("Open Settings", "notifications")}</Row>
                <Row ok={perms.microphone === "granted"} title="Microphone" hint="Optional. For dictating, talking to Marigold, and calls on websites.">{perms.microphone !== "granted" && allowBtn(perms.microphone === "denied" ? "Open Settings" : "Allow", "microphone")}</Row>
                <Row ok={perms.camera === "granted"} title="Camera" hint="Optional. For video calls on websites, and for taking a photo to show Marigold.">{perms.camera !== "granted" && allowBtn(perms.camera === "denied" ? "Open Settings" : "Allow", "camera")}</Row>
                  </>
                )}
            <Row ok={status.google > 0} title="Google account" hint="Optional. Gmail, Calendar, Drive, Docs and more through Google's own sign-in.">
              {status.google === 0 && <button onClick={() => { onClose(); window.dispatchEvent(new Event("mg-open-settings")); }} className="h-7 rounded-lg border border-border px-3 text-[11.5px] hover:bg-surface-hover">Connect in Settings</button>}
            </Row>
            <Row ok={voice.installed || status.voice} title="Voice" hint={voice.installing ? `Setting up: ${voice.step || "starting"}…` : voice.error ? voice.error : "Optional. Dictation and spoken answers with open models on this Mac (one-time download of about 600 MB; needs Python 3.10–3.13)."}>
              {!(voice.installed || status.voice) && <button onClick={() => void ensureVoice()} disabled={voice.installing} className="h-7 rounded-lg border border-border px-3 text-[11.5px] hover:bg-surface-hover disabled:opacity-50">{voice.installing ? "Setting up…" : "Set up voice"}</button>}
            </Row>
              </div>
            </details>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-5 py-3">
        <p className="min-w-0 flex-1 text-[11.5px] text-muted">{done ? "You're set. You can reopen this from Settings any time." : "You can start now and finish later, but Marigold can't do much without the items marked needed."}</p>
        <button onClick={onClose} className="h-8 shrink-0 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-accent-foreground">{done ? "Start using Marigold" : "Later"}</button>
      </div>
    </Modal>
  );
}
