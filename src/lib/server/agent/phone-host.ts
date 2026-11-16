import { spawn, execFile } from "child_process";
import { promises as fs, existsSync } from "fs";
import crypto from "crypto";
import net from "net";
import os from "os";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";

/**
 * Runs the Marigold phone app for the user's iPhone from inside Marigold, so nothing is typed in Terminal:
 * the phone server starts by itself (behind a PIN that never changes, so the phone stays signed in), Tailscale (private
 * network + real https) is switched on for it when installed, and Settings shows ONE QR code that opens the app signed in.
 * The phone can ask and see tabs; it can't drive the Mac (see /api/agent/phone).
 */
const exec = promisify(execFile);
const PORT = 3200;
const LAN_PORT = 3443;
const TLS_DIR = path.join(MARIGOLD_DIR, "phone-tls");
const PIN_FILE = path.join(MARIGOLD_DIR, "phone-pin");
const ON_FILE = path.join(MARIGOLD_DIR, "phone-host-on");
const g = globalThis as unknown as { __mgPhoneHost?: { child?: ReturnType<typeof spawn>; building?: boolean; log: string } };
const H = (g.__mgPhoneHost ??= { log: "" });

/** Where the phone app lives: next to the Mac app's resources (shipped), or the developer's own folder. */
function phoneDir(): string | null {
  const c = [process.env.MARIGOLD_PHONE_DIR, process.env.MARIGOLD_RESOURCES && path.join(process.env.MARIGOLD_RESOURCES, "phone"), path.join(os.homedir(), "Developer", "marigold-phone")].filter(Boolean) as string[];
  return c.find((d) => existsSync(path.join(d, "package.json"))) ?? null;
}
async function pin(): Promise<string> {
  try { const p = (await fs.readFile(PIN_FILE, "utf8")).trim(); if (/^\d{6}$/.test(p)) return p; } catch { /* make one */ }
  const p = String(crypto.randomInt(100000, 1000000));
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(PIN_FILE, p, { mode: 0o600 });
  return p;
}
async function listening(): Promise<boolean> {
  return fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
}
function tailscaleBin(): string | null {
  return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"].find((p) => existsSync(p)) ?? null;
}
async function tailnetName(bin: string): Promise<string> {
  try {
    const j = JSON.parse((await exec(bin, ["status", "--json"], { timeout: 6000 })).stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    return j.BackendState === "Running" ? (j.Self?.DNSName ?? "").replace(/\.$/, "") : "";
  } catch { return ""; }
}

export const phoneHostWanted = () => existsSync(ON_FILE);

/** Has any phone-app source file changed since it was last built? (Then the build is stale and is redone.) */
async function newerThanBuild(dir: string): Promise<boolean> {
  try {
    const built = (await fs.stat(path.join(dir, ".next", "BUILD_ID"))).mtimeMs;
    const walk = async (d: string): Promise<boolean> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { if (await walk(f)) return true; }
        else if ((await fs.stat(f)).mtimeMs > built) return true;
      }
      return false;
    };
    return (await walk(path.join(dir, "src"))) || (await fs.stat(path.join(dir, "package.json"))).mtimeMs > built;
  } catch { return false; }
}


// ---------------------------------------------------------------- the home Wi-Fi way (no Tailscale)

const opensslBin = () => ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"].find((p) => existsSync(p)) ?? "openssl";
/** Marigold's own certificate for the phone link. The iPhone app trusts exactly this one (by its fingerprint), so no outside authority is involved. */
async function lanCert(): Promise<{ key: string; cert: string; fp: string } | null> {
  const key = path.join(TLS_DIR, "key.pem"), cert = path.join(TLS_DIR, "cert.pem");
  try {
    if (!existsSync(key) || !existsSync(cert)) {
      await fs.mkdir(TLS_DIR, { recursive: true, mode: 0o700 });
      await exec(opensslBin(), ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "3650", "-subj", "/CN=Marigold phone link"], { timeout: 20_000 });
      await fs.chmod(key, 0o600);
    }
    const out = (await exec(opensslBin(), ["x509", "-in", cert, "-noout", "-fingerprint", "-sha256"], { timeout: 8000 })).stdout;
    const fp = out.split("=")[1]?.trim().replace(/:/g, "").toLowerCase() ?? "";
    return /^[0-9a-f]{64}$/.test(fp) ? { key, cert, fp } : null;
  } catch { return null; }
}
async function lanListening(): Promise<boolean> {
  return new Promise((res) => { const s = net.connect({ host: "127.0.0.1", port: LAN_PORT, timeout: 1200 }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); });
}
const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "";
async function macLocalName(): Promise<string> {
  try { const n = (await exec("scutil", ["--get", "LocalHostName"], { timeout: 3000 })).stdout.trim(); return n ? `${n}.local` : ""; } catch { return ""; }
}

/** Start the phone server (building it first if needed) and expose it on the private network. Safe to call repeatedly. */
export async function ensurePhoneHost(): Promise<void> {
  const dir = phoneDir();
  if (!dir || H.building) return;
  if (await listening()) { await ensureLanProxy(dir, process.env.MARIGOLD_NODE ?? process.execPath); return; }
  const env = { ...process.env, MARIGOLD_PHONE_PIN: await pin() };
  const node = process.env.MARIGOLD_NODE ?? process.execPath;
  const next = path.join(dir, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(next)) return;
  const run = (args: string[], detached: boolean) => spawn(node, [next, ...args], { cwd: dir, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", detached });
  if (!existsSync(path.join(dir, ".next", "BUILD_ID")) || (await newerThanBuild(dir))) {
    H.building = true;
    await new Promise<void>((r) => { const b = run(["build"], false); b.on("exit", () => r()); b.on("error", () => r()); });
    H.building = false;
  }
  H.child = run(["start", "-p", String(PORT), "-H", "127.0.0.1"], true);
  H.child.unref();
  H.child.on("exit", () => { H.child = undefined; });
  await ensureLanProxy(dir, node);
  const ts = tailscaleBin();
  if (ts) await exec(ts, ["serve", "--bg", String(PORT)], { timeout: 10_000 }).catch(() => {});
}

async function ensureLanProxy(dir: string, node: string) {
  if (await lanListening()) return;
  const c = await lanCert();
  const script = path.join(dir, "scripts", "lan-proxy.mjs");
  if (!c || !existsSync(script)) return;
  const p = spawn(node, [script, c.key, c.cert, String(LAN_PORT), String(PORT)], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", detached: true });
  p.unref();
}

export async function stopPhoneHost() {
  await fs.rm(ON_FILE, { force: true });
  try { H.child?.kill("SIGTERM"); } catch { /* gone */ }
  try {
    const pids = [...new Set([...(await exec("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"]).then((r) => r.stdout, () => "")).split("\n"), ...(await exec("lsof", ["-ti", `tcp:${LAN_PORT}`, "-sTCP:LISTEN"]).then((r) => r.stdout, () => "")).split("\n")].map((x) => x.trim()).filter(Boolean))];
    for (const p of pids) { try { process.kill(Number(p), "SIGTERM"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
  const ts = tailscaleBin();
  if (ts) await exec(ts, ["serve", "reset"], { timeout: 8000 }).catch(() => {});
}

export interface PhoneHostStatus { available: boolean; on: boolean; running: boolean; building: boolean; tailscale: "missing" | "signed-out" | "ready"; url: string; qr: string; lan: string; wifi: { ready: boolean; host: string; ip: string; qr: string } }

export async function phoneHostStatus(): Promise<PhoneHostStatus> {
  const dir = phoneDir();
  const ts = tailscaleBin();
  const name = ts ? await tailnetName(ts) : "";
  const running = await listening();
  const p = await pin();
  const url = name ? `https://${name}/?k=${p}` : "";
  let qr = "";
  if (url) { try { qr = await (await import("qrcode")).toString(url, { type: "svg", margin: 1, width: 220, color: { dark: "#111111", light: "#ffffff" } }); } catch { /* no qr */ } }
  const lan = lanIp();
  // The iPhone app's code: this Mac's address on the home Wi-Fi, the certificate fingerprint it must match, and the PIN.
  const wifi: PhoneHostStatus["wifi"] = { ready: false, host: "", ip: lan, qr: "" };
  if (phoneHostWanted() && running) {
    const c = await lanCert();
    wifi.host = await macLocalName();
    if (c && lan && (await lanListening())) {
      const payload = `marigold-pair://v1?h=${encodeURIComponent(wifi.host)}&i=${encodeURIComponent(lan)}&p=${LAN_PORT}&f=${c.fp}&k=${p}`;
      try { wifi.qr = await (await import("qrcode")).toString(payload, { type: "svg", margin: 1, width: 220, color: { dark: "#111111", light: "#ffffff" } }); wifi.ready = true; } catch { /* no qr */ }
    }
  }
  return { available: !!dir, on: phoneHostWanted(), running, building: !!H.building, tailscale: !ts ? "missing" : name ? "ready" : "signed-out", url, qr, lan, wifi };
}

export async function startPhoneHost() {
  await fs.mkdir(MARIGOLD_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(ON_FILE, "1", { mode: 0o600 });
  void ensurePhoneHost();
}
