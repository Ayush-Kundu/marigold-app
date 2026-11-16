import { execFile } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR } from "./policy";

/**
 * Marigold's small native helpers (Accessibility, windows, calendar, OCR, icons, document reading…) are Swift
 * programs. Shipped builds carry them PRE-COMPILED inside the app (Resources/helpers), so a tester's Mac
 * needs no developer tools. When running from source they're compiled on first use instead.
 */

const exec = promisify(execFile);
const BIN = path.join(MARIGOLD_DIR, "bin");
const building = new Map<string, Promise<string>>();

export const HELPERS = ["axapp", "axweb", "appctl", "windows", "scperm", "ocr", "eventkit", "brightness", "docread", "appicon"] as const;
export type HelperName = (typeof HELPERS)[number];

/** Path to a ready-to-run helper binary. */
export function helperBin(name: HelperName): Promise<string> {
  const hit = building.get(name);
  if (hit) return hit;
  const p = prepare(name).finally(() => building.delete(name));
  building.set(name, p);
  return p;
}

async function prepare(name: string): Promise<string> {
  const target = path.join(BIN, name);
  mkdirSync(BIN, { recursive: true, mode: 0o700 });
  // 1. The copy that ships inside the app (kept fresh across updates).
  const bundled = path.join(process.env.MARIGOLD_RESOURCES ?? "", "helpers", name);
  if (process.env.MARIGOLD_RESOURCES && existsSync(bundled)) {
    const stale = !existsSync(target) || statSync(bundled).mtimeMs > statSync(target).mtimeMs || statSync(bundled).size !== statSync(target).size;
    if (stale) { copyFileSync(bundled, target); chmodSync(target, 0o755); }
    return target;
  }
  // 2. Running from source: compile on first use, and again when the source changes.
  const src = path.join(process.cwd(), "scripts", `${name}.swift`);
  const fresh = existsSync(target) && (!existsSync(src) || statSync(target).mtimeMs >= statSync(src).mtimeMs);
  if (fresh) return target;
  try {
    await exec("swiftc", ["-O", src, "-o", target], { timeout: 240_000 });
  } catch (e) {
    if (existsSync(target)) return target; // an older build is better than none
    const missing = /ENOENT|not found|xcrun/i.test(String(e));
    throw new Error(missing
      ? "This feature needs Apple's command-line developer tools. Run “xcode-select --install” in Terminal once, then try again."
      : `Couldn't prepare the ${name} helper: ${String(e).slice(0, 200)}`);
  }
  return target;
}
