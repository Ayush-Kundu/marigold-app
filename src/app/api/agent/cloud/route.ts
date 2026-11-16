import { localOnly } from "@/lib/server/agent/guard";
import { PRESETS, presetForKey, cloudConfig, cloudReachable, hasCloudKey, saveCloudConfig, testCloud, type CloudMode } from "@/lib/server/agent/cloud";

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  return Response.json({ ...cloudConfig(), hasKey: await hasCloudKey(), online: await cloudReachable(), presets: PRESETS });
}

/** POST { mode?, preset?, baseUrl?, model?, apiKey? }  or  { action: "test" } */
export async function POST(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const b = await req.json().catch(() => ({}));
  if (b.action === "test") return Response.json(await testCloud());
  const guessed = typeof b.apiKey === "string" ? presetForKey(b.apiKey) : null; // an Abacus key always goes to Abacus, whatever the dropdown said
  const preset = PRESETS[guessed ?? String(b.preset ?? "")];
  const mode = (["off", "plan", "complex", "always"] as CloudMode[]).includes(b.mode) ? (b.mode as CloudMode) : undefined;
  const baseUrl = typeof b.baseUrl === "string" && /^https:\/\//.test(b.baseUrl) ? b.baseUrl.replace(/\/$/, "") : preset?.baseUrl;
  const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : preset?.model;
  const fastModel = typeof b.fastModel === "string" ? b.fastModel.trim() : undefined;
  await saveCloudConfig({ ...(mode ? { mode } : {}), ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}), ...(fastModel !== undefined ? { fastModel } : {}) }, typeof b.apiKey === "string" && b.apiKey.length > 10 ? b.apiKey : undefined);
  return Response.json({ ok: true, ...cloudConfig(), hasKey: await hasCloudKey() });
}
