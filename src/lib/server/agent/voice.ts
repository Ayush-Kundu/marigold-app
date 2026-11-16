import { execFile, spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { createWriteStream, existsSync, promises as fs } from "fs";
import net from "net";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";

/**
 * Voice, fully on this Mac with open models:
 *   • Dictation — Whisper (small.en) via faster-whisper.
 *   • Spoken replies — Kokoro-82M (open weights) via kokoro-onnx.
 * One small Python helper (scripts/voice_server.py) keeps both loaded; it listens on a random
 * loopback port with a per-run token, and only this engine talks to it. "Set up voice" (Settings
 * or the first mic click) installs the helper's Python packages and downloads the models once (~600 MB).
 */

const exec = promisify(execFile);
const DIR = path.join(MARIGOLD_DIR, "voice");
const PY = path.join(DIR, "venv", "bin", "python");
const MODELS = path.join(DIR, "models");
const KOKORO = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
const WHISPER = "small.en";

interface Run { proc: ChildProcess; port: number; token: string }
const g = globalThis as unknown as { __marigoldVoice?: { run?: Run; starting?: Promise<Run>; setup: { active: boolean; step: string; error: string } } };
const st = (g.__marigoldVoice ??= { setup: { active: false, step: "", error: "" } });

export function voiceInstalled(): boolean {
  return existsSync(PY) && existsSync(path.join(MODELS, "kokoro.onnx")) && existsSync(path.join(MODELS, "voices.bin")) && existsSync(path.join(MODELS, "whisper"));
}
export function voiceStatus() {
  return { installed: voiceInstalled(), installing: st.setup.active, step: st.setup.step, error: st.setup.error, running: !!st.run && st.run.proc.exitCode === null, expressive: expressiveInstalled(), expressiveInstalling: xs.setup.active, expressiveStep: xs.setup.step, expressiveError: xs.setup.error };
}

// ---------------------------------------------------------------- the expressive voice (laughs, sighs, real pauses)
// Chatterbox Turbo (open weights, MIT) on Apple's MLX, in its own helper so the dictation helper stays light.
const XPY = path.join(DIR, "venv-tts", "bin", "python");
const XMARK = path.join(DIR, "expressive.ok");
const XREPO = "mlx-community/chatterbox-turbo-fp16";
const xg = globalThis as unknown as { __marigoldExpressive?: { run?: Run; starting?: Promise<Run>; idle?: ReturnType<typeof setTimeout>; setup: { active: boolean; step: string; error: string } } };
const xs = (xg.__marigoldExpressive ??= { setup: { active: false, step: "", error: "" } });
export const expressiveInstalled = () => existsSync(XPY) && existsSync(XMARK);

async function startExpressive(): Promise<Run> {
  if (!expressiveInstalled()) throw new Error("EXPRESSIVE_NOT_SET_UP");
  await exec("pkill", ["-f", "scripts/expressive_tts.py"]).catch(() => {});
  const port = await freePort(), token = randomBytes(16).toString("hex");
  const proc = spawn(XPY, [path.join(process.cwd(), "scripts", "expressive_tts.py"), "--port", String(port), "--token", token, "--repo", XREPO], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr?.on("data", (d) => { err = (err + d).slice(-600); });
  const run: Run = { proc, port, token };
  const stop = () => { try { proc.kill(); } catch { /* gone */ } };
  process.once("exit", stop);
  process.once("SIGTERM", stop);
  proc.on("exit", () => { if (xs.run === run) xs.run = undefined; });
  for (let i = 0; i < 480; i++) { // the model loads in 5-30 s (longer the very first time)
    if (proc.exitCode !== null) throw new Error(`Expressive voice stopped: ${err.trim().split("\n").pop() ?? "unknown error"}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-marigold-voice": token }, signal: AbortSignal.timeout(500) }); if (r.ok && ((await r.json()) as { ready?: boolean }).ready) return run; } catch { /* still loading */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("Expressive voice didn't start.");
}
async function xserver(): Promise<Run> {
  if (xs.run && xs.run.proc.exitCode === null) return xs.run;
  xs.starting ??= startExpressive().then((r) => (xs.run = r)).finally(() => { xs.starting = undefined; });
  return xs.starting;
}
/** The expressive voice keeps ~2 GB in memory: let it go after 15 quiet minutes. */
function xidle() {
  if (xs.idle) clearTimeout(xs.idle);
  xs.idle = setTimeout(() => { try { xs.run?.proc.kill(); } catch { /* gone */ } xs.run = undefined; }, 15 * 60_000);
}
/** What the plain voice says in place of a sound it can't make. */
export const plainTags = (t: string) => t
  .replace(/\[(laugh|laughs)\]|\((laughs?|laughing)\)/gi, " Ha ha! ").replace(/\[(chuckle|giggle)s?\]|\((chuckles?|giggles?)\)/gi, " Heh. ")
  .replace(/\[sigh\]|\(sighs?\)/gi, " Hmm. ").replace(/\[gasp\]|\(gasps?\)/gi, " Oh! ")
  .replace(/\[[a-z ]{3,14}\]/gi, " ").replace(/\s+/g, " ").trim();

async function speakExpressive(text: string): Promise<Buffer> {
  const r = await xserver();
  xidle();
  const res = await fetch(`http://127.0.0.1:${r.port}/speak`, { method: "POST", headers: { "x-marigold-voice": r.token, "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `expressive voice failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** One-time install of the expressive voice (about 1.5 GB: the model plus Apple's MLX libraries). */
export function setupExpressive() {
  if (xs.setup.active || expressiveInstalled()) return;
  xs.setup = { active: true, step: "Starting", error: "" };
  void (async () => {
    try {
      if (!existsSync(XPY)) {
        xs.setup.step = "Finding Python";
        const py = await pythonFor();
        if (!py) throw new Error("The expressive voice needs Python 3.10–3.13 (brew install python@3.12).");
        xs.setup.step = "Creating the environment";
        await exec(py, ["-m", "venv", path.join(DIR, "venv-tts")], { timeout: 120_000 });
      }
      xs.setup.step = "Installing Apple MLX speech libraries";
      await exec(XPY, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], { timeout: 300_000 });
      await exec(XPY, ["-m", "pip", "install", "--quiet", "mlx-audio", "soundfile"], { timeout: 1_200_000, maxBuffer: 8 * 1024 * 1024 });
      xs.setup.step = "Downloading the expressive voice model (about 1 GB)";
      await exec(XPY, ["-c", `from mlx_audio.tts.utils import load_model; load_model("${XREPO}")`], { timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 });
      await fs.writeFile(XMARK, new Date().toISOString());
      xs.setup.step = "Done";
    } catch (e) {
      xs.setup.error = String(e instanceof Error ? e.message : e).slice(0, 300);
    } finally { xs.setup.active = false; }
  })();
}

const freePort = () => new Promise<number>((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on("error", rej); });

async function start(): Promise<Run> {
  if (!voiceInstalled()) throw new Error("VOICE_NOT_SET_UP");
  // A helper left over from an engine that restarted would hold ~700 MB for nothing: stop it first.
  await exec("pkill", ["-f", "scripts/voice_server.py"]).catch(() => {});
  const port = await freePort(), token = randomBytes(16).toString("hex");
  const proc = spawn(PY, [path.join(process.cwd(), "scripts", "voice_server.py"), "--port", String(port), "--token", token, "--models", MODELS, "--whisper", WHISPER], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr?.on("data", (d) => { err = (err + d).slice(-600); });
  const run: Run = { proc, port, token };
  const stop = () => { try { proc.kill(); } catch { /* gone */ } };
  process.once("exit", stop);
  process.once("SIGTERM", stop);
  proc.on("exit", () => { if (st.run === run) st.run = undefined; });
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`Voice helper stopped: ${err.trim().split("\n").pop() ?? "unknown error"}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-marigold-voice": token }, signal: AbortSignal.timeout(500) }); if (r.ok) return run; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("Voice helper didn't start.");
}

async function server(): Promise<Run> {
  if (st.run && st.run.proc.exitCode === null) return st.run;
  st.starting ??= start().then((r) => (st.run = r)).finally(() => { st.starting = undefined; });
  return st.starting;
}

/** Audio (WAV) → text. */
/** Speech to text WITH times, for whole recordings (a long request: no short timeouts). */
export async function transcribeSegments(wav: Buffer): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  const { Agent, fetch: ufetch } = await import("undici");
  const r = await server();
  const res = await ufetch(`http://127.0.0.1:${r.port}/stt`, { method: "POST", headers: { "x-marigold-voice": r.token, "Content-Type": "audio/wav" }, body: new Uint8Array(wav), dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0 }) });
  const j = (await res.json()) as { text?: string; segments?: { start: number; end: number; text: string }[]; error?: string };
  if (!res.ok) throw new Error(j.error ?? `speech-to-text failed (${res.status})`);
  return { text: (j.text ?? "").trim(), segments: j.segments ?? [] };
}

export async function transcribe(wav: Buffer): Promise<string> {
  const r = await server();
  const res = await fetch(`http://127.0.0.1:${r.port}/stt`, { method: "POST", headers: { "x-marigold-voice": r.token, "Content-Type": "audio/wav" }, body: new Uint8Array(wav), signal: AbortSignal.timeout(120_000) });
  const j = (await res.json()) as { text?: string; error?: string };
  if (!res.ok) throw new Error(j.error ?? `speech-to-text failed (${res.status})`);
  return (j.text ?? "").trim();
}

/** Text → spoken audio (WAV). */
export async function speak(text: string, voice = "af_heart", speed = 1, expressive = false): Promise<Buffer> {
  if (expressive && expressiveInstalled()) {
    try { return await speakExpressive(text); } catch { /* fall back to the plain voice below */ }
  }
  text = plainTags(text) || text;
  const r = await server();
  const res = await fetch(`http://127.0.0.1:${r.port}/tts`, { method: "POST", headers: { "x-marigold-voice": r.token, "Content-Type": "application/json" }, body: JSON.stringify({ text, voice, speed }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `text-to-speech failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------- one-time setup

async function pythonFor(): Promise<string | null> {
  for (const c of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
    try {
      const { stdout } = await exec("/bin/zsh", ["-lc", `command -v ${c} && ${c} -c "import sys;print(sys.version_info[0]*100+sys.version_info[1])"`], { timeout: 10_000 });
      const [p, v] = stdout.trim().split("\n");
      if (p && Number(v) >= 310 && Number(v) < 314) return p;
    } catch { /* next */ }
  }
  return null;
}

async function download(url: string, to: string) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}): ${url.split("/").pop()}`);
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(to));
}

/** Install the helper's packages + models in the background. Safe to call repeatedly. */
export function setupVoice() {
  if (st.setup.active || voiceInstalled()) return;
  st.setup = { active: true, step: "Starting", error: "" };
  void (async () => {
    try {
      await fs.mkdir(MODELS, { recursive: true });
      if (!existsSync(PY)) {
        st.setup.step = "Finding Python";
        const py = await pythonFor();
        if (!py) throw new Error("Voice needs Python 3.10–3.13. Install it once (brew install python@3.12), then try again.");
        st.setup.step = "Creating the voice environment";
        await exec(py, ["-m", "venv", path.join(DIR, "venv")], { timeout: 120_000 });
      }
      st.setup.step = "Installing speech libraries (about 250 MB)";
      await exec(PY, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], { timeout: 300_000 });
      await exec(PY, ["-m", "pip", "install", "--quiet", "kokoro-onnx", "faster-whisper", "soundfile", "numpy"], { timeout: 900_000, maxBuffer: 8 * 1024 * 1024 });
      if (!existsSync(path.join(MODELS, "kokoro.onnx"))) { st.setup.step = "Downloading the voice model (90 MB)"; await download(`${KOKORO}/kokoro-v1.0.int8.onnx`, path.join(MODELS, "kokoro.onnx")); }
      if (!existsSync(path.join(MODELS, "voices.bin"))) { st.setup.step = "Downloading the voices (28 MB)"; await download(`${KOKORO}/voices-v1.0.bin`, path.join(MODELS, "voices.bin")); }
      st.setup.step = "Downloading the listening model (480 MB)";
      await exec(PY, ["-c", `from faster_whisper import WhisperModel; WhisperModel("${WHISPER}", device="cpu", compute_type="int8", download_root=r"${path.join(MODELS, "whisper")}")`], { timeout: 1_800_000 });
      st.setup.step = "Done";
    } catch (e) {
      st.setup.error = String(e instanceof Error ? e.message : e).slice(0, 300);
    } finally { st.setup.active = false; }
  })();
}
