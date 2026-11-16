import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";
import { helperBin } from "./helpers";

/**
 * Files the user attaches in chat (the + button, drag-and-drop, paste, screenshots). Saved under
 * ~/.marigold/uploads/<id>/, then "read" on this Mac so the agent knows what's in them:
 *   • pictures → Apple Vision (text in the image, what it shows, faces, QR codes) — and, when a cloud
 *     model is on, the picture itself so it can describe and reason about it;
 *   • PDFs → their text (scanned pages are read with text recognition);
 *   • Word / RTF / HTML / text / code / CSV → their text.
 */

const exec = promisify(execFile);
export const UPLOADS = path.join(MARIGOLD_DIR, "uploads");
export const MAX_UPLOAD = 50 * 1024 * 1024;

export type AttKind = "image" | "pdf" | "text" | "doc" | "audio" | "video" | "other";
export interface Attachment { id: string; name: string; mime: string; kind: AttKind; size: number; path: string }

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|toml|ini|log|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|swift|kt|sh|zsh|sql|html?|css|scss|tex|rtf)$/i;
const DOC_EXT = /\.(docx?|rtfd?|odt|webarchive|html?)$/i;

export function kindOf(name: string, mime: string): AttKind {
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^audio\//.test(mime) || /\.(mp3|m4a|wav|aac|flac|aiff)$/i.test(name)) return "audio";
  if (/^video\//.test(mime) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) return "video";
  if (DOC_EXT.test(name) && !/\.html?$/i.test(name)) return "doc";
  if (/^text\//.test(mime) || TEXT_EXT.test(name)) return "text";
  return "other";
}

const safeName = (n: string) => (n.replace(/[/\\:\0]/g, "_").replace(/^\.+/, "").trim().slice(0, 120) || "file");

export async function saveUpload(name: string, mime: string, buf: Buffer): Promise<Attachment> {
  if (buf.length > MAX_UPLOAD) throw new Error("That file is over 50 MB.");
  const id = randomBytes(6).toString("hex");
  const dir = path.join(UPLOADS, id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const clean = safeName(name);
  const file = path.join(dir, clean);
  await fs.writeFile(file, buf, { mode: 0o600 });
  return { id, name: clean, mime: mime || "application/octet-stream", kind: kindOf(clean, mime), size: buf.length, path: file };
}

/** Find an upload by id (the id is hex only, so it can't point outside the uploads folder). */
export async function getUpload(id: string): Promise<Attachment | null> {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  const dir = path.join(UPLOADS, id);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const name = files[0];
  if (!name) return null;
  const file = path.join(dir, name);
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  const ext = path.extname(name).toLowerCase().slice(1);
  const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json" } as Record<string, string>)[ext] ?? "application/octet-stream";
  return { id, name, mime, kind: kindOf(name, mime), size: st.size, path: file };
}

async function docread(mode: "image" | "pdf", file: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec(await helperBin("docread"), [mode, file], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout || "{}");
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n…[cut: ${t.length - n} more characters in the file]` : t);

/** What the agent is told about one attachment (always names the path, so it can open / move / use the file itself). */
export async function describeAttachment(a: Attachment): Promise<string> {
  const head = `“${a.name}” (${a.kind}, ${a.size > 1e6 ? (a.size / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(a.size / 1e3)) + " KB"}) saved at ${a.path}`;
  try {
    if (a.kind === "image") {
      const j = (await docread("image", a.path)) as { error?: string; width?: number; height?: number; text?: string; labels?: { label: string; confidence: number }[]; faces?: number; codes?: string[] };
      if (j.error) return `${head}\nCouldn't read the image: ${j.error}`;
      const bits = [
        `${j.width}×${j.height} picture`,
        j.labels?.length ? `looks like: ${j.labels.slice(0, 5).map((l) => `${l.label} (${Math.round(l.confidence * 100)}%)`).join(", ")}` : "",
        j.faces ? `${j.faces} face${j.faces > 1 ? "s" : ""} detected` : "",
        j.codes?.length ? `QR/barcode: ${j.codes.join(" | ")}` : "",
      ].filter(Boolean).join("; ");
      return `${head}\nImage analysis (on-device): ${bits}.${j.text?.trim() ? `\nText in the image:\n${clip(j.text.trim(), 4000)}` : "\n(No readable text in it.)"}`;
    }
    if (a.kind === "pdf") {
      const j = (await docread("pdf", a.path)) as { error?: string; pages?: number; text?: string };
      if (j.error) return `${head}\nCouldn't read the PDF: ${j.error}`;
      return `${head}\n${j.pages} page${j.pages === 1 ? "" : "s"}. Text:\n${clip((j.text ?? "").trim() || "(no text found)", 9000)}`;
    }
    if (a.kind === "doc") {
      const { stdout } = await exec("textutil", ["-convert", "txt", "-stdout", a.path], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return `${head}\nText:\n${clip(stdout.trim() || "(empty)", 9000)}`;
    }
    if (a.kind === "text") {
      const t = await fs.readFile(a.path, "utf8");
      return `${head}\nContents:\n${clip(t, 12000)}`;
    }
  } catch (e) {
    return `${head}\nCouldn't read it: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
  }
  return `${head}\n(${a.kind === "audio" || a.kind === "video" ? "Audio/video isn't transcribed yet" : "Binary file"}; use the files tools if you need to move, copy or open it.)`;
}

/** A picture shrunk for a vision model (max 1568 px, JPEG) as a data URL, or null. */
export async function imageDataUrl(a: Attachment): Promise<string | null> {
  if (a.kind !== "image") return null;
  const tmp = path.join(os.tmpdir(), `marigold-vision-${a.id}.jpg`);
  try {
    await exec("sips", ["-Z", "1568", "-s", "format", "jpeg", "-s", "formatOptions", "78", a.path, "--out", tmp], { timeout: 20_000 });
    const buf = await fs.readFile(tmp);
    return buf.length > 4_500_000 ? null : `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch { return null; } finally { await fs.unlink(tmp).catch(() => {}); }
}
