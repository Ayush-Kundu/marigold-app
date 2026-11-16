import { createDecipheriv, scryptSync } from "crypto";
import { existsSync, readFileSync } from "fs";
import { saveCloudConfig, type CloudMode } from "./cloud";
import { saveTavilyKey } from "./summarize";

/**
 * Tester pack: a file the owner sends with a separate passphrase. Format: "MGP1" | salt(16) | iv(12) | tag(16) | ciphertext,
 * AES-256-GCM, key = scrypt(passphrase, salt). The plaintext is JSON { k, base, model, fast?, mode } — it is stored in the
 * Keychain / cloud.json and never returned to the page.
 */
export async function importPack(buf: Buffer, pass: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (buf.length < 50 || buf.subarray(0, 4).toString() !== "MGP1") return { ok: false, error: "That isn't a Marigold file." };
    const salt = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(32, 48), data = buf.subarray(48);
    const d = createDecipheriv("aes-256-gcm", scryptSync(pass, salt, 32), iv);
    d.setAuthTag(tag);
    const j = JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
    if (typeof j.k !== "string" || !/^https:\/\//.test(j.base)) return { ok: false, error: "The file is damaged." };
    if (typeof j.tavily === "string" && /^tvly-/.test(j.tavily)) await saveTavilyKey(j.tavily);
    await saveCloudConfig({ mode: (j.mode as CloudMode) || "always", baseUrl: j.base, model: j.model, ...(j.fast ? { fastModel: j.fast } : {}) }, j.k);
    return { ok: true };
  } catch { return { ok: false, error: "Wrong passphrase, or the file is damaged." }; }
}

/** The invite that ships inside the app (Resources/invite.dat): encrypted, opened only with the invite code the user types. */
const bundled = () => (process.env.MARIGOLD_RESOURCES ? `${process.env.MARIGOLD_RESOURCES}/invite.dat` : "");
export const inviteAvailable = () => { const f = bundled(); return !!f && existsSync(f); };
export async function importBundledInvite(code: string) {
  if (!inviteAvailable()) return { ok: false, error: "This copy of Marigold has no invite inside it." };
  return importPack(readFileSync(bundled()), code.trim());
}
