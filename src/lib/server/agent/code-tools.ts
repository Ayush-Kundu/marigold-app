import { execFile, spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { MARIGOLD_DIR, expandPath, sensitivePath, type Classified, NETWORK_OUT } from "./policy";
import type { ToolDef } from "./tools";

/**
 * Coding mode: the tools a coding agent needs, shaped like the ones in Claude Code: read with line numbers, search,
 * exact-match edits that show a diff, run tests/builds, git, a to-do plan, and hand-off to whatever editor the user uses.
 * They only exist while the user has chosen a project folder ("Code" in the message bar).
 */

const execAsync = promisify(execFile);
type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
const num = (a: Args, k: string, d: number) => (Number.isFinite(Number(a[k])) && a[k] !== undefined && a[k] !== "" ? Number(a[k]) : d);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });
const IGNORE = ["node_modules", ".git", ".next", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".turbo", ".cache", "Pods", "DerivedData", ".build", "coverage"];

export type CodeCtx = { coding?: { root: string } };
const rootOf = (ctx: unknown) => (ctx as CodeCtx)?.coding?.root ?? "";

/** A path as the model wrote it → absolute, relative to the project folder. */
function resolveIn(root: string, p: string): string {
  const e = p.startsWith("~") ? expandPath(p) : path.isAbsolute(p) ? p : path.resolve(root, p);
  return path.resolve(e);
}
const inside = (root: string, abs: string) => { const r = path.relative(root, abs); return !r.startsWith("..") && !path.isAbsolute(r); };
const rel = (root: string, abs: string) => (inside(root, abs) ? path.relative(root, abs) || "." : abs.replace(os.homedir(), "~"));

async function sh(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}) {
  try {
    const { stdout, stderr } = await execAsync(cmd, args, { encoding: "utf8", cwd: opts.cwd, timeout: opts.timeout ?? 30_000, maxBuffer: 16 * 1024 * 1024, signal: opts.signal, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
    return { code: 0, out: `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}` };
  } catch (e) {
    const x = e as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string; message: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: `${x.stdout ?? ""}${x.stderr ? `${x.stdout ? "\n" : ""}${x.stderr}` : ""}` || x.message, timedOut: x.killed === true };
  }
}
/** Long output: keep the start and the end (where failures show up), cut the middle. */
const tail = (t: string, max = 12000) => (t.length <= max ? t : `${t.slice(0, Math.floor(max * 0.25))}\n…[${t.length - max} characters cut]…\n${t.slice(-Math.floor(max * 0.75))}`);

async function backup(file: string) {
  try { await fs.access(file); } catch { return; }
  const dir = path.join(MARIGOLD_DIR, "backups");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.copyFile(file, path.join(dir, `${Date.now()}_${path.basename(file)}`));
}

// ---------------------------------------------------------------- project context (what Claude Code gets from CLAUDE.md etc.)

/** Project notes, how it is built and tested, git state and layout: given to the agent before its first move. */
export async function readPlan(root: string): Promise<string> {
  try { return (await fs.readFile(path.join(root, ".marigold", "plan.md"), "utf8")).replace(/^# .*\n+/, "").trim().slice(0, 3000); } catch { return ""; }
}

export async function projectContext(root: string): Promise<string> {
  const read = async (f: string, n: number) => { try { return (await fs.readFile(path.join(root, f), "utf8")).slice(0, n); } catch { return ""; } };
  const parts: string[] = [`PROJECT FOLDER: ${root}`];
  for (const f of ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md", "CONTRIBUTING.md"]) {
    const t = await read(f, 3500);
    if (t.trim()) { parts.push(`--- ${f} (the project's own instructions: follow them) ---\n${t.trim()}`); break; }
  }
  const hints: string[] = [];
  try {
    const pkg = JSON.parse(await read("package.json", 40_000)) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const stack = ["next", "react", "vue", "svelte", "express", "electron", "typescript", "vite", "jest", "vitest", "playwright", "tailwindcss"].filter((d) => deps.includes(d));
    hints.push(`Node project${pkg.name ? ` "${pkg.name}"` : ""}${stack.length ? ` (${stack.join(", ")})` : ""}. Scripts: ${Object.entries(pkg.scripts ?? {}).slice(0, 14).map(([k, v]) => `${k}=\`${v.slice(0, 60)}\``).join("; ") || "none"}`);
  } catch { /* not a node project */ }
  const has = (f: string) => existsSync(path.join(root, f));
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) hints.push(`Python project (${has("pyproject.toml") ? "pyproject.toml" : has("requirements.txt") ? "requirements.txt" : "setup.py"}); tests: ${has("pytest.ini") || has("tests") ? "pytest" : "check the repo"}`);
  if (has("Cargo.toml")) hints.push("Rust project: cargo build / cargo test");
  if (has("go.mod")) hints.push("Go project: go build ./... / go test ./...");
  if (has("Package.swift")) hints.push("Swift package: swift build / swift test");
  if ((await fs.readdir(root).catch(() => [] as string[])).some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"))) hints.push("Xcode project: xcodebuild -list, then xcodebuild build/test");
  if (has("Makefile")) hints.push("Makefile present");
  if (hints.length) parts.push(`HOW IT BUILDS: ${hints.join(" | ")}`);
  const git = await sh("git", ["-C", root, "status", "-sb", "--porcelain=1"], { timeout: 8000 });
  if (git.code === 0) {
    const lines = git.out.trim().split("\n");
    parts.push(`GIT: ${lines[0]}${lines.length > 1 ? `; ${lines.length - 1} changed file(s): ${lines.slice(1, 9).join(", ")}${lines.length > 9 ? ", …" : ""}` : "; clean"}`);
  } else parts.push("GIT: not a git repository (no undo besides Marigold's backups)");
  const top = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => !IGNORE.includes(e.name) && !e.name.startsWith(".")).slice(0, 60).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  if (top.length) parts.push(`TOP LEVEL: ${top.join("  ")}`);
  const plan = await readPlan(root);
  if (plan) parts.push(`YOUR SAVED PLAN FROM EARLIER WORK ON THIS PROJECT (continue from it; update it with code_plan):\n${plan}`);
  return parts.join("\n\n");
}

export const CODING_RULES = `You are Marigold in CODING MODE: a careful senior software engineer working inside the user's project folder, using the same disciplined workflow as Claude Code. Tools: code_search, code_read, code_edit, code_write, code_run, code_git, code_plan, editor, web_search / web_fetch (docs only).
HOW TO WORK
1. Understand first. Search (code_search) and read (code_read, with line ranges for big files) the relevant code BEFORE changing it. Never guess file names, APIs or signatures: look them up. Read the nearby code to match its style, naming and patterns.
2. Plan bigger jobs with code_plan (3-8 short steps) and keep it updated; it is saved in the project, so after a long stretch you will still have it. For an app or any job of many files: plan first, build in small working steps, and after each milestone that runs, call code_checkpoint so there is always something to go back to.
   LOOK AT WHAT YOU BUILD: for anything with a screen, start it with code_serve, open the localhost address with web_browser, take a screenshot, and fix what looks wrong before you say it is done. Stop the server at the end.
3. Change code with code_edit: exact, minimal edits (old_string must match the file exactly and be unique: include enough surrounding lines). Several changes to one file → one code_edit with edits=[…]. Use code_write only for NEW files. Never rewrite a whole file to change a few lines. Don't touch unrelated code, and don't add comments, dependencies or abstractions nobody asked for.
4. VERIFY. After changing code, run the project's checks with code_run (tests, type-check, lint, build: whatever this project uses, see HOW IT BUILDS). If something fails, read the error, fix the cause, and run again. Don't stop at a red build, and never claim it works without running it. If you cannot run anything, say so plainly.
5. Be honest. If a test fails and you can't fix it, say exactly what failed. Don't hide errors, delete or weaken tests to make them pass, or invent results.
6. Safety. Stay inside the project folder. Don't read secrets (.env, keys). No sudo, no destructive commands (rm -rf, git reset --hard, force-push), no deploys or installs unless the user asked. Don't commit or push unless asked. Prefer small reversible steps; every edit is backed up and \`git diff\` shows exactly what changed (code_git).
7. When done, reply briefly: what you changed and why (file:line), what you ran and the result, and anything the user should check or decide. No long code dumps: the edits are already in the files, and the user's editor shows them.
8. If the request is ambiguous in a way that changes the result, ask ONE short question. Otherwise make a sensible choice and go.
If the user asks a coding QUESTION (explain, review, how does X work), read the code and answer; don't change files.`;

// ---------------------------------------------------------------- shell classification for coding

const BLOCK: [RegExp, string][] = [
  [/\bsudo\b|\bsu\s/, "no root access"],
  [/rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\.\.?)(\s|$)/, "refusing to wipe a whole folder"],
  [/git\s+(push\s+(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f)/, "history- or work-destroying git command"],
  [/(curl|wget)[^|]*\|\s*(ba|z)?sh/, "piping downloads into a shell is blocked"],
  [/\.marigold\b|\bsecurity\s+(find|dump|export)/, "off-limits"],
];
const CHAIN = /[;&|`$><()]/;
const SAFE_DEV: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|typecheck|type-check|check|format|fmt)(:[\w-]+)?(\s|$)/,
  /^(npx\s+)?(tsc|eslint|prettier|jest|vitest|mocha|ruff|black|flake8|mypy|pyright|biome)(\s|$)/,
  /^(python3?|py)\s+-m\s+(pytest|unittest|mypy|ruff|black|flake8)(\s|$)/, /^pytest(\s|$)/,
  /^cargo\s+(test|build|check|clippy|fmt|doc)(\s|$)/, /^go\s+(test|build|vet|fmt)(\s|$)/, /^swift\s+(build|test)(\s|$)/,
  /^xcodebuild\s+(-list|build|test|-showBuildSettings)\b/, /^make(\s+(test|check|build|lint|all))?$/,
  /^(mvn|gradle|\.\/gradlew)\s+(test|build|check|compile)/, /^dotnet\s+(build|test)(\s|$)/, /^deno\s+(test|lint|fmt|check)(\s|$)/, /^node\s+--test/,
];
const READ_ONLY = /^(ls|pwd|cat|head|tail|wc|which|echo|grep|rg|find|tree|stat|file|du|git\s+(status|log|diff|show|branch|blame|ls-files|rev-parse|stash list|remote -v))(\s|$)/;

function classifyCode(cmd: string): Classified {
  const c = cmd.trim();
  for (const [re, why] of BLOCK) if (re.test(c)) return { tier: 2, blocked: why, summary: c };
  for (const tok of c.match(/(~|\/)[^\s'"|;&<>]*/g) ?? []) { const why = sensitivePath(tok); if (why) return { tier: 2, blocked: why, summary: c }; }
  if (!CHAIN.test(c) && READ_ONLY.test(c) && !/\s-(delete|exec|execdir|ok)\b/.test(c)) return { tier: 0, summary: `Run: ${c}` };
  if (!CHAIN.test(c) && SAFE_DEV.some((re) => re.test(c))) return { tier: 1, summary: `Run: ${c}` };
  return { tier: 2, scope: "terminal", outward: NETWORK_OUT.test(c), summary: `Run in the project: ${c}` }; // the same single terminal permission as run_shell
}

// ---------------------------------------------------------------- tools

/** Unified-style change view: a little context, then - and + lines. */
function diffView(file: string, before: string, after: string, atLine: number, ctx = 2): string {
  const b = before.split("\n"), a = after.split("\n");
  let top = 0; while (top < b.length && top < a.length && b[top] === a[top]) top++;
  let bb = b.length - 1, aa = a.length - 1;
  while (bb >= top && aa >= top && b[bb] === a[aa]) { bb--; aa--; }
  const pre = a.slice(Math.max(0, top - ctx), top), post = a.slice(aa + 1, aa + 1 + ctx);
  const rm = b.slice(top, bb + 1).slice(0, 40), add = a.slice(top, aa + 1).slice(0, 40);
  const n = (i: number) => String(i).padStart(4);
  return [`${file}:${top + 1}`, ...pre.map((l, i) => `${n(top - pre.length + i + 1)}  ${l}`), ...rm.map((l, i) => `${n(top + i + 1)} -${l}`), ...add.map((l, i) => `${n(top + i + 1)} +${l}`), ...post.map((l, i) => `${n(aa + 2 + i)}  ${l}`)].join("\n") + (rm.length === 40 || add.length === 40 ? "\n…" : "");
}

/** Find old_string in the text: exactly, else ignoring indentation and trailing spaces (models often get those wrong). */
function locate(text: string, old: string): { start: number; end: number; loose: boolean; count: number } | { error: string } {
  const exact: number[] = [];
  for (let i = text.indexOf(old); i !== -1 && exact.length < 50; i = text.indexOf(old, i + Math.max(1, old.length))) exact.push(i);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + old.length, loose: false, count: 1 };
  if (exact.length > 1) return { count: exact.length, start: exact[0], end: exact[0] + old.length, loose: false };
  const lines = text.split("\n"), want = old.split("\n").map((l) => l.trim());
  while (want.length && !want[want.length - 1]) want.pop();
  if (!want.length || want.every((l) => !l)) return { error: "old_string is empty" };
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) if (want.every((w, k) => lines[i + k].trim() === w)) hits.push(i);
  if (hits.length === 1) {
    const start = lines.slice(0, hits[0]).reduce((n, l) => n + l.length + 1, 0);
    const end = start + lines.slice(hits[0], hits[0] + want.length).join("\n").length;
    return { start, end, loose: true, count: 1 };
  }
  if (hits.length > 1) return { count: hits.length, start: 0, end: 0, loose: true };
  return { error: "old_string wasn't found in the file. Read the file again (code_read) and copy the exact text." };
}

const codeRead: ToolDef = {
  name: "code_read",
  description: "Read a file in the project with line numbers (format: number, tab, text). Use offset (first line, default 1) and limit (default 400 lines) for big files. Also lists a folder if path is a directory.",
  parameters: obj({ path: s("file or folder, relative to the project folder"), offset: { type: "number", description: "first line (1-based)" }, limit: { type: "number", description: "how many lines (max 800)" } }, ["path"]),
  classify: (a): Classified => ({ tier: 0, blocked: sensitivePath(str(a, "path")), summary: `Read ${str(a, "path")}${a.offset ? `:${a.offset}` : ""}` }),
  async exec(a, _sig, ctx) {
    const root = rootOf(ctx); const p = resolveIn(root, str(a, "path"));
    const bad = sensitivePath(p); if (bad) return `BLOCKED: ${bad}`;
    const st = await fs.stat(p).catch(() => null);
    if (!st) return `FAILED: ${rel(root, p)} doesn't exist. Use code_search (mode=files) to find it.`;
    if (st.isDirectory()) return (await fs.readdir(p, { withFileTypes: true })).filter((e) => !IGNORE.includes(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    if (st.size > 3_000_000) return `FAILED: ${rel(root, p)} is ${(st.size / 1e6).toFixed(1)} MB: too big to read. Use code_search to find the part you need.`;
    const buf = await fs.readFile(p);
    if (buf.subarray(0, 4000).includes(0)) return `${rel(root, p)} is a binary file (${st.size} bytes).`;
    const lines = buf.toString("utf8").split("\n");
    const off = Math.max(1, Math.floor(num(a, "offset", 1))), lim = Math.min(800, Math.max(1, Math.floor(num(a, "limit", 400))));
    const slice = lines.slice(off - 1, off - 1 + lim);
    const body = slice.map((l, i) => `${off + i}\t${l.length > 400 ? `${l.slice(0, 400)}…` : l}`).join("\n");
    return `${rel(root, p)} (lines ${off}–${off + slice.length - 1} of ${lines.length})\n${body}${off + lim - 1 < lines.length ? `\n…[more: continue with offset ${off + lim}]` : ""}`;
  },
};

let rgChecked: boolean | undefined;
const codeSearch: ToolDef = {
  name: "code_search",
  description: "Search the project. mode=content (default): regex search inside files, returns file:line: text (use context for surrounding lines). mode=files: find files by name/glob (e.g. '*.test.ts', 'auth'). Skips node_modules, .git, build output.",
  parameters: obj({ pattern: s("regex (content) or name/glob (files)"), mode: { type: "string", enum: ["content", "files"] }, path: s("folder to search, relative (default: the whole project)"), glob: s("only files matching this glob, e.g. '*.tsx'"), context: { type: "number", description: "lines of context around each match (content mode, max 5)" }, ignore_case: { type: "boolean" } }, ["pattern"]),
  classify: (a): Classified => ({ tier: 0, summary: `Search ${str(a, "pattern")}` }),
  async exec(a, signal, ctx) {
    const root = rootOf(ctx); const where = resolveIn(root, str(a, "path") || ".");
    const pat = str(a, "pattern"); if (!pat) return "FAILED: give a pattern.";
    rgChecked ??= (await sh("which", ["rg"])).code === 0;
    const files = str(a, "mode") === "files";
    const c = Math.min(5, Math.max(0, Math.floor(num(a, "context", 0))));
    let r: { code: number; out: string };
    if (rgChecked) {
      const base = ["--no-heading", "--color", "never", "--max-columns", "300", "--max-count", "40", ...IGNORE.flatMap((d) => ["-g", `!${d}`])];
      r = files
        ? await sh("rg", ["--files", "--color", "never", ...IGNORE.flatMap((d) => ["-g", `!${d}`]), "-g", pat.includes("*") ? pat : `*${pat}*`, where], { cwd: root, signal })
        : await sh("rg", [...base, "-n", ...(a.ignore_case === true ? ["-i"] : []), ...(c ? ["-C", String(c)] : []), ...(str(a, "glob") ? ["-g", str(a, "glob")] : []), "-e", pat, where], { cwd: root, signal });
    } else {
      const ex = IGNORE.flatMap((d) => ["--exclude-dir", d]);
      r = files
        ? await sh("find", [where, "-type", "f", "-iname", pat.includes("*") ? pat : `*${pat}*`, ...IGNORE.flatMap((d) => ["-not", "-path", `*/${d}/*`])], { cwd: root, signal })
        : await sh("grep", ["-rnE", ...(a.ignore_case === true ? ["-i"] : []), ...(c ? ["-C", String(c)] : []), ...ex, ...(str(a, "glob") ? ["--include", str(a, "glob")] : []), pat, where], { cwd: root, signal });
    }
    const lines = r.out.split("\n").filter(Boolean).map((l) => l.split(root + "/").join(""));
    if (!lines.length) return files ? "No files matched." : "No matches.";
    const shown = lines.slice(0, 100);
    return `${shown.join("\n")}${lines.length > 100 ? `\n…[${lines.length - 100} more lines: narrow the search]` : ""}`;
  },
};

const codeEdit: ToolDef = {
  name: "code_edit",
  description: "Edit a file by exact text replacement (like Claude Code's Edit). old_string must match the file exactly and be unique (add surrounding lines to make it unique, or set replace_all). For several changes in one file pass edits=[{old_string,new_string},…]; they apply in order and all-or-nothing. Returns a diff. Backed up before writing.",
  parameters: obj({ path: s("file, relative to the project folder"), old_string: s("exact text to replace"), new_string: s("replacement text"), replace_all: { type: "boolean" }, edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } } } } }, ["path"]),
  classify: (a): Classified => ({ tier: 1, blocked: sensitivePath(str(a, "path")), summary: `Edit ${str(a, "path")}` }),
  async exec(a, _sig, ctx) {
    const root = rootOf(ctx); const p = resolveIn(root, str(a, "path"));
    if (!inside(root, p)) return `BLOCKED: ${p.replace(os.homedir(), "~")} is outside the project folder (${root.replace(os.homedir(), "~")}). Coding mode only edits inside it.`;
    const bad = sensitivePath(p); if (bad) return `BLOCKED: ${bad}`;
    let text: string;
    try { text = await fs.readFile(p, "utf8"); } catch { return `FAILED: ${rel(root, p)} doesn't exist. Use code_write to create a new file.`; }
    const crlf = text.includes("\r\n");
    const work = crlf ? text.replace(/\r\n/g, "\n") : text;
    const list = Array.isArray(a.edits) && a.edits.length ? (a.edits as { old_string?: string; new_string?: string; replace_all?: boolean }[]) : [{ old_string: str(a, "old_string"), new_string: str(a, "new_string"), replace_all: a.replace_all === true }];
    let cur = work; const notes: string[] = [];
    for (const [i, e] of list.entries()) {
      const old = String(e.old_string ?? "").replace(/\r\n/g, "\n"), nw = String(e.new_string ?? "").replace(/\r\n/g, "\n");
      const tag = list.length > 1 ? `edit ${i + 1}: ` : "";
      if (!old) return `FAILED: ${tag}old_string is empty. (To create a file use code_write.)`;
      if (old === nw) return `FAILED: ${tag}old_string and new_string are identical.`;
      if (e.replace_all) {
        if (!cur.includes(old)) return `FAILED: ${tag}old_string wasn't found. Read the file again (code_read) and copy the exact text. Nothing was changed.`;
        cur = cur.split(old).join(nw); notes.push(`${tag}replaced every occurrence`);
        continue;
      }
      const hit = locate(cur, old);
      if ("error" in hit) return `FAILED: ${tag}${hit.error} Nothing was changed.`;
      if (hit.count > 1) return `FAILED: ${tag}old_string matches ${hit.count} places. Include more surrounding lines to make it unique, or set replace_all. Nothing was changed.`;
      cur = cur.slice(0, hit.start) + nw + cur.slice(hit.end);
      if (hit.loose) notes.push(`${tag}matched ignoring indentation`);
    }
    const out = crlf ? cur.replace(/\n/g, "\r\n") : cur;
    if (/\.json$/i.test(p)) { try { JSON.parse(out); } catch (err) { return `FAILED: that edit would make ${rel(root, p)} invalid JSON (${String(err).slice(0, 80)}). Nothing was changed.`; } }
    await backup(p);
    await fs.writeFile(p, out);
    return `Edited ${rel(root, p)}${notes.length ? ` (${notes.join("; ")})` : ""}\n${diffView(rel(root, p), work, cur, 0)}`;
  },
};

const codeWrite: ToolDef = {
  name: "code_write",
  description: "Create a NEW file in the project (parent folders are created). Refuses to overwrite an existing file unless overwrite=true (then it is backed up). To change an existing file use code_edit.",
  parameters: obj({ path: s("new file, relative to the project folder"), content: s("full file contents"), overwrite: { type: "boolean" } }, ["path", "content"]),
  classify: (a): Classified => ({ tier: 1, blocked: sensitivePath(str(a, "path")), summary: `Create ${str(a, "path")}` }),
  async exec(a, _sig, ctx) {
    const root = rootOf(ctx); const p = resolveIn(root, str(a, "path"));
    if (!inside(root, p)) return `BLOCKED: ${p.replace(os.homedir(), "~")} is outside the project folder.`;
    const bad = sensitivePath(p); if (bad) return `BLOCKED: ${bad}`;
    const exists = await fs.access(p).then(() => true, () => false);
    if (exists && a.overwrite !== true) return `FAILED: ${rel(root, p)} already exists. Use code_edit to change it (or set overwrite=true to replace it entirely).`;
    await backup(p);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, str(a, "content"));
    const n = str(a, "content").split("\n").length;
    return `${exists ? "Replaced" : "Created"} ${rel(root, p)} (${n} lines).`;
  },
};

const codeRun: ToolDef = {
  name: "code_run",
  description: "Run a shell command in the project folder (or a subfolder via cwd): tests, type-check, lint, build, scripts, git, package managers. Returns the output and exit code. Test/build/lint commands run directly; anything else asks the user once. Long output keeps its start and end.",
  parameters: obj({ command: s("the command (zsh)"), cwd: s("subfolder, relative to the project folder (default: its root)"), timeout_seconds: { type: "number", description: "default 180, max 900" } }, ["command"]),
  classify: (a): Classified => classifyCode(str(a, "command")),
  async exec(a, signal, ctx) {
    const root = rootOf(ctx); const cwd = resolveIn(root, str(a, "cwd") || ".");
    if (!inside(root, cwd)) return "BLOCKED: cwd is outside the project folder.";
    const t0 = Date.now();
    const r = await sh("/bin/zsh", ["-lc", str(a, "command")], { cwd, signal, timeout: Math.min(900, Math.max(5, num(a, "timeout_seconds", 180))) * 1000 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return `${tail(r.out.trim() || "(no output)")}\n[exit ${r.code}${(r as { timedOut?: boolean }).timedOut ? ", timed out" : ""} · ${secs}s]`;
  },
};

const codeGit: ToolDef = {
  name: "code_git",
  description: "Read-only git view of the project: status, diff (unstaged + staged; optionally one path), log (last 15), branch, blame (needs path). To commit, stage or branch use code_run (it asks the user).",
  parameters: obj({ action: { type: "string", enum: ["status", "diff", "log", "branch", "blame"] }, path: s("optional file for diff/blame") }, ["action"]),
  classify: (a): Classified => ({ tier: 0, summary: `git ${str(a, "action")}` }),
  async exec(a, signal, ctx) {
    const root = rootOf(ctx); const act = str(a, "action"); const p = str(a, "path");
    const args = act === "status" ? ["status", "-sb"] : act === "diff" ? ["diff", "--no-color", "HEAD", ...(p ? ["--", p] : [])] : act === "log" ? ["log", "--oneline", "-15"] : act === "branch" ? ["branch", "-vv"] : p ? ["blame", "-L", "1,60", "--", p] : [];
    if (!args.length) return "FAILED: blame needs a path.";
    const r = await sh("git", ["-C", root, ...args], { signal });
    if (r.code !== 0 && /not a git repository/i.test(r.out)) return "This folder isn't a git repository.";
    return tail(r.out.trim() || (act === "diff" ? "No changes since the last commit." : "(nothing)"), 14000);
  },
};

const codePlan: ToolDef = {
  name: "code_plan",
  description: "Write or update your to-do list for a bigger job (3-8 short steps). status: todo, doing, done. Call again to update it as you go; keep exactly one step 'doing'.",
  parameters: obj({ todos: { type: "array", items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } } } } }, ["todos"]),
  classify: (): Classified => ({ tier: 0, summary: "Update the plan" }),
  async exec(a, _signal, ctx) {
    const list = (Array.isArray(a.todos) ? a.todos : []) as { text?: string; status?: string }[];
    const text = list.map((t) => `${t.status === "done" ? "[x]" : t.status === "doing" ? "[~]" : "[ ]"} ${String(t.text ?? "").slice(0, 160)}`).join("\n") || "(empty)";
    // Kept in the project, so a long job (or tomorrow's follow-up) picks up exactly where this left off.
    const root = rootOf(ctx);
    if (root && list.length) { try { await fs.mkdir(path.join(root, ".marigold"), { recursive: true }); await fs.writeFile(path.join(root, ".marigold", "plan.md"), `# Marigold's plan for this project\n\n${text}\n`, "utf8"); } catch { /* read-only folder: the plan still shows in the chat */ } }
    return text;
  },
};

// ---------------------------------------------------------------- editors

interface Editor { id: string; name: string; app: string; bundle: string; cli?: string[]; open: (f: string, l: number) => string[] }
const colon = (f: string, l: number) => [`${f}:${l}`];
const EDITORS: Editor[] = [
  { id: "vscode", name: "Visual Studio Code", app: "Visual Studio Code", bundle: "com.microsoft.VSCode", cli: ["code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"], open: (f, l) => ["-g", ...colon(f, l)] },
  { id: "cursor", name: "Cursor", app: "Cursor", bundle: "com.todesktop.230313mzl4w4u92", cli: ["cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"], open: (f, l) => ["-g", ...colon(f, l)] },
  { id: "windsurf", name: "Windsurf", app: "Windsurf", bundle: "com.exafunction.windsurf", cli: ["windsurf", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"], open: (f, l) => ["-g", ...colon(f, l)] },
  { id: "vscodium", name: "VSCodium", app: "VSCodium", bundle: "com.vscodium", cli: ["codium", "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"], open: (f, l) => ["-g", ...colon(f, l)] },
  { id: "zed", name: "Zed", app: "Zed", bundle: "dev.zed.Zed", cli: ["zed", "/Applications/Zed.app/Contents/MacOS/cli"], open: (f, l) => colon(f, l) },
  { id: "sublime", name: "Sublime Text", app: "Sublime Text", bundle: "com.sublimetext.4", cli: ["subl", "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"], open: (f, l) => colon(f, l) },
  { id: "xcode", name: "Xcode", app: "Xcode", bundle: "com.apple.dt.Xcode", cli: ["xed"], open: (f, l) => ["--line", String(l), f] },
  { id: "intellij", name: "IntelliJ IDEA", app: "IntelliJ IDEA", bundle: "com.jetbrains.intellij", cli: ["idea", "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"], open: (f, l) => ["--line", String(l), f] },
  { id: "pycharm", name: "PyCharm", app: "PyCharm", bundle: "com.jetbrains.pycharm", cli: ["pycharm", "/Applications/PyCharm.app/Contents/MacOS/pycharm"], open: (f, l) => ["--line", String(l), f] },
  { id: "webstorm", name: "WebStorm", app: "WebStorm", bundle: "com.jetbrains.WebStorm", cli: ["webstorm", "/Applications/WebStorm.app/Contents/MacOS/webstorm"], open: (f, l) => ["--line", String(l), f] },
  { id: "goland", name: "GoLand", app: "GoLand", bundle: "com.jetbrains.goland", cli: ["goland", "/Applications/GoLand.app/Contents/MacOS/goland"], open: (f, l) => ["--line", String(l), f] },
  { id: "clion", name: "CLion", app: "CLion", bundle: "com.jetbrains.CLion", cli: ["clion", "/Applications/CLion.app/Contents/MacOS/clion"], open: (f, l) => ["--line", String(l), f] },
  { id: "studio", name: "Android Studio", app: "Android Studio", bundle: "com.google.android.studio", cli: ["studio", "/Applications/Android Studio.app/Contents/MacOS/studio"], open: (f, l) => ["--line", String(l), f] },
  { id: "nova", name: "Nova", app: "Nova", bundle: "com.panic.Nova", cli: ["nova"], open: (f) => [f] },
  { id: "bbedit", name: "BBEdit", app: "BBEdit", bundle: "com.barebones.bbedit", cli: ["bbedit"], open: (f, l) => [`+${l}`, f] },
  { id: "textmate", name: "TextMate", app: "TextMate", bundle: "com.macromates.TextMate", cli: ["mate"], open: (f, l) => ["-l", String(l), f] },
];
const appPath = (name: string) => [`/Applications/${name}.app`, path.join(os.homedir(), "Applications", `${name}.app`), `/Applications/JetBrains Toolbox/${name}.app`].find((p) => existsSync(p));
const installed = () => EDITORS.filter((e) => appPath(e.app) || appPath(`${e.app} CE`));
async function running(e: Editor): Promise<boolean> { return (await sh("pgrep", ["-f", `${e.app}.app/Contents/MacOS`])).code === 0; }

async function editorCli(e: Editor): Promise<string | null> {
  for (const c of e.cli ?? []) {
    if (c.startsWith("/")) { if (existsSync(c)) return c; continue; }
    const w = await sh("/bin/zsh", ["-lc", `command -v ${c}`]);
    if (w.code === 0 && w.out.trim()) return w.out.trim().split("\n").pop()!;
  }
  return null;
}

const editorTool: ToolDef = {
  name: "editor",
  description: "Work with the user's code editors. action=list: which editors are installed / running. action=open: open file (path, optional line) in an editor (app = name; default: the one running, else VS Code/Cursor/Xcode/whatever is installed). action=current: what the user has open right now (each running editor's front window title: file and project). Supports VS Code, Cursor, Windsurf, VSCodium, Zed, Sublime Text, Xcode, IntelliJ IDEA, PyCharm, WebStorm, GoLand, CLion, Android Studio, Nova, BBEdit, TextMate. Edits you make with code_edit show up in these editors automatically.",
  parameters: obj({ action: { type: "string", enum: ["list", "open", "current"] }, path: s("file to open, relative to the project folder"), line: { type: "number" }, app: s("editor name, e.g. Cursor, Xcode") }, ["action"]),
  classify: (a): Classified => ({ tier: str(a, "action") === "open" ? 1 : 0, summary: str(a, "action") === "open" ? `Open ${str(a, "path")} in ${str(a, "app") || "your editor"}` : `Editors: ${str(a, "action")}` }),
  async exec(a, _sig, ctx) {
    const act = str(a, "action"); const root = rootOf(ctx);
    if (act === "list") {
      const ins = installed();
      if (!ins.length) return "No known code editor is installed (VS Code, Cursor, Xcode, Zed, Sublime, JetBrains, Nova, BBEdit, TextMate).";
      const lines = await Promise.all(ins.map(async (e) => `${e.name}${(await running(e)) ? " (running)" : ""}`));
      return lines.join("\n");
    }
    if (act === "current") {
      const out: string[] = [];
      for (const e of installed()) {
        if (!(await running(e))) continue;
        const r = await sh("osascript", ["-e", `tell application "System Events"\nset ps to every application process whose bundle identifier is "${e.bundle}"\nif (count of ps) is 0 then return ""\ntry\nreturn name of front window of item 1 of ps\non error\nreturn ""\nend try\nend tell`]);
        const t = r.out.trim();
        out.push(`${e.name}: ${t || "(no window title: check Marigold has Accessibility permission)"}`);
      }
      return out.join("\n") || "No code editor is open.";
    }
    const file = str(a, "path") ? resolveIn(root, str(a, "path")) : "";
    if (!file) return "FAILED: give path.";
    const bad = sensitivePath(file); if (bad) return `BLOCKED: ${bad}`;
    if (!existsSync(file)) return `FAILED: ${rel(root, file)} doesn't exist.`;
    const want = str(a, "app").toLowerCase();
    const ins = installed();
    let pick = want ? ins.find((e) => e.name.toLowerCase().includes(want) || e.id === want) : undefined;
    if (!pick && !want) { for (const e of ins) if (await running(e)) { pick = e; break; } pick ??= ins[0]; }
    if (!pick) return want ? `FAILED: ${str(a, "app")} isn't installed here.` : "FAILED: no known editor installed.";
    const line = Math.max(1, Math.floor(num(a, "line", 1)));
    const cli = await editorCli(pick);
    const r = cli ? await sh(cli, pick.open(file, line), { timeout: 15_000 }) : await sh("open", ["-a", pick.app, file]);
    return r.code === 0 ? `Opened ${rel(root, file)}${cli ? `:${line}` : ""} in ${pick.name}.` : `FAILED: ${r.out.slice(0, 200)}`;
  },
};


// ---------------------------------------------------------------- checkpoints (git commits) and a dev server to look at
const codeCheckpoint: ToolDef = {
  name: "code_checkpoint",
  description: "Save a checkpoint of the project as a git commit (stages everything, then commits with your message). Do this after each working milestone of a big job, so the user can always go back. Sets up git first if the folder isn't a repository.",
  parameters: obj({ message: s("a short commit message describing the milestone") }, ["message"]),
  classify: (a): Classified => ({ tier: 2, scope: "git:commit", summary: `Save a checkpoint: ${str(a, "message").slice(0, 80)}` }),
  async exec(a, signal, ctx) {
    const root = rootOf(ctx); const msg = str(a, "message").replace(/[\r\n]+/g, " ").slice(0, 200) || "Checkpoint";
    const isRepo = (await sh("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { signal })).code === 0;
    const steps: string[] = [];
    if (!isRepo) { const r = await sh("git", ["-C", root, "init"], { signal }); steps.push(r.code === 0 ? "Started a git repository here." : `git init failed: ${r.out.trim()}`); if (r.code !== 0) return steps.join("\n"); }
    const add = await sh("git", ["-C", root, "add", "-A"], { signal });
    if (add.code !== 0) return `git add failed: ${tail(add.out)}`;
    const c = await sh("git", ["-C", root, "-c", "user.name=Marigold", "-c", "user.email=marigold@localhost", "commit", "-m", msg], { signal });
    if (c.code !== 0 && /nothing to commit/i.test(c.out)) return [...steps, "Nothing has changed since the last checkpoint."].join("\n");
    if (c.code !== 0) return `git commit failed: ${tail(c.out)}`;
    return [...steps, tail(c.out.trim().split("\n").slice(0, 4).join("\n")), "Checkpoint saved. To go back to it later: git log, then git checkout <id> -- . (ask the user first)."].join("\n");
  },
};

interface Served { proc: ReturnType<typeof spawn>; log: string[]; url?: string; command: string }
const serving = new Map<string, Served>();
const stopServer = (root: string) => { const x = serving.get(root); if (x) { try { process.kill(-(x.proc.pid ?? 0), "SIGTERM"); } catch { try { x.proc.kill("SIGTERM"); } catch { /* gone */ } } serving.delete(root); } };
process.on("exit", () => { for (const k of [...serving.keys()]) stopServer(k); });

const codeServe: ToolDef = {
  name: "code_serve",
  description: "Run the project's dev server in the background (npm run dev, vite, next dev, python -m http.server…), so you can open it with web_browser (action=open_url on the localhost address, then action=screenshot to LOOK at it) and check that what you built really works. Actions: start (needs command), logs, stop. Stop it when you are done.",
  parameters: obj({ action: { type: "string", enum: ["start", "logs", "stop"] }, command: s("start: the dev-server command, e.g. npm run dev") }, ["action"]),
  classify: (a): Classified => str(a, "action") === "start" ? { ...classifyCode(str(a, "command")), tier: 2, scope: "terminal", summary: `Start the dev server: ${str(a, "command")}` } : { tier: 0, summary: `Dev server: ${str(a, "action")}` },
  async exec(a, _signal, ctx) {
    const root = rootOf(ctx); const act = str(a, "action");
    if (act === "stop") { const had = serving.has(root); stopServer(root); return had ? "Dev server stopped." : "No dev server was running."; }
    if (act === "logs") { const x = serving.get(root); return x ? tail(x.log.slice(-60).join("\n") || "(no output yet)") + (x.url ? `\n[running at ${x.url}]` : "") : "No dev server is running."; }
    const command = str(a, "command"); if (!command) return "FAILED: give the command to start.";
    for (const [re, why] of BLOCK) if (re.test(command)) return `BLOCKED: ${why}`;
    stopServer(root);
    const proc = spawn("/bin/zsh", ["-lc", command], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROWSER: "none", CI: "" } });
    const entry: Served = { proc, log: [], command };
    serving.set(root, entry);
    const feed = (b: Buffer) => { for (const line of b.toString().split("\n")) { if (!line.trim()) continue; entry.log.push(line.slice(0, 300)); if (entry.log.length > 300) entry.log.shift(); const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})[^\s]*/); if (m && !entry.url) entry.url = m[0].replace("0.0.0.0", "localhost"); } };
    proc.stdout?.on("data", feed); proc.stderr?.on("data", feed);
    proc.on("exit", () => { if (serving.get(root) === entry) serving.delete(root); });
    for (let i = 0; i < 60 && !entry.url && serving.get(root) === entry; i++) await new Promise((r) => setTimeout(r, 500));
    if (serving.get(root) !== entry) return `The server exited right away:\n${tail(entry.log.slice(-25).join("\n"))}`;
    return entry.url ? `Dev server is up at ${entry.url}. Open it with web_browser (open_url) and take a screenshot to check the result. Stop it with code_serve action=stop when finished.` : `Started, but no address appeared in 30 s. Recent output:\n${tail(entry.log.slice(-20).join("\n"))}`;
  },
};

export const CODE_TOOLS: ToolDef[] = [codeRead, codeSearch, codeEdit, codeWrite, codeRun, codeGit, codePlan, codeCheckpoint, codeServe, editorTool];
/** What the model may use in coding mode (plus docs lookups). */
export const CODE_TOOL_NAMES = new Set([...CODE_TOOLS.map((t) => t.name), "web_search", "web_fetch", "web_browser", "video_edit"]); // (the browser is for looking at what was built)
