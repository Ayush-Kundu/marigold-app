import { localOnly } from "@/lib/server/agent/guard";
import { appBrowserAvailable, mb } from "@/lib/server/agent/app-browser";

/** Dev diagnostics: can the Marigold Browser play video here? (opens a background tab, tries, closes it) */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  if (!appBrowserAvailable()) return Response.json({ error: "not in the app" }, { status: 409 });
  const url = new URL(req.url).searchParams.get("url") ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
  await mb("open", { url, newTab: true });
  await new Promise((r) => setTimeout(r, 4000));
  const probe = `(async () => {
    const v = document.querySelector('video');
    const out = { title: document.title, hasVideo: !!v };
    out.codecs = { h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'), vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'), av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.05M.08"'), aac: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'), opus: MediaSource.isTypeSupported('audio/webm; codecs="opus"') };
    try { await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]); out.widevine = true; } catch (e) { out.widevine = String(e).slice(0, 80); }
    if (v) {
      try { v.muted = true; await v.play(); } catch (e) { out.playError = String(e).slice(0, 120); }
      await new Promise(r => setTimeout(r, 3000));
      out.state = { paused: v.paused, time: v.currentTime, ready: v.readyState, error: v.error && v.error.message, src: (v.currentSrc || '').slice(0, 40) };
    }
    out.errorText = (document.querySelector('.ytp-error, .ytp-error-content') || {}).innerText || '';
    return JSON.stringify(out);
  })()`;
  const { value } = (await mb("eval", { js: probe })) as { value: string };
  const { blocked: blockedHosts } = (await mb("blocked")) as { blocked: string[] };
  await mb("close");
  return Response.json({ ...JSON.parse(value), blockedOnThisMac: blockedHosts });
}
