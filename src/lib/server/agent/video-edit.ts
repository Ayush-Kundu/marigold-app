import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Video Studio: real editing with ffmpeg (on this Mac) plus Whisper for the words. Everything is a NEW file next to the original
 * (nothing is ever overwritten), so every edit can be undone by deleting the result.
 *
 *   probe · frames (a few pictures the AI can look at) · transcribe (words with times) · silence (dry run first) ·
 *   cut (keep these parts / remove these parts, preview first) · trim · concat · speed · reframe (9:16, 1:1…) ·
 *   captions (burned in, from the transcript) · normalize (loudness) · extract_audio · export (presets)
 *
 * The AI proposes an edit in words and times, the user says what to change, a quick preview is rendered, and only then the full one.
 */

const run = promisify(execFile);
export interface Seg { start: number; end: number; text: string }
export interface VideoDeps {
  /** Why a path is off-limits (keys, keychains…), or undefined. */
  sensitive: (p: string) => string | undefined;
  /** Whisper on this Mac for one WAV: the text and its timed segments. */
  transcribe: (wav: Buffer) => Promise<{ text: string; segments: Seg[] }>;
  /** Pictures to hand to the model with its next step. */
  queueImages: (urls: string[]) => void;
}

const bin = (name: "ffmpeg" | "ffprobe") => ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"].map((d) => d + name).find((p) => existsSync(p)) ?? name;
const hms = (s: number) => { const t = Math.max(0, Math.round(s)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(t % 60).padStart(2, "0")}`; };
const MEDIA = /\.(mp4|mov|m4v|mkv|avi|webm|mpg|mpeg|mts|m2ts|mp3|m4a|wav|aac|flac|ogg)$/i;
const AUDIO_ONLY = /\.(mp3|m4a|wav|aac|flac|ogg)$/i;

export class VideoError extends Error {}
const fail = (m: string): never => { throw new VideoError(m); };

async function ff(args: string[], opts: { timeout?: number; cwd?: string } = {}): Promise<{ out: string; err: string }> {
  try {
    const r = await run(bin("ffmpeg"), ["-hide_banner", "-nostdin", ...args], { timeout: opts.timeout ?? 1_800_000, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
    return { out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { stderr?: string; message?: string; code?: string };
    if (x.code === "ENOENT") return fail("ffmpeg isn't installed. Ask the user to install it (brew install ffmpeg), or offer to run that for them.");
    const tail = String(x.stderr ?? x.message ?? "").trim().split("\n").slice(-6).join("\n");
    return fail(`ffmpeg failed:\n${tail}`);
  }
}

function resolveIn(p: string, d: VideoDeps): string {
  const file = path.resolve((p || "").replace(/^~(?=\/|$)/, os.homedir()));
  const why = d.sensitive(file);
  if (why) fail(`That path is off limits (${why}).`);
  if (!existsSync(file)) fail(`I can't find ${p}. Give the full path of the file.`);
  if (!MEDIA.test(file)) fail("That isn't a video or audio file I know how to edit (mp4, mov, mkv, m4v, webm, mp3, wav…).");
  return file;
}
/** A new file next to the original; never an existing one. */
function outPath(src: string, suffix: string, ext: string, wanted?: string): string {
  const dir = path.dirname(src), base = path.basename(src, path.extname(src));
  let p = wanted ? path.resolve(wanted.replace(/^~(?=\/|$)/, os.homedir())) : path.join(dir, `${base}-${suffix}${ext}`);
  const e = path.extname(p), stem = p.slice(0, p.length - e.length);
  for (let i = 2; existsSync(p); i++) p = `${stem}-${i}${e}`;
  return p;
}
const mb = async (f: string) => `${((await fs.stat(f)).size / 1048576).toFixed(1)} MB`;

export interface Info { duration: number; width: number; height: number; fps: number; hasAudio: boolean; hasVideo: boolean; text: string }
export async function probe(file: string): Promise<Info> {
  let json: { format?: { duration?: string; size?: string; bit_rate?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }[] };
  try {
    const r = await run(bin("ffprobe"), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 16 * 1024 * 1024 });
    json = JSON.parse(r.stdout);
  } catch (e) { return fail((e as { code?: string }).code === "ENOENT" ? "ffmpeg isn't installed (brew install ffmpeg)." : "Couldn't read that file. It may be damaged or not a media file."); }
  const v = json.streams?.find((s) => s.codec_type === "video" && s.width), a = json.streams?.find((s) => s.codec_type === "audio");
  const [n, dn] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  const info: Info = { duration: Number(json.format?.duration ?? 0), width: v?.width ?? 0, height: v?.height ?? 0, fps: dn ? n / dn : 0, hasAudio: !!a, hasVideo: !!v, text: "" };
  info.text = `${path.basename(file)}: ${hms(info.duration)} (${info.duration.toFixed(1)} s), ${json.format?.size ? `${(Number(json.format.size) / 1048576).toFixed(1)} MB, ` : ""}${v ? `${v.width}×${v.height} ${v.codec_name} at ${info.fps.toFixed(2)} fps` : "no video"}${a ? `, audio ${a.codec_name} ${a.channels}ch ${a.sample_rate} Hz` : ", no audio"}`;
  return info;
}

/** Render these parts (in order) as one new file. */
async function render(src: string, info: Info, keeps: [number, number][], out: string, opts: { preview?: boolean; extraVideo?: string; extraArgs?: string[] } = {}): Promise<void> {
  if (!keeps.length) fail("There is nothing left to keep.");
  if (keeps.length > 300) fail("That's more than 300 separate pieces; ask for bigger pieces (or a higher minimum silence).");
  const parts: string[] = [];
  keeps.forEach(([a, b], i) => {
    if (info.hasVideo) parts.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    if (info.hasAudio) parts.push(`[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const pairs = keeps.map((_, i) => `${info.hasVideo ? `[v${i}]` : ""}${info.hasAudio ? `[a${i}]` : ""}`).join("");
  const post = [opts.preview && info.hasVideo ? "scale=640:-2" : "", opts.extraVideo ?? ""].filter(Boolean).join(",");
  const graph = [...parts, `${pairs}concat=n=${keeps.length}:v=${info.hasVideo ? 1 : 0}:a=${info.hasAudio ? 1 : 0}${info.hasVideo ? "[vc]" : ""}${info.hasAudio ? "[ac]" : ""}`, ...(info.hasVideo ? [`[vc]${post || "null"}[vo]`] : [])].join(";");
  const maps = [...(info.hasVideo ? ["-map", "[vo]"] : []), ...(info.hasAudio ? ["-map", "[ac]"] : [])];
  const enc = info.hasVideo
    ? ["-c:v", "libx264", "-preset", opts.preview ? "ultrafast" : "medium", "-crf", opts.preview ? "30" : "20", "-pix_fmt", "yuv420p", ...(info.hasAudio ? ["-c:a", "aac", "-b:a", opts.preview ? "96k" : "160k"] : []), "-movflags", "+faststart"]
    : ["-c:a", AUDIO_ONLY.test(out) && /\.mp3$/i.test(out) ? "libmp3lame" : "aac", "-b:a", "160k"];
  await ff(["-n", "-i", src, "-filter_complex", graph, ...maps, ...enc, ...(opts.extraArgs ?? []), out]);
}

const merge = (segs: [number, number][], gap = 0.05): [number, number][] => {
  const out: [number, number][] = [];
  for (const [a, b] of [...segs].sort((x, y) => x[0] - y[0])) { const l = out[out.length - 1]; if (l && a <= l[1] + gap) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
};
const invert = (remove: [number, number][], total: number): [number, number][] => {
  const keeps: [number, number][] = []; let at = 0;
  for (const [a, b] of merge(remove.map(([x, y]) => [Math.max(0, x), Math.min(total, y)] as [number, number]).filter(([x, y]) => y > x))) { if (a > at + 0.05) keeps.push([at, a]); at = Math.max(at, b); }
  if (total > at + 0.05) keeps.push([at, total]);
  return keeps;
};
export const parseTime = (v: unknown): number => {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const p = s.split(":").map(Number);
  if (p.some((x) => !Number.isFinite(x))) return fail(`I can't read the time “${s}”. Use seconds (90) or minutes:seconds (1:30).`);
  return p.reduce((t, x) => t * 60 + x, 0);
};
type Range = { start: unknown; end: unknown };
const ranges = (v: unknown, what: string): [number, number][] => {
  if (!Array.isArray(v) || !v.length) return fail(`${what} needs a list like [{"start":"0:10","end":"0:45"}].`);
  return (v as Range[]).map((r) => { const a = parseTime(r.start), b = parseTime(r.end); if (!(b > a)) fail(`A range ends before it starts (${r.start} → ${r.end}).`); return [a, b] as [number, number]; });
};

// ---------------------------------------------------------------- transcript (cached)
export async function transcript(file: string, d: VideoDeps, maxMinutes = 45): Promise<Seg[]> {
  const st = await fs.stat(file);
  const key = createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
  const dir = path.join(os.homedir(), ".marigold", "video"); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const cache = path.join(dir, `${key}.json`);
  try { return JSON.parse(await fs.readFile(cache, "utf8")) as Seg[]; } catch { /* not yet */ }
  const info = await probe(file);
  if (!info.hasAudio) return fail("That file has no audio to transcribe.");
  if (info.duration > maxMinutes * 60) fail(`That's ${hms(info.duration)} long; I transcribe up to ${maxMinutes} minutes at once. Trim it first, or ask for a shorter range.`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "marigold-asr-"));
  try {
    await ff(["-n", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", "300", path.join(tmp, "a%03d.wav")]);
    const chunks = (await fs.readdir(tmp)).filter((f) => f.endsWith(".wav")).sort();
    const all: Seg[] = [];
    for (const [i, f] of chunks.entries()) {
      const r = await d.transcribe(await fs.readFile(path.join(tmp, f)));
      for (const s of r.segments) if (s.text.trim()) all.push({ start: s.start + i * 300, end: s.end + i * 300, text: s.text.trim() });
    }
    await fs.writeFile(cache, JSON.stringify(all), { mode: 0o600 });
    return all;
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
const fmtSrt = (t: number) => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
function toSrt(segs: Seg[]): string {
  const out: string[] = []; let n = 1;
  for (const s of segs) {
    const words = s.text.split(/\s+/); const lines: string[] = []; let cur = "";
    for (const w of words) { if ((cur + " " + w).trim().length > 38) { lines.push(cur.trim()); cur = w; } else cur = `${cur} ${w}`; }
    if (cur.trim()) lines.push(cur.trim());
    // two lines at a time, the segment's time shared by how much text each card holds
    const cards: string[] = []; for (let i = 0; i < lines.length; i += 2) cards.push(lines.slice(i, i + 2).join("\n"));
    const total = cards.reduce((a, c) => a + c.length, 0) || 1; let t = s.start;
    for (const c of cards) { const dur = ((s.end - s.start) * c.length) / total; out.push(`${n++}\n${fmtSrt(t)} --> ${fmtSrt(t + dur)}\n${c}\n`); t += dur; }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- the tool
export interface VideoArgs {
  action: string; file?: string; files?: string[]; out?: string; start?: unknown; end?: unknown; times?: string; count?: number;
  keep?: unknown; remove?: unknown; preview?: boolean; apply?: boolean; min_seconds?: number; noise_db?: number; factor?: number; aspect?: string; burn_in?: boolean; preset?: string; format?: string;
}

export async function videoEdit(a: VideoArgs, d: VideoDeps): Promise<string> {
  try {
    switch (a.action) {
      case "probe": return (await probe(resolveIn(a.file ?? "", d))).text;

      case "frames": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        if (!info.hasVideo) fail("That file has no picture.");
        const n = Math.min(8, Math.max(1, a.count ?? 6));
        const at = a.times ? a.times.split(",").map((t) => parseTime(t)) : Array.from({ length: n }, (_, i) => (info.duration * (i + 0.5)) / n);
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marigold-frames-")); const urls: string[] = []; const lines: string[] = [];
        for (const t of at.slice(0, 8)) {
          const f = path.join(dir, `f${urls.length}.jpg`);
          await ff(["-n", "-ss", Math.max(0, Math.min(info.duration - 0.1, t)).toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", f], { timeout: 60_000 });
          urls.push(`data:image/jpeg;base64,${(await fs.readFile(f)).toString("base64")}`); lines.push(`frame ${urls.length}: ${hms(t)}`);
        }
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        d.queueImages(urls);
        return `Took ${urls.length} frames (${lines.join(", ")}). The pictures come with your next step: look at them and describe what is on screen before you suggest edits.`;
      }

      case "transcribe": {
        const file = resolveIn(a.file ?? "", d);
        const segs = await transcript(file, d);
        if (!segs.length) return "No speech was found in that file.";
        const text = segs.map((s) => `[${hms(s.start)}] ${s.text}`).join("\n");
        return `Transcript (${segs.length} segments, saved so repeats are instant):\n${text.length > 30_000 ? `${text.slice(0, 30_000)}\n[cut: the rest is long; ask for a range]` : text}`;
      }

      case "silence": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        if (!info.hasAudio) fail("That file has no audio.");
        const minS = Math.max(0.2, a.min_seconds ?? 0.7), db = Math.min(-15, Math.max(-60, a.noise_db ?? -35));
        const r = await ff(["-i", file, "-af", `silencedetect=noise=${db}dB:d=${minS}`, "-f", "null", "-"]);
        const starts = [...r.err.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
        const ends = [...r.err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
        const sil: [number, number][] = starts.map((s, i) => [s + 0.15, (ends[i] ?? info.duration) - 0.15] as [number, number]).filter(([x, y]) => y - x > 0.2); // keep a breath at each cut
        const removed = sil.reduce((t, [x, y]) => t + (y - x), 0);
        const summary = `${sil.length} silent stretches of ${minS}s or more (about ${hms(removed)} in total) in ${hms(info.duration)}. The longest: ${[...sil].sort((x, y) => y[1] - y[0] - (x[1] - x[0])).slice(0, 6).map(([x, y]) => `${hms(x)}–${hms(y)}`).join(", ") || "none"}.`;
        if (!a.apply) return `${summary}\nThis was a dry run: nothing was written. Tell the user, and if they agree call silence again with apply=true (add preview=true for a quick low-quality preview first).`;
        const keeps = invert(sil, info.duration); const out = outPath(file, a.preview ? "nosilence-preview" : "nosilence", info.hasVideo ? ".mp4" : ".m4a", a.out);
        await render(file, info, keeps, out, { preview: a.preview });
        return `${summary}\nWrote ${out} (${await mb(out)}, about ${hms(info.duration - removed)} long).`;
      }

      case "cut": case "trim": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        const keeps = a.action === "trim" ? [[parseTime(a.start ?? 0), a.end === undefined ? info.duration : parseTime(a.end)] as [number, number]]
          : a.keep ? merge(ranges(a.keep, "keep")) : invert(ranges(a.remove, "remove or keep"), info.duration);
        for (const [x, y] of keeps) if (x >= info.duration) fail(`${hms(x)} is past the end (${hms(info.duration)}).`);
        const total = keeps.reduce((t, [x, y]) => t + (Math.min(y, info.duration) - x), 0);
        const out = outPath(file, a.preview ? "cut-preview" : a.action === "trim" ? "trim" : "cut", info.hasVideo ? ".mp4" : ".m4a", a.out);
        await render(file, info, keeps.map(([x, y]) => [x, Math.min(y, info.duration)] as [number, number]), out, { preview: a.preview });
        return `Wrote ${out} (${await mb(out)}, ${hms(total)} long, from ${keeps.length} piece${keeps.length > 1 ? "s" : ""}).${a.preview ? " This is a small, fast preview. Show the user, take their changes, then render the full one." : ""}`;
      }

      case "concat": {
        const files = (a.files ?? []).map((f) => resolveIn(f, d));
        if (files.length < 2) fail("concat needs at least two files in `files`.");
        const first = await probe(files[0]); const W = (first.width || 1920) - ((first.width || 1920) % 2), H = (first.height || 1080) - ((first.height || 1080) % 2);
        const infos = await Promise.all(files.map(probe));
        const graph = infos.map((n, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}];${n.hasAudio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=0:${n.duration.toFixed(3)}[a${i}]`}`).join(";")
          + `;${infos.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${files.length}:v=1:a=1[v][a]`;
        const out = outPath(files[0], "joined", ".mp4", a.out);
        await ff(["-n", ...files.flatMap((f) => ["-i", f]), "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
        return `Wrote ${out} (${await mb(out)}) from ${files.length} clips, all at ${W}×${H}.`;
      }

      case "speed": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file); const f = Number(a.factor);
        if (!(f >= 0.25 && f <= 4)) fail("factor must be between 0.25 and 4 (2 = twice as fast).");
        let at = f; const chain: string[] = []; while (at > 2) { chain.push("atempo=2"); at /= 2; } while (at < 0.5) { chain.push("atempo=0.5"); at /= 0.5; } chain.push(`atempo=${at.toFixed(4)}`);
        const out = outPath(file, `${f}x`, info.hasVideo ? ".mp4" : ".m4a", a.out);
        await ff(["-n", "-i", file, ...(info.hasVideo ? ["-filter:v", `setpts=PTS/${f}`] : []), ...(info.hasAudio ? ["-filter:a", chain.join(",")] : []), ...(info.hasVideo ? ["-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"] : []), out]);
        return `Wrote ${out} (${await mb(out)}) at ${f}× speed.`;
      }

      case "reframe": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        const m = String(a.aspect ?? "").match(/^(\d+):(\d+)$/); if (!m) fail("aspect must look like 9:16, 1:1, 4:5 or 16:9.");
        const [aw, ah] = [Number(m![1]), Number(m![2])]; const out = outPath(file, `${aw}x${ah}`, ".mp4", a.out);
        const long = 1080, W = aw >= ah ? Math.round((long * aw) / ah / 2) * 2 : long, H = aw >= ah ? long : Math.round((long * ah) / aw / 2) * 2;
        await ff(["-n", "-i", file, "-vf", `crop='min(iw,ih*${aw}/${ah})':'min(ih,iw*${ah}/${aw})',scale=${W}:${H},setsar=1`, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : []), "-movflags", "+faststart", out]);
        return `Wrote ${out} (${await mb(out)}) as ${aw}:${ah} (${W}×${H}), cropped to the centre.`;
      }

      case "captions": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        const segs = await transcript(file, d);
        if (!segs.length) fail("No speech was found, so there is nothing to caption.");
        const srt = outPath(file, "captions", ".srt"); await fs.writeFile(srt, toSrt(segs), "utf8");
        if (a.burn_in === false || !info.hasVideo) return `Wrote ${srt} (${segs.length} caption groups). Open it in any editor, or ask me to burn it into the video.`;
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "marigold-cap-")); await fs.copyFile(srt, path.join(tmp, "cap.srt"));
        const out = outPath(file, "captioned", ".mp4", a.out);
        try { await ff(["-n", "-i", file, "-vf", `subtitles=cap.srt:force_style='FontSize=22,Outline=2,Shadow=0,MarginV=36'`, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out], { cwd: tmp }); }
        finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
        return `Wrote ${out} (${await mb(out)}) with captions burned in, and ${srt} to edit them separately.`;
      }

      case "normalize": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        if (!info.hasAudio) fail("That file has no audio.");
        const out = outPath(file, "levelled", info.hasVideo ? ".mp4" : ".m4a", a.out);
        await ff(["-n", "-i", file, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", ...(info.hasVideo ? ["-c:v", "copy"] : []), "-c:a", "aac", "-b:a", "192k", out]);
        return `Wrote ${out} (${await mb(out)}) with the sound levelled to a standard loudness (-16 LUFS).`;
      }

      case "extract_audio": {
        const file = resolveIn(a.file ?? "", d); const fmt = a.format === "mp3" ? "mp3" : "m4a";
        const out = outPath(file, "audio", `.${fmt}`, a.out);
        await ff(["-n", "-i", file, "-vn", ...(fmt === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"] : ["-c:a", "aac", "-b:a", "192k"]), out]);
        return `Wrote ${out} (${await mb(out)}).`;
      }

      case "export": {
        const file = resolveIn(a.file ?? "", d); const info = await probe(file);
        const presets: Record<string, { vf: string; crf: string; tag: string }> = { youtube: { vf: "scale=-2:'min(1080,ih)'", crf: "18", tag: "youtube-1080p" }, small: { vf: "scale=-2:'min(720,ih)'", crf: "28", tag: "small-720p" }, web: { vf: "scale=-2:'min(720,ih)'", crf: "23", tag: "web-720p" } };
        const p = presets[a.preset ?? "youtube"]; if (!p) fail("preset must be youtube, web or small.");
        const out = outPath(file, p.tag, ".mp4", a.out);
        await ff(["-n", "-i", file, "-vf", p.vf, "-c:v", "libx264", "-preset", "medium", "-crf", p.crf, "-pix_fmt", "yuv420p", ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : []), "-movflags", "+faststart", out]);
        return `Wrote ${out} (${await mb(out)}) with the ${a.preset ?? "youtube"} preset.`;
      }
    }
    return fail(`Unknown video action “${a.action}”.`);
  } catch (e) {
    return `FAILED: ${e instanceof VideoError ? e.message : (e as Error).message}`;
  }
}
