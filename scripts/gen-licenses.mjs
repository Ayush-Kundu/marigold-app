// Writes src/data/licenses.json: every production dependency Marigold ships, with its version and license.
// Run by scripts/release.sh before packing (and by hand: node scripts/gen-licenses.mjs).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const out = new Map();
for (const [p, info] of Object.entries(lock.packages ?? {})) {
  if (!p.startsWith("node_modules/") || info.dev || info.devOptional) continue;
  const name = p.replace(/^.*node_modules\//, "");
  const pj = path.join(root, p, "package.json");
  let meta = {};
  if (existsSync(pj)) { try { meta = JSON.parse(readFileSync(pj, "utf8")); } catch { /* unreadable */ } }
  let license = meta.license ?? info.license ?? "";
  if (license && typeof license === "object") license = license.type ?? "";
  if (!license && Array.isArray(meta.licenses)) license = meta.licenses.map((l) => l.type).join(" OR ");
  const homepage = typeof meta.homepage === "string" ? meta.homepage : typeof meta.repository === "string" ? meta.repository : meta.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ?? "";
  const key = `${name}@${info.version}`;
  if (!out.has(key)) out.set(key, { name, version: info.version, license: String(license || "See package"), url: homepage });
}
const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(path.join(root, "src/data"), { recursive: true });
writeFileSync(path.join(root, "src/data/licenses.json"), JSON.stringify(list));
const counts = {};
for (const l of list) counts[l.license] = (counts[l.license] ?? 0) + 1;
console.log(`licenses: ${list.length} packages`, Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(", "));
